"""
capture.py

Phase 1 tracker-observation capture: for each site in the curated list,
loads the homepage in headless Chromium via Playwright and records every
distinct third-party domain the page contacts while it loads.

Deliberately minimal for this milestone -- one page load per site (the
homepage only), no login/interaction, no multi-page crawl, no scrolling.
That's enough to validate the scoring logic in score.py against Tracker
Radar; broadening capture (deeper crawls, interaction-triggered trackers,
scroll-triggered lazy loads, consent-banner handling) is scoped for a
later milestone once the scoring rule itself is validated. See README.md
"Known limitations" for the specific gaps this leaves.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from urllib.parse import urlparse

import tldextract
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

NAV_TIMEOUT_MS = 20_000
POST_LOAD_SETTLE_MS = 4_000  # let async/lazy-loaded trackers fire after "load"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Disable tldextract's live public-suffix-list fetch and rely on its bundled
# snapshot -- this only needs to be "correct enough" for eTLD+1 grouping and
# shouldn't make a network call (or fail/slow down) on every run.
_TLD_EXTRACTOR = tldextract.TLDExtract(suffix_list_urls=())


@dataclass
class CaptureResult:
    site: str
    ok: bool
    first_party_domain: str | None = None
    third_party_domains: list[str] = field(default_factory=list)
    error: str | None = None


def registrable_domain(hostname: str) -> str:
    """Best-effort eTLD+1, e.g. 'www.googletagmanager.com' -> 'googletagmanager.com'.
    Uses tldextract's public suffix list rather than a naive "last two
    labels" split so multi-part TLDs (co.uk, com.au, etc.) resolve
    correctly instead of e.g. splitting 'bbc.co.uk' into 'co.uk'.
    """
    if not hostname:
        return ""
    ext = _TLD_EXTRACTOR(hostname)
    if not ext.domain:
        return hostname
    return f"{ext.domain}.{ext.suffix}" if ext.suffix else ext.domain


def capture_site(playwright, site_url: str) -> CaptureResult:
    """Visit one site and return the distinct third-party domains it
    contacted. Network errors and navigation timeouts don't raise -- they
    come back as ok=False with whatever partial data was captured before
    the failure, since a slow/blocked page often still fires its tracking
    requests before failing to finish loading.
    """
    first_party = registrable_domain(urlparse(site_url).hostname or "")
    seen_domains: set[str] = set()

    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(user_agent=USER_AGENT)
    page = context.new_page()

    def on_request(request):
        host = urlparse(request.url).hostname
        if host:
            seen_domains.add(registrable_domain(host))

    page.on("request", on_request)

    try:
        page.goto(site_url, timeout=NAV_TIMEOUT_MS, wait_until="load")
        page.wait_for_timeout(POST_LOAD_SETTLE_MS)
        ok, error = True, None
    except PlaywrightTimeoutError as e:
        ok, error = False, f"navigation timeout: {e}"
    except PlaywrightError as e:
        ok, error = False, f"playwright error: {e}"
    except Exception as e:  # noqa: BLE001 -- surface any capture failure per-site, not crash the whole run
        ok, error = False, str(e)
    finally:
        context.close()
        browser.close()

    third_party = sorted(d for d in seen_domains if d and d != first_party)
    return CaptureResult(
        site=site_url, ok=ok, first_party_domain=first_party,
        third_party_domains=third_party, error=error,
    )


def capture_sites(site_urls: list[str]) -> list[CaptureResult]:
    """Capture each site in turn, sequentially, in one browser process.
    Sequential and single-process is deliberate for this milestone -- it
    keeps output order stable and debuggable for ~20 sites. Parallelizing
    across contexts/processes is a reasonable speed-up once this is scaled
    past a hand-checked prototype.
    """
    results = []
    with sync_playwright() as p:
        for url in site_urls:
            print(f"capturing {url} ...", file=sys.stderr)
            result = capture_site(p, url)
            if not result.ok:
                print(f"  warning: {result.error}", file=sys.stderr)
            print(f"  {len(result.third_party_domains)} third-party domain(s)", file=sys.stderr)
            results.append(result)
    return results


if __name__ == "__main__":
    import json

    urls = sys.argv[1:] or ["https://example.com"]
    for r in capture_sites(urls):
        print(json.dumps(r.__dict__, indent=2))
