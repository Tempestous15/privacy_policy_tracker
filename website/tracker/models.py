from django.conf import settings
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

    # Structured LLM summary from tracker.summarizer.summarize_policy(), or
    # None if summarization hasn't run / failed. summary_error holds the
    # failure message in the latter case. Both are populated in views.home().
    #
    # NOTE for later: a future multi-site dashboard view or a browser-extension
    # API endpoint can read `summary` directly off the latest snapshot for a
    # site instead of recomputing it.
    summary = models.JSONField(null=True, blank=True, default=None)
    summary_error = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["-captured_at"]

    def __str__(self):
        return f"{self.website.name} - {self.captured_at}"


class UserAPIKey(models.Model):
    """A user's own Anthropic API key, saved only when they explicitly opt
    in (see services.save_user_api_key) -- never a shared/site-wide secret.
    Used to generate that user's on-demand AI summaries with their own key
    instead of the server's ANTHROPIC_API_KEY env var."""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="tracker_api_key"
    )
    anthropic_api_key = models.CharField(max_length=200, blank=True, default="")

    def __str__(self):
        return f"API key for {self.user}"


class SavedSite(models.Model):
    """A user's personal bookmark of a (globally shared) Website."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="saved_sites"
    )
    website = models.ForeignKey(Website, on_delete=models.CASCADE, related_name="saved_by")
    saved_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-saved_at"]
        constraints = [
            models.UniqueConstraint(fields=["user", "website"], name="unique_user_website"),
        ]

    def __str__(self):
        return f"{self.user} saved {self.website.name}"
