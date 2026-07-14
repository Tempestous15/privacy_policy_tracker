import re

# Browsers enforce CORS on cross-origin fetches from an extension's popup/
# background page exactly like any other cross-origin request -- there is no
# blanket bypass just because host_permissions were granted. So the API has
# to opt in explicitly for the browser extension's origin.
EXTENSION_ORIGIN_RE = re.compile(r"^(chrome|moz|safari-web)-extension://")


class ExtensionCorsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        origin = request.META.get("HTTP_ORIGIN", "")
        is_extension_origin = bool(EXTENSION_ORIGIN_RE.match(origin))

        if is_extension_origin and request.method == "OPTIONS":
            from django.http import HttpResponse

            response = HttpResponse()
        else:
            response = self.get_response(request)

        if is_extension_origin:
            response["Access-Control-Allow-Origin"] = origin
            response["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
            response["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
            response["Access-Control-Max-Age"] = "86400"
        return response
