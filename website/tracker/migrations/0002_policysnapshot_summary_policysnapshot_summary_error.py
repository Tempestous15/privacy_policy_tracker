# Generated manually to add structured-summary fields to PolicySnapshot.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tracker', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='policysnapshot',
            name='summary',
            field=models.JSONField(blank=True, default=None, null=True),
        ),
        migrations.AddField(
            model_name='policysnapshot',
            name='summary_error',
            field=models.TextField(blank=True, default=''),
        ),
    ]
