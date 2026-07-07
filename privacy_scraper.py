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
import os
import sys
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


def find_privacy_link(soup, base_url, debug=False):
    """Scan all links on the page for anything privacy-related."""
    candidates = []
    all_links_seen = 0

    for a in soup.find_all("a", href=True):
        all_links_seen += 1
        text = a.get_text(strip=True).lower()
        href = a["href"].lower()
        matched_kw = next((kw for kw in PRIVACY_KEYWORDS if kw in text), None)
        href_match = "privacy" in href

        if matched_kw or href_match:
            full_url = urljoin(base_url, a["href"])
            if full_url.startswith("http"):
                candidates.append(full_url)
                if debug:
                    reason = f"text matched '{matched_kw}'" if matched_kw else "href contains 'privacy'"
                    print(f"  [debug] candidate: {full_url}  ({reason})")
            elif debug:
                print(f"  [debug] rejected (non-http link): {a['href']}")

    if debug:
        print(f"  [debug] scanned {all_links_seen} total <a> tags on page, "
              f"{len(candidates)} privacy-related candidates found")

    # Prefer exact-ish matches like "Privacy Policy" over loose ones
    def score(link):
        return 0 if "privacy-policy" in link.lower() or "privacy_policy" in link.lower() else 1

    candidates.sort(key=score)
    return candidates[0] if candidates else None


def try_common_paths(base_url, debug=False):
    """Fallback: guess common privacy policy URL paths."""
    parsed = urlparse(base_url)
    root = f"{parsed.scheme}://{parsed.netloc}"
    for path in COMMON_PATHS:
        candidate = root + path
        try:
            r = requests.get(candidate, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
            if debug:
                print(f"  [debug] tried common path {candidate} -> status {r.status_code}")
            if r.status_code == 200:
                return candidate
        except requests.RequestException as e:
            if debug:
                print(f"  [debug] tried common path {candidate} -> failed ({e})")
            continue
    return None


def extract_text(soup):
    """Strip boilerplate tags and return clean readable text."""
    for tag in soup(["script", "style", "nav", "header", "footer", "noscript"]):
        tag.decompose()
    text = soup.get_text(separator="\n")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return "\n".join(lines)


def get_privacy_policy(url, debug=False):
    url = normalize_url(url)
    result = {"input_url": url, "found": False, "policy_url": None, "text": None, "error": None}

    if debug:
        print(f"[debug] fetching homepage: {url}")

    try:
        soup = get_soup(url)
    except requests.RequestException as e:
        result["error"] = f"Failed to fetch input URL: {e}"
        if debug:
            print(f"[debug] homepage fetch failed: {e}")
        return result

    if debug:
        print("[debug] homepage fetched OK, scanning links for privacy policy...")

    link = find_privacy_link(soup, url, debug=debug)
    if not link:
        if debug:
            print("[debug] no link found on page, trying common paths...")
        link = try_common_paths(url, debug=debug)

    if not link:
        result["error"] = "No privacy policy link found via page links or common paths."
        return result

    if debug:
        print(f"[debug] fetching candidate policy page: {link}")

    try:
        policy_soup = get_soup(link)
    except requests.RequestException as e:
        result["policy_url"] = link
        result["error"] = f"Found link but failed to fetch it: {e}"
        if debug:
            print(f"[debug] policy page fetch failed: {e}")
        return result

    result["found"] = True
    result["policy_url"] = link
    result["text"] = extract_text(policy_soup)
    return result


SUMMARY_PROMPT_TEMPLATE = """Summarize the following privacy policy. Structure your answer with these sections:

1. What personal data is collected
2. How the data is used
3. Whether data is shared/sold to third parties
4. Data retention period (if stated)
5. User rights (opt-out, deletion, access requests)
6. Any notable red flags (e.g. vague language, broad third-party sharing)

Keep it concise and in plain English. If a section isn't addressed in the policy, say so briefly.

Privacy policy text:
{policy_text}
"""

# Max characters of policy text sent to the model. Most policies fit comfortably;
# this just guards against extreme outliers (e.g. a page that scraped badly).
MAX_POLICY_CHARS = 15000


def summarize_policy(policy_text, model="claude-sonnet-4-6"):
    """Send policy text to the Anthropic API and return a structured summary."""
    try:
        import anthropic
    except ImportError:
        return None, "The 'anthropic' package isn't installed. Run: pip install anthropic"

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None, "ANTHROPIC_API_KEY environment variable is not set."

    client = anthropic.Anthropic(api_key=api_key)
    prompt = SUMMARY_PROMPT_TEMPLATE.format(policy_text=policy_text[:MAX_POLICY_CHARS])

    try:
        response = client.messages.create(
            model=model,
            max_tokens=1000,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text, None
    except Exception as e:
        return None, f"Summarization failed: {e}"


def main():
    parser = argparse.ArgumentParser(description="Scrape a website's privacy policy given its URL.")
    parser.add_argument("url", help="Website URL, e.g. https://example.com")
    parser.add_argument("--json", action="store_true", help="Output raw JSON instead of formatted text")
    parser.add_argument("--save", metavar="FILE", help="Save extracted policy text to a file")
    parser.add_argument("--summarize", action="store_true", help="Summarize the policy using Claude")
    parser.add_argument("--model", default="claude-sonnet-4-6", help="Model to use for summarization")
    parser.add_argument("--debug", action="store_true", help="Print detailed scraping steps and rejected candidates")
    args = parser.parse_args()

    result = get_privacy_policy(args.url, debug=args.debug)
    result["summary"] = None
    result["summary_error"] = None

    if args.summarize and result.get("text"):
        summary, err = summarize_policy(result["text"], model=args.model)
        result["summary"] = summary
        result["summary_error"] = err

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["found"]:
            print(f"✅ Found privacy policy at: {result['policy_url']}\n")

            if args.summarize:
                if result["summary"]:
                    print("📋 Summary:\n")
                    print(result["summary"])
                else:
                    print(f"⚠️  Could not generate summary: {result['summary_error']}")
            else:
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
            if result["summary"]:
                f.write("\n\n---- SUMMARY ----\n\n")
                f.write(result["summary"])
        print(f"\n📄 Full text saved to {args.save}")

    sys.exit(0 if result["found"] else 1)


if __name__ == "__main__":
    main()
