"""Shared lookup pipeline used by both the web form (views.home) and the
browser-extension API (tracker.api). Kept in one place so the scrape ->
cache behavior can't drift between the two callers.

The primary analysis (risk badge + red flags) is a non-LLM classifier that
runs client-side in the browser (see classifier/ and redflags-engine.js) --
this module never touches it. The Anthropic-generated plain-English summary
is optional and on-demand: see get_ai_summary(), called only when a user
clicks "Get AI summary", not on every lookup.

API keys are bring-your-own, not a shared site secret: each user may save
their own Anthropic key (only when they explicitly opt in -- see
save_user_api_key), used only for their own on-demand summaries. See
resolve_api_key() for the fallback order.
"""

import hashlib
import os
from urllib.parse import urlparse

from .models import PolicySnapshot, Website
from . import scraper
from . import summarizer


def perform_lookup(url):
    """Look up `url`'s privacy policy, reusing/caching a Website + PolicySnapshot.

    Returns a dict with:
      - result: the dict from scraper.get_privacy_policy()
      - website: the Website instance, or None if the policy wasn't found
      - snapshot: the PolicySnapshot to display, or None
    """
    normalized_url = scraper.normalize_url(url)
    cached_website = Website.objects.filter(url=normalized_url).first()
    cached_policy_url = cached_website.privacy_policy_url if cached_website else None

    result = scraper.get_privacy_policy(url, cached_policy_url=cached_policy_url)

    website = None
    snapshot = None

    if result["found"]:
        site_url = result["input_url"]
        name = urlparse(site_url).netloc or site_url

        website, _ = Website.objects.update_or_create(
            url=site_url,
            defaults={
                "name": name,
                "privacy_policy_url": result["policy_url"],
            },
        )

        content_hash = hashlib.sha256(result["text"].encode("utf-8")).hexdigest()
        latest = website.snapshots.first()

        if not latest or latest.hash != content_hash:
            snapshot = PolicySnapshot(
                website=website,
                content=result["text"],
                hash=content_hash,
            )
            snapshot.save()
        else:
            snapshot = latest

    return {
        "result": result,
        "website": website,
        "snapshot": snapshot,
    }


def get_ai_summary(website, mode, user=None, api_key=None):
    """Generate (and for mode == "real", persist) the optional LLM summary
    for a website's latest snapshot. Called only from the on-demand "Get AI
    summary" button, never from perform_lookup().

    `api_key`, if given, is used for this call only (see resolve_api_key).
    `user` is only used to look up their saved key when `api_key` isn't
    given directly.

    Returns a dict with:
      - summary: the summary dict, or None if generation failed
      - summary_error: the failure message, or "" on success
    Raises ValueError if the website has no snapshot yet.
    """
    snapshot = website.snapshots.first()
    if snapshot is None:
        raise ValueError("Website has no snapshot to summarize yet.")

    if mode == "mock":
        # Mock runs are never written to PolicySnapshot, matching the
        # previous inline behavior -- switching to "real" later can't
        # accidentally serve stale mock data from the cache.
        return {"summary": summarizer.mock_summarize_policy(snapshot.content), "summary_error": ""}

    resolved_key = resolve_api_key(user, api_key)
    try:
        summary = summarizer.summarize_policy(snapshot.content, api_key=resolved_key)
        snapshot.summary = summary
        snapshot.summary_error = ""
        snapshot.save(update_fields=["summary", "summary_error"])
        return {"summary": summary, "summary_error": ""}
    except summarizer.SummarizerError as e:
        # Covers empty text, missing API key/package, API failures, and
        # malformed model output.
        snapshot.summary_error = str(e)
        snapshot.save(update_fields=["summary_error"])
        return {"summary": None, "summary_error": str(e)}


def _saved_key(user):
    """The Anthropic key this user previously chose to save, if any. Never
    shared across users -- each row is scoped to its own OneToOne user."""
    if user is None or not getattr(user, "is_authenticated", False):
        return ""
    saved = getattr(user, "tracker_api_key", None)
    return (saved.anthropic_api_key if saved else "") or ""


def has_saved_api_key(user):
    return bool(_saved_key(user))


def resolve_api_key(user, explicit_key=None):
    """Fallback order for a single AI-summary call: a key typed in for this
    call, then the user's saved key, then the deployment-level
    ANTHROPIC_API_KEY env var (kept so single-operator/dev usage that
    predates per-user keys keeps working unchanged)."""
    return explicit_key or _saved_key(user) or os.environ.get("ANTHROPIC_API_KEY") or None


def save_user_api_key(user, api_key):
    """Persist `user`'s own key -- only called when they explicitly checked
    "save this key", never automatically."""
    from .models import UserAPIKey

    obj, _ = UserAPIKey.objects.get_or_create(user=user)
    obj.anthropic_api_key = api_key
    obj.save(update_fields=["anthropic_api_key"])


def clear_user_api_key(user):
    from .models import UserAPIKey

    UserAPIKey.objects.filter(user=user).update(anthropic_api_key="")
