#!/usr/bin/env python3
"""
privacy_scraper.py

MVP script: given a URL, find and extract that site's privacy policy text.

Usage:
    python3 privacy_scraper.py https://example.com
    python3 privacy_scraper.py https://example.com --json
    python3 privacy_scraper.py https://example.com --save output.txt
"""

import argparse
import json
import sys
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; PrivacyPolicyBot/1.0)"}
PRIVACY_KEYWORDS = ["privacy policy", "privacy notice", "privacy statement", "privacy"]
COMMON_PATHS = [
    "/privacy-policy",
    "/privacy",
    "/legal/privacy",
    "/privacy-notice",
    "/policies/privacy",
    "/en/privacy",
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
        if any(kw in text for kw in PRIVACY_KEYWORDS) or "privacy" in href:
            full_url = urljoin(base_url, a["href"])
            # skip mailto/js links
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


def main():
    parser = argparse.ArgumentParser(description="Scrape a website's privacy policy given its URL.")
    parser.add_argument("url", help="Website URL, e.g. https://example.com")
    parser.add_argument("--json", action="store_true", help="Output raw JSON instead of formatted text")
    parser.add_argument("--save", metavar="FILE", help="Save extracted policy text to a file")
    args = parser.parse_args()

    result = get_privacy_policy(args.url)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["found"]:
            print(f"✅ Found privacy policy at: {result['policy_url']}\n")
            preview = result["text"][:1000]
            print(preview)
            if len(result["text"]) > 1000:
                print(f"\n... [{len(result['text'])} total characters, truncated for display]")
        else:
            print(f"❌ Could not find privacy policy for {result['input_url']}")
            print(f"Reason: {result['error']}")

    if args.save and result["text"]:
        with open(args.save, "w", encoding="utf-8") as f:
            f.write(result["text"])
        print(f"\n📄 Full text saved to {args.save}")

    sys.exit(0 if result["found"] else 1)


if __name__ == "__main__":
    main()
