import hashlib
from urllib.parse import urlparse

from django.shortcuts import render, get_object_or_404

from .models import Website, PolicySnapshot
from . import scraper


def home(request):
    context = {}
    url = request.GET.get("url", "").strip()

    if url:
        result = scraper.get_privacy_policy(url)
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

            content_hash = hashlib.sha256(result["text"].encode("utf-8")).hexdigest()
            latest = website.snapshots.first()
            if not latest or latest.hash != content_hash:
                PolicySnapshot.objects.create(
                    website=website,
                    content=result["text"],
                    hash=content_hash,
                )

            context["website"] = website

    return render(request, "tracker/home.html", context)


def mission(request):
    return render(request, "tracker/mission.html")


def privacy(request):
    return render(request, "tracker/privacy.html")


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
