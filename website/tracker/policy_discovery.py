"""
policy_discovery.py

Multi-stage privacy-policy discovery pipeline. Given a site URL, reliably
locates that site's privacy policy even when it isn't linked anywhere
obvious on the homepage.

Public entry point:

    from tracker.policy_discovery import find_privacy_policy
    result = find_privacy_policy("https://example.com")

`result` is a plain JSON-serializable dict matching one of two shapes:

    # found
    {
        "found": True,
        "policy_url": str,
        "discovery_method": str,
        "confidence": "high" | "medium" | "low",
        "alternative_candidates": [{"url": str, "source": str, "score": int}, ...],
        "reasoning": str,
        "next_action": "summarize",
    }

    # not found
    {
        "found": False,
        "reason": str,
        "attempted_methods": [str, ...],
        "possible_candidates": [{"url": str, "source": str, "score": int}, ...],
    }

Design notes
------------
This intentionally lives server-side rather than in the browser extension:
plain `requests` calls here aren't subject to CORS, so stages 3-6 (guessing
paths, reading robots.txt/sitemaps, poking a search endpoint, parsing
structured metadata) can freely hit arbitrary pages on the target site --
something a content script generally can't do across origins. Stage 7 also
needs the Anthropic API key, which must never reach the extension. The
extension's own policyFinder.js remains a free, instant "stage 1+2 only"
pre-check of the page the user is actually looking at; this module is what
runs when that quick check comes up empty (or low-confidence), and is also
reused directly as the discovery step for the website's own pages.

Stages run cheapest-and-most-reliable first and STOP as soon as a
high-confidence, validated candidate is found -- later stages (guessing
paths, fetching sitemaps, calling the LLM) only run if the earlier ones
didn't produce a confident answer. Each stage is a small, independent
function that returns a list of Candidate objects, so adding a new
strategy later is just "write a function, call it from find_privacy_policy()".

Reuses tracker.scraper's HTTP setup (HEADERS, TIMEOUT, normalize_url,
get_soup, extract_text) rather than duplicating it -- this module only adds
*discovery* strategies on top, and keeps scraper.py's existing
get_privacy_policy() untouched since other code (views.home()) still uses
that simpler path directly.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from . import scraper

try:
    import anthropic
except ImportError:  # package not installed -- handled at call time, same as summarizer.py
    anthropic = None


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-5"
REQUEST_TIMEOUT = 6          # seconds -- short, since we may make many requests
MAX_COMMON_PATH_ATTEMPTS = 20
MAX_SITEMAPS_TO_READ = 2
MAX_SITEMAP_LOCS_SCANNED = 2000
MAX_SITEMAP_MATCHES = 5
MAX_LLM_CANDIDATES = 5

COMMON_PATHS = [
    "/privacy",
    "/privacy-policy",
    "/privacy_policy",
    "/privacy-notice",
    "/privacy-notice/",
    "/legal/privacy",
    "/legal/privacy-policy",
    "/legal",
    "/privacy.html",
    "/privacy-policy.html",
    "/data-policy",
    "/privacy-center",
    "/privacycentre",
    "/privacy-and-cookies",
    "/privacy-policy/",
    "/policies/privacy",
    "/en/privacy",
    "/en-us/privacy",
    "/about/privacy",
]

# Keyword tiers, from most to least trustworthy. Used both to decide whether
# a link is a candidate at all, and to weight how strongly it counts.
STRONG_PHRASES = [
    "privacy policy", "privacy notice", "privacy statement", "data protection",
    "data policy", "data privacy", "your privacy", "legal/privacy",
]
MODERATE_PHRASES = ["privacy"]
WEAK_PHRASES = ["gdpr", "trust center", "trust centre", "cookies", "legal", "terms"]

SITEMAP_URL_KEYWORDS = ["privacy", "legal", "policy", "cookies"]

# Words that indicate genuine privacy-policy content when found in a
# candidate page's body text.
VALIDATION_POSITIVE_KEYWORDS = [
    "personal information", "personal data", "data collection", "we collect",
    "cookies", "third part", "gdpr", "ccpa", "your rights", "retention",
    "processing", "controller", "consent",
]

# Title/H1 patterns that suggest a page is NOT a privacy policy, even if it
# matched on link text/href. Each maps to a short reason string. Checked
# only when the page's own positive-keyword count is low.
NEGATIVE_PAGE_SIGNALS = [
    (re.compile(r"\bterms\s+(of\s+(service|use)|and\s+conditions)\b", re.IGNORECASE), "Terms of Service"),
    (re.compile(r"\b(cookie\s+(preferences|settings)|manage\s+cookies)\b", re.IGNORECASE), "Cookie preferences only"),
    (re.compile(r"\b(careers?|jobs?|we'?re\s+hiring)\b", re.IGNORECASE), "Careers"),
    (re.compile(r"^\s*(legal\s+)?disclaimer\s*$", re.IGNORECASE), "Legal disclaimer"),
    (re.compile(r"\baccessibility\s+statement\b", re.IGNORECASE), "Accessibility"),
    (re.compile(r"^\s*contact(\s+us)?\s*$", re.IGNORECASE), "Contact"),
]

FOOTER_AREA_CLASS_RE = re.compile(r"(footer|legal-nav|legal-menu|bottom-nav|bottom-bar)", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Candidate:
    url: str
    source: str  # "homepage_scan" | "footer_scan" | "common_path" | "sitemap" |
                 # "internal_search" | "structured_metadata" | "llm_ranked"
    score: int = 0
    link_text: str = ""
    reasoning: str = ""
    # Filled in by validate_candidate():
    validated: bool = False
    validation_score: int = 0
    is_negative: bool = False
    negative_reason: str | None = None
    confidence: str = "low"

    def to_public_dict(self) -> dict:
        return {"url": self.url, "source": self.source, "score": self.score}


class DiscoveryContext:
    """Small mutable bag of caches shared across stages within a single
    find_privacy_policy() call, so no page is fetched or validated twice."""

    def __init__(self, session: requests.Session):
        self.session = session
        self.text_cache: dict[str, str] = {}       # url -> extracted text
        self.title_cache: dict[str, str] = {}       # url -> <title> text
        self.validated: dict[str, Candidate] = {}   # url -> validated Candidate


# ---------------------------------------------------------------------------
# Shared scoring helpers
# ---------------------------------------------------------------------------

def _matches_any(haystack_lower: str, phrases: list[str]) -> bool:
    return any(p in haystack_lower for p in phrases)


def is_in_footer_area(el) -> bool:
    """Stage 2: is this element inside a <footer>, role=contentinfo, or a
    legal/bottom-nav-style container? Walks up the DOM tree from the link."""
    node = el
    while node is not None:
        if getattr(node, "name", None) == "footer":
            return True
        if (node.get("role") or "").strip().lower() == "contentinfo":
            return True
        class_str = " ".join(node.get("class", []) or [])
        node_id = node.get("id") or ""
        if FOOTER_AREA_CLASS_RE.search(class_str) or FOOTER_AREA_CLASS_RE.search(node_id):
            return True
        node = node.parent
    return False


def score_link(text: str, href_raw: str, aria_label: str, title_attr: str,
                in_footer: bool, same_domain: bool) -> int | None:
    """Score a single link's privacy-relevance. Returns None if it isn't a
    candidate at all. Tiers are spaced far apart, mirroring the browser
    extension's client-side scoring (policyFinder.js) so both sides agree on
    what "obviously the privacy policy" looks like."""
    text_lower = (text or "").strip().lower()
    href_lower = (href_raw or "").lower()
    combined = " ".join([text_lower, href_lower, (aria_label or "").lower(), (title_attr or "").lower()])

    matched_strong = _matches_any(combined, STRONG_PHRASES)
    matched_moderate = _matches_any(combined, MODERATE_PHRASES)
    matched_weak = _matches_any(combined, WEAK_PHRASES)

    if not (matched_strong or matched_moderate or matched_weak):
        return None

    score = 1  # base: it's a candidate at all

    if text_lower == "privacy policy":
        score += 1000  # Tier 1: exact text match
    if "/privacy" in href_lower:
        score += 500   # Tier 2: href contains "/privacy"
    if "privacy" in text_lower:
        score += 250   # Tier 3: text contains "privacy"
    if in_footer:
        score += 100   # Tier 4: footer / contentinfo / legal-nav
    if same_domain:
        score += 50    # Tier 5: same-domain over third-party
    if href_raw.startswith(("http://", "https://", "//")):
        score += 10    # Tier 6: originally-absolute href

    if not matched_strong and not matched_moderate and matched_weak:
        # Only a generic/noisy keyword (terms, legal, cookies, gdpr...)
        # matched -- still admit it as a low-value fallback candidate.
        score += 20

    return score


# ---------------------------------------------------------------------------
# Stage 1 + 2: homepage scan (link text/href/aria-label/title + footer boost)
# ---------------------------------------------------------------------------

def stage_homepage_scan(site_url: str, ctx: DiscoveryContext) -> tuple[BeautifulSoup | None, list[Candidate]]:
    """Fetch the homepage once and scan every link on it. Stage 2 (footer
    analysis) is folded into this same pass -- it's a scoring boost on links
    we've already found, not a separate request."""
    try:
        resp = ctx.session.get(site_url, headers=scraper.HEADERS, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException:
        return None, []

    soup = BeautifulSoup(resp.text, "html.parser")
    page_hostname = (urlparse(site_url).hostname or "").replace("www.", "")

    candidates: list[Candidate] = []
    for a in soup.find_all("a", href=True):
        href_raw = a["href"]
        if not href_raw or href_raw.startswith("#") or href_raw.lower().startswith("javascript:"):
            continue
        absolute = urljoin(site_url, href_raw)
        if not absolute.startswith("http"):
            continue

        text = a.get_text(" ", strip=True)
        aria_label = a.get("aria-label", "")
        title_attr = a.get("title", "")
        in_footer = is_in_footer_area(a)
        link_hostname = (urlparse(absolute).hostname or "").replace("www.", "")
        same_domain = link_hostname == page_hostname

        score = score_link(text, href_raw, aria_label, title_attr, in_footer, same_domain)
        if score is None:
            continue

        candidates.append(Candidate(
            url=absolute,
            source="footer_scan" if in_footer else "homepage_scan",
            score=score,
            link_text=text or aria_label or title_attr,
            reasoning=f"Matched on homepage link{' (in footer/legal nav)' if in_footer else ''}.",
        ))

    return soup, _dedupe(candidates)


def _dedupe(candidates: list[Candidate]) -> list[Candidate]:
    best_by_url: dict[str, Candidate] = {}
    for c in candidates:
        existing = best_by_url.get(c.url)
        if existing is None or c.score > existing.score:
            best_by_url[c.url] = c
    return sorted(best_by_url.values(), key=lambda c: c.score, reverse=True)


# ---------------------------------------------------------------------------
# Stage 3: common path guessing
# ---------------------------------------------------------------------------

def stage_common_paths(site_url: str, ctx: DiscoveryContext) -> list[Candidate]:
    """Try well-known privacy-policy paths, HEAD first (cheaper), falling
    back to GET if the server doesn't support HEAD. Stops at the first hit
    -- per spec, we don't need to try all 19 paths once one resolves."""
    parsed = urlparse(site_url)
    root = f"{parsed.scheme}://{parsed.netloc}"
    candidates: list[Candidate] = []

    for path in COMMON_PATHS[:MAX_COMMON_PATH_ATTEMPTS]:
        candidate_url = root + path
        final_url, ok = _check_path_exists(ctx.session, candidate_url)
        if ok:
            candidates.append(Candidate(
                url=final_url,
                source="common_path",
                score=300,
                link_text=path,
                reasoning=f"Guessed path {path} resolved successfully.",
            ))
            break  # stop as soon as a likely page is found

    return candidates


def _check_path_exists(session: requests.Session, url: str) -> tuple[str, bool]:
    try:
        resp = session.head(url, headers=scraper.HEADERS, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        if resp.status_code in (405, 501):  # HEAD not supported -- retry with GET
            resp = session.get(url, headers=scraper.HEADERS, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        return resp.url, 200 <= resp.status_code < 300
    except requests.RequestException:
        return url, False


# ---------------------------------------------------------------------------
# Stage 4: robots.txt + sitemap search
# ---------------------------------------------------------------------------

_LOC_RE = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.IGNORECASE)
_SITEMAP_DIRECTIVE_RE = re.compile(r"^\s*sitemap\s*:\s*(\S+)", re.IGNORECASE | re.MULTILINE)


def stage_sitemap_search(site_url: str, ctx: DiscoveryContext) -> list[Candidate]:
    parsed = urlparse(site_url)
    root = f"{parsed.scheme}://{parsed.netloc}"

    sitemap_urls = _find_sitemap_urls(ctx.session, root)
    if not sitemap_urls:
        return []

    candidates: list[Candidate] = []
    scanned = 0
    for sitemap_url in sitemap_urls[:MAX_SITEMAPS_TO_READ]:
        locs = _read_sitemap_locs(ctx.session, sitemap_url)
        for loc in locs:
            scanned += 1
            if scanned > MAX_SITEMAP_LOCS_SCANNED:
                break
            loc_lower = loc.lower()
            if any(kw in loc_lower for kw in SITEMAP_URL_KEYWORDS):
                bonus = 30 if "privacy" in loc_lower else 0
                candidates.append(Candidate(
                    url=loc,
                    source="sitemap",
                    score=250 + bonus,
                    link_text=loc,
                    reasoning=f"URL listed in sitemap {sitemap_url} matches privacy/legal keywords.",
                ))
                if len(candidates) >= MAX_SITEMAP_MATCHES:
                    return _dedupe(candidates)
        if scanned > MAX_SITEMAP_LOCS_SCANNED:
            break

    return _dedupe(candidates)


def _find_sitemap_urls(session: requests.Session, root: str) -> list[str]:
    try:
        resp = session.get(root + "/robots.txt", headers=scraper.HEADERS, timeout=REQUEST_TIMEOUT)
        if resp.ok:
            found = _SITEMAP_DIRECTIVE_RE.findall(resp.text)
            if found:
                return found
    except requests.RequestException:
        pass
    # No robots.txt (or no Sitemap: directive) -- try the conventional default.
    return [root + "/sitemap.xml"]


def _read_sitemap_locs(session: requests.Session, sitemap_url: str) -> list[str]:
    try:
        resp = session.get(sitemap_url, headers=scraper.HEADERS, timeout=REQUEST_TIMEOUT)
        if not resp.ok:
            return []
        # Regex-based <loc> extraction rather than an XML parser -- avoids
        # adding a new dependency (BeautifulSoup's XML mode needs lxml) and
        # is plenty robust for well-formed sitemap files.
        return _LOC_RE.findall(resp.text)[:MAX_SITEMAP_LOCS_SCANNED]
    except requests.RequestException:
        return []


# ---------------------------------------------------------------------------
# Stage 5: internal site search (only tried if cheap AND earlier stages failed)
# ---------------------------------------------------------------------------

SEARCH_URL_TEMPLATES = [
    "{root}/?s=privacy",       # WordPress-style
    "{root}/search?q=privacy",  # generic
]
MAX_INTERNAL_SEARCH_SCORE = 400  # search-result links are noisier -- cap their trust


def stage_internal_search(site_url: str, ctx: DiscoveryContext) -> list[Candidate]:
    parsed = urlparse(site_url)
    root = f"{parsed.scheme}://{parsed.netloc}"
    page_hostname = (parsed.hostname or "").replace("www.", "")

    candidates: list[Candidate] = []
    for template in SEARCH_URL_TEMPLATES:
        search_url = template.format(root=root)
        try:
            resp = ctx.session.get(search_url, headers=scraper.HEADERS, timeout=REQUEST_TIMEOUT)
            if not resp.ok:
                continue
        except requests.RequestException:
            continue

        soup = BeautifulSoup(resp.text, "html.parser")
        for a in soup.find_all("a", href=True):
            href_raw = a["href"]
            absolute = urljoin(search_url, href_raw)
            if not absolute.startswith("http"):
                continue
            text = a.get_text(" ", strip=True)
            link_hostname = (urlparse(absolute).hostname or "").replace("www.", "")
            same_domain = link_hostname == page_hostname
            score = score_link(text, href_raw, a.get("aria-label", ""), a.get("title", ""), False, same_domain)
            if score is None:
                continue
            candidates.append(Candidate(
                url=absolute,
                source="internal_search",
                score=min(score, MAX_INTERNAL_SEARCH_SCORE),
                link_text=text,
                reasoning=f"Found via the site's own search for \"privacy\" ({search_url}).",
            ))

        if candidates:
            break  # one working search endpoint is enough

    return _dedupe(candidates)


# ---------------------------------------------------------------------------
# Stage 6: structured metadata (JSON-LD, <link rel>, meta tags)
# ---------------------------------------------------------------------------

_JSONLD_PRIVACY_KEY_RE = re.compile(r'"[^"]*privacy[^"]*"\s*:\s*"(https?://[^"]+)"', re.IGNORECASE)
_LINK_REL_PRIVACY_RE = re.compile(r"privacy", re.IGNORECASE)


def stage_structured_metadata(homepage_soup: BeautifulSoup | None, site_url: str) -> list[Candidate]:
    """Reuses the already-fetched homepage soup from stage 1 -- no extra
    HTTP request. Looks for JSON-LD blocks with a privacy-ish key pointing
    at a URL, and <link rel="privacy-policy"> / similar hints some site
    templates include."""
    if homepage_soup is None:
        return []

    candidates: list[Candidate] = []

    for script in homepage_soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = script.string or script.get_text() or ""
        if not raw.strip():
            continue
        for match in _JSONLD_PRIVACY_KEY_RE.finditer(raw):
            url = urljoin(site_url, match.group(1))
            candidates.append(Candidate(
                url=url, source="structured_metadata", score=350,
                link_text="JSON-LD", reasoning="URL referenced by a privacy-related key in JSON-LD structured data.",
            ))

    for link in homepage_soup.find_all("link", rel=True, href=True):
        rel_value = " ".join(link.get("rel", []))
        if _LINK_REL_PRIVACY_RE.search(rel_value):
            url = urljoin(site_url, link["href"])
            candidates.append(Candidate(
                url=url, source="structured_metadata", score=350,
                link_text=rel_value, reasoning=f'<link rel="{rel_value}"> points at this URL.',
            ))

    for meta in homepage_soup.find_all("meta", attrs={"name": re.compile("privacy", re.IGNORECASE)}):
        content = meta.get("content", "")
        if content.startswith("http"):
            candidates.append(Candidate(
                url=urljoin(site_url, content), source="structured_metadata", score=320,
                link_text=meta.get("name", ""), reasoning=f'<meta name="{meta.get("name")}"> points at this URL.',
            ))

    return _dedupe(candidates)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_candidate(candidate: Candidate, ctx: DiscoveryContext) -> Candidate:
    """Fetches (or reuses a cached fetch of) the candidate page and checks
    whether it actually reads like a privacy policy. Mutates and returns the
    same Candidate with validated/validation_score/is_negative/confidence
    filled in. Cached in ctx.validated so a URL is never fetched or scored
    twice within one find_privacy_policy() call."""
    cached = ctx.validated.get(candidate.url)
    if cached is not None:
        # Reuse the validation outcome but keep this candidate's own
        # score/source/reasoning (it may have been found a different way).
        candidate.validated = cached.validated
        candidate.validation_score = cached.validation_score
        candidate.is_negative = cached.is_negative
        candidate.negative_reason = cached.negative_reason
        candidate.confidence = _compute_confidence(candidate)
        return candidate

    text = ctx.text_cache.get(candidate.url)
    title = ctx.title_cache.get(candidate.url, "")
    if text is None:
        try:
            resp = ctx.session.get(candidate.url, headers=scraper.HEADERS, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "html.parser")
            title_tag = soup.find("title")
            h1_tag = soup.find("h1")
            title = " ".join(filter(None, [
                title_tag.get_text(strip=True) if title_tag else "",
                h1_tag.get_text(strip=True) if h1_tag else "",
            ]))
            text = scraper.extract_text(soup)
        except requests.RequestException:
            text = ""
            title = ""
        ctx.text_cache[candidate.url] = text
        ctx.title_cache[candidate.url] = title

    text_lower = text.lower()
    positive_hits = [kw for kw in VALIDATION_POSITIVE_KEYWORDS if kw in text_lower]
    validation_score = min(len(positive_hits) * 15, 100)

    is_negative = False
    negative_reason = None
    for pattern, reason in NEGATIVE_PAGE_SIGNALS:
        if pattern.search(title):
            is_negative = True
            negative_reason = reason
            break
    if is_negative and len(positive_hits) >= 3:
        # It mentions "Terms of Service" etc. in its title but ALSO reads
        # substantially like a privacy policy -- don't penalize it.
        is_negative = False
        negative_reason = None

    candidate.validated = bool(text)
    candidate.validation_score = validation_score
    candidate.is_negative = is_negative
    candidate.negative_reason = negative_reason
    candidate.confidence = _compute_confidence(candidate)

    ctx.validated[candidate.url] = candidate
    return candidate


def _compute_confidence(candidate: Candidate) -> str:
    """
    score >= 1000  -- an exact "Privacy Policy" text/tier-1 match is already
                      near-certain on its own, regardless of validation.
    score >= 250   -- any "real" structural signal (href match, footer hit,
                      common-path/sitemap/LLM hit) -- becomes "high" once
                      backed by strong content validation (4+ keyword
                      hits), otherwise "medium".
    validation>=60 -- even with a weak structural signal, strong content
                      validation alone is enough for "medium".
    everything else is "low" (includes any negative-page match).
    """
    if candidate.is_negative:
        return "low"

    score = candidate.score
    validation = candidate.validation_score

    if score >= 1000:
        return "high"
    if score >= 250 and validation >= 60:
        return "high"
    if score >= 250:
        return "medium"
    if validation >= 60:
        return "medium"
    return "low"


def pick_best(candidates: list[Candidate], ctx: DiscoveryContext, limit: int = 3) -> Candidate | None:
    """Validate the top `limit` unvalidated candidates (highest score
    first) and return the best one overall, preferring non-negative
    candidates but falling back to a negative one if it's all we have."""
    ranked = sorted(candidates, key=lambda c: c.score, reverse=True)
    for c in ranked[:limit]:
        validate_candidate(c, ctx)

    validated = [c for c in candidates if c.validated or c.url in ctx.validated]
    if not validated:
        return None

    non_negative = [c for c in validated if not c.is_negative]
    pool = non_negative if non_negative else validated
    return max(pool, key=lambda c: (c.score + c.validation_score))


# ---------------------------------------------------------------------------
# Stage 7: LLM candidate ranking
# ---------------------------------------------------------------------------

class LLMRankingError(Exception):
    """Raised internally for stage-7 failures; always caught by the
    coordinator so a broken LLM call never fails discovery outright."""


def stage_llm_rank(candidates: list[Candidate], site_url: str, ctx: DiscoveryContext,
                    mode: str = "auto", model: str = DEFAULT_MODEL) -> Candidate | None:
    """Last resort: ask the model to pick the most likely privacy-policy URL
    from a short list of candidates. Sends ONLY url/anchor-text/title for
    each candidate -- never full page content."""
    # Validate the top-scored candidates first so we can drop any we already
    # know are wrong (a page whose title/content flags it as a Terms of
    # Service / careers / etc. page) and rank the rest by the same
    # score+validation signal pick_best() uses -- not raw pre-validation
    # score, which a mislabeled link (e.g. "Terms of Service (Privacy)")
    # could otherwise win on structure alone.
    prevalidated = sorted(candidates, key=lambda c: c.score, reverse=True)[:MAX_LLM_CANDIDATES]
    for c in prevalidated:
        validate_candidate(c, ctx)

    usable = [c for c in prevalidated if not c.is_negative]
    if not usable:
        usable = prevalidated  # nothing better -- let the ranking pick the least-bad option

    top = sorted(usable, key=lambda c: c.score + c.validation_score, reverse=True)
    if len(top) < 2:
        return None

    items = []
    for c in top:
        items.append({
            "url": c.url,
            "anchor_text": c.link_text[:120],
            "title": ctx.title_cache.get(c.url, "")[:120],
        })

    resolved_mode = mode
    if resolved_mode == "auto":
        resolved_mode = "real" if os.environ.get("ANTHROPIC_API_KEY") else "mock"

    try:
        if resolved_mode == "mock":
            best_index = 0  # deterministic: highest-scored candidate wins
            reasoning = "Mock ranking (no ANTHROPIC_API_KEY configured) -- picked the highest-scored candidate."
        else:
            best_index, reasoning = _llm_rank_call(items, site_url, model)
    except LLMRankingError:
        return None

    if best_index is None or not (0 <= best_index < len(top)):
        return None

    winner = top[best_index]
    winner.source = "llm_ranked"
    winner.reasoning = reasoning or winner.reasoning
    winner.score = max(winner.score, 400)  # LLM endorsement is worth at least a "medium" baseline
    validate_candidate(winner, ctx)
    return winner


_LLM_RANK_PROMPT = """You are helping find a website's privacy policy page. Below is a JSON array of \
candidate links found on or around {site_url} -- each has the URL, the link's visible anchor text, and \
(if known) the target page's <title>. Pick the ONE most likely to be the site's actual privacy policy.

Candidates:
{candidates_json}

Respond with ONLY a JSON object: {{"best_index": <integer index into the array, 0-based>, "reasoning": <one short sentence>}}. \
If none of them look like a real privacy policy, use the closest match and say so briefly in "reasoning".
"""


def _llm_rank_call(items: list[dict], site_url: str, model: str) -> tuple[int | None, str]:
    if anthropic is None:
        raise LLMRankingError("anthropic package not installed")
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise LLMRankingError("ANTHROPIC_API_KEY not set")

    client = anthropic.Anthropic(api_key=api_key)
    prompt = _LLM_RANK_PROMPT.format(site_url=site_url, candidates_json=json.dumps(items, indent=2))

    try:
        response = client.messages.create(
            model=model,
            max_tokens=300,
            messages=[
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": "{"},
            ],
        )
    except Exception as e:
        raise LLMRankingError(f"Anthropic API request failed: {e}") from e

    if not response.content or not getattr(response.content[0], "text", None):
        raise LLMRankingError("empty response from Anthropic API")

    raw = "{" + response.content[0].text
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        brace_match = re.search(r"\{[\s\S]*\}", raw)
        if not brace_match:
            raise LLMRankingError("could not parse LLM ranking response as JSON")
        try:
            parsed = json.loads(brace_match.group(0))
        except json.JSONDecodeError as e:
            raise LLMRankingError(f"could not parse LLM ranking response as JSON: {e}") from e

    return parsed.get("best_index"), str(parsed.get("reasoning", ""))


# ---------------------------------------------------------------------------
# Coordinator
# ---------------------------------------------------------------------------

def find_privacy_policy(
    site_url: str, mode: str = "auto", model: str = DEFAULT_MODEL, cached_policy_url: str | None = None
) -> dict[str, Any]:
    """
    Run the full discovery pipeline for a site, stopping as soon as a
    high-confidence, validated candidate is found. See module docstring for
    the exact response shapes.

    Args:
        site_url: the site to find a privacy policy for.
        mode: "auto" (real LLM ranking if ANTHROPIC_API_KEY is set, else
            mock), "real", or "mock" -- controls ONLY stage 7.
        model: Anthropic model id for stage 7.
        cached_policy_url: a previously discovered policy URL for this site
            (e.g. Website.privacy_policy_url), if any. Tried first with a
            single validation fetch -- if it still checks out, the whole
            multi-stage search is skipped entirely.
    """
    result, _ctx = _run_pipeline(site_url, mode, model, cached_policy_url)
    return result


def find_privacy_policy_with_text(
    site_url: str, mode: str = "auto", model: str = DEFAULT_MODEL, cached_policy_url: str | None = None
) -> tuple[dict[str, Any], str | None]:
    """
    Same contract as find_privacy_policy(), but also returns the winning
    candidate's already-fetched page text (from the validation step's
    internal cache) as a second value, so a caller that needs to summarize
    it -- like tracker.api_views -- doesn't have to fetch the page again.
    `text` is None when nothing was found or the page couldn't be re-read.
    """
    result, ctx = _run_pipeline(site_url, mode, model, cached_policy_url)
    text = ctx.text_cache.get(result.get("policy_url")) if result.get("found") else None
    return result, (text or None)


def _run_pipeline(
    site_url: str, mode: str, model: str, cached_policy_url: str | None = None
) -> tuple[dict[str, Any], DiscoveryContext]:
    normalized = scraper.normalize_url(site_url)
    session = requests.Session()
    ctx = DiscoveryContext(session)

    attempted: list[str] = []
    all_candidates: list[Candidate] = []

    def best_so_far(limit: int = 3) -> Candidate | None:
        return pick_best(all_candidates, ctx, limit=limit)

    # Stage 0 (efficiency shortcut, not one of the 7 numbered stages): if we
    # already know a policy URL for this site from a previous scan, check
    # ONLY that -- one request -- before running the full pipeline. Skipped
    # entirely if the site restructured and the cached URL no longer holds up.
    if cached_policy_url:
        attempted.append("cached_url_check")
        cached_candidate = Candidate(
            url=cached_policy_url, source="cached", score=600,
            reasoning="Previously discovered privacy policy URL for this site.",
        )
        validate_candidate(cached_candidate, ctx)
        if not cached_candidate.is_negative and cached_candidate.validated:
            all_candidates.append(cached_candidate)
            if cached_candidate.confidence == "high":
                return _success(cached_candidate, all_candidates, attempted), ctx
            # Stale-ish but not obviously wrong -- keep it in the running
            # pool and let the normal stages try to beat it.

    # Stages 1 + 2: homepage scan (link text/href/aria-label/title + footer boost)
    attempted.append("homepage_scan")
    homepage_soup, s1 = stage_homepage_scan(normalized, ctx)
    all_candidates.extend(s1)
    best = best_so_far()
    if best and best.confidence == "high":
        return _success(best, all_candidates, attempted), ctx

    # Stage 6: structured metadata -- free (reuses the homepage fetch already done)
    attempted.append("structured_metadata")
    all_candidates.extend(stage_structured_metadata(homepage_soup, normalized))
    best = best_so_far()
    if best and best.confidence == "high":
        return _success(best, all_candidates, attempted), ctx

    # Stage 3: common path guessing
    attempted.append("common_path_guessing")
    all_candidates.extend(stage_common_paths(normalized, ctx))
    best = best_so_far()
    if best and best.confidence == "high":
        return _success(best, all_candidates, attempted), ctx

    # Stage 4: robots.txt + sitemap search
    attempted.append("sitemap_search")
    all_candidates.extend(stage_sitemap_search(normalized, ctx))
    best = best_so_far()
    if best and best.confidence == "high":
        return _success(best, all_candidates, attempted), ctx

    # Stage 5: internal site search -- only if we still have nothing decent
    if best is None or best.confidence == "low":
        attempted.append("internal_site_search")
        all_candidates.extend(stage_internal_search(normalized, ctx))
        best = best_so_far()
        if best and best.confidence == "high":
            return _success(best, all_candidates, attempted), ctx

    # Stage 7: LLM ranking -- last resort, only if genuinely ambiguous
    if len(all_candidates) >= 2 and (best is None or best.confidence != "high"):
        attempted.append("llm_ranking")
        llm_pick = stage_llm_rank(all_candidates, normalized, ctx, mode=mode, model=model)
        if llm_pick is not None:
            # Only let the LLM's pick replace the existing best if it's
            # actually at least as good -- stage 7 is a last resort, not
            # license to override a perfectly good validated candidate.
            current_total = (best.score + best.validation_score) if best else -1
            if (llm_pick.score + llm_pick.validation_score) >= current_total:
                best = llm_pick

    if best is not None:
        return _success(best, all_candidates, attempted), ctx

    return _failure(attempted, all_candidates), ctx


def _success(best: Candidate, all_candidates: list[Candidate], attempted: list[str]) -> dict[str, Any]:
    alternatives = [
        c.to_public_dict() for c in sorted(all_candidates, key=lambda c: c.score, reverse=True)
        if c.url != best.url
    ][:5]

    reasoning = best.reasoning
    if best.is_negative and best.negative_reason:
        reasoning += (
            f" Note: this page looks like it might be a '{best.negative_reason}' page rather than a "
            f"true privacy policy, but no better candidate was found."
        )
    elif best.validated:
        reasoning += f" Validated against the page content ({best.validation_score}/100 policy-language match)."

    return {
        "found": True,
        "policy_url": best.url,
        "discovery_method": best.source,
        "confidence": best.confidence,
        "alternative_candidates": alternatives,
        "reasoning": reasoning.strip(),
        "next_action": "summarize",
    }


def _failure(attempted: list[str], all_candidates: list[Candidate]) -> dict[str, Any]:
    possible = [c.to_public_dict() for c in sorted(all_candidates, key=lambda c: c.score, reverse=True)][:5]
    return {
        "found": False,
        "reason": "Couldn't find a page that reliably looks like this site's privacy policy.",
        "attempted_methods": attempted,
        "possible_candidates": possible,
    }
