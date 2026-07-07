from django.contrib.auth.decorators import login_required
from django.shortcuts import render
from .models import Website


def home(request):
    return render(request, "tracker/home.html")


def mission(request):
    return render(request, "tracker/mission.html")


def privacy(request):
    return render(request, "tracker/privacy.html")


@login_required
def dashboard(request):
    websites = Website.objects.all()[:20]
    return render(request, "tracker/dashboard.html", {"websites": websites})
