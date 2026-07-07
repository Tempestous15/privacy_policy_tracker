from django.db import models


class Website(models.Model):
    name = models.CharField(max_length=255)
    url = models.URLField(unique=True)
    privacy_policy_url = models.URLField(blank=True, default="")
    added_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-added_at"]

    def __str__(self):
        return self.name


class PolicySnapshot(models.Model):
    website = models.ForeignKey(Website, on_delete=models.CASCADE, related_name="snapshots")
    captured_at = models.DateTimeField(auto_now_add=True)
    content = models.TextField()
    hash = models.CharField(max_length=64, db_index=True)

    class Meta:
        ordering = ["-captured_at"]

    def __str__(self):
        return f"{self.website.name} - {self.captured_at}"
