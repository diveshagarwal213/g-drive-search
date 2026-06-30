import json
import os
import requests as http_requests
from datetime import datetime, timezone

from django.conf import settings
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
