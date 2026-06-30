import json
import os
import requests as http_requests
from datetime import datetime, timezone, timedelta
from random import randint, choice, uniform

from django.conf import settings
from django.db import connection
from django.http import JsonResponse
from django.shortcuts import render
from django.utils.dateparse import parse_datetime
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from .models import DriveFile, SyncMeta

# ---------------------------------------------------------------------------
# Helper utilities
# ---------------------------------------------------------------------------

def _get_meta(key, default=''):
    try:
        return SyncMeta.objects.get(key=key).value
    except SyncMeta.DoesNotExist:
        return default


def _set_meta(key, value):
    obj, _ = SyncMeta.objects.get_or_create(key=key)
    obj.value = value
    obj.save()


def _db_size_kb():
    db_path = settings.DATABASES['default']['NAME']
    try:
        return round(os.path.getsize(db_path) / 1024, 1)
    except (OSError, TypeError):
        return 0


def _extract_folder_id(raw):
    """Extract Google Drive folder ID from a URL or return the raw string."""
    import re
    raw = raw.strip()
    match = re.search(r'/folders/([a-zA-Z0-9_-]{25,})', raw)
    return match.group(1) if match else raw


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------

def index(request):
    """Render the main single-page application."""
    return render(request, 'searcher/index.html')


# ---------------------------------------------------------------------------
# GET /api/stats/
# ---------------------------------------------------------------------------
@require_GET
def api_stats(request):
    count = DriveFile.objects.count()
    db_size = _db_size_kb()
    last_sync = _get_meta('last_sync_time', 'Never')
    return JsonResponse({
        'count':     count,
        'db_size_kb': db_size,
        'last_sync': last_sync,
    })


# ---------------------------------------------------------------------------
# GET /api/search/
# ---------------------------------------------------------------------------
@require_GET
def api_search(request):
    q             = request.GET.get('q', '').strip()
    case_sens     = request.GET.get('case', 'false').lower() == 'true'
    sort          = request.GET.get('sort', 'date-desc')
    start_date    = request.GET.get('start_date', '')
    end_date      = request.GET.get('end_date', '')
    type_filter   = request.GET.get('type', 'all')   # all | folders | files | pdf | xls | doc | img | zip
    folders_only  = request.GET.get('folders_only', 'false').lower() == 'true'
    files_only    = request.GET.get('files_only', 'false').lower() == 'true'

    qs = DriveFile.objects.all()

    # ---- Mime / type filtering ----
    FOLDER_MIME = 'application/vnd.google-apps.folder'

    if type_filter == 'folders' or folders_only:
        qs = qs.filter(mime_type=FOLDER_MIME)
    elif type_filter == 'files' or files_only:
        qs = qs.exclude(mime_type=FOLDER_MIME)

    if type_filter == 'pdf':
        qs = qs.filter(extension='pdf')
    elif type_filter == 'xls':
        qs = qs.filter(extension__in=['xls', 'xlsx', 'csv'])
    elif type_filter == 'doc':
        qs = qs.filter(extension__in=['doc', 'docx', 'rtf', 'gdoc'])
    elif type_filter == 'img':
        qs = qs.filter(extension__in=['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])
    elif type_filter == 'zip':
        qs = qs.filter(extension__in=['zip', 'tar', 'gz', 'rar', '7z'])

    # ---- Substring search ----
    if q:
        if case_sens:
            qs = qs.filter(name__contains=q)
        else:
            qs = qs.filter(name__icontains=q)

    # ---- Date range ----
    if start_date:
        try:
            dt = datetime.strptime(start_date, '%Y-%m-%d').replace(
                hour=0, minute=0, second=0, tzinfo=timezone.utc)
            qs = qs.filter(modified_date__gte=dt)
        except ValueError:
            pass
    if end_date:
        try:
            dt = datetime.strptime(end_date, '%Y-%m-%d').replace(
                hour=23, minute=59, second=59, tzinfo=timezone.utc)
            qs = qs.filter(modified_date__lte=dt)
        except ValueError:
            pass

    # ---- Sorting ----
    sort_map = {
        'name-asc':   'name',
        'name-desc':  '-name',
        'date-desc':  '-modified_date',
        'date-asc':   'modified_date',
        'size-desc':  '-size',
        'size-asc':   'size',
    }
    qs = qs.order_by(sort_map.get(sort, '-modified_date'))

    files = [f.to_dict() for f in qs[:2000]]
    return JsonResponse({'files': files, 'total': len(files)})


# ---------------------------------------------------------------------------
# POST /api/sync/
# ---------------------------------------------------------------------------
@csrf_exempt
@require_POST
def api_sync(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'success': False, 'error': 'Invalid JSON body'}, status=400)

    script_url = data.get('script_url', '').strip()
    folder_input = data.get('folder_url', '').strip()

    if not script_url:
        return JsonResponse({'success': False, 'error': 'Missing script_url'}, status=400)
    if not folder_input:
        return JsonResponse({'success': False, 'error': 'Missing folder_url'}, status=400)

    folder_id = _extract_folder_id(folder_input)

    try:
        response = http_requests.get(
            script_url,
            params={'id': folder_id},
            timeout=60,
        )
        response.raise_for_status()
        result = response.json()
    except http_requests.RequestException as e:
        return JsonResponse({'success': False, 'error': str(e)}, status=502)

    if not result.get('success'):
        return JsonResponse({'success': False, 'error': result.get('error', 'Unknown Apps Script error')}, status=400)

    files_data = result.get('files', [])

    # Bulk-replace all records
    DriveFile.objects.all().delete()
    objs = []
    for f in files_data:
        name = f.get('name', '')
        dot  = name.rfind('.')
        ext  = name[dot + 1:].lower() if dot != -1 else ''
        if f.get('mimeType') == 'application/vnd.google-apps.folder':
            ext = ''

        mod_raw = f.get('modifiedDate', '')
        mod_dt  = None
        if mod_raw:
            try:
                mod_dt = datetime.fromisoformat(mod_raw.replace('Z', '+00:00'))
            except ValueError:
                pass

        objs.append(DriveFile(
            drive_id      = f.get('id', ''),
            name          = name,
            mime_type     = f.get('mimeType', ''),
            extension     = ext,
            modified_date = mod_dt,
            url           = f.get('url', ''),
            path          = f.get('path', ''),
            size          = f.get('size', 0) or 0,
        ))

    DriveFile.objects.bulk_create(objs, ignore_conflicts=True)

    sync_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    _set_meta('last_sync_time', sync_time)

    return JsonResponse({'success': True, 'count': len(objs), 'last_sync': sync_time})


# ---------------------------------------------------------------------------
# POST /api/demo/
# ---------------------------------------------------------------------------
@csrf_exempt
@require_POST
def api_demo(request):
    """Load a pre-fabricated demo dataset of ~54 mock files/folders."""
    now = datetime.now(tz=timezone.utc)

    def sub_days(days):
        return now - timedelta(days=days)

    FOLDER_MIME = 'application/vnd.google-apps.folder'

    mock_files = [
        # Folders
        {'id': 'fol_1', 'name': 'Work Documents',   'mimeType': FOLDER_MIME, 'url': 'https://drive.google.com/drive/folders/demo1', 'path': 'Work Documents',   'size': 0, 'modified': sub_days(2)},
        {'id': 'fol_2', 'name': 'Personal Receipts', 'mimeType': FOLDER_MIME, 'url': 'https://drive.google.com/drive/folders/demo2', 'path': 'Personal Receipts', 'size': 0, 'modified': sub_days(5)},
        {'id': 'fol_3', 'name': 'Database Backups',  'mimeType': FOLDER_MIME, 'url': 'https://drive.google.com/drive/folders/demo3', 'path': 'Database Backups',  'size': 0, 'modified': sub_days(1)},
        {'id': 'fol_4', 'name': 'Archive 2025',      'mimeType': FOLDER_MIME, 'url': 'https://drive.google.com/drive/folders/demo4', 'path': 'Work Documents/Archive 2025',     'size': 0, 'modified': sub_days(120)},
        {'id': 'fol_5', 'name': 'Images & Design',   'mimeType': FOLDER_MIME, 'url': 'https://drive.google.com/drive/folders/demo5', 'path': 'Work Documents/Images & Design', 'size': 0, 'modified': sub_days(10)},

        # Target search mock files (containing phone number substrings)
        {'id': 'f_1', 'name': '+91123456789.xlsx',             'mimeType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'url': 'https://drive.google.com/file/d/demo_f1', 'path': 'Work Documents/+91123456789.xlsx',                          'size': 48900,   'modified': sub_days(1)},
        {'id': 'f_2', 'name': 'customer_list_23456789.csv',    'mimeType': 'text/csv',                                                          'url': 'https://drive.google.com/file/d/demo_f2', 'path': 'Work Documents/customer_list_23456789.csv',               'size': 104500,  'modified': sub_days(3)},
        {'id': 'f_3', 'name': 'leads_91123456789.pdf',         'mimeType': 'application/pdf',                                                   'url': 'https://drive.google.com/file/d/demo_f3', 'path': 'Work Documents/leads_91123456789.pdf',                    'size': 1204000, 'modified': sub_days(4)},
        {'id': 'f_4', 'name': 'Invoice-10023456789.docx',      'mimeType': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'url': 'https://drive.google.com/file/d/demo_f4', 'path': 'Work Documents/Archive 2025/Invoice-10023456789.docx', 'size': 94000,  'modified': sub_days(110)},
        {'id': 'f_5', 'name': 'phone_contacts_234567890.xlsx', 'mimeType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'url': 'https://drive.google.com/file/d/demo_f5', 'path': 'Work Documents/phone_contacts_234567890.xlsx',            'size': 32000,   'modified': sub_days(2)},

        # Standard PDFs
        {'id': 'f_6', 'name': 'Q1_Financial_Report.pdf',        'mimeType': 'application/pdf', 'url': 'https://drive.google.com/file/d/demo_f6', 'path': 'Work Documents/Q1_Financial_Report.pdf',        'size': 2450000, 'modified': sub_days(15)},
        {'id': 'f_7', 'name': 'Employment_Agreement_Final.pdf', 'mimeType': 'application/pdf', 'url': 'https://drive.google.com/file/d/demo_f7', 'path': 'Work Documents/Employment_Agreement_Final.pdf', 'size': 450000,  'modified': sub_days(45)},
        {'id': 'f_8', 'name': 'Google_Cloud_Arch_Specs.pdf',    'mimeType': 'application/pdf', 'url': 'https://drive.google.com/file/d/demo_f8', 'path': 'Work Documents/Google_Cloud_Arch_Specs.pdf',    'size': 4890000, 'modified': sub_days(6)},

        # Spreadsheets/CSV
        {'id': 'f_9',  'name': 'Budget_Planning_2026.xlsx',    'mimeType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'url': 'https://drive.google.com/file/d/demo_f9',  'path': 'Work Documents/Budget_Planning_2026.xlsx',    'size': 180000,  'modified': sub_days(0)},
        {'id': 'f_10', 'name': 'User_Logs_June.csv',           'mimeType': 'text/csv',                                                          'url': 'https://drive.google.com/file/d/demo_f10', 'path': 'Database Backups/User_Logs_June.csv',          'size': 8500400, 'modified': sub_days(0.5)},
        {'id': 'f_11', 'name': 'Marketing_Campaign_ROI.xlsx',  'mimeType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'url': 'https://drive.google.com/file/d/demo_f11', 'path': 'Work Documents/Marketing_Campaign_ROI.xlsx',  'size': 145000,  'modified': sub_days(8)},

        # Word Docs
        {'id': 'f_12', 'name': 'Project_Outline.docx',           'mimeType': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'url': 'https://drive.google.com/file/d/demo_f12', 'path': 'Work Documents/Project_Outline.docx',           'size': 85000,  'modified': sub_days(9)},
        {'id': 'f_13', 'name': 'todo_list.txt',                  'mimeType': 'text/plain', 'url': 'https://drive.google.com/file/d/demo_f13', 'path': 'todo_list.txt',                  'size': 1024, 'modified': now},
        {'id': 'f_14', 'name': 'API_Key_Secret_DoNotShare.txt',  'mimeType': 'text/plain', 'url': 'https://drive.google.com/file/d/demo_f14', 'path': 'API_Key_Secret_DoNotShare.txt',  'size': 512,  'modified': sub_days(30)},

        # Images
        {'id': 'f_15', 'name': 'App_Logo_Dark.png',        'mimeType': 'image/png',  'url': 'https://drive.google.com/file/d/demo_f15', 'path': 'Work Documents/Images & Design/App_Logo_Dark.png',        'size': 45000,   'modified': sub_days(11)},
        {'id': 'f_16', 'name': 'Banner_Background.jpg',    'mimeType': 'image/jpeg', 'url': 'https://drive.google.com/file/d/demo_f16', 'path': 'Work Documents/Images & Design/Banner_Background.jpg',    'size': 1204000, 'modified': sub_days(10)},
        {'id': 'f_17', 'name': 'User_Avatar_Divesh.webp',  'mimeType': 'image/webp', 'url': 'https://drive.google.com/file/d/demo_f17', 'path': 'User_Avatar_Divesh.webp',  'size': 18000,   'modified': sub_days(35)},

        # Archives
        {'id': 'f_18', 'name': 'source_code_backup.zip',   'mimeType': 'application/zip',   'url': 'https://drive.google.com/file/d/demo_f18', 'path': 'Database Backups/source_code_backup.zip',   'size': 45890000, 'modified': sub_days(1)},
        {'id': 'f_19', 'name': 'Tax_Receipts_2024.tar.gz', 'mimeType': 'application/gzip',  'url': 'https://drive.google.com/file/d/demo_f19', 'path': 'Personal Receipts/Tax_Receipts_2024.tar.gz', 'size': 8900000,  'modified': sub_days(140)},
    ]

    # Generate extra 35 random files
    ext_mime = {
        'pdf':  'application/pdf',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'png':  'image/png',
        'zip':  'application/zip',
        'csv':  'text/csv',
        'txt':  'text/plain',
    }
    exts = list(ext_mime.keys())
    for i in range(1, 36):
        ext = choice(exts)
        name = f'asset_document_0{i}.{ext}'
        mock_files.append({
            'id':       f'f_extra_{i}',
            'name':     name,
            'mimeType': ext_mime[ext],
            'url':      f'https://drive.google.com/file/d/demo_f_extra_{i}',
            'path':     f'Work Documents/Archive 2025/{name}',
            'size':     randint(120, 2500000),
            'modified': sub_days(round(uniform(0, 90), 2)),
        })

    # Replace all existing data
    DriveFile.objects.all().delete()
    objs = []
    for f in mock_files:
        name = f['name']
        dot  = name.rfind('.')
        ext  = name[dot + 1:].lower() if (dot != -1 and f['mimeType'] != FOLDER_MIME) else ''
        objs.append(DriveFile(
            drive_id      = f['id'],
            name          = name,
            mime_type     = f['mimeType'],
            extension     = ext,
            modified_date = f['modified'],
            url           = f.get('url', ''),
            path          = f.get('path', ''),
            size          = f.get('size', 0),
        ))

    DriveFile.objects.bulk_create(objs)

    sync_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    _set_meta('last_sync_time', sync_time)

    return JsonResponse({'success': True, 'count': len(objs), 'last_sync': sync_time})


# ---------------------------------------------------------------------------
# POST /api/reset/
# ---------------------------------------------------------------------------
@csrf_exempt
@require_POST
def api_reset(request):
    deleted, _ = DriveFile.objects.all().delete()
    _set_meta('last_sync_time', 'Never')
    return JsonResponse({'success': True, 'deleted': deleted})


# ---------------------------------------------------------------------------
# POST /api/sql/
# ---------------------------------------------------------------------------
@csrf_exempt
@require_POST
def api_sql(request):
    """
    Execute a raw SQL SELECT query against the Django SQLite database.
    For safety, only SELECT statements are allowed.
    """
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'success': False, 'error': 'Invalid JSON body'}, status=400)

    sql = data.get('sql', '').strip()
    if not sql:
        return JsonResponse({'success': False, 'error': 'No SQL provided'}, status=400)

    # Safety: only allow SELECT statements
    sql_upper = sql.upper().lstrip()
    if not sql_upper.startswith('SELECT'):
        return JsonResponse({
            'success': False,
            'error':   'Only SELECT queries are allowed in the SQL console.'
        }, status=403)

    try:
        with connection.cursor() as cursor:
            cursor.execute(sql)
            columns = [col[0] for col in cursor.description] if cursor.description else []
            rows    = cursor.fetchall()

        # Convert rows to list-of-lists for JSON serialization
        serialized_rows = []
        for row in rows:
            serialized_rows.append([
                str(val) if val is not None else None for val in row
            ])

        return JsonResponse({
            'success': True,
            'columns': columns,
            'rows':    serialized_rows,
            'count':   len(serialized_rows),
        })
    except Exception as e:
        return JsonResponse({'success': False, 'error': str(e)}, status=400)


# ---------------------------------------------------------------------------
# POST /api/settings/save/
# ---------------------------------------------------------------------------
@csrf_exempt
@require_POST
def api_settings_save(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'success': False, 'error': 'Invalid JSON body'}, status=400)

    _set_meta('script_url', data.get('script_url', ''))
    _set_meta('folder_url', data.get('folder_url', ''))
    return JsonResponse({'success': True})


# ---------------------------------------------------------------------------
# GET /api/settings/load/
# ---------------------------------------------------------------------------
@require_GET
def api_settings_load(request):
    return JsonResponse({
        'script_url': _get_meta('script_url', ''),
        'folder_url': _get_meta('folder_url', 'https://drive.google.com/drive/folders/1Cc0BLV_SdNnmM6esqsPu4ZuapGD3nCSq'),
    })
