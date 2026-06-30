from rest_framework import serializers

from .models import DriveFile


# ---------------------------------------------------------------------------
# Model serializer
# ---------------------------------------------------------------------------

class DriveFileSerializer(serializers.ModelSerializer):
    """
    Serializes a DriveFile instance.
    Maps 'drive_id' → 'id' so the frontend receives the same shape as before.
    """
    id            = serializers.CharField(source='drive_id', read_only=True)
    modified_date = serializers.DateTimeField(read_only=True)

    class Meta:
        model  = DriveFile
        fields = ['id', 'name', 'mime_type', 'extension',
                  'modified_date', 'url', 'path', 'size']


# ---------------------------------------------------------------------------
# Request / input serializers
# ---------------------------------------------------------------------------

class SearchQuerySerializer(serializers.Serializer):
    """Validates query-string parameters for GET /api/search/."""

    SORT_CHOICES = ['name-asc', 'name-desc', 'date-desc', 'date-asc',
                    'size-desc', 'size-asc']
    TYPE_CHOICES = ['all', 'folders', 'files', 'pdf', 'xls', 'doc', 'img', 'zip']

    q            = serializers.CharField(allow_blank=True, default='')
    case         = serializers.BooleanField(default=False)
    sort         = serializers.ChoiceField(choices=SORT_CHOICES, default='date-desc')
    type         = serializers.ChoiceField(choices=TYPE_CHOICES, default='all')
    folders_only = serializers.BooleanField(default=False)
    files_only   = serializers.BooleanField(default=False)
    start_date   = serializers.DateField(required=False, allow_null=True)
    end_date     = serializers.DateField(required=False, allow_null=True)

