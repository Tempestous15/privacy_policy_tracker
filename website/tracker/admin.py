from django.contrib import admin
from .models import Website, PolicySnapshot


@admin.register(Website)
class WebsiteAdmin(admin.ModelAdmin):
    list_display = ("name", "url", "added_at")
    search_fields = ("name", "url")


@admin.register(PolicySnapshot)
class PolicySnapshotAdmin(admin.ModelAdmin):
    list_display = ("website", "captured_at", "hash")
    search_fields = ("website__name",)
