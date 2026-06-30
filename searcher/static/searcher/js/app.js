/**
 * G-Drive SQLite Searcher — Django Edition
 * Frontend logic: all data operations are delegated to Django API endpoints.
 * No sql.js, no IndexedDB — persistence is handled server-side.
 */

// -------------------------------------------------------------------------
// CSRF helper (reads token from <meta name="csrf-token">)
// -------------------------------------------------------------------------
function getCsrf() {
  return document.querySelector('meta[name="csrf-token"]').getAttribute('content');
}

async function postJSON(url, data = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': getCsrf(),
    },
    body: JSON.stringify(data),
  });
  return res.json();
}

// -------------------------------------------------------------------------
// App State
// -------------------------------------------------------------------------
let currentActiveTypeFilter = 'all';

// -------------------------------------------------------------------------
// Bootstrap
// -------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  initUI();
  await loadSavedSettings();
  await refreshStats();
  await refreshSearchResults();
});

// -------------------------------------------------------------------------
// UI Wiring (tabs, buttons, listeners — identical logic to original)
// -------------------------------------------------------------------------
function initUI() {
  // Tab navigation
  const navItems = document.querySelectorAll('.nav-item');
  const panels   = document.querySelectorAll('.tab-panel');
  const pageTitle = document.getElementById('page-title');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tabId = item.getAttribute('data-tab');
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      panels.forEach(p => p.classList.remove('active'));
      document.getElementById(tabId).classList.add('active');
      if (tabId === 'tab-search') pageTitle.textContent = 'Search Indexed Files';
      if (tabId === 'tab-sync')   pageTitle.textContent = 'Setup & Google Drive Sync';
    });
  });

  // Search
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', debounce(() => refreshSearchResults(), 200));

  // Checkboxes
  document.getElementById('chk-case').addEventListener('change', refreshSearchResults);
  document.getElementById('chk-folders').addEventListener('change', e => {
    if (e.target.checked) document.getElementById('chk-files').checked = false;
    refreshSearchResults();
  });
  document.getElementById('chk-files').addEventListener('change', e => {
    if (e.target.checked) document.getElementById('chk-folders').checked = false;
    refreshSearchResults();
  });
  document.getElementById('select-sort').addEventListener('change', refreshSearchResults);

  // Date pickers
  document.getElementById('search-start-date').addEventListener('change', refreshSearchResults);
  document.getElementById('search-end-date').addEventListener('change', refreshSearchResults);
  document.getElementById('btn-clear-dates').addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('search-start-date').value = '';
    document.getElementById('search-end-date').value = '';
    refreshSearchResults();
  });

  // Type tag filter buttons
  const tagBtns = document.querySelectorAll('.tag-btn');
  tagBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tagBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentActiveTypeFilter = btn.getAttribute('data-type');
      refreshSearchResults();
    });
  });

  // Action buttons
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-sync-now').addEventListener('click', syncGoogleDrive);
  document.getElementById('clear-logs').addEventListener('click', () => {
    document.getElementById('sync-logs-body').innerHTML = '<div class="log-item info">Console cleared.</div>';
  });

  // Copy script button
  document.getElementById('btn-copy-script').addEventListener('click', () => {
    const code = document.getElementById('script-code-block').innerText;
    navigator.clipboard.writeText(code).then(() => {
      const btn = document.getElementById('btn-copy-script');
      btn.innerText = 'Copied!';
      btn.style.backgroundColor = 'var(--success)';
      btn.style.color = '#fff';
      setTimeout(() => {
        btn.innerText = 'Copy Code';
        btn.style.backgroundColor = 'rgba(255,255,255,0.05)';
        btn.style.color = 'var(--text-secondary)';
      }, 2000);
    });
  });


  // Modal
  const modal = document.getElementById('details-modal');
  document.getElementById('modal-close-btn').addEventListener('click', () => modal.style.display = 'none');
  document.getElementById('modal-done-btn').addEventListener('click',  () => modal.style.display = 'none');
  window.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
}

// -------------------------------------------------------------------------
// Stats — GET /api/stats/
// -------------------------------------------------------------------------
async function refreshStats() {
  try {
    const data = await fetch('/api/stats/').then(r => r.json());
    document.getElementById('stat-count').textContent = (data.count || 0).toLocaleString();
    document.getElementById('stat-size').textContent  = `${data.db_size_kb || 0} KB`;
    document.getElementById('stat-sync').textContent  = data.last_sync || 'Never';
    updateStatus('online', 'Django DB Ready');
  } catch (err) {
    updateStatus('offline', 'DB Error');
    console.error('Stats error:', err);
  }
}

// -------------------------------------------------------------------------
// Search — GET /api/search/?q=...
// -------------------------------------------------------------------------
async function refreshSearchResults() {
  const q           = document.getElementById('search-input').value.trim();
  const caseSens    = document.getElementById('chk-case').checked;
  const foldersOnly = document.getElementById('chk-folders').checked;
  const filesOnly   = document.getElementById('chk-files').checked;
  const sort        = document.getElementById('select-sort').value;
  const startDate   = document.getElementById('search-start-date').value;
  const endDate     = document.getElementById('search-end-date').value;

  const params = new URLSearchParams({
    q,
    case:         caseSens ? 'true' : 'false',
    sort,
    type:         currentActiveTypeFilter,
    folders_only: foldersOnly ? 'true' : 'false',
    files_only:   filesOnly   ? 'true' : 'false',
    start_date:   startDate,
    end_date:     endDate,
  });

  try {
    const data = await fetch(`/api/search/?${params}`).then(r => r.json());
    renderResults(data.files || []);
  } catch (err) {
    console.error('Search error:', err);
  }
}

// -------------------------------------------------------------------------
// Sync — POST /api/sync/
// -------------------------------------------------------------------------
async function syncGoogleDrive() {
  const scriptUrl   = document.getElementById('sync-script-url').value.trim();
  const folderInput = document.getElementById('sync-folder-url').value.trim();

  if (!scriptUrl) {
    alert('Please provide a Google Apps Script Web App URL first.');
    document.querySelector('[data-tab="tab-sync"]').click();
    document.getElementById('sync-script-url').focus();
    return;
  }
  if (!folderInput) {
    alert('Please enter a valid Google Drive Folder URL or Folder ID.');
    return;
  }

  const syncBtn    = document.getElementById('btn-sync-now');
  const origHtml   = syncBtn.innerHTML;

  try {
    syncBtn.disabled = true;
    syncBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Syncing...';
    updateStatus('loading', 'Syncing Drive...');

    logToSyncConsole(`Sending sync request to Django backend...`);
    logToSyncConsole(`Apps Script URL: ${scriptUrl.substring(0, 45)}...`);

    const result = await postJSON('/api/sync/', {
      script_url: scriptUrl,
      folder_url: folderInput,
    });

    if (!result.success) {
      throw new Error(result.error || 'Unknown sync error');
    }

    logToSyncConsole(`Sync complete! ${result.count} records saved to Django database.`, 'success');
    updateStatus('online', 'Django DB Ready');
    await refreshStats();
    await refreshSearchResults();
    alert(`Sync completed! ${result.count} items indexed in Django SQLite.`);
  } catch (err) {
    console.error(err);
    logToSyncConsole(`Sync failed: ${err.message}`, 'error');
    updateStatus('online', 'Django DB Ready');
    alert(`Sync failed: ${err.message}`);
  } finally {
    syncBtn.disabled = false;
    syncBtn.innerHTML = origHtml;
  }
}

// -------------------------------------------------------------------------
// Settings — Save & Load
// -------------------------------------------------------------------------
async function saveSettings() {
  const scriptUrl = document.getElementById('sync-script-url').value.trim();
  const folderUrl = document.getElementById('sync-folder-url').value.trim();

  try {
    await postJSON('/api/settings/save/', { script_url: scriptUrl, folder_url: folderUrl });
    logToSyncConsole('Settings saved to Django database.', 'success');
    alert('Settings saved!');
  } catch (err) {
    alert('Error saving settings: ' + err.message);
  }
}

async function loadSavedSettings() {
  try {
    const data = await fetch('/api/settings/load/').then(r => r.json());
    document.getElementById('sync-script-url').value = data.script_url || '';
    document.getElementById('sync-folder-url').value = data.folder_url || '';
  } catch (err) {
    console.error('Could not load settings:', err);
  }
}

// -------------------------------------------------------------------------
// Render search results table (unchanged display logic from original)
// -------------------------------------------------------------------------
function renderResults(files) {
  const tbody = document.getElementById('search-results-body');
  tbody.innerHTML = '';

  if (!files || files.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="no-results">
            <i class="fa-solid fa-magnifying-glass-minus"></i>
            <p>No matching files or folders found.</p>
          </div>
        </td>
      </tr>`;
    return;
  }

  files.forEach(file => {
    const isFolder = file.mime_type === 'application/vnd.google-apps.folder';
    const ext      = file.extension || '';
    const extClass = getBadgeClass(ext, isFolder);
    const fileIcon = getFileIcon(ext, isFolder);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="file-name-cell">
          <div class="file-icon" style="color:${fileIcon.color}">
            <i class="${fileIcon.icon}"></i>
          </div>
          <div>
            <div style="font-weight:600;font-size:0.95rem;">${escapeHtml(file.name)}</div>
            <div class="file-path" title="${escapeHtml(file.path)}">${escapeHtml(file.path || file.name)}</div>
          </div>
        </div>
      </td>
      <td><span class="file-path">${escapeHtml(file.path || '/')}</span></td>
      <td><span class="ext-badge ${extClass}">${isFolder ? 'folder' : (ext || 'file')}</span></td>
      <td class="file-date">${formatDate(file.modified_date)}</td>
      <td class="file-size">${isFolder ? '-' : formatBytes(file.size)}</td>
      <td>
        <div style="display:flex;gap:12px;align-items:center;">
          ${file.url ? `<a href="${file.url}" target="_blank" class="open-link"><i class="fa-solid fa-external-link-alt"></i> Open</a>` : ''}
          <a href="#" class="open-link view-details-link" data-id="${file.id}"><i class="fa-solid fa-circle-info"></i> Info</a>
        </div>
      </td>`;

    tr.querySelector('.view-details-link').addEventListener('click', e => {
      e.preventDefault();
      showFileDetails(file);
    });

    tbody.appendChild(tr);
  });
}

// -------------------------------------------------------------------------
// File Details Modal (data already available — no extra fetch needed)
// -------------------------------------------------------------------------
function showFileDetails(file) {
  const modal      = document.getElementById('details-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalBody  = document.getElementById('modal-body-content');
  const isFolder   = file.mime_type === 'application/vnd.google-apps.folder';

  modalTitle.textContent = isFolder ? 'Folder Information' : 'File Information';

  modalBody.innerHTML = `
    <div class="detail-row">
      <div class="detail-label">Name</div>
      <div class="detail-value" style="font-weight:600;">${escapeHtml(file.name)}</div>
    </div>
    <div class="detail-row">
      <div class="detail-label">Relative Path</div>
      <div class="detail-value mono">${escapeHtml(file.path || '/')}</div>
    </div>
    <div class="detail-row">
      <div class="detail-label">Mime Type</div>
      <div class="detail-value mono" style="font-size:0.75rem;">${escapeHtml(file.mime_type)}</div>
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
      <div class="detail-value mono">${isFolder ? 'Directory' : formatBytes(file.size)}</div>
    </div>
    <div class="detail-row">
      <div class="detail-label">Google Drive ID</div>
      <div class="detail-value mono" style="font-size:0.75rem;">${file.id}</div>
    </div>
    ${file.url ? `
    <div class="detail-row" style="border-bottom:none;margin-top:8px;">
      <div class="detail-label">Web View Link</div>
      <div class="detail-value">
        <a href="${file.url}" target="_blank" style="color:var(--accent-primary);text-decoration:none;font-weight:500;">
          Open in Google Drive <i class="fa-solid fa-external-link-alt" style="font-size:0.75rem;"></i>
        </a>
      </div>
    </div>` : ''}`;

  modal.style.display = 'flex';
}

// -------------------------------------------------------------------------
// Status Badge
// -------------------------------------------------------------------------
function updateStatus(state, text) {
  const dot   = document.getElementById('db-status-dot');
  const label = document.getElementById('db-status-text');
  dot.className = 'status-dot';
  if (state === 'online')  dot.classList.add('online');
  if (state === 'loading') dot.classList.add('loading');
  if (state === 'offline') dot.classList.add('offline');
  label.textContent = text;
}

// -------------------------------------------------------------------------
// Sync Console Logger
// -------------------------------------------------------------------------
function logToSyncConsole(message, type = 'info') {
  const consoleEl = document.getElementById('sync-logs-body');
  const timestamp = new Date().toLocaleTimeString();
  const div       = document.createElement('div');
  div.className   = `log-item ${type}`;
  div.innerHTML   = `<span style="color:var(--text-muted)">[${timestamp}]</span> ${message}`;
  consoleEl.appendChild(div);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

// -------------------------------------------------------------------------
// Pure display utilities (unchanged from original)
// -------------------------------------------------------------------------
function getBadgeClass(ext, isFolder) {
  if (isFolder) return 'ext-folder';
  if (ext === 'pdf') return 'ext-pdf';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'ext-xls';
  if (['doc', 'docx', 'gdoc', 'rtf'].includes(ext)) return 'ext-doc';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'ext-img';
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return 'ext-zip';
  return 'ext-other';
}

function getFileIcon(ext, isFolder) {
  if (isFolder) return { icon: 'fa-solid fa-folder-open', color: '#f59e0b' };
  if (ext === 'pdf') return { icon: 'fa-solid fa-file-pdf', color: '#ef4444' };
  if (['xls', 'xlsx', 'csv'].includes(ext)) return { icon: 'fa-solid fa-file-excel', color: '#10b981' };
  if (['doc', 'docx', 'gdoc'].includes(ext)) return { icon: 'fa-solid fa-file-word', color: '#3b82f6' };
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return { icon: 'fa-solid fa-file-image', color: '#8b5cf6' };
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return { icon: 'fa-solid fa-file-zipper', color: '#ec4899' };
  return { icon: 'fa-solid fa-file-lines', color: '#94a3b8' };
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024, sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}`;
  } catch { return isoString; }
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}
