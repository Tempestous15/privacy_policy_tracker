"""
scraper.py

Core privacy-policy scraping logic, adapted from the root-level
privacy_scraper.py script so it can be imported directly by Django views
(no argparse / CLI dependency).

Given a website URL, find and extract that site's privacy policy text.
"""

from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

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


def get_soup(url, timeout=TIMEOUT):
    resp = requests.get(url, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    return BeautifulSoup(resp.text, "html.parser")


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
            r = requests.get(candidate, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
            if r.status_code == 200:
                return candidate
        except requests.RequestException:
            continue
    return None


def extract_text(soup):
    """Strip boilerplate tags and return clean readable text."""
    for tag in soup(["script", "style", "nav", "header", "footer", "noscript"]):
        tag.decompose()
    text = soup.get_text(separator="\n")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return "\n".join(lines)


def get_privacy_policy(url):
    """
    Given a site URL, return a dict:
        {
            "input_url": str,
            "found": bool,
            "policy_url": str | None,
            "text": str | None,
            "error": str | None,
        }
    """
    url = normalize_url(url)
    result = {"input_url": url, "found": False, "policy_url": None, "text": None, "error": None}

    try:
        soup = get_soup(url)
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
    except requests.RequestException as e:
        result["policy_url"] = link
        result["error"] = f"Found link but failed to fetch it: {e}"
        return result

    result["found"] = True
    result["policy_url"] = link
    result["text"] = extract_text(policy_soup)
    return result
