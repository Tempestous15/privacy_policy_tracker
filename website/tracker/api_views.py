"""
api_views.py

Minimal JSON API for the browser extension (and any other future
non-Django client). Kept separate from views.py -- which renders HTML
pages for the website -- so the "serve a webpage" concern and the
"answer a JSON request" concern don't get tangled together. No scraping
or summarization logic lives here either; this module only parses the
request, calls tracker.scraper / tracker.summarizer, and shapes the
JSON response.

Currently exposes exactly one endpoint:

    POST /api/summarize-policy/
        Request:  {"site_url": str, "domain": str, "policy_url": str|null, "mode"?: "real"|"mock"}
        Response (200): the same JSON shape tracker.summarizer.summarize_policy()
                   already produces -- data_collected, data_usage,
                   third_party_sharing, retention, user_rights, red_flags,
                   plain_english_summary, risk_level, user_takeaways --
                   plus two additive fields: "policy_url" (the URL that was
                   actually summarized, useful when the client didn't find
                   one itself and this view discovered it server-side) and
                   "mock" (true if no real API call was made).
        Response (4xx/5xx): {"error": str, "domain"?: str}

No API keys are ever sent to or exposed by this endpoint. ANTHROPIC_API_KEY
stays server-side and is read only by tracker.summarizer, exactly as it
already is for the website's own views.

As a best-effort side effect (never allowed to fail the API response), a
successful real-mode scan is also persisted via Website/PolicySnapshot --
the same models views.home() already writes to -- so sites scanned from the
extension show up on the site's own Dashboard page too.
"""

from __future__ import annotations

import hashlib
import json
import os
from urllib.parse import urlparse

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from . import scraper
from . import summarizer
from .models import PolicySnapshot, Website

# Minimal, explicit CORS support for the browser extension's popup/background
# fetch calls. django-cors-headers isn't part of this project, and this is
# the only endpoint that needs cross-origin access, so a small local helper
# is simpler than adding a new dependency for one route. "*" is safe here
# because the endpoint takes no cookies/session credentials and returns no
# per-user data -- it only summarizes a public policy URL.
ALLOWED_ORIGIN = "*"


def _cors(response):
    response["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN
    response["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    response["Access-Control-Allow-Headers"] = "Content-Type"
    response["Access-Control-Max-Age"] = "600"
    return response


@csrf_exempt
@require_http_methods(["POST", "OPTIONS"])
def summarize_policy_api(request):
    # Browsers send a CORS preflight OPTIONS request before the real POST
    # whenever the request has a JSON body from a different origin. Answer
    # it with just the CORS headers and no body.
    if request.method == "OPTIONS":
        return _cors(JsonResponse({}))

    try:
        payload = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return _cors(JsonResponse({"error": "Request body must be valid JSON."}, status=400))

    if not isinstance(payload, dict):
        return _cors(JsonResponse({"error": "Request body must be a JSON object."}, status=400))

    site_url = str(payload.get("site_url") or "").strip()
    domain = str(payload.get("domain") or "").strip()
    client_policy_url = str(payload.get("policy_url") or "").strip() or None
    requested_mode = str(payload.get("mode") or "").strip().lower()

    if not site_url and not client_policy_url:
        return _cors(JsonResponse(
            {"error": "Provide at least a site_url or a policy_url."}, status=400
        ))

    normalized_site_url = scraper.normalize_url(site_url) if site_url else None
    cached_website = (
        Website.objects.filter(url=normalized_site_url).first() if normalized_site_url else None
    )

    resolved_policy_url = client_policy_url
    policy_text = None

    if resolved_policy_url:
        # The extension already found a link on the page -- fetch it directly
        # rather than re-running discovery.
        try:
            policy_soup = scraper.get_soup(resolved_policy_url)
        except Exception as e:
            return _cors(JsonResponse(
                {"error": f"Couldn't fetch the privacy policy page: {e}", "domain": domain or None},
                status=502,
            ))
        policy_text = scraper.extract_text(policy_soup)
    else:
        # The extension couldn't find a policy link on the page itself --
        # fall back to the same link-scan + common-paths discovery (with the
        # same cached-URL shortcut) the website's own tracking page uses.
        cached_policy_url = cached_website.privacy_policy_url if cached_website else None
        discovery = scraper.get_privacy_policy(site_url, cached_policy_url=cached_policy_url)
        if not discovery["found"]:
            return _cors(JsonResponse(
                {
                    "error": (
                        "Couldn't automatically find a privacy policy for this site. "
                        + (discovery["error"] or "")
                    ).strip(),
                    "domain": domain or discovery.get("input_url"),
                },
                status=404,
            ))
        resolved_policy_url = discovery["policy_url"]
        policy_text = discovery["text"]

    if not policy_text or not policy_text.strip():
        return _cors(JsonResponse(
            {"error": "The privacy policy page had no readable text to summarize.", "domain": domain or None},
            status=422,
        ))

    has_api_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
    mode = requested_mode or ("real" if has_api_key else "mock")

    try:
        if mode == "mock":
            summary = summarizer.mock_summarize_policy(policy_text)
        else:
            summary = summarizer.summarize_policy(policy_text)
    except summarizer.SummarizerError as e:
        return _cors(JsonResponse({"error": str(e), "domain": domain or None}, status=502))

    if normalized_site_url:
        _persist_scan(normalized_site_url, domain, resolved_policy_url, policy_text, summary, mode)

    summary["policy_url"] = resolved_policy_url
    summary["mock"] = mode == "mock"
    return _cors(JsonResponse(summary))


def _persist_scan(site_url, domain, policy_url, policy_text, summary, mode):
    """Best-effort write-through to the same Website/PolicySnapshot models
    views.home() uses, so extension-driven scans also show up on the
    Dashboard page. Never allowed to raise -- a persistence hiccup should
    never turn a successful summary into a failed API response."""
    try:
        name = domain or urlparse(site_url).netloc or site_url
        website, _ = Website.objects.update_or_create(
            url=site_url,
            defaults={"name": name, "privacy_policy_url": policy_url},
        )

        if mode != "mock":
            content_hash = hashlib.sha256(policy_text.encode("utf-8")).hexdigest()
            latest = website.snapshots.first()
            if not latest or latest.hash != content_hash:
                PolicySnapshot.objects.create(
                    website=website,
                    content=policy_text,
                    hash=content_hash,
                    summary=summary,
                    summary_error="",
                )
    except Exception:
        # Deliberately swallowed -- see docstring. Persistence is a bonus,
        # not a requirement for a successful scan response.
        pass
