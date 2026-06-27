// Global application state
let SQL = null;
let db = null;
let currentActiveTypeFilter = 'all';

// IndexedDB Configuration
const IDB_NAME = 'GDriveSqliteBrowserStore';
const IDB_STORE = 'sqlite_db';
const IDB_KEY = 'database_file';

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  initUI();
  await initSQLite();
  loadSavedSettings();
});

// Initialize UI Interactions (Tabs, copy buttons, logs etc)
function initUI() {
  // Navigation tabs switching
  const navItems = document.querySelectorAll('.nav-item');
  const panels = document.querySelectorAll('.tab-panel');
  const pageTitle = document.getElementById('page-title');
  
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tabId = item.getAttribute('data-tab');
      
      // Update sidebar nav states
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      
      // Show correct tab panel
      panels.forEach(p => p.classList.remove('active'));
      document.getElementById(tabId).classList.add('active');
      
      // Update top header title
      if (tabId === 'tab-search') pageTitle.textContent = 'Search Indexed Files';
      if (tabId === 'tab-sql') pageTitle.textContent = 'SQLite Raw SQL Console';
      if (tabId === 'tab-sync') pageTitle.textContent = 'Setup & Google Drive Sync';
    });
  });

  // Search input events
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', debounce(() => {
    refreshSearchResults();
  }, 150));

  // Checkbox and select events
  document.getElementById('chk-case').addEventListener('change', refreshSearchResults);
  document.getElementById('chk-folders').addEventListener('change', (e) => {
    if (e.target.checked) {
      document.getElementById('chk-files').checked = false;
    }
    refreshSearchResults();
  });
  document.getElementById('chk-files').addEventListener('change', (e) => {
    if (e.target.checked) {
      document.getElementById('chk-folders').checked = false;
    }
    refreshSearchResults();
  });
  document.getElementById('select-sort').addEventListener('change', refreshSearchResults);

  // Type Tag Filters
  const tagBtns = document.querySelectorAll('.tag-btn');
  tagBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tagBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentActiveTypeFilter = btn.getAttribute('data-type');
      refreshSearchResults();
    });
  });

  // Action Buttons
  document.getElementById('btn-run-sql').addEventListener('click', runRawSql);
  document.getElementById('btn-load-demo').addEventListener('click', loadDemoDataset);
  document.getElementById('btn-clear-db').addEventListener('click', resetDatabase);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-sync-now').addEventListener('click', syncGoogleDrive);
  document.getElementById('clear-logs').addEventListener('click', () => {
    document.getElementById('sync-logs-body').innerHTML = '<div class="log-item info">Console cleared.</div>';
  });

  // Script copy button
  document.getElementById('btn-copy-script').addEventListener('click', () => {
    const code = document.getElementById('script-code-block').innerText;
    navigator.clipboard.writeText(code).then(() => {
      const copyBtn = document.getElementById('btn-copy-script');
      copyBtn.innerText = 'Copied!';
      copyBtn.style.backgroundColor = 'var(--success)';
      copyBtn.style.color = '#fff';
      setTimeout(() => {
        copyBtn.innerText = 'Copy Code';
        copyBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
        copyBtn.style.color = 'var(--text-secondary)';
      }, 2000);
    });
  });

  // Modal Actions
  const modal = document.getElementById('details-modal');
  document.getElementById('modal-close-btn').addEventListener('click', () => modal.style.display = 'none');
  document.getElementById('modal-done-btn').addEventListener('click', () => modal.style.display = 'none');
  window.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });

  // Add SQL query template click listeners
  const suggestionItems = document.querySelectorAll('.suggestion-item');
  suggestionItems.forEach(item => {
    item.addEventListener('click', () => {
      const sqlText = item.getAttribute('data-query');
      document.getElementById('sql-editor').value = sqlText;
      runRawSql();
    });
  });
}

// Initialize SQLite Engine
async function initSQLite() {
  updateStatus('loading', 'SQLite Loading...');
  try {
    // Locate the WASM file on the same CDN version
    SQL = await initSqlJs({
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
    });
    
    // Load database from IndexedDB
    const savedBinary = await loadDbFromIndexedDB();
    if (savedBinary) {
      db = new SQL.Database(savedBinary);
      logToSyncConsole('Loaded existing database state from browser storage.');
    } else {
      db = new SQL.Database();
      createDatabaseSchema();
      logToSyncConsole('Initialized empty SQLite database.');
      await saveDatabaseToStore();
    }
    
    updateStatus('online', 'SQLite Ready');
    updateStats();
    refreshSearchResults();
  } catch (err) {
    updateStatus('offline', 'SQLite Error');
    console.error(err);
    logToSyncConsole(`SQLite Initialization Error: ${err.message}`, 'error');
  }
}

// IndexedDB Helper Operations
function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
  });
}

async function saveDatabaseToStore() {
  if (!db) return;
  try {
    const binaryData = db.export(); // Export sqlite to Uint8Array
    const idb = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const transaction = idb.transaction(IDB_STORE, 'readwrite');
      const store = transaction.objectStore(IDB_STORE);
      const request = store.put(binaryData, IDB_KEY);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Failed to store SQLite database in IndexedDB', err);
  }
}

async function loadDbFromIndexedDB() {
  try {
    const idb = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const transaction = idb.transaction(IDB_STORE, 'readonly');
      const store = transaction.objectStore(IDB_STORE);
      const request = store.get(IDB_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Failed to retrieve SQLite database from IndexedDB', err);
    return null;
  }
}

// Database Schema creation
function createDatabaseSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT,
      mime_type TEXT,
      extension TEXT,
      modified_date TEXT,
      url TEXT,
      path TEXT,
      size INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
    CREATE INDEX IF NOT EXISTS idx_files_ext ON files(extension);
  `);
}

// Update DB Status badge in sidebar
function updateStatus(state, text) {
  const dot = document.getElementById('db-status-dot');
  const textEl = document.getElementById('db-status-text');
  
  dot.className = 'status-dot';
  if (state === 'online') dot.classList.add('online');
  if (state === 'loading') dot.classList.add('loading');
  if (state === 'offline') dot.classList.add('offline');
  
  textEl.textContent = text;
}

// Update File count and DB Size Stats
function updateStats() {
  if (!db) return;
  try {
    // Fetch Count
    const countRes = db.exec("SELECT COUNT(*) FROM files");
    const count = countRes[0].values[0][0];
    document.getElementById('stat-count').textContent = count.toLocaleString();
    
    // Estimate size based on exported byte array
    const binary = db.export();
    const sizeKB = (binary.length / 1024).toFixed(1);
    document.getElementById('stat-size').textContent = `${sizeKB} KB`;
    
    // Last Sync Date
    const lastSync = localStorage.getItem('gdrive_last_sync_time') || 'Never';
    document.getElementById('stat-sync').textContent = lastSync;
  } catch (err) {
    console.error('Error updating stats:', err);
  }
}

// Load configurations from LocalStorage
function loadSavedSettings() {
  const scriptUrl = localStorage.getItem('gdrive_sync_script_url') || '';
  const folderUrl = localStorage.getItem('gdrive_sync_folder_url') || 'https://drive.google.com/drive/folders/1Cc0BLV_SdNnmM6esqsPu4ZuapGD3nCSq';
  
  document.getElementById('sync-script-url').value = scriptUrl;
  document.getElementById('sync-folder-url').value = folderUrl;
}

// Save config inputs to LocalStorage
function saveSettings() {
  const scriptUrl = document.getElementById('sync-script-url').value.trim();
  const folderUrl = document.getElementById('sync-folder-url').value.trim();
  
  localStorage.setItem('gdrive_sync_script_url', scriptUrl);
  localStorage.setItem('gdrive_sync_folder_url', folderUrl);
  
  logToSyncConsole('Configuration settings saved successfully.', 'success');
  alert('Settings saved!');
}

// Reset SQLite database entirely
async function resetDatabase() {
  if (!confirm('Are you sure you want to clear all data and reset the SQLite database?')) return;
  
  try {
    db = new SQL.Database();
    createDatabaseSchema();
    localStorage.removeItem('gdrive_last_sync_time');
    await saveDatabaseToStore();
    
    updateStats();
    refreshSearchResults();
    logToSyncConsole('Database has been fully reset.', 'warn');
    alert('Database reset complete!');
  } catch (err) {
    console.error(err);
    alert('Error resetting database: ' + err.message);
  }
}

// Write to Sync logs terminal
function logToSyncConsole(message, type = 'info') {
  const consoleEl = document.getElementById('sync-logs-body');
  const timestamp = new Date().toLocaleTimeString();
  const logDiv = document.createElement('div');
  logDiv.className = `log-item ${type}`;
  logDiv.innerHTML = `<span style="color: var(--text-muted)">[${timestamp}]</span> ${message}`;
  consoleEl.appendChild(logDiv);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

// Extract Google Drive folder ID from URL
function extractFolderId(input) {
  const trimmed = input.trim();
  // Regex to extract from drive.google.com/drive/folders/... or drive.google.com/drive/u/0/folders/...
  const match = /\/folders\/([a-zA-Z0-9-_]{25,})/.exec(trimmed);
  if (match && match[1]) {
    return match[1];
  }
  return trimmed; // Return raw string if it doesn't match URL pattern
}

// Main Google Drive Sync Logic (GET to Apps Script)
async function syncGoogleDrive() {
  const scriptUrl = document.getElementById('sync-script-url').value.trim();
  const folderInput = document.getElementById('sync-folder-url').value.trim();
  
  if (!scriptUrl) {
    alert('Please provide a Google Apps Script Web App URL first.');
    // Focus and switch to settings tab
    document.querySelector('[data-tab="tab-sync"]').click();
    document.getElementById('sync-script-url').focus();
    return;
  }
  
  const folderId = extractFolderId(folderInput);
  if (!folderId) {
    alert('Please enter a valid Google Drive Folder URL or Folder ID.');
    return;
  }

  const syncBtn = document.getElementById('btn-sync-now');
  const originalHtml = syncBtn.innerHTML;
  
  try {
    // Disable UI
    syncBtn.disabled = true;
    syncBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Syncing...';
    updateStatus('loading', 'Syncing Drive...');
    
    logToSyncConsole(`Starting Google Drive fetch for Folder ID: ${folderId}`);
    logToSyncConsole(`Connecting to Apps Script: ${scriptUrl.substring(0, 45)}...`);
    
    const requestUrl = `${scriptUrl}?id=${encodeURIComponent(folderId)}`;
    
    const response = await fetch(requestUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    logToSyncConsole('Apps Script execution completed. Parsing results...');
    const result = await response.json();
    
    if (!result.success) {
      throw new Error(result.error || 'Unknown error occurred in Google Apps Script');
    }
    
    const files = result.files || [];
    logToSyncConsole(`Retrieved ${files.length} nested files/folders. Writing to SQLite database...`, 'success');
    
    // Bulk insert files
    db.run("BEGIN TRANSACTION;");
    db.run("DELETE FROM files;"); // Clear old records
    
    const stmt = db.prepare(`
      INSERT INTO files (id, name, mime_type, extension, modified_date, url, path, size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    for (const f of files) {
      stmt.run([
        f.id,
        f.name,
        f.mimeType,
        f.extension || '',
        f.modifiedDate,
        f.url || '',
        f.path || '',
        f.size !== null && f.size !== undefined ? f.size : 0
      ]);
    }
    
    stmt.free();
    db.run("COMMIT;");
    
    // Log Sync complete time
    const syncTimeStr = new Date().toLocaleString();
    localStorage.setItem('gdrive_last_sync_time', syncTimeStr);
    
    // Save to IndexedDB
    await saveDatabaseToStore();
    
    logToSyncConsole(`Database synchronized successfully! ${files.length} records active.`, 'success');
    updateStatus('online', 'SQLite Ready');
    updateStats();
    refreshSearchResults();
    alert(`Sync completed! Loaded ${files.length} items.`);
  } catch (err) {
    console.error(err);
    logToSyncConsole(`Sync failed: ${err.message}`, 'error');
    updateStatus('online', 'SQLite Ready');
    alert(`Sync failed: ${err.message}\nMake sure your Web App URL is correctly deployed for 'Anyone' access.`);
  } finally {
    syncBtn.disabled = false;
    syncBtn.innerHTML = originalHtml;
  }
}

// Refresh results on UI based on inputs
function refreshSearchResults() {
  if (!db) return;
  
  const searchInput = document.getElementById('search-input').value.trim();
  const caseSensitive = document.getElementById('chk-case').checked;
  const foldersOnly = document.getElementById('chk-folders').checked;
  const filesOnly = document.getElementById('chk-files').checked;
  const sortVal = document.getElementById('select-sort').value;
  
  // Set case sensitivity for LIKE
  db.run(`PRAGMA case_sensitive_like = ${caseSensitive ? 'ON' : 'OFF'};`);
  
  // Construct Query
  let query = "SELECT * FROM files WHERE 1=1";
  const bindings = {};
  
  // Tag Filter OR Checkbox Filter
  if (currentActiveTypeFilter === 'folders' || foldersOnly) {
    query += " AND mime_type = 'application/vnd.google-apps.folder'";
  } else if (filesOnly) {
    query += " AND mime_type != 'application/vnd.google-apps.folder'";
    
    // Add extension filters if a tag filter is clicked
    if (currentActiveTypeFilter === 'pdf') {
      query += " AND extension = 'pdf'";
    } else if (currentActiveTypeFilter === 'xls') {
      query += " AND extension IN ('xls', 'xlsx', 'csv')";
    } else if (currentActiveTypeFilter === 'doc') {
      query += " AND extension IN ('doc', 'docx', 'rtf', 'gdoc')";
    } else if (currentActiveTypeFilter === 'img') {
      query += " AND extension IN ('png', 'jpg', 'jpeg', 'gif', 'svg', 'webp')";
    } else if (currentActiveTypeFilter === 'zip') {
      query += " AND extension IN ('zip', 'tar', 'gz', 'rar', '7z')";
    }
  } else {
    // If "All Types" is selected but "folders only" / "files only" are not toggled,
    // match tag buttons
    if (currentActiveTypeFilter === 'pdf') {
      query += " AND extension = 'pdf'";
    } else if (currentActiveTypeFilter === 'xls') {
      query += " AND extension IN ('xls', 'xlsx', 'csv')";
    } else if (currentActiveTypeFilter === 'doc') {
      query += " AND extension IN ('doc', 'docx', 'gdoc')";
    } else if (currentActiveTypeFilter === 'img') {
      query += " AND extension IN ('png', 'jpg', 'jpeg', 'gif', 'svg')";
    } else if (currentActiveTypeFilter === 'zip') {
      query += " AND extension IN ('zip', 'tar', 'gz', 'rar', '7z')";
    }
  }
  
  // Search query substring
  if (searchInput) {
    query += " AND name LIKE :searchTerm";
    bindings[':searchTerm'] = `%${searchInput}%`;
  }
  
  // Sort Values
  if (sortVal === 'name-asc') {
    query += " ORDER BY name COLLATE NOCASE ASC";
  } else if (sortVal === 'name-desc') {
    query += " ORDER BY name COLLATE NOCASE DESC";
  } else if (sortVal === 'date-desc') {
    query += " ORDER BY modified_date DESC";
  } else if (sortVal === 'date-asc') {
    query += " ORDER BY modified_date ASC";
  } else if (sortVal === 'size-desc') {
    query += " ORDER BY size DESC";
  } else if (sortVal === 'size-asc') {
    query += " ORDER BY size ASC";
  }
  
  // Execute Search
  try {
    const res = db.exec(query, bindings);
    renderResults(res);
  } catch (err) {
    console.error('Search query execution error:', err);
  }
}

// Render SQL Query output inside Search View table
function renderResults(res) {
  const tbody = document.getElementById('search-results-body');
  tbody.innerHTML = '';
  
  if (res.length === 0 || res[0].values.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="no-results">
            <i class="fa-solid fa-magnifying-glass-minus"></i>
            <p>No matching files or folders found.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }
  
  const columns = res[0].columns;
  const values = res[0].values;
  
  // Map index for each column name
  const idIdx = columns.indexOf('id');
  const nameIdx = columns.indexOf('name');
  const mimeIdx = columns.indexOf('mime_type');
  const extIdx = columns.indexOf('extension');
  const dateIdx = columns.indexOf('modified_date');
  const urlIdx = columns.indexOf('url');
  const pathIdx = columns.indexOf('path');
  const sizeIdx = columns.indexOf('size');
  
  values.forEach(row => {
    const id = row[idIdx];
    const name = row[nameIdx];
    const mime = row[mimeIdx];
    const ext = row[extIdx] || '';
    const date = row[dateIdx];
    const url = row[urlIdx];
    const path = row[pathIdx];
    const size = row[sizeIdx];
    
    const isFolder = mime === 'application/vnd.google-apps.folder';
    const extClass = getBadgeClass(ext, isFolder);
    const fileIcon = getFileIcon(ext, isFolder);
    
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="file-name-cell">
          <div class="file-icon" style="color: ${fileIcon.color}">
            <i class="${fileIcon.icon}"></i>
          </div>
          <div>
            <div style="font-weight: 600; font-size: 0.95rem;">${escapeHtml(name)}</div>
            <div class="file-path" title="${escapeHtml(path)}">${escapeHtml(path || name)}</div>
          </div>
        </div>
      </td>
      <td><span class="file-path">${escapeHtml(path || '/')}</span></td>
      <td>
        <span class="ext-badge ${extClass}">
          ${isFolder ? 'folder' : (ext || 'file')}
        </span>
      </td>
      <td class="file-date">${formatDate(date)}</td>
      <td class="file-size">${isFolder ? '-' : formatBytes(size)}</td>
      <td>
        <div style="display: flex; gap: 12px; align-items: center;">
          ${url ? `<a href="${url}" target="_blank" class="open-link"><i class="fa-solid fa-external-link-alt"></i> Open</a>` : ''}
          <a href="#" class="open-link view-details-link" data-id="${id}"><i class="fa-solid fa-circle-info"></i> Info</a>
        </div>
      </td>
    `;
    
    // Bind Details link
    tr.querySelector('.view-details-link').addEventListener('click', (e) => {
      e.preventDefault();
      showFileDetails(id);
    });
    
    tbody.appendChild(tr);
  });
}

// Return Badge styling class based on file extension
function getBadgeClass(ext, isFolder) {
  if (isFolder) return 'ext-folder';
  if (ext === 'pdf') return 'ext-pdf';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'ext-xls';
  if (['doc', 'docx', 'gdoc', 'rtf'].includes(ext)) return 'ext-doc';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'ext-img';
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return 'ext-zip';
  return 'ext-other';
}

// Return FontAwesome Icon and Color based on extension
function getFileIcon(ext, isFolder) {
  if (isFolder) {
    return { icon: 'fa-solid fa-folder-open', color: '#f59e0b' };
  }
  if (ext === 'pdf') {
    return { icon: 'fa-solid fa-file-pdf', color: '#ef4444' };
  }
  if (['xls', 'xlsx', 'csv'].includes(ext)) {
    return { icon: 'fa-solid fa-file-excel', color: '#10b981' };
  }
  if (['doc', 'docx', 'gdoc'].includes(ext)) {
    return { icon: 'fa-solid fa-file-word', color: '#3b82f6' };
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
    return { icon: 'fa-solid fa-file-image', color: '#8b5cf6' };
  }
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) {
    return { icon: 'fa-solid fa-file-zipper', color: '#ec4899' };
  }
  return { icon: 'fa-solid fa-file-lines', color: '#94a3b8' };
}

// Display File Details Modal
function showFileDetails(fileId) {
  if (!db) return;
  try {
    const res = db.exec("SELECT * FROM files WHERE id = :id", { ':id': fileId });
    if (res.length === 0 || res[0].values.length === 0) return;
    
    const file = {};
    res[0].columns.forEach((col, idx) => {
      file[col] = res[0].values[0][idx];
    });
    
    const modal = document.getElementById('details-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalBody = document.getElementById('modal-body-content');
    
    modalTitle.textContent = file.mime_type === 'application/vnd.google-apps.folder' ? 'Folder Information' : 'File Information';
    
    modalBody.innerHTML = `
      <div class="detail-row">
        <div class="detail-label">Name</div>
        <div class="detail-value" style="font-weight: 600;">${escapeHtml(file.name)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Relative Path</div>
        <div class="detail-value mono">${escapeHtml(file.path || '/')}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Mime Type</div>
        <div class="detail-value mono" style="font-size: 0.75rem;">${escapeHtml(file.mime_type)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Extension</div>
        <div class="detail-value mono">${escapeHtml(file.extension || 'None')}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Modified Date</div>
        <div class="detail-value mono">${formatDate(file.modified_date)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Size</div>
        <div class="detail-value mono">${file.mime_type === 'application/vnd.google-apps.folder' ? 'Directory' : formatBytes(file.size)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Google Drive ID</div>
        <div class="detail-value mono" style="font-size: 0.75rem;">${file.id}</div>
      </div>
      ${file.url ? `
      <div class="detail-row" style="border-bottom: none; margin-top: 8px;">
        <div class="detail-label">Web View Link</div>
        <div class="detail-value">
          <a href="${file.url}" target="_blank" style="color: var(--accent-primary); text-decoration: none; font-weight: 500;">
            Open in Google Drive <i class="fa-solid fa-external-link-alt" style="font-size: 0.75rem;"></i>
          </a>
        </div>
      </div>` : ''}
    `;
    
    modal.style.display = 'flex';
  } catch (err) {
    console.error(err);
    alert('Error loading file details: ' + err.message);
  }
}

// Run SQL command from editor
function runRawSql() {
  if (!db) return;
  const sql = document.getElementById('sql-editor').value.trim();
  const errorBox = document.getElementById('sql-error');
  const head = document.getElementById('sql-results-head');
  const tbody = document.getElementById('sql-results-body');
  
  errorBox.style.display = 'none';
  errorBox.textContent = '';
  
  if (!sql) {
    tbody.innerHTML = '<tr><td>Write a query and click Execute.</td></tr>';
    return;
  }
  
  try {
    const res = db.exec(sql);
    
    if (res.length === 0) {
      // Query completed, no results returned (e.g. UPDATE, INSERT, CREATE)
      head.innerHTML = '<tr><th>Status</th></tr>';
      tbody.innerHTML = `
        <tr>
          <td>
            <div class="text-success" style="display: flex; align-items: center; gap: 8px; font-weight: 500;">
              <i class="fa-solid fa-circle-check"></i>
              Query executed successfully. No rows returned.
            </div>
          </td>
        </tr>
      `;
      
      // Update sizes/counts in background since write queries may change database content
      updateStats();
      saveDatabaseToStore();
      return;
    }
    
    // Render Results table
    const columns = res[0].columns;
    const values = res[0].values;
    
    // Render Headers
    head.innerHTML = '';
    const trHead = document.createElement('tr');
    columns.forEach(col => {
      const th = document.createElement('th');
      th.textContent = col;
      trHead.appendChild(th);
    });
    head.appendChild(trHead);
    
    // Render Rows
    tbody.innerHTML = '';
    values.forEach(row => {
      const tr = document.createElement('tr');
      row.forEach(val => {
        const td = document.createElement('td');
        // Treat null values
        if (val === null) {
          td.innerHTML = '<span style="color: var(--text-muted); font-style: italic;">NULL</span>';
        } else {
          td.textContent = val;
        }
        td.style.fontFamily = 'var(--font-mono)';
        td.style.fontSize = '0.85rem';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.style.display = 'block';
  }
}

// Generate beautiful Mock/Demo files for immediate testing
async function loadDemoDataset() {
  if (!db) return;
  if (!confirm('This will load a demo dataset of 55 mock files/folders. Proceed?')) return;
  
  try {
    logToSyncConsole('Loading pre-fabricated mock dataset of files...');
    
    db.run("BEGIN TRANSACTION;");
    db.run("DELETE FROM files;");
    
    const now = new Date();
    
    // Mock files listing
    const mockFiles = [
      // Folders
      { id: 'fol_1', name: 'Work Documents', mimeType: 'application/vnd.google-apps.folder', url: 'https://drive.google.com/drive/folders/demo1', path: 'Work Documents', modified: subDays(now, 2) },
      { id: 'fol_2', name: 'Personal Receipts', mimeType: 'application/vnd.google-apps.folder', url: 'https://drive.google.com/drive/folders/demo2', path: 'Personal Receipts', modified: subDays(now, 5) },
      { id: 'fol_3', name: 'Database Backups', mimeType: 'application/vnd.google-apps.folder', url: 'https://drive.google.com/drive/folders/demo3', path: 'Database Backups', modified: subDays(now, 1) },
      { id: 'fol_4', name: 'Archive 2025', mimeType: 'application/vnd.google-apps.folder', url: 'https://drive.google.com/drive/folders/demo4', path: 'Work Documents/Archive 2025', modified: subDays(now, 120) },
      { id: 'fol_5', name: 'Images & Design', mimeType: 'application/vnd.google-apps.folder', url: 'https://drive.google.com/drive/folders/demo5', path: 'Work Documents/Images & Design', modified: subDays(now, 10) },
      
      // Target Search Mock Files (containing +91123456789 variations)
      { id: 'f_1', name: '+91123456789.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', url: 'https://drive.google.com/file/d/demo_f1', path: 'Work Documents/+91123456789.xlsx', size: 48900, modified: subDays(now, 1) },
      { id: 'f_2', name: 'customer_list_23456789.csv', mimeType: 'text/csv', url: 'https://drive.google.com/file/d/demo_f2', path: 'Work Documents/customer_list_23456789.csv', size: 104500, modified: subDays(now, 3) },
      { id: 'f_3', name: 'leads_91123456789.pdf', mimeType: 'application/pdf', url: 'https://drive.google.com/file/d/demo_f3', path: 'Work Documents/leads_91123456789.pdf', size: 1204000, modified: subDays(now, 4) },
      { id: 'f_4', name: 'Invoice-10023456789.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', url: 'https://drive.google.com/file/d/demo_f4', path: 'Work Documents/Archive 2025/Invoice-10023456789.docx', size: 94000, modified: subDays(now, 110) },
      { id: 'f_5', name: 'phone_contacts_234567890.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', url: 'https://drive.google.com/file/d/demo_f5', path: 'Work Documents/phone_contacts_234567890.xlsx', size: 32000, modified: subDays(now, 2) },
      
      // Standard PDFs
      { id: 'f_6', name: 'Q1_Financial_Report.pdf', mimeType: 'application/pdf', url: 'https://drive.google.com/file/d/demo_f6', path: 'Work Documents/Q1_Financial_Report.pdf', size: 2450000, modified: subDays(now, 15) },
      { id: 'f_7', name: 'Employment_Agreement_Final.pdf', mimeType: 'application/pdf', url: 'https://drive.google.com/file/d/demo_f7', path: 'Work Documents/Employment_Agreement_Final.pdf', size: 450000, modified: subDays(now, 45) },
      { id: 'f_8', name: 'Google_Cloud_Arch_Specs.pdf', mimeType: 'application/pdf', url: 'https://drive.google.com/file/d/demo_f8', path: 'Work Documents/Google_Cloud_Arch_Specs.pdf', size: 4890000, modified: subDays(now, 6) },
      
      // Spreadsheet/CSV Files
      { id: 'f_9', name: 'Budget_Planning_2026.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', url: 'https://drive.google.com/file/d/demo_f9', path: 'Work Documents/Budget_Planning_2026.xlsx', size: 180000, modified: subDays(now, 0) },
      { id: 'f_10', name: 'User_Logs_June.csv', mimeType: 'text/csv', url: 'https://drive.google.com/file/d/demo_f10', path: 'Database Backups/User_Logs_June.csv', size: 8500400, modified: subDays(now, 0.5) },
      { id: 'f_11', name: 'Marketing_Campaign_ROI.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', url: 'https://drive.google.com/file/d/demo_f11', path: 'Work Documents/Marketing_Campaign_ROI.xlsx', size: 145000, modified: subDays(now, 8) },
      
      // Text and Docs
      { id: 'f_12', name: 'Project_Outline.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', url: 'https://drive.google.com/file/d/demo_f12', path: 'Work Documents/Project_Outline.docx', size: 85000, modified: subDays(now, 9) },
      { id: 'f_13', name: 'todo_list.txt', mimeType: 'text/plain', url: 'https://drive.google.com/file/d/demo_f13', path: 'todo_list.txt', size: 1024, modified: now },
      { id: 'f_14', name: 'API_Key_Secret_DoNotShare.txt', mimeType: 'text/plain', url: 'https://drive.google.com/file/d/demo_f14', path: 'API_Key_Secret_DoNotShare.txt', size: 512, modified: subDays(now, 30) },
      
      // Images
      { id: 'f_15', name: 'App_Logo_Dark.png', mimeType: 'image/png', url: 'https://drive.google.com/file/d/demo_f15', path: 'Work Documents/Images & Design/App_Logo_Dark.png', size: 45000, modified: subDays(now, 11) },
      { id: 'f_16', name: 'Banner_Background.jpg', mimeType: 'image/jpeg', url: 'https://drive.google.com/file/d/demo_f16', path: 'Work Documents/Images & Design/Banner_Background.jpg', size: 1204000, modified: subDays(now, 10) },
      { id: 'f_17', name: 'User_Avatar_Divesh.webp', mimeType: 'image/webp', url: 'https://drive.google.com/file/d/demo_f17', path: 'User_Avatar_Divesh.webp', size: 18000, modified: subDays(now, 35) },
      
      // Zips and Archive
      { id: 'f_18', name: 'source_code_backup.zip', mimeType: 'application/zip', url: 'https://drive.google.com/file/d/demo_f18', path: 'Database Backups/source_code_backup.zip', size: 45890000, modified: subDays(now, 1) },
      { id: 'f_19', name: 'Tax_Receipts_2024.tar.gz', mimeType: 'application/gzip', url: 'https://drive.google.com/file/d/demo_f19', path: 'Personal Receipts/Tax_Receipts_2024.tar.gz', size: 8900000, modified: subDays(now, 140) }
    ];
    
    // Add extra 35 files dynamically to make list complete and interesting
    for (let i = 1; i <= 35; i++) {
      const ext = ['pdf', 'xlsx', 'docx', 'png', 'zip', 'csv', 'txt'][Math.floor(Math.random() * 7)];
      const mime = getMimeFromExt(ext);
      const randSize = Math.floor(Math.random() * 2500000) + 120;
      const randDays = (Math.random() * 90).toFixed(2);
      const name = `asset_document_0${i}.${ext}`;
      
      mockFiles.push({
        id: `f_extra_${i}`,
        name: name,
        mimeType: mime,
        url: `https://drive.google.com/file/d/demo_f_extra_${i}`,
        path: `Work Documents/Archive 2025/${name}`,
        size: randSize,
        modified: subDays(now, parseFloat(randDays))
      });
    }
    
    const stmt = db.prepare(`
      INSERT INTO files (id, name, mime_type, extension, modified_date, url, path, size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    for (const f of mockFiles) {
      const dotIndex = f.name.lastIndexOf('.');
      const ext = f.mimeType === 'application/vnd.google-apps.folder' ? '' : (dotIndex !== -1 ? f.name.substring(dotIndex + 1).toLowerCase() : '');
      stmt.run([
        f.id,
        f.name,
        f.mimeType,
        ext,
        f.modified.toISOString(),
        f.url,
        f.path,
        f.mimeType === 'application/vnd.google-apps.folder' ? 0 : f.size
      ]);
    }
    
    stmt.free();
    db.run("COMMIT;");
    
    const syncTimeStr = new Date().toLocaleString();
    localStorage.setItem('gdrive_last_sync_time', syncTimeStr);
    
    // Save to IndexedDB
    await saveDatabaseToStore();
    
    logToSyncConsole(`Loaded ${mockFiles.length} demo records into database.`, 'success');
    updateStats();
    refreshSearchResults();
    alert(`Demo dataset of ${mockFiles.length} files successfully loaded into the browser SQLite database!`);
  } catch (err) {
    console.error(err);
    alert('Error loading demo data: ' + err.message);
  }
}

// Date offset helper
function subDays(date, days) {
  const result = new Date(date);
  result.setMilliseconds(result.getMilliseconds() - (days * 24 * 60 * 60 * 1000));
  return result;
}

// Ext helper for demo data generator
function getMimeFromExt(ext) {
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'png': return 'image/png';
    case 'zip': return 'application/zip';
    case 'csv': return 'text/csv';
    case 'txt': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

// Format bytes size to readable units
function formatBytes(bytes) {
  if (bytes === 0 || bytes === null || bytes === undefined) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Format ISO modified date to readable local string
function formatDate(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  } catch (e) {
    return isoString;
  }
}

// Escape HTML utility to prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Debounce search inputs to avoid heavy database re-queries on rapid typing
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
