# Searcher App Migration Guide

This guide outlines the key steps and technical considerations for copying the `searcher` app into another Django project that uses **MySQL** (instead of SQLite) and where you want to serve the searcher interface under the `/searcher/` URL path.

---

## 1. URL Routing Setup (`/searcher/`)

To host the searcher page under `/searcher/` rather than the root path (`/`), configure the URL patterns as follows:

### Main Project `urls.py`
Include the searcher app URLs under the `'searcher/'` prefix:
```python
from django.urls import path, include

urlpatterns = [
    # ... your other project URLs
    path('searcher/', include('searcher.urls')),
]
```

### Searcher App `urls.py`
Keep the searcher's internal routing clean and relative:
```python
from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),  # Serves '/searcher/'
    path('api/stats/', views.StatsView.as_view(), name='api_stats'),    # Serves '/searcher/api/stats/'
    path('api/search/', views.SearchView.as_view(), name='api_search'),  # Serves '/searcher/api/search/'
]
```

### Critical JavaScript Update (`app.js`)
If the searcher app is mounted at `/searcher/`, relative fetch calls pointing to `/api/search/` will fail (404) because the actual endpoints will reside under `/searcher/api/...`. 

To handle this dynamically, update the API base URL in `app.js`:
```javascript
// Add a helper to compute the correct sub-path base URL
const API_BASE = window.location.pathname.replace(/\/$/, ''); // e.g. "/searcher"

// Use API_BASE in all fetch calls:
const data = await fetch(`${API_BASE}/api/stats/`).then(r => r.json());
const data = await fetch(`${API_BASE}/api/search/?${params}`).then(r => r.json());
```

---

## 2. MySQL Migration Considerations

### Charset & Emojis (`utf8mb4`)
Google Drive file names and paths often contain unicode symbols or emojis. SQLite handles these implicitly, but MySQL requires explicit setup:
- Ensure your MySQL database is created with `utf8mb4` character set and `utf8mb4_unicode_ci` collation.
- If you run migrations and encounter encoding errors, double-check your Django `DATABASES` setting:
  ```python
  DATABASES = {
      'default': {
          'ENGINE': 'django.db.backends.mysql',
          'NAME': 'my_db',
          # ...
          'OPTIONS': {
              'charset': 'utf8mb4',
              'use_unicode': True,
          },
      }
  }
  ```

### Primary Key Constraints & Field Limits
- In `models.py`, `DriveFile` uses a `drive_id` as a primary unique index lookup. Under `utf8mb4`, MySQL indexes have key length limits (usually 767 or 3072 bytes depending on `innodb_large_prefix`). 
- Keep `drive_id` length restricted (it is currently `max_length=255`, which fits perfectly inside standard InnoDB limits).

### Bulk Actions (`bulk_create`)
- SQLite supports `ignore_conflicts=True` out of the box. On MySQL, Django handles `ignore_conflicts=True` by translating it to an `INSERT IGNORE` statement.
- **Bulk Insert Packet Size**: MySQL has a `max_allowed_packet` limit. If your Apps Script sync fetches hundreds of thousands of files, a single `bulk_create` call might exceed this limit. Consider batching inserts:
  ```python
  # In service.py
  DriveFile.objects.bulk_create(objs, ignore_conflicts=True, batch_size=1000)
  ```

---

## 3. Adapting to a Different Indexing Source

If the new project indexes a different database/source (e.g. local directory, S3 buckets, local file sharing, another business database, etc.), you **only need to change `searcher/service.py`**:

```
[Django Admin Action] ---> (searcher/service.py) <--- [Sync Endpoint / Cron Job]
                                   |
                                   v  (Modify perform_gdrive_sync logic)
                        [New Source (S3, Local Directory, etc.)]
                                   |
                                   v
                        [MySQL / db.sqlite3 Database]
```

### Steps to Customize the Index Source:
1. Open `searcher/service.py`.
2. Edit `perform_gdrive_sync` to query your new target API/Service.
3. Map the returned metadata properties to the `DriveFile` object properties:
   - `drive_id` (Unique identifier)
   - `name` (File name)
   - `mime_type` (Content type)
   - `extension` (File extension suffix)
   - `modified_date` (Modification timestamp)
   - `url` (Link to view the item)
   - `path` (Virtual folder path)
   - `size` (Size in bytes)
4. Save the file. The database view representation, filters, search backend (`SearchView`), and Stats Dashboard (`StatsView`) will continue to work out of the box.
