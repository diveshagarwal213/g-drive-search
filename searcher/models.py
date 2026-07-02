from django.db import models


class DriveFile(models.Model):
    """
    Mirrors the original browser SQLite 'files' table.
    Stores indexed Google Drive file/folder metadata.
    """
    drive_id      = models.CharField(max_length=255, unique=True, db_index=True)
    name          = models.TextField(db_index=True)
    mime_type     = models.CharField(max_length=255, blank=True)
    extension     = models.CharField(max_length=50, blank=True, db_index=True)
    modified_date = models.DateTimeField(null=True, blank=True)
    url           = models.TextField(blank=True)
    path          = models.TextField(blank=True)
    size          = models.BigIntegerField(default=0)

    class Meta:
        ordering = ['-modified_date']

    def __str__(self):
        return self.name

    @property
    def is_folder(self):
        return self.mime_type == 'application/vnd.google-apps.folder'

    def to_dict(self):
        return {
            'id':            self.drive_id,
            'name':          self.name,
            'mime_type':     self.mime_type,
            'extension':     self.extension,
            'modified_date': self.modified_date.isoformat() if self.modified_date else None,
            'url':           self.url,
            'path':          self.path,
            'size':          self.size,
        }


class SyncMeta(models.Model):
    """
    Key-value store for app settings and sync metadata.
    Replaces browser localStorage.
    """
    key   = models.CharField(max_length=100, unique=True)
    value = models.TextField(blank=True)

    def __str__(self):
        return f'{self.key} = {self.value[:60]}'


class FolderSyncState(models.Model):
    """
    Tracks the sync status of every Google Drive folder discovered during sync.
    Enables folder-by-folder processing with resume / retry on failure.
    """
    PENDING = 'pending'
    DONE    = 'done'
    FAILED  = 'failed'
    STATUS_CHOICES = [
        (PENDING, 'Pending'),
        (DONE,    'Done'),
        (FAILED,  'Failed'),
    ]

    folder_id  = models.CharField(max_length=255, unique=True, db_index=True)
    name       = models.CharField(max_length=500, blank=True)
    path       = models.TextField(blank=True)        # path of the folder itself
    status     = models.CharField(max_length=20, choices=STATUS_CHOICES,
                                  default=PENDING, db_index=True)
    error_msg  = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['created_at']

    def __str__(self):
        return f"{self.path or 'root'} [{self.status}]"

