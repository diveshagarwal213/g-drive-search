# Google Drive SQLite Searcher & Indexer

A client-side web application designed to recursively index Google Drive folders, store their metadata (names, paths, modified dates, sizes) inside a local WebAssembly-backed SQLite database, and run advanced substring (`LIKE`) and raw SQL queries directly in the browser.

This project solves the limitation of default Google Drive search, which fails on arbitrary substring matches (such as searching `23456789` to find a file named `+91123456789.xlsx`).

---

## Key Features

- 📁 **Deep Recursive Traversal**: Indexes nested files and subfolders down to arbitrary depths.
- 💾 **In-Browser SQLite**: Executes database queries using `sql.js` (SQLite compiled to WebAssembly) entirely client-side.
- 🔄 **Persistent Storage**: Serializes and caches the SQLite database file in browser **IndexedDB** so index states persist across page reloads.
- 🔍 **Substring Search**: Performs parameter-bound search matches using SQL `LIKE` clauses (e.g. `WHERE name LIKE '%23456789%'`).
- 💻 **SQL Query Console**: An interactive editor allowing you to write, test, and render custom SQLite read/write queries.
- ⚡ **Apps Script Synchronization**: Bypasses complex user OAuth setups by running a lightweight Apps Script proxy web app to fetch folder lists.
- 🎨 **Futuristic Dashboard**: A responsive, modern dark UI styled with CSS variables and glassmorphism.

---

## File Structure

```text
├── index.html   # Main application interface and CDN resource loading
├── style.css    # Responsive styles and glassmorphism design system
├── app.js       # Core application, SQLite WASM, IndexedDB, and Sync logic
└── README.md    # Project documentation and setup guide
```

---

## Getting Started

### 1. Run the Web Server Locally
Since the application uses WebAssembly (`sql.js`), it needs to be served via an HTTP server. Run one of the following commands in the project directory:

**Using Python:**
```bash
python -m http.server 8000
```

**Using Node.js:**
```bash
npx http-server -p 8000
```

Once running, navigate to **[http://localhost:8000](http://localhost:8000)** in your browser.

### 2. Verify Using Demo Data
1. Open the page and click **Load Demo Data** in the top bar.
2. This loads 55 pre-fabricated mock folders and documents, including search elements like `+91123456789.xlsx` and `customer_list_23456789.csv`.
3. In the search bar, type a substring such as `23456789`. You will immediately see matching files filtered.
4. Try writing a custom query in the **SQL Console** tab, e.g.:
   ```sql
   SELECT extension, COUNT(*) as count FROM files GROUP BY extension ORDER BY count DESC;
   ```

---

## Google Apps Script Setup Guide

To index and search your actual Google Drive folders, you will deploy a Google Apps Script that returns folder metadata as a JSON structure.

### Step 1: Create a Script
- Open [script.google.com](https://script.google.com) and click **New Project**.
- Delete any template code and paste the script below:

```javascript
function doGet(e) {
  var folderId = e.parameter.id;
  if (!folderId) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: "Missing 'id' parameter specifying the Google Drive Folder ID."
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  try {
    var folder = DriveApp.getFolderById(folderId);
    var filesList = [];
    
    function getFiles(parentFolder, currentPath) {
      // Fetch files
      var files = parentFolder.getFiles();
      while (files.hasNext()) {
        var file = files.next();
        var name = file.getName();
        var dotIndex = name.lastIndexOf('.');
        var ext = dotIndex !== -1 ? name.substring(dotIndex + 1).toLowerCase() : '';
        filesList.push({
          id: file.getId(),
          name: name,
          mimeType: file.getMimeType(),
          extension: ext,
          modifiedDate: file.getLastUpdated().toISOString(),
          url: file.getUrl(),
          path: currentPath ? currentPath + '/' + name : name,
          size: file.getSize()
        });
      }
      
      // Fetch subfolders recursively
      var subfolders = parentFolder.getFolders();
      while (subfolders.hasNext()) {
        var subfolder = subfolders.next();
        var subfolderPath = currentPath ? currentPath + '/' + subfolder.getName() : subfolder.getName();
        getFiles(subfolder, subfolderPath);
      }
    }
    
    getFiles(folder, '');
    
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      files: filesList
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}
```

### Step 2: Deploy as Web App
1. Click **Deploy** > **New deployment** (top right).
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill out the configuration:
   - **Description**: G-Drive Indexer API
   - **Execute as**: `Me (your-email@gmail.com)`
   - **Who has access**: `Anyone` *(Note: This allows the client-side JavaScript request to contact the endpoint directly without authentication headers, bypassing preflight CORS blocks).*
4. Click **Deploy**. Authorize Google permissions if prompted.
5. Copy the generated **Web App URL** (e.g. `https://script.google.com/macros/s/.../exec`).

### Step 3: Synchronize folders
1. In the web app interface, navigate to **Setup & Sync**.
2. Paste the **Apps Script Web App URL** in the configuration panel.
3. Enter your Google Drive Folder URL or Folder ID.
4. Click **Fetch & Sync Now**. The Sync Process Console will output status updates. Once complete, you can search all nested files in the **Search Files** panel.

---

## SQLite Database Schema

The index is loaded into a local SQLite memory space using the following table schema:

```sql
CREATE TABLE files (
  id TEXT PRIMARY KEY,       -- Google Drive unique item ID
  name TEXT,                 -- Base filename or folder name
  mime_type TEXT,            -- Google Drive Mime type
  extension TEXT,            -- Lowercase extension (e.g. 'xlsx', 'pdf')
  modified_date TEXT,        -- ISO UTC timestamp
  url TEXT,                  -- Direct Drive URL
  path TEXT,                 -- Relative path from the root sync folder
  size INTEGER               -- File size in bytes
);

CREATE INDEX idx_files_name ON files(name);
CREATE INDEX idx_files_ext ON files(extension);
```
