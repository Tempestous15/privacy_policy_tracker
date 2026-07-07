import hashlib
import os
from urllib.parse import urlparse

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import UserCreationForm
from django.shortcuts import render, get_object_or_404, redirect

from .models import Website, PolicySnapshot
from . import scraper
from . import summarizer


def home(request):
    context = {}
    url = request.GET.get("url", "").strip()

    has_api_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
    # Default to mock mode if no key is configured yet, so the form works
    # out of the box with zero setup/cost. The <select> in home.html always
    # submits an explicit value once the form is used, so this default only
    # matters for the very first page load.
    mode = request.GET.get("mode") or ("real" if has_api_key else "mock")
    context["has_api_key"] = has_api_key
    context["mode"] = mode

    if url:
        # If we've scraped this site before, reuse its stored policy URL
        # instead of rediscovering it (skips the homepage fetch, link scan,
        # and common-path guessing on every repeat lookup).
        normalized_url = scraper.normalize_url(url)
        cached_website = Website.objects.filter(url=normalized_url).first()
        cached_policy_url = cached_website.privacy_policy_url if cached_website else None

        result = scraper.get_privacy_policy(url, cached_policy_url=cached_policy_url)
        context["submitted_url"] = url
        context["result"] = result

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
            context["website"] = website

            content_hash = hashlib.sha256(result["text"].encode("utf-8")).hexdigest()
            latest = website.snapshots.first()

            if mode == "mock":
                # Mock runs are never written to PolicySnapshot -- they're
                # rendered directly here so switching back to "real" mode
                # later can never accidentally serve stale mock data from
                # the cache. `latest` (if any) is passed through unchanged
                # so the "view full snapshot" link still works for a
                # previously-generated real summary.
                context["mock_summary"] = summarizer.mock_summarize_policy(result["text"])
                context["snapshot"] = latest
            else:
                if not latest or latest.hash != content_hash:
                    snapshot = PolicySnapshot(
                        website=website,
                        content=result["text"],
                        hash=content_hash,
                    )
                    try:
                        snapshot.summary = summarizer.summarize_policy(result["text"])
                        snapshot.summary_error = ""
                    except summarizer.SummarizerError as e:
                        # Covers empty text, missing API key/package, API
                        # failures, and malformed model output -- the scrape
                        # still succeeded, so we keep the snapshot and just
                        # record why summarization didn't work.
                        snapshot.summary = None
                        snapshot.summary_error = str(e)
                    snapshot.save()
                else:
                    snapshot = latest
                context["snapshot"] = snapshot

    return render(request, "tracker/home.html", context)


def mission(request):
    return render(request, "tracker/mission.html")


def privacy(request):
    return render(request, "tracker/privacy.html")


def register(request):
    if request.method == "POST":
        form = UserCreationForm(request.POST)
        if form.is_valid():
            form.save()
            messages.success(request, "Account created. You can now sign in.")
            return redirect("login")
    else:
        form = UserCreationForm()
    return render(request, "registration/register.html", {"form": form})


@login_required
def dashboard(request):
    websites = Website.objects.all()[:20]
    return render(request, "tracker/dashboard.html", {"websites": websites})


def snapshot_detail(request, website_id):
    website = get_object_or_404(Website, pk=website_id)
    snapshot = website.snapshots.first()
    return render(
        request,
        "tracker/snapshot_detail.html",
        {"website": website, "snapshot": snapshot},
    )
