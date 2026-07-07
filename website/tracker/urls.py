from django.urls import path
from . import views

app_name = "tracker"

urlpatterns = [
    path("", views.home, name="home"),
    path("dashboard/", views.dashboard, name="dashboard"),
    path("mission/", views.mission, name="mission"),
    path("privacy/", views.privacy, name="privacy"),
    path("register/", views.register, name="register"),
]
