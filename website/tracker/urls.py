from django.urls import path
from rest_framework.authtoken.views import obtain_auth_token

from . import api, views
from . import api_views

app_name = "tracker"

urlpatterns = [
    path("", views.home, name="home"),
    path("api/summarize-policy/", api_views.summarize_policy_api, name="api_summarize_policy"),
    path("dashboard/", views.dashboard, name="dashboard"),
    path("site/<int:website_id>/", views.snapshot_detail, name="snapshot_detail"),
    path("site/<int:website_id>/ai-summary/", views.ai_summary, name="ai_summary"),
    path("mission/", views.mission, name="mission"),
    path("privacy/", views.privacy, name="privacy"),
    path("register/", views.register, name="register"),
    path("account/token/", views.manage_token, name="manage_token"),
    path("account/api-key/", views.manage_api_key, name="manage_api_key"),
    # Browser-extension API. Token-authenticated, no CSRF/session involved.
    path("api/login/", obtain_auth_token, name="api_login"),
    path("api/logout/", api.LogoutView.as_view(), name="api_logout"),
    path("api/lookup/", api.LookupView.as_view(), name="api_lookup"),
    path("api/ai-summary/<int:website_id>/", api.AISummaryView.as_view(), name="api_ai_summary"),
    path("api/api-key/", api.ApiKeyView.as_view(), name="api_api_key"),
    path("api/api-key/status/", api.ApiKeyStatusView.as_view(), name="api_api_key_status"),
    path("api/saved/", api.SavedSiteListCreateView.as_view(), name="api_saved_list"),
    path(
        "api/saved/<int:website_id>/",
        api.SavedSiteDetailView.as_view(),
        name="api_saved_detail",
    ),
]
