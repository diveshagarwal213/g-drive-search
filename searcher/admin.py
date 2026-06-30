from django.contrib import admin
from .models import DriveFile, SyncMeta
from .service import perform_gdrive_sync


@admin.register(DriveFile)
class DriveFileAdmin(admin.ModelAdmin):
    list_display  = ('name', 'extension', 'mime_type', 'modified_date', 'size', 'path')
    search_fields = ('name', 'path', 'drive_id', 'extension')
    list_filter   = ('extension', 'mime_type')
    ordering      = ('-modified_date',)


@admin.register(SyncMeta)
class SyncMetaAdmin(admin.ModelAdmin):
    list_display = ('key', 'value')
    actions = ['create_default_keys', 'fetch_and_sync']

    @admin.action(description="Create default keys ('folder_url' & 'script_url')")
    def create_default_keys(self, request, queryset):
        created_count = 0
        for k in ['folder_url', 'script_url']:
            obj, created = SyncMeta.objects.get_or_create(key=k, defaults={'value': ''})
            if created:
                created_count += 1
        self.message_user(request, f"Ensured default keys exist. Created {created_count} new key(s).")

    @admin.action(description="Trigger Fetch & Sync from Google Drive")
    def fetch_and_sync(self, request, queryset):
        try:
            script_url = SyncMeta.objects.get(key='script_url').value.strip()
            folder_url = SyncMeta.objects.get(key='folder_url').value.strip()
        except SyncMeta.DoesNotExist:
            self.message_user(
                request, 
                "Error: 'script_url' or 'folder_url' keys do not exist in SyncMeta database. Run 'Create default keys' first.", 
                level='error'
            )
            return

        if not script_url or not folder_url:
            self.message_user(request, "Error: 'script_url' and 'folder_url' values must not be empty.", level='error')
            return

        res = perform_gdrive_sync(script_url, folder_url)
        if not res.get('success'):
            self.message_user(request, f"Sync failed: {res.get('error')}", level='error')
            return

        self.message_user(request, f"Sync complete! Successfully indexed {res.get('count')} files/folders.")
