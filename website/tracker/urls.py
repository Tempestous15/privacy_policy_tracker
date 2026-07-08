from django.urls import path
from . import views
from . import api_views

app_name = "tracker"

urlpatterns = [
    path("", views.home, name="home"),
    path("api/summarize-policy/", api_views.summarize_policy_api, name="api_summarize_policy"),
    path("dashboard/", views.dashboard, name="dashboard"),
    path("site/<int:website_id>/", views.snapshot_detail, name="snapshot_detail"),
    path("mission/", views.mission, name="mission"),
    path("privacy/", views.privacy, name="privacy"),
    path("register/", views.register, name="register"),
]
