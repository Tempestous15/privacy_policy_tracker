from django.contrib import admin
from .models import PolicySnapshot, SavedSite, UserAPIKey, Website


@admin.register(Website)
class WebsiteAdmin(admin.ModelAdmin):
    list_display = ("name", "url", "added_at")
    search_fields = ("name", "url")


@admin.register(PolicySnapshot)
class PolicySnapshotAdmin(admin.ModelAdmin):
    list_display = ("website", "captured_at", "hash")
    search_fields = ("website__name",)


@admin.register(SavedSite)
class SavedSiteAdmin(admin.ModelAdmin):
    list_display = ("user", "website", "saved_at")
    search_fields = ("user__username", "website__name")


@admin.register(UserAPIKey)
class UserAPIKeyAdmin(admin.ModelAdmin):
    list_display = ("user", "has_key")
    search_fields = ("user__username",)

    @admin.display(boolean=True, description="Has key")
    def has_key(self, obj):
        return bool(obj.anthropic_api_key)
