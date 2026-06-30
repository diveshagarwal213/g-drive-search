import os
import re
import requests as http_requests
from datetime import datetime, timezone

from django.conf import settings
from django.shortcuts import render

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import DriveFile, SyncMeta
from .serializers import (
    DriveFileSerializer,
    SearchQuerySerializer,
    SettingsSerializer,
    SyncRequestSerializer,
)

# ---------------------------------------------------------------------------
# Internal helpers
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


def _extract_folder_id(raw: str) -> str:
    """Return the Drive folder ID from a URL or pass through a bare ID."""
    raw = raw.strip()
    match = re.search(r'/folders/([a-zA-Z0-9_-]{25,})', raw)
    return match.group(1) if match else raw


# ---------------------------------------------------------------------------
# Template view  (plain Django — DRF APIView cannot render HTML templates)
# ---------------------------------------------------------------------------

def index(request):
    """Render the single-page application shell."""
    return render(request, 'searcher/index.html')


# ---------------------------------------------------------------------------
# GET /api/stats/
# ---------------------------------------------------------------------------

class StatsView(APIView):
    """
    Returns aggregate statistics about the indexed database.

    GET /api/stats/
    Response: { count, db_size_kb, last_sync }
    """

    def get(self, request):
        return Response({
            'count':      DriveFile.objects.count(),
            'db_size_kb': _db_size_kb(),
            'last_sync':  _get_meta('last_sync_time', 'Never'),
        })


# ---------------------------------------------------------------------------
# GET /api/search/
# ---------------------------------------------------------------------------

FOLDER_MIME = 'application/vnd.google-apps.folder'

SORT_MAP = {
    'name-asc':  'name',
    'name-desc': '-name',
    'date-desc': '-modified_date',
    'date-asc':  'modified_date',
    'size-desc': '-size',
    'size-asc':  'size',
}

EXT_MAP = {
    'pdf': ['pdf'],
    'xls': ['xls', 'xlsx', 'csv'],
    'doc': ['doc', 'docx', 'rtf', 'gdoc'],
    'img': ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'],
    'zip': ['zip', 'tar', 'gz', 'rar', '7z'],
}


class SearchView(APIView):
    """
    Search and filter indexed Drive files.

    GET /api/search/?q=&sort=date-desc&type=all&...
    Response: { files: [...], total: N }
    """

    def get(self, request):
        params = SearchQuerySerializer(data=request.query_params)
        if not params.is_valid():
            return Response(params.errors, status=status.HTTP_400_BAD_REQUEST)

        d            = params.validated_data
        q            = d['q'].strip()
        case_sens    = d['case']
        sort         = d['sort']
        type_filter  = d['type']
        folders_only = d['folders_only']
        files_only   = d['files_only']
        start_date   = d.get('start_date')
        end_date     = d.get('end_date')

        qs = DriveFile.objects.all()

        # --- Mime / type filtering ---
        if type_filter == 'folders' or folders_only:
            qs = qs.filter(mime_type=FOLDER_MIME)
        elif type_filter == 'files' or files_only:
            qs = qs.exclude(mime_type=FOLDER_MIME)

        if type_filter in EXT_MAP:
            qs = qs.filter(extension__in=EXT_MAP[type_filter])

        # --- Substring search ---
        if q:
            lookup = 'name__contains' if case_sens else 'name__icontains'
            qs = qs.filter(**{lookup: q})

        # --- Date range ---
        if start_date:
            dt = datetime(start_date.year, start_date.month, start_date.day,
                          0, 0, 0, tzinfo=timezone.utc)
            qs = qs.filter(modified_date__gte=dt)
        if end_date:
            dt = datetime(end_date.year, end_date.month, end_date.day,
                          23, 59, 59, tzinfo=timezone.utc)
            qs = qs.filter(modified_date__lte=dt)

        # --- Sort ---
        qs = qs.order_by(SORT_MAP.get(sort, '-modified_date'))

        files = DriveFileSerializer(qs[:2000], many=True).data
        return Response({'files': files, 'total': len(files)})


# ---------------------------------------------------------------------------
# POST /api/sync/
# ---------------------------------------------------------------------------

class SyncView(APIView):
    """
    Fetches file metadata from a Google Apps Script proxy and stores it
    in the Django database, replacing all previous records.

    POST /api/sync/
    Body: { script_url, folder_url }
    Response: { success, count, last_sync }
    """

    def post(self, request):
        body = SyncRequestSerializer(data=request.data)
        if not body.is_valid():
            return Response(body.errors, status=status.HTTP_400_BAD_REQUEST)

        script_url   = body.validated_data['script_url']
        folder_input = body.validated_data['folder_url']
        folder_id    = _extract_folder_id(folder_input)

        # --- Fetch from Apps Script (server-side, no CORS) ---
        try:
            resp = http_requests.get(
                script_url,
                params={'id': folder_id},
                timeout=60,
            )
            resp.raise_for_status()
            result = resp.json()
        except http_requests.RequestException as exc:
            return Response(
                {'success': False, 'error': str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        if not result.get('success'):
            return Response(
                {'success': False, 'error': result.get('error', 'Unknown Apps Script error')},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # --- Bulk-replace records ---
        files_data = result.get('files', [])
        DriveFile.objects.all().delete()

        objs = []
        for f in files_data:
            name = f.get('name', '')
            dot  = name.rfind('.')
            ext  = name[dot + 1:].lower() if dot != -1 else ''
            if f.get('mimeType') == FOLDER_MIME:
                ext = ''

            mod_dt = None
            mod_raw = f.get('modifiedDate', '')
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

        return Response({'success': True, 'count': len(objs), 'last_sync': sync_time})


# ---------------------------------------------------------------------------
# GET + POST /api/settings/
# ---------------------------------------------------------------------------

class SettingsView(APIView):
    """
    Retrieve or persist the Apps Script URL and Drive folder URL.

    GET  /api/settings/  → { script_url, folder_url }
    POST /api/settings/  ← { script_url, folder_url }
                         → { success: true }
    """

    DEFAULT_FOLDER = 'https://drive.google.com/drive/folders/1Cc0BLV_SdNnmM6esqsPu4ZuapGD3nCSq'

    def get(self, request):
        return Response({
            'script_url': _get_meta('script_url', ''),
            'folder_url': _get_meta('folder_url', self.DEFAULT_FOLDER),
        })

    def post(self, request):
        body = SettingsSerializer(data=request.data)
        if not body.is_valid():
            return Response(body.errors, status=status.HTTP_400_BAD_REQUEST)

        _set_meta('script_url', body.validated_data['script_url'])
        _set_meta('folder_url', body.validated_data['folder_url'])
        return Response({'success': True})
