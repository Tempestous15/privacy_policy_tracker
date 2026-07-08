from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import UserCreationForm
from django.contrib import messages
from django.shortcuts import render, redirect, get_object_or_404
from .models import Website
from . import scraper


def home(request):
    context = {}
    url = request.GET.get("url", "").strip()

    if url:
        result = scraper.get_privacy_policy(url)
        context["submitted_url"] = url
        context["result"] = result

        if result["found"]:
            website, created = Website.objects.get_or_create(
                url=result["input_url"],
                defaults={
                    "name": result["input_url"].split("//")[-1].split("/")[0],
                    "privacy_policy_url": result["policy_url"],
                },
            )
            context["website"] = website

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
