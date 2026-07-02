# Generated manually - adds FolderSyncState model

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('searcher', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='FolderSyncState',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('folder_id', models.CharField(db_index=True, max_length=255, unique=True)),
                ('name', models.CharField(blank=True, max_length=500)),
                ('path', models.TextField(blank=True)),
                ('status', models.CharField(
                    choices=[('pending', 'Pending'), ('done', 'Done'), ('failed', 'Failed')],
                    db_index=True, default='pending', max_length=20,
                )),
                ('error_msg', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'ordering': ['created_at'],
            },
        ),
    ]
