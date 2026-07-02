# Google Drive SQLite Searcher & Indexer

A client-side web application designed to recursively index Google Drive folders, store their metadata (names, paths, modified dates, sizes) inside a local WebAssembly-backed SQLite database, and run advanced substring (`LIKE`) and raw SQL queries directly in the browser.

This project solves the limitation of default Google Drive search, which fails on arbitrary substring matches (such as searching `23456789` to find a file named `+91123456789.xlsx`).

---

## Key Features

- 📁 **Deep Recursive Traversal**: Indexes nested files and subfolders down to arbitrary depths.
- 💾 **In-Browser SQLite**: Executes database queries using `sql.js` (SQLite compiled to WebAssembly) entirely client-side.
- 🔄 **Persistent Storage**: Serializes and caches the SQLite database file in browser **IndexedDB** so index states persist across page reloads.
- 🔍 **Substring Search**: Performs parameter-bound search matches using SQL `LIKE` clauses (e.g. `WHERE name LIKE '%23456789%'`).
- 📅 **Date Range Filter**: Limits search results dynamically based on file modified start and end date boundaries.
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

To index and search your actual Google Drive folders, deploy the **paginated** Google Apps Script below.  
It returns up to 500 files per request and provides a `nextPageToken` so the Django backend can keep fetching until all pages are collected — avoiding Apps Script's 6-minute execution timeout on large folders.

### Step 1: Create a Script
- Open [script.google.com](https://script.google.com) and click **New Project**.
- Delete any template code and paste the script below:

```javascript
/**
 * Paginated GDrive Indexer — v2
 *
 * Query params:
 *   id        (required) Folder ID or full Drive folder URL
 *   pageToken (optional) Continuation token returned by a previous call
 *   pageSize  (optional, default 500) Max files to return per call
 *
 * Response:
 *   { success: true, files: [...], nextPageToken: "<string|null>" }
 */
function doGet(e) {
  var folderId = (e.parameter.id || '').trim();
  // Accept full folder URLs
  var match = folderId.match(/\/folders\/([a-zA-Z0-9_-]{25,})/);
  if (match) folderId = match[1];

  if (!folderId) {
    return json({ success: false, error: "Missing 'id' parameter." });
  }

  var pageSize = parseInt(e.parameter.pageSize, 10) || 500;

  // Decode continuation state or bootstrap fresh
  var state;
  if (e.parameter.pageToken) {
    try {
      state = JSON.parse(Utilities.newBlob(Utilities.base64Decode(e.parameter.pageToken)).getDataAsString());
    } catch (err) {
      return json({ success: false, error: "Invalid pageToken: " + err });
    }
  } else {
    // State: stack of { folderId, path } objects to visit (BFS)
    state = { stack: [{ id: folderId, path: '' }] };
  }

  var filesList = [];

  try {
    while (state.stack.length > 0 && filesList.length < pageSize) {
      var current = state.stack.shift();
      var folder = DriveApp.getFolderById(current.id);

      // --- Files in this folder ---
      var files = folder.getFiles();
      while (files.hasNext() && filesList.length < pageSize) {
        var file = files.next();
        var name = file.getName();
        filesList.push({
          id:           file.getId(),
          name:         name,
          mimeType:     file.getMimeType(),
          modifiedDate: file.getLastUpdated().toISOString(),
          url:          file.getUrl(),
          path:         current.path ? current.path + '/' + name : name,
          size:         file.getSize()
        });
      }

      // --- Queue subfolders ---
      var subfolders = folder.getFolders();
      while (subfolders.hasNext()) {
        var sub = subfolders.next();
        var subPath = current.path ? current.path + '/' + sub.getName() : sub.getName();
        state.stack.push({ id: sub.getId(), path: subPath });

        // Also record the folder itself as an entry
        if (filesList.length < pageSize) {
          filesList.push({
            id:           sub.getId(),
            name:         sub.getName(),
            mimeType:     'application/vnd.google-apps.folder',
            modifiedDate: sub.getLastUpdated().toISOString(),
            url:          sub.getUrl(),
            path:         subPath,
            size:         0
          });
        }
      }
    }

    var nextPageToken = null;
    if (state.stack.length > 0) {
      // More folders remain — encode state as continuation token
      nextPageToken = Utilities.base64Encode(JSON.stringify(state));
    }

    return json({ success: true, files: filesList, nextPageToken: nextPageToken });

  } catch (error) {
    return json({ success: false, error: error.toString() });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

### Step 2: Deploy as Web App
1. Click **Deploy** > **New deployment** (top right).
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill out the configuration:
   - **Description**: G-Drive Indexer API (Paginated)
   - **Execute as**: `Me (your-email@gmail.com)`
   - **Who has access**: `Anyone`
4. Click **Deploy**. Authorize Google permissions if prompted.
5. Copy the generated **Web App URL** (e.g. `https://script.google.com/macros/s/.../exec`).

### Step 3: Trigger a Sync via the API

```bash
curl -X POST http://localhost:8000/api/sync/ \
  -H "Content-Type: application/json" \
  -d '{
    "script_url": "https://script.google.com/macros/s/.../exec",
    "folder_url": "https://drive.google.com/drive/folders/<YOUR_FOLDER_ID>"
  }'
```

**Success response:**
```json
{ "success": true, "count": 4821, "pages": 10, "last_sync": "2026-07-02 18:00:00" }
```

The backend fetches page by page (≤500 files each), accumulates everything, then does a single atomic DB upsert.  
`pages` in the response tells you how many round-trips were made.

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
