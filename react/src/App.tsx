import React, { useState, useEffect } from 'react';

// API path pointing to Django dev server
const API_BASE = "http://localhost:8000";

interface DriveFile {
  id: string;
  name: string;
  mime_type: string;
  extension: string;
  modified_date: string;
  url: string;
  path: string;
  size: number;
}

interface Stats {
  count: number;
  last_sync: string;
}

export default function App() {
  // --- States ---
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [stats, setStats] = useState<Stats>({ count: 0, last_sync: 'Never' });
  const [status, setStatus] = useState<'online' | 'loading' | 'offline'>('online');
  const [statusText, setStatusText] = useState<string>('Django DB Ready');

  // --- Filter states ---
  const [searchQuery, setSearchQuery] = useState<string>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('search') || '';
  });
  const [caseSensitive, setCaseSensitive] = useState<boolean>(false);
  const [foldersOnly, setFoldersOnly] = useState<boolean>(false);
  const [filesOnly, setFilesOnly] = useState<boolean>(true);
  const [sortBy, setSortBy] = useState<string>('date-desc');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  // --- Modal states ---
  const [selectedFile, setSelectedFile] = useState<DriveFile | null>(null);

  // --- Fetch database stats ---
  const fetchStats = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/stats/`);
      if (!res.ok) throw new Error('Stats fetch failed');
      const data = await res.json();
      setStats({
        count: data.count || 0,
        last_sync: data.last_sync || 'Never'
      });
      setStatus('online');
      setStatusText('Django DB Ready');
    } catch (err) {
      console.error(err);
      setStatus('offline');
      setStatusText('DB Error');
    }
  };

  // --- Fetch search results ---
  const fetchSearchResults = async () => {
    const params = new URLSearchParams({
      q: searchQuery,
      case: caseSensitive ? 'true' : 'false',
      sort: sortBy,
      type: typeFilter,
      folders_only: foldersOnly ? 'true' : 'false',
      files_only: filesOnly ? 'true' : 'false',
      start_date: startDate,
      end_date: endDate,
    });

    try {
      const res = await fetch(`${API_BASE}/api/search/?${params}`);
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      setFiles(data.files || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error('Search error:', err);
    }
  };

  // --- Trigger stats fetch on load ---
  useEffect(() => {
    fetchStats();
  }, []);

  // --- Debounced search runner ---
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchSearchResults();
    }, 200);

    return () => clearTimeout(timer);
  }, [searchQuery, caseSensitive, foldersOnly, filesOnly, sortBy, startDate, endDate, typeFilter]);

  // --- Clear date filters ---
  const handleClearDates = (e: React.MouseEvent) => {
    e.preventDefault();
    setStartDate('');
    setEndDate('');
  };

  // --- Type utility helpers ---
  const getBadgeClass = (ext: string, isFolder: boolean) => {
    if (isFolder) return 'ext-badge ext-folder';
    if (ext === 'pdf') return 'ext-badge ext-pdf';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return 'ext-badge ext-xls';
    if (['doc', 'docx', 'gdoc', 'rtf'].includes(ext)) return 'ext-badge ext-doc';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'ext-badge ext-img';
    if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return 'ext-badge ext-zip';
    return 'ext-badge ext-other';
  };

  const getFileIcon = (ext: string, isFolder: boolean) => {
    if (isFolder) return { icon: 'fa-solid fa-folder-open', color: '#f59e0b' };
    if (ext === 'pdf') return { icon: 'fa-solid fa-file-pdf', color: '#ef4444' };
    if (['xls', 'xlsx', 'csv'].includes(ext)) return { icon: 'fa-solid fa-file-excel', color: '#10b981' };
    if (['doc', 'docx', 'gdoc'].includes(ext)) return { icon: 'fa-solid fa-file-word', color: '#3b82f6' };
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return { icon: 'fa-solid fa-file-image', color: '#8b5cf6' };
    if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return { icon: 'fa-solid fa-file-zipper', color: '#ec4899' };
    return { icon: 'fa-solid fa-file-lines', color: '#94a3b8' };
  };

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatDate = (isoString: string) => {
    if (!isoString) return '-';
    try {
      const d = new Date(isoString);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const h = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      return `${y}-${m}-${day} ${h}:${min}`;
    } catch {
      return isoString;
    }
  };

  return (
    <div className="google-drive-scope">
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="logo-section">
          <div className="logo-icon">
            <i className="fa-solid fa-circle-nodes"></i>
          </div>
          <span className="logo-title">G-Drive Searcher</span>
        </div>

        <nav>
          <ul className="nav-menu">
            <li className="nav-item active">
              <i className="fa-solid fa-magnifying-glass"></i>
              <span>Search Files</span>
            </li>
          </ul>
        </nav>

        <div className="sidebar-footer">
          <div className="db-status-card">
            <div className="status-row">
              <span className={`status-dot ${status}`}></span>
              <span>{statusText}</span>
            </div>
            <div className="stat-row">
              <span>Total Index:</span>
              <span className="stat-value">{stats.count.toLocaleString()}</span>
            </div>
            <div className="stat-row">
              <span>Last Sync:</span>
              <span className="stat-value">{stats.last_sync}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <header className="top-bar">
          <h1 className="top-bar-title">Search Indexed Files</h1>
        </header>

        {/* Search Panel */}
        <section className="tab-panel active">
          <div className="search-controls">
            {/* Search Bar */}
            <div className="search-bar-row">
              <div className="search-input-wrapper">
                <i className="fa-solid fa-magnifying-glass"></i>
                <input
                  type="text"
                  className="search-input"
                  placeholder="Type filename substring (e.g. 23456789 or document)..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  autoComplete="off"
                />
              </div>
            </div>

            {/* Filters */}
            <div className="filters-row">
              <div className="filter-options">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={caseSensitive}
                    onChange={(e) => setCaseSensitive(e.target.checked)}
                  />
                  <span>Case Sensitive</span>
                </label>

                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={foldersOnly}
                    onChange={(e) => {
                      setFoldersOnly(e.target.checked);
                      if (e.target.checked) setFilesOnly(false);
                    }}
                  />
                  <span>Folders Only</span>
                </label>

                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={filesOnly}
                    onChange={(e) => {
                      setFilesOnly(e.target.checked);
                      if (e.target.checked) setFoldersOnly(false);
                    }}
                  />
                  <span>Files Only</span>
                </label>

                <div className="select-wrapper">
                  <select
                    className="select-input"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                  >
                    <option value="name-asc">Name (A-Z)</option>
                    <option value="name-desc">Name (Z-A)</option>
                    <option value="date-desc">Modified Date (Newest)</option>
                    <option value="date-asc">Modified Date (Oldest)</option>
                    <option value="size-desc">Size (Largest)</option>
                    <option value="size-asc">Size (Smallest)</option>
                  </select>
                </div>

                <div className="date-input-group">
                  <i className="fa-solid fa-calendar-days" style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginLeft: '4px' }}></i>
                  <input
                    type="date"
                    className="date-input"
                    title="Start Date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                  <span className="date-separator">to</span>
                  <input
                    type="date"
                    className="date-input"
                    title="End Date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                  {(startDate || endDate) && (
                    <button
                      onClick={handleClearDates}
                      className="btn-copy"
                      style={{ position: 'static', fontSize: '0.75rem', padding: '4px 6px', marginLeft: '4px' }}
                      title="Clear Dates"
                    >
                      <i className="fa-solid fa-xmark"></i>
                    </button>
                  )}
                </div>
              </div>

              {/* Tag Filters */}
              <div className="tag-filters">
                <button
                  className={`tag-btn ${typeFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setTypeFilter('all')}
                >
                  All Types
                </button>
                <button
                  className={`tag-btn ${typeFilter === 'folders' ? 'active' : ''}`}
                  onClick={() => setTypeFilter('folders')}
                >
                  <i className="fa-solid fa-folder"></i> Folders
                </button>
                <button
                  className={`tag-btn ${typeFilter === 'pdf' ? 'active' : ''}`}
                  onClick={() => setTypeFilter('pdf')}
                >
                  <i className="fa-solid fa-file-pdf"></i> PDF
                </button>
                <button
                  className={`tag-btn ${typeFilter === 'xls' ? 'active' : ''}`}
                  onClick={() => setTypeFilter('xls')}
                >
                  <i className="fa-solid fa-file-excel"></i> Excel/CSV
                </button>
                <button
                  className={`tag-btn ${typeFilter === 'doc' ? 'active' : ''}`}
                  onClick={() => setTypeFilter('doc')}
                >
                  <i className="fa-solid fa-file-word"></i> Word/Docs
                </button>
                <button
                  className={`tag-btn ${typeFilter === 'img' ? 'active' : ''}`}
                  onClick={() => setTypeFilter('img')}
                >
                  <i className="fa-solid fa-file-image"></i> Images
                </button>
                <button
                  className={`tag-btn ${typeFilter === 'zip' ? 'active' : ''}`}
                  onClick={() => setTypeFilter('zip')}
                >
                  <i className="fa-solid fa-file-zipper"></i> Zip
                </button>
              </div>
            </div>
          </div>

          {/* Results Table */}
          <div className="results-section">
            <table className="results-table">
              <thead>
                <tr>
                  <th>File / Folder Name</th>
                  <th>Path</th>
                  <th>Type</th>
                  <th>Modified Date</th>
                  <th>Size</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {files.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="no-results">
                        <i className="fa-solid fa-magnifying-glass-minus"></i>
                        <p>No matching files or folders found.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  files.map((file) => {
                    const isFolder = file.mime_type === 'application/vnd.google-apps.folder';
                    const ext = file.extension || '';
                    const iconStyle = getFileIcon(ext, isFolder);
                    return (
                      <tr key={file.id}>
                        <td>
                          <div className="file-name-cell">
                            <div
                              className="file-icon"
                              style={{ backgroundColor: `${iconStyle.color}1c`, color: iconStyle.color }}
                            >
                              <i className={iconStyle.icon}></i>
                            </div>
                            <span
                              style={{ cursor: 'pointer', textDecoration: 'none' }}
                              onClick={() => setSelectedFile(file)}
                            >
                              {file.name}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="file-path" title={file.path || '/'}>
                            {file.path || '/'}
                          </div>
                        </td>
                        <td>
                          <span className={getBadgeClass(ext, isFolder)}>
                            {isFolder ? 'folder' : ext || 'file'}
                          </span>
                        </td>
                        <td>
                          <span className="file-date">{formatDate(file.modified_date)}</span>
                        </td>
                        <td>
                          <span className="file-size">{isFolder ? '-' : formatBytes(file.size)}</span>
                        </td>
                        <td>
                          {file.url ? (
                            <a
                              href={file.url}
                              className="open-link"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Open <i className="fa-solid fa-arrow-up-right-from-square" style={{ fontSize: '0.75rem' }}></i>
                            </a>
                          ) : (
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Details Modal */}
      {selectedFile && (
        <div className="modal" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3 className="modal-title">File Details</h3>
              <button className="modal-close" onClick={() => setSelectedFile(null)}>
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div className="modal-body">
              <div className="detail-row">
                <div className="detail-label">Name</div>
                <div className="detail-value" style={{ fontWeight: 600 }}>{selectedFile.name}</div>
              </div>
              <div className="detail-row">
                <div className="detail-label">Path</div>
                <div className="detail-value">{selectedFile.path || '/'}</div>
              </div>
              <div className="detail-row">
                <div className="detail-label">Type</div>
                <div className="detail-value">{selectedFile.mime_type}</div>
              </div>
              <div className="detail-row">
                <div className="detail-label">Size</div>
                <div className="detail-value">{selectedFile.mime_type === 'application/vnd.google-apps.folder' ? '-' : formatBytes(selectedFile.size)}</div>
              </div>
              <div className="detail-row">
                <div className="detail-label">Modified Date</div>
                <div className="detail-value">{formatDate(selectedFile.modified_date)}</div>
              </div>
              <div className="detail-row">
                <div className="detail-label">Drive ID</div>
                <div className="detail-value mono">{selectedFile.id}</div>
              </div>
              {selectedFile.url && (
                <div className="detail-row" style={{ borderBottom: 'none', marginTop: '8px' }}>
                  <div className="detail-label">Web View Link</div>
                  <div className="detail-value">
                    <a
                      href={selectedFile.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--accent-primary)', textDecoration: 'none', fontWeight: 500 }}
                    >
                      Open in Google Drive <i className="fa-solid fa-external-link-alt" style={{ fontSize: '0.75rem' }}></i>
                    </a>
                  </div>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setSelectedFile(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
