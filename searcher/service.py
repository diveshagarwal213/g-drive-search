import re
import requests as http_requests
from datetime import datetime
from django.db import transaction
from .models import DriveFile, FolderSyncState, SyncMeta

FOLDER_MIME = "application/vnd.google-apps.folder"

_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
}


def _make_session() -> http_requests.Session:
    s = http_requests.Session()
    s.headers.update(_BROWSER_HEADERS)
    return s


def extract_folder_id(raw: str) -> str:
    """Extract folder ID from a URL or return raw ID."""
    raw = raw.strip()
    match = re.search(r"/folders/([a-zA-Z0-9_-]{25,})", raw)
    return match.group(1) if match else raw


def _fetch_folder(script_url: str, folder_id: str) -> dict:
    """
    Call Apps Script for a single folder.
    Returns { success, files: [...], subfolders: [...] }

    Uses manual redirect handling so cookies travel from
    script.google.com → script.googleusercontent.com correctly.
    """
    with _make_session() as session:
        r1 = session.get(
            script_url,
            params={"id": folder_id},
            timeout=60,
            allow_redirects=False,
        )
        if r1.status_code in (301, 302, 303, 307, 308):
            redirect_url = r1.headers.get("Location", "")
            r2 = session.get(redirect_url, timeout=60)
            return r2.json()
        return r1.json()


# ---------------------------------------------------------------------------
# v1 — legacy single-shot (kept for reference, not used by admin action)
# ---------------------------------------------------------------------------

def perform_gdrive_sync(script_url: str, folder_url: str) -> dict:
    """Original single-shot sync (may timeout on large folders)."""
    folder_id = extract_folder_id(folder_url)
    print(f"[sync v1] Starting | folder_id={folder_id}")

    try:
        result = _fetch_folder(script_url, folder_id)
    except Exception as exc:
        print(f"[sync v1] ERROR: {exc}")
        return {"success": False, "error": str(exc)}

    if not result.get("success"):
        return {"success": False, "error": result.get("error", "Unknown error")}

    files_data = result.get("files", [])
    print(f"[sync v1] Got {len(files_data)} items")

    with transaction.atomic():
        DriveFile.objects.all().delete()
        objs = _build_drive_file_objs(files_data, parent_path="")
        DriveFile.objects.bulk_create(objs, ignore_conflicts=True)
        sync_time = _save_sync_time()

    print(f"[sync v1] Done | count={len(objs)}")
    return {"success": True, "count": len(objs), "last_sync": sync_time}


# ---------------------------------------------------------------------------
# v2 — folder-by-folder with DB-tracked state (resilient, retry-able)
# ---------------------------------------------------------------------------

def perform_gdrive_sync_v2(
    script_url: str,
    folder_url: str = "",
    retry_failed: bool = False,
) -> dict:
    """
    Folder-by-folder sync strategy:

    1. Enqueue root folder as 'pending' in FolderSyncState (or reset failed
       folders to 'pending' if retry_failed=True).
    2. Loop: pick next pending folder → call Apps Script → save files to
       DriveFile → enqueue discovered subfolders → mark folder done/failed.
    3. Failures are recorded with their error message and skipped so the rest
       of the tree can still be indexed.
    4. Returns final counts; call again with retry_failed=True to re-attempt
       any failed folders without re-indexing already-done ones.
    """

    if retry_failed:
        failed_qs = FolderSyncState.objects.filter(status=FolderSyncState.FAILED)
        count = failed_qs.update(status=FolderSyncState.PENDING, error_msg="")
        print(f"[sync v2] Retrying {count} previously failed folder(s)...")
    else:
        folder_id = extract_folder_id(folder_url)
        print(f"[sync v2] Fresh sync | root_folder_id={folder_id}")
        with transaction.atomic():
            DriveFile.objects.all().delete()
            FolderSyncState.objects.all().delete()
            FolderSyncState.objects.create(
                folder_id=folder_id,
                name="root",
                path="",
                status=FolderSyncState.PENDING,
            )

    folders_done = 0
    folders_failed = 0
    files_indexed = 0

    while True:
        pending = FolderSyncState.objects.filter(
            status=FolderSyncState.PENDING
        ).first()
        if not pending:
            break

        pending_count = FolderSyncState.objects.filter(
            status=FolderSyncState.PENDING
        ).count()
        print(
            f"[sync v2] Processing: {pending.path or 'root'!r} | "
            f"pending={pending_count} done={folders_done} failed={folders_failed}"
        )

        # ---- Call Apps Script ------------------------------------------------
        try:
            result = _fetch_folder(script_url, pending.folder_id)
        except Exception as exc:
            print(f"  ERROR fetching folder: {exc}")
            pending.status = FolderSyncState.FAILED
            pending.error_msg = str(exc)
            pending.save()
            folders_failed += 1
            continue

        if not result.get("success"):
            err = result.get("error", "Unknown Apps Script error")
            print(f"  ERROR from Apps Script: {err}")
            pending.status = FolderSyncState.FAILED
            pending.error_msg = err
            pending.save()
            folders_failed += 1
            continue

        files_data      = result.get("files", [])
        subfolders_data = result.get("subfolders", [])
        print(f"  files={len(files_data)} | subfolders={len(subfolders_data)}")

        # ---- Persist to DB ---------------------------------------------------
        with transaction.atomic():
            # Save files in this folder
            file_objs = _build_drive_file_objs(files_data, parent_path=pending.path)
            if file_objs:
                DriveFile.objects.bulk_create(file_objs, ignore_conflicts=True)

            # Save subfolders as DriveFile entries + enqueue for processing
            for sub in subfolders_data:
                sub_path = f"{pending.path}/{sub['name']}" if pending.path else sub["name"]

                mod_dt = _parse_iso(sub.get("modifiedDate", ""))
                DriveFile.objects.get_or_create(
                    drive_id=sub["id"],
                    defaults=dict(
                        name=sub["name"],
                        mime_type=FOLDER_MIME,
                        extension="",
                        modified_date=mod_dt,
                        url=sub.get("url", ""),
                        path=sub_path,
                        size=0,
                    ),
                )

                # Enqueue subfolder (skip if already known)
                FolderSyncState.objects.get_or_create(
                    folder_id=sub["id"],
                    defaults=dict(
                        name=sub["name"],
                        path=sub_path,
                        status=FolderSyncState.PENDING,
                    ),
                )

            pending.status = FolderSyncState.DONE
            pending.save()

        files_indexed += len(file_objs)
        folders_done += 1

    # ---- Finalise ------------------------------------------------------------
    sync_time = _save_sync_time()
    total_in_db = DriveFile.objects.count()
    remaining_failed = FolderSyncState.objects.filter(
        status=FolderSyncState.FAILED
    ).count()

    print(
        f"[sync v2] Finished | db_total={total_in_db} | "
        f"folders_done={folders_done} | folders_failed={remaining_failed} | "
        f"sync_time={sync_time}"
    )

    return {
        "success": True,
        "count": total_in_db,
        "folders_done": folders_done,
        "folders_failed": remaining_failed,
        "last_sync": sync_time,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_iso(raw: str):
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _build_drive_file_objs(files_data: list, parent_path: str) -> list:
    objs = []
    for f in files_data:
        name = f.get("name", "")
        dot  = name.rfind(".")
        ext  = name[dot + 1:].lower() if dot != -1 else ""
        if f.get("mimeType") == FOLDER_MIME:
            ext = ""

        file_path = f"{parent_path}/{name}" if parent_path else name

        objs.append(
            DriveFile(
                drive_id     = f.get("id", ""),
                name         = name,
                mime_type    = f.get("mimeType", ""),
                extension    = ext,
                modified_date= _parse_iso(f.get("modifiedDate", "")),
                url          = f.get("url", ""),
                path         = file_path,
                size         = f.get("size", 0) or 0,
            )
        )
    return objs


def _save_sync_time() -> str:
    sync_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    obj, _ = SyncMeta.objects.get_or_create(key="last_sync_time")
    obj.value = sync_time
    obj.save()
    return sync_time
