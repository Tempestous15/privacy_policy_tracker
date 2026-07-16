"""
config.py

Single source of truth for everything this milestone's prototype needs
tuned by hand: the site list, the dataset location, and the scoring rule's
weights. Nothing here is learned/fit from data -- it's a plain, readable
rule you can edit directly. See README.md for the reasoning behind these
specific numbers; none of them are load-bearing beyond "reasonable
starting point to validate the approach against."
"""

from pathlib import Path

# ---------------------------------------------------------------------------
# Site list
# ---------------------------------------------------------------------------
# Mix of major platforms and smaller/independent sites, so the scoring rule
# gets tested against both ends of the tracking spectrum rather than just
# ad-heavy majors. Swap this out freely -- run.py also accepts --sites-file
# (one URL per line) if you'd rather not edit this file directly.

MAJOR_PLATFORM_SITES = [
    "https://www.google.com",
    "https://www.youtube.com",
    "https://www.facebook.com",
    "https://www.instagram.com",
    "https://www.amazon.com",
    "https://www.reddit.com",
    "https://www.wikipedia.org",
    "https://www.linkedin.com",
    "https://www.spotify.com",
    "https://www.netflix.com",
    "https://www.nytimes.com",
    "https://www.x.com",
    "https://www.walmart.com",
    "https://www.espn.com",
]

SMALLER_INDEPENDENT_SITES = [
    "https://duckduckgo.com",       # near-zero trackers expected -- sanity check
    "https://craigslist.org",       # deliberately minimal, old-school site
    "https://www.propublica.org",   # nonprofit newsroom, smaller ad stack
    "https://basecamp.com",         # small SaaS, privacy-forward marketing
    "https://daringfireball.net",   # one-person blog
    "https://www.metafilter.com",   # small community forum
]

SITES = MAJOR_PLATFORM_SITES + SMALLER_INDEPENDENT_SITES

# ---------------------------------------------------------------------------
# Dataset location
# ---------------------------------------------------------------------------
# Populated by fetch_dataset.sh, which sparse-checks-out just the US region
# of duckduckgo/tracker-radar (20k+ domain entries -- plenty for validating
# the scoring rule; see README.md for why only one region is fetched).
MODULE_DIR = Path(__file__).parent
DATASET_DOMAINS_DIR = MODULE_DIR / "data" / "tracker-radar" / "domains" / "US"

# ---------------------------------------------------------------------------
# Scoring rule -- see score.classify_tracker() for how these combine.
# ---------------------------------------------------------------------------

# DuckDuckGo's own 0-3 fingerprinting scale (0 = no browser-API use,
# 3 = excessive/near-certain tracking use). Kept as its own graduated scale
# rather than collapsed into a single "high" cutoff, so the profile can
# report none/low/medium/high fingerprinting counts distinctly instead of
# a single flattened bucket.
FINGERPRINT_SCORE_LABELS = {0: "none", 1: "low", 2: "medium", 3: "high"}
FINGERPRINT_SCORE_WEIGHTS = {0: 0, 1: 2, 2: 6, 3: 10}

# A domain counts toward "high-fingerprinting" (spec item 3) at this score
# or above -- currently just score 3 ("high"). The full none/low/medium/high
# breakdown is still reported separately either way (fingerprintingBreakdown
# in score.build_profile), so this only controls the single summary count.
HIGH_FINGERPRINTING_SCORE_FLOOR = 3

# Tracker Radar categories bucketed into the three tiers from the spec:
# fingerprinting-related (heavy), ad-tracking (moderate), plain CDN (~0).
# A domain can carry multiple categories; classify_tracker() takes the
# highest-weighted match, so a domain that's both "CDN" and "Analytics"
# (e.g. cloudflare.com) is scored as ad-tracking, not CDN.
AD_TRACKING_CATEGORIES = {
    "Advertising", "Ad Motivated Tracking", "Ad Fraud", "Analytics",
    "Audience Measurement", "Third-Party Analytics Marketing", "Tag Manager",
    "Action Pixels", "Social Network", "Social - Share", "Social - Comment",
    "Federated Login", "SSO",
}
CDN_FUNCTIONAL_CATEGORIES = {
    "CDN", "Embedded Content", "Badge", "Online Payment", "Non-Tracking",
    "Support Chat Widget", "Consent Management Platform", "Fraud Prevention",
}
# These categories describe inherently high-risk behavior regardless of the
# numeric fingerprinting score (e.g. a session-replay script with a low
# fingerprinting score is still recording every mouse movement), so they're
# always scored as heavy.
FORCE_HEAVY_CATEGORIES = {
    "Session Replay", "Malware", "Unknown High Risk Behavior", "Obscure Ownership",
}

AD_TRACKING_WEIGHT = 4
CDN_FUNCTIONAL_WEIGHT = 0.5
FORCE_HEAVY_WEIGHT = 10
UNMATCHED_WEIGHT = 0  # a domain with no Tracker Radar entry scores 0, never
                       # a guess -- see score.build_profile()'s coverage note

# Overall risk score = weighted_sum(trackers) * (1 + COMPANY_SCALING_COEFFICIENT
# * distinct_owner_count), capped at RISK_SCORE_CAP. More distinct companies
# touching the same site is treated as its own risk signal (harder to reason
# about who has your data), independent of raw tracker volume.
COMPANY_SCALING_COEFFICIENT = 0.15
RISK_SCORE_CAP = 100

# If fewer than this fraction of a site's captured third-party domains are
# found in the dataset, the profile is flagged low-coverage. Below this
# threshold the score is still computed (from whatever did match) but
# flagged as likely undercounting -- see score._build_coverage_note().
LOW_COVERAGE_RATIO_THRESHOLD = 0.4
