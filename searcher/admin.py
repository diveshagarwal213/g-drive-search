from django.contrib import admin
from .models import DriveFile, FolderSyncState, SyncMeta
from .service import perform_gdrive_sync_v2


# ---------------------------------------------------------------------------
# DriveFile
# ---------------------------------------------------------------------------


@admin.register(DriveFile)
class DriveFileAdmin(admin.ModelAdmin):
    list_display = ("name", "extension", "mime_type", "modified_date", "size", "path")
    search_fields = ("name", "path", "drive_id", "extension")
    list_filter = ("extension", "mime_type")
    ordering = ("-modified_date",)


# ---------------------------------------------------------------------------
# FolderSyncState
# ---------------------------------------------------------------------------


@admin.register(FolderSyncState)
class FolderSyncStateAdmin(admin.ModelAdmin):
    list_display = ("path_or_root", "status", "error_msg_short", "updated_at")
    list_filter = ("status",)
    search_fields = ("folder_id", "path", "name")
    ordering = ("created_at",)
    readonly_fields = ("folder_id", "name", "path", "created_at", "updated_at")
    actions = ["sync_selected_folders"]

    @admin.display(description="Path")
    def path_or_root(self, obj):
        return obj.path or "(root)"

    @admin.display(description="Error")
    def error_msg_short(self, obj):
        return obj.error_msg[:80] if obj.error_msg else ""

    @admin.action(description="Sync selected folders now")
    def sync_selected_folders(self, request, queryset):
        from .service import _fetch_folder, _build_drive_file_objs, _save_sync_time
        from django.db import transaction
        from .models import DriveFile

        try:
            script_url = SyncMeta.objects.get(key="script_url").value.strip()
        except SyncMeta.DoesNotExist:
            self.message_user(
                request, "Error: 'script_url' not found in SyncMeta.", level="error"
            )
            return
        if not script_url:
            self.message_user(request, "Error: 'script_url' is empty.", level="error")
            return

        done = 0
        failed = 0
        files_saved = 0

        for folder in queryset:
            print(
                f"[sync selected] Processing: {folder.path or 'root'!r} | id={folder.folder_id}"
            )
            try:
                result = _fetch_folder(script_url, folder.folder_id)
            except Exception as exc:
                print(f"  ERROR: {exc}")
                folder.status = FolderSyncState.FAILED
                folder.error_msg = str(exc)
                folder.save()
                failed += 1
                continue

            if not result.get("success"):
                err = result.get("error", "Unknown error")
                print(f"  ERROR from Apps Script: {err}")
                folder.status = FolderSyncState.FAILED
                folder.error_msg = err
                folder.save()
                failed += 1
                continue

            files_data = result.get("files", [])
            subfolders_data = result.get("subfolders", [])
            print(f"  files={len(files_data)} | subfolders={len(subfolders_data)}")

            with transaction.atomic():
                # Save / update files
                file_objs = _build_drive_file_objs(files_data, parent_path=folder.path)
                if file_objs:
                    DriveFile.objects.bulk_create(file_objs, ignore_conflicts=True)

                # Save subfolders as DriveFile entries + enqueue if new
                for sub in subfolders_data:
                    sub_path = (
                        f"{folder.path}/{sub['name']}" if folder.path else sub["name"]
                    )
                    from .service import _parse_iso, FOLDER_MIME

                    DriveFile.objects.get_or_create(
                        drive_id=sub["id"],
                        defaults=dict(
                            name=sub["name"],
                            mime_type=FOLDER_MIME,
                            extension="",
                            modified_date=_parse_iso(sub.get("modifiedDate", "")),
                            url=sub.get("url", ""),
                            path=sub_path,
                            size=0,
                        ),
                    )
                    FolderSyncState.objects.get_or_create(
                        folder_id=sub["id"],
                        defaults=dict(
                            name=sub["name"],
                            path=sub_path,
                            status=FolderSyncState.PENDING,
                        ),
                    )

                folder.status = FolderSyncState.DONE
                folder.error_msg = ""
                folder.save()

            files_saved += len(file_objs)
            done += 1

        _save_sync_time()

        msg = f"Sync done: {done} folder(s) indexed, {files_saved} file(s) saved."
        if failed:
            msg += f" ⚠ {failed} folder(s) failed (see error column)."
        level = "warning" if failed else "success"
        self.message_user(request, msg, level=level)


# ---------------------------------------------------------------------------
# SyncMeta
# ---------------------------------------------------------------------------


def _get_sync_urls():
    """Read script_url and folder_url from SyncMeta. Returns (script_url, folder_url, error)."""
    try:
        script_url = SyncMeta.objects.get(key="script_url").value.strip()
        folder_url = SyncMeta.objects.get(key="folder_url").value.strip()
    except SyncMeta.DoesNotExist:
        return (
            None,
            None,
            "'script_url' or 'folder_url' keys missing. Run 'Create default keys' first.",
        )

    if not script_url or not folder_url:
        return None, None, "'script_url' and 'folder_url' must not be empty."

    return script_url, folder_url, None


@admin.register(SyncMeta)
class SyncMetaAdmin(admin.ModelAdmin):
    list_display = ("key", "value")
    actions = ["create_default_keys", "fetch_and_sync", "retry_failed_folders"]

    # ------------------------------------------------------------------
    @admin.action(description="① Create default keys ('folder_url' & 'script_url')")
    def create_default_keys(self, request, queryset):
        created = 0
        for k in ["folder_url", "script_url"]:
            _, made = SyncMeta.objects.get_or_create(key=k, defaults={"value": ""})
            if made:
                created += 1
        self.message_user(
            request, f"Default keys ensured. Created {created} new key(s)."
        )

    # ------------------------------------------------------------------
    @admin.action(
        description="② Full Sync — clear DB and re-index everything from root"
    )
    def fetch_and_sync(self, request, queryset):
        script_url, folder_url, err = _get_sync_urls()
        if err:
            self.message_user(request, f"Error: {err}", level="error")
            return

        res = perform_gdrive_sync_v2(script_url, folder_url, retry_failed=False)

        if not res.get("success"):
            self.message_user(
                request, f"Sync failed: {res.get('error')}", level="error"
            )
            return

        msg = (
            f"Sync complete! "
            f"{res['count']} items in DB | "
            f"{res['folders_done']} folders indexed"
        )
        if res["folders_failed"]:
            msg += f" | ⚠ {res['folders_failed']} folder(s) failed — use 'Retry failed folders' to retry."
        self.message_user(request, msg)

    # ------------------------------------------------------------------
    @admin.action(
        description="③ Retry Failed Folders — re-attempt only folders that errored"
    )
    def retry_failed_folders(self, request, queryset):
        script_url, _, err = _get_sync_urls()
        if err:
            self.message_user(request, f"Error: {err}", level="error")
            return

        failed_before = FolderSyncState.objects.filter(
            status=FolderSyncState.FAILED
        ).count()
        if not failed_before:
            self.message_user(request, "No failed folders to retry.", level="warning")
            return

        res = perform_gdrive_sync_v2(script_url, retry_failed=True)

        if not res.get("success"):
            self.message_user(
                request, f"Retry failed: {res.get('error')}", level="error"
            )
            return

        msg = (
            f"Retry complete! "
            f"{res['count']} total items in DB | "
            f"{res['folders_done']} folders now done"
        )
        if res["folders_failed"]:
            msg += f" | ⚠ {res['folders_failed']} still failing."
        self.message_user(request, msg)
