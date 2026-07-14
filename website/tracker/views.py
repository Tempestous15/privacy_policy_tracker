from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import UserCreationForm
from django.core.cache import cache
from django.http import JsonResponse
from django.shortcuts import render, get_object_or_404, redirect
from django.views.decorators.http import require_POST
from rest_framework.authtoken.models import Token

from . import services
from .models import SavedSite, Website
from .services import get_ai_summary, perform_lookup

# Lookups per identity (account, or IP for anonymous visitors) per hour.
# Each lookup triggers outbound scraping, so it has to be bounded or a
# single visitor/account could hammer other sites. Logged-in users share
# this budget between the web form and the browser extension (see
# tracker/api.py). The classifier that runs on the result is free/local, so
# this limit is only about scrape load, not API cost.
LOOKUPS_PER_HOUR = 15

# AI summaries are the only remaining path that can trigger a paid Anthropic
# API call (see services.get_ai_summary), so they get their own, much
# smaller budget, separate from LOOKUPS_PER_HOUR.
AI_SUMMARIES_PER_HOUR = 5


def _client_ip(request):
    # Behind nginx, REMOTE_ADDR is always 127.0.0.1; nginx puts the real
    # client address at the front of X-Forwarded-For.
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "unknown")


def _lookup_throttle_key(request):
    if request.user.is_authenticated:
        return f"user:{request.user.id}"
    return f"ip:{_client_ip(request)}"


def _rate_limited(key, limit, namespace="lookup-throttle"):
    cache_key = f"{namespace}:{key}"
    try:
        count = cache.incr(cache_key)
    except ValueError:  # key doesn't exist yet
        cache.set(cache_key, 1, 3600)
        count = 1
    return count > limit


def home(request):
    context = {}
    url = request.GET.get("url", "").strip()
    user = request.user if request.user.is_authenticated else None
    context["has_api_key"] = bool(services.resolve_api_key(user))
    context["has_saved_api_key"] = services.has_saved_api_key(user)

    if url and _rate_limited(_lookup_throttle_key(request), LOOKUPS_PER_HOUR):
        context["submitted_url"] = url
        context["result"] = {
            "input_url": url,
            "found": False,
            "error": "Too many lookups from your address in the past hour. "
                     "Please wait a while and try again.",
        }
        return render(request, "tracker/home.html", context)

    if url:
        lookup = perform_lookup(url)
        context["submitted_url"] = url
        context["result"] = lookup["result"]
        if lookup["website"] is not None:
            context["website"] = lookup["website"]
            context["snapshot"] = lookup["snapshot"]

    return render(request, "tracker/home.html", context)


@require_POST
def ai_summary(request, website_id):
    website = get_object_or_404(Website, pk=website_id)

    if _rate_limited(_lookup_throttle_key(request), AI_SUMMARIES_PER_HOUR, namespace="ai-summary-throttle"):
        return JsonResponse(
            {
                "error": f"Too many AI summary requests from your address in the past hour "
                         f"(limit {AI_SUMMARIES_PER_HOUR}/hour). Please wait and try again."
            },
            status=429,
        )

    # The button that triggers this is disabled client-side whenever
    # resolve_api_key() would come back empty (see _summary_panel.html), so
    # in practice this only ever runs in "mock" mode if state went stale
    # between page load and click (e.g. the key was removed in another tab).
    user = request.user if request.user.is_authenticated else None
    resolved_key = services.resolve_api_key(user)
    mode = "real" if resolved_key else "mock"

    try:
        result = get_ai_summary(website, mode, user=user)
    except ValueError as e:
        return JsonResponse({"error": str(e)}, status=400)

    return JsonResponse({
        "summary": result["summary"],
        "summary_error": result["summary_error"],
        "mock": mode == "mock",
    })


@login_required
def manage_api_key(request):
    """Add/remove *your own* Anthropic API key -- see services.py. Mirrors
    manage_token's action=save/clear + redirect pattern below."""
    if request.method == "POST":
        action = request.POST.get("action")
        if action == "save":
            api_key = request.POST.get("api_key", "").strip()
            if api_key:
                services.save_user_api_key(request.user, api_key)
                messages.success(request, "API key saved.")
        elif action == "clear":
            services.clear_user_api_key(request.user)
            messages.success(request, "API key removed.")
    return redirect("tracker:dashboard")


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
    if request.method == "POST" and request.POST.get("url"):
        url = request.POST.get("url", "").strip()
        if _rate_limited(_lookup_throttle_key(request), LOOKUPS_PER_HOUR):
            messages.error(
                request,
                "Too many lookups from your account in the past hour. Please wait and try again.",
            )
        else:
            lookup = perform_lookup(url)
            if lookup["website"] is not None:
                SavedSite.objects.get_or_create(user=request.user, website=lookup["website"])
                messages.success(request, f"Added {lookup['website'].name}.")
            else:
                messages.error(request, lookup["result"].get("error") or "No privacy policy found for that URL.")
        return redirect("tracker:dashboard")

    saved_sites = (
        SavedSite.objects.filter(user=request.user)
        .select_related("website")
        .order_by("-saved_at")
    )
    saved_sites_data = []
    for saved_site in saved_sites:
        snapshot = saved_site.website.snapshots.first()
        saved_sites_data.append({
            "saved_site": saved_site,
            "content": snapshot.content if snapshot else None,
            "script_id": f"policy-text-{saved_site.website.id}",
        })

    has_token = Token.objects.filter(user=request.user).exists()
    # Only present right after generate_token/manage_token issues a new one --
    # the raw key is only ever available at creation time, so this is the one
    # chance to show it to the user for pasting into the extension.
    new_token = request.session.pop("new_extension_token", None)
    return render(
        request,
        "tracker/dashboard.html",
        {
            "saved_sites_data": saved_sites_data,
            "has_token": has_token,
            "new_token": new_token,
            "has_api_key": bool(services.resolve_api_key(request.user)),
            "has_saved_api_key": services.has_saved_api_key(request.user),
        },
    )


@login_required
def manage_token(request):
    if request.method == "POST":
        action = request.POST.get("action")
        if action == "revoke":
            Token.objects.filter(user=request.user).delete()
            messages.success(request, "Extension access token revoked.")
        elif action == "generate":
            Token.objects.filter(user=request.user).delete()
            token = Token.objects.create(user=request.user)
            request.session["new_extension_token"] = token.key
    return redirect("tracker:dashboard")


def snapshot_detail(request, website_id):
    website = get_object_or_404(Website, pk=website_id)
    snapshot = website.snapshots.first()
    user = request.user if request.user.is_authenticated else None
    return render(
        request,
        "tracker/snapshot_detail.html",
        {
            "website": website,
            "snapshot": snapshot,
            "has_api_key": bool(services.resolve_api_key(user)),
            "has_saved_api_key": services.has_saved_api_key(user),
        },
    )
