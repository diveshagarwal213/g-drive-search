from datetime import datetime, timezone

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import DriveFile, SyncMeta
from .serializers import (
    DriveFileSerializer,
    SearchQuerySerializer,
)

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _get_meta(key, default=''):
    try:
        return SyncMeta.objects.get(key=key).value
    except SyncMeta.DoesNotExist:
        return default




# ---------------------------------------------------------------------------
# GET /api/stats/
# ---------------------------------------------------------------------------

class StatsView(APIView):
    """
    Returns aggregate statistics about the indexed database.

    GET /api/stats/
    Response: { count, last_sync }
    """

    def get(self, request):
        return Response({
            'count':      DriveFile.objects.count(),
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

