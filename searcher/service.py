import re
import requests as http_requests
from datetime import datetime, timezone
from django.db import transaction
from .models import DriveFile, SyncMeta

FOLDER_MIME = 'application/vnd.google-apps.folder'


def extract_folder_id(raw: str) -> str:
    """Extract folder ID from a URL or return raw ID."""
    raw = raw.strip()
    match = re.search(r'/folders/([a-zA-Z0-9_-]{25,})', raw)
    return match.group(1) if match else raw


def perform_gdrive_sync(script_url: str, folder_url: str) -> dict:
    """
    Common logic to synchronize Google Drive metadata with Django models.
    Returns a dictionary indicating success/failure, total count synced, or an error.
    """
    folder_id = extract_folder_id(folder_url)

    try:
        resp = http_requests.get(script_url, params={'id': folder_id}, timeout=60)
        resp.raise_for_status()
        result = resp.json()
    except Exception as exc:
        return {'success': False, 'error': f"HTTP request failed: {str(exc)}"}

    if not result.get('success'):
        return {'success': False, 'error': result.get('error', 'Unknown Apps Script error')}

    files_data = result.get('files', [])

    with transaction.atomic():
        # Clean all existing records
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
        obj, _ = SyncMeta.objects.get_or_create(key='last_sync_time')
        obj.value = sync_time
        obj.save()

    return {'success': True, 'count': len(objs), 'last_sync': sync_time}
