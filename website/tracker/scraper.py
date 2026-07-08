"""
scraper.py

Core privacy-policy scraping logic, adapted from the root-level
privacy_scraper.py script so it can be imported directly by Django views
(no argparse / CLI dependency).

Given a website URL, find and extract that site's privacy policy text.
"""

import ipaddress
import socket
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup


class UnsafeURLError(Exception):
    """Raised when a URL fails SSRF safety checks (bad scheme, private or
    metadata-service address, oversized response, redirect loop)."""

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
PRIVACY_KEYWORDS = [
    "privacy policy",
    "privacy notice",
    "privacy statement",
    "data protection",
    "data privacy",
    "your privacy rights",
    "privacy",
]
COMMON_PATHS = [
    "/privacy-policy",
    "/privacy",
    "/legal/privacy",
    "/privacy-notice",
    "/policies/privacy",
    "/en/privacy",
    "/en-us/privacy",
    "/legal/privacy-policy",
    "/about/privacy",
    "/privacy.html",
]
TIMEOUT = 10
MAX_REDIRECTS = 5
MAX_RESPONSE_BYTES = 2 * 1024 * 1024  # 2 MB is far beyond any real policy page


def _validate_url(url):
    """Reject URLs that could reach internal services (SSRF).

    The server fetches user-supplied URLs, so without this an attacker could
    point it at the EC2 metadata service (169.254.169.254 -> IAM credentials),
    localhost-only services, or anything else on the VPC's private network.
    Every address the hostname resolves to must be public.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise UnsafeURLError(f"Unsupported URL scheme: {parsed.scheme or '(none)'}")
    host = parsed.hostname
    if not host:
        raise UnsafeURLError("URL has no hostname.")
    try:
        infos = socket.getaddrinfo(host, parsed.port or 0, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise UnsafeURLError(f"Could not resolve host: {host}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            raise UnsafeURLError(f"URL resolves to a non-public address: {host}")


def _fetch(url, timeout=TIMEOUT):
    """requests.get with SSRF checks re-applied on every redirect hop and a
    cap on response size. Auto-following redirects would skip validation of
    intermediate targets, so hops are followed manually."""
    for _ in range(MAX_REDIRECTS + 1):
        _validate_url(url)
        resp = requests.get(
            url, headers=HEADERS, timeout=timeout, allow_redirects=False, stream=True
        )
        if resp.is_redirect or resp.is_permanent_redirect:
            location = resp.headers.get("Location")
            resp.close()
            if not location:
                raise UnsafeURLError("Redirect response with no Location header.")
            url = urljoin(url, location)
            continue
        resp.raise_for_status()
        body = resp.raw.read(MAX_RESPONSE_BYTES + 1, decode_content=True)
        resp.close()
        if len(body) > MAX_RESPONSE_BYTES:
            raise UnsafeURLError("Response exceeded the size limit.")
        return resp, body.decode(resp.encoding or "utf-8", errors="replace")
    raise UnsafeURLError("Too many redirects.")


def get_soup(url, timeout=TIMEOUT):
    _, text = _fetch(url, timeout=timeout)
    return BeautifulSoup(text, "html.parser")


def normalize_url(url):
    if not urlparse(url).scheme:
        url = "https://" + url
    return url


def find_privacy_link(soup, base_url):
    """Scan all links on the page for anything privacy-related."""
    candidates = []

    for a in soup.find_all("a", href=True):
        text = a.get_text(strip=True).lower()
        href = a["href"].lower()
        matched_kw = next((kw for kw in PRIVACY_KEYWORDS if kw in text), None)
        href_match = "privacy" in href

        if matched_kw or href_match:
            full_url = urljoin(base_url, a["href"])
            if full_url.startswith("http"):
                candidates.append(full_url)

    # Prefer exact-ish matches like "Privacy Policy" over loose ones
    def score(link):
        return 0 if "privacy-policy" in link.lower() or "privacy_policy" in link.lower() else 1

    candidates.sort(key=score)
    return candidates[0] if candidates else None


def try_common_paths(base_url):
    """Fallback: guess common privacy policy URL paths."""
    parsed = urlparse(base_url)
    root = f"{parsed.scheme}://{parsed.netloc}"
    for path in COMMON_PATHS:
        candidate = root + path
        try:
            resp, _ = _fetch(candidate)
            if resp.status_code == 200:
                return candidate
        except (requests.RequestException, UnsafeURLError):
            continue
    return None


def extract_text(soup):
    """Strip boilerplate tags and return clean readable text."""
    for tag in soup(["script", "style", "nav", "header", "footer", "noscript"]):
        tag.decompose()
    text = soup.get_text(separator="\n")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return "\n".join(lines)


def get_privacy_policy(url, cached_policy_url=None):
    """
    Given a site URL, return a dict:
        {
            "input_url": str,
            "found": bool,
            "policy_url": str | None,
            "text": str | None,
            "error": str | None,
            "from_cache": bool,
        }

    If `cached_policy_url` is supplied (e.g. a previously discovered policy
    URL for this site, stored on Website.privacy_policy_url), it is fetched
    directly first. This skips both the homepage fetch/link-scan and the
    common-path guessing fallback -- the expensive parts of discovery -- on
    every repeat visit to a site we've already scraped once.

    If the cached URL no longer resolves (site restructured, page removed,
    etc.) discovery runs from scratch, exactly as if no cache had been given.
    """
    url = normalize_url(url)
    result = {
        "input_url": url,
        "found": False,
        "policy_url": None,
        "text": None,
        "error": None,
        "from_cache": False,
    }

    if cached_policy_url:
        try:
            cached_soup = get_soup(cached_policy_url)
        except (requests.RequestException, UnsafeURLError):
            cached_soup = None

        if cached_soup is not None:
            result["found"] = True
            result["policy_url"] = cached_policy_url
            result["text"] = extract_text(cached_soup)
            result["from_cache"] = True
            return result
        # Cache miss -- fall through to full discovery below.

    try:
        soup = get_soup(url)
    except UnsafeURLError as e:
        result["error"] = f"URL rejected: {e}"
        return result
    except requests.RequestException as e:
        result["error"] = f"Failed to fetch input URL: {e}"
        return result

    link = find_privacy_link(soup, url)
    if not link:
        link = try_common_paths(url)

    if not link:
        result["error"] = "No privacy policy link found via page links or common paths."
        return result

    try:
        policy_soup = get_soup(link)
    except (requests.RequestException, UnsafeURLError) as e:
        result["policy_url"] = link
        result["error"] = f"Found link but failed to fetch it: {e}"
        return result

    result["found"] = True
    result["policy_url"] = link
    result["text"] = extract_text(policy_soup)
    return result
