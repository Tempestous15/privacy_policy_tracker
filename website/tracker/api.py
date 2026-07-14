"""REST API backing the browser extension. Session-authenticated web pages
never call this -- it's TokenAuthentication only (see REST_FRAMEWORK in
config/settings.py), so there's no CSRF concern here.
"""

from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from . import services
from .models import SavedSite, Website
from .services import get_ai_summary, perform_lookup
from .views import AI_SUMMARIES_PER_HOUR, LOOKUPS_PER_HOUR, _lookup_throttle_key, _rate_limited


def _serialize_website(website):
    return {
        "id": website.id,
        "name": website.name,
        "url": website.url,
        "privacy_policy_url": website.privacy_policy_url,
    }


def _serialize_snapshot(snapshot):
    # "content" lets the client run the local classifier (redflags-engine.js)
    # itself; "summary"/"summary_error" reflect whatever the last on-demand
    # AI summary request produced, if any.
    if snapshot is None:
        return {"content": None, "summary": None, "summary_error": ""}
    return {
        "content": snapshot.content,
        "summary": snapshot.summary,
        "summary_error": snapshot.summary_error,
    }


class LogoutView(APIView):
    def post(self, request):
        request.user.auth_token.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class LookupView(APIView):
    def get(self, request):
        url = request.query_params.get("url", "").strip()
        if not url:
            return Response({"error": "url is required"}, status=status.HTTP_400_BAD_REQUEST)

        if _rate_limited(_lookup_throttle_key(request), LOOKUPS_PER_HOUR):
            return Response(
                {
                    "error": f"Too many lookups from your account in the past hour "
                             f"(limit {LOOKUPS_PER_HOUR}/hour). Please wait and try again."
                },
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )

        lookup = perform_lookup(url)
        website = lookup["website"]
        snapshot = lookup["snapshot"]
        saved = False

        if website is not None and request.query_params.get("save") == "true":
            SavedSite.objects.get_or_create(user=request.user, website=website)
            saved = True
        elif website is not None:
            saved = SavedSite.objects.filter(user=request.user, website=website).exists()

        return Response({
            "submitted_url": url,
            "result": lookup["result"],
            "website": _serialize_website(website) if website else None,
            "content": snapshot.content if snapshot else None,
            "saved": saved,
        })


class AISummaryView(APIView):
    """On-demand LLM summary, called only when the user taps "Get AI summary"
    in the extension -- never automatically from LookupView."""

    def post(self, request, website_id):
        website = get_object_or_404(Website, pk=website_id)

        if _rate_limited(_lookup_throttle_key(request), AI_SUMMARIES_PER_HOUR, namespace="ai-summary-throttle"):
            return Response(
                {
                    "error": f"Too many AI summary requests from your account in the past hour "
                             f"(limit {AI_SUMMARIES_PER_HOUR}/hour). Please wait and try again."
                },
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )

        # The button that triggers this is disabled client-side whenever
        # ApiKeyStatusView reports no key available, so this only runs in
        # "mock" mode if state went stale between fetching that status and
        # clicking (e.g. the key was removed in another session).
        resolved_key = services.resolve_api_key(request.user)
        mode = "real" if resolved_key else "mock"

        try:
            result = get_ai_summary(website, mode, user=request.user)
        except ValueError as e:
            return Response({"error": str(e)}, status=status.HTTP_400_BAD_REQUEST)

        return Response({
            "summary": result["summary"],
            "summary_error": result["summary_error"],
            "mock": mode == "mock",
        })


class ApiKeyView(APIView):
    """Add/remove *your own* Anthropic API key -- see services.py. Only ever
    saved here, when the user explicitly submits this, never as a side
    effect of using a key elsewhere."""

    def post(self, request):
        api_key = (request.data.get("api_key") or "").strip()
        if not api_key:
            return Response({"error": "api_key is required"}, status=status.HTTP_400_BAD_REQUEST)
        services.save_user_api_key(request.user, api_key)
        return Response({"has_saved_api_key": True})

    def delete(self, request):
        services.clear_user_api_key(request.user)
        return Response({"has_saved_api_key": False})


class ApiKeyStatusView(APIView):
    def get(self, request):
        return Response({
            "has_api_key": bool(services.resolve_api_key(request.user)),
            "has_saved_api_key": services.has_saved_api_key(request.user),
        })


class SavedSiteListCreateView(APIView):
    def get(self, request):
        saved_sites = (
            SavedSite.objects.filter(user=request.user)
            .select_related("website")
            .order_by("-saved_at")
        )
        data = []
        for saved_site in saved_sites:
            website = saved_site.website
            entry = {
                "saved_at": saved_site.saved_at,
                "website": _serialize_website(website),
            }
            entry.update(_serialize_snapshot(website.snapshots.first()))
            data.append(entry)
        return Response(data)

    def post(self, request):
        website_id = request.data.get("website_id")
        website = Website.objects.filter(pk=website_id).first()
        if website is None:
            return Response({"error": "unknown website_id"}, status=status.HTTP_400_BAD_REQUEST)

        saved_site, _ = SavedSite.objects.get_or_create(user=request.user, website=website)
        entry = {
            "saved_at": saved_site.saved_at,
            "website": _serialize_website(website),
        }
        entry.update(_serialize_snapshot(website.snapshots.first()))
        return Response(entry, status=status.HTTP_201_CREATED)


class SavedSiteDetailView(APIView):
    def _get_saved_site(self, request, website_id):
        return SavedSite.objects.filter(
            user=request.user, website_id=website_id
        ).select_related("website").first()

    def get(self, request, website_id):
        saved_site = self._get_saved_site(request, website_id)
        if saved_site is None:
            return Response(status=status.HTTP_404_NOT_FOUND)

        website = saved_site.website
        snapshot = website.snapshots.first()
        data = {"website": _serialize_website(website)}
        if snapshot is not None:
            data["snapshot"] = {
                "captured_at": snapshot.captured_at,
                "content": snapshot.content,
                "summary": snapshot.summary,
                "summary_error": snapshot.summary_error,
            }
        else:
            data["snapshot"] = None
        return Response(data)

    def delete(self, request, website_id):
        saved_site = self._get_saved_site(request, website_id)
        if saved_site is None:
            return Response(status=status.HTTP_404_NOT_FOUND)
        saved_site.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
