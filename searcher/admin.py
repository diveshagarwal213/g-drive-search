from django.contrib import admin
from .models import DriveFile, SyncMeta


@admin.register(DriveFile)
class DriveFileAdmin(admin.ModelAdmin):
    list_display  = ('name', 'extension', 'mime_type', 'modified_date', 'size', 'path')
    search_fields = ('name', 'path', 'drive_id', 'extension')
    list_filter   = ('extension', 'mime_type')
    ordering      = ('-modified_date',)


@admin.register(SyncMeta)
class SyncMetaAdmin(admin.ModelAdmin):
    list_display = ('key', 'value')
