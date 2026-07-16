# tracker_radar/

Independent, **behavior-based** privacy signal: instead of reading what a
site's privacy policy says, this module visits the site and observes what
third-party domains it actually contacts, then cross-references those
domains against [DuckDuckGo's Tracker Radar](https://github.com/duckduckgo/tracker-radar)
dataset. It's meant to sit next to your teammate's ToS;DR-based policy
grade so the two can be compared -- flagging cases where observed behavior
doesn't match a site's stated privacy posture -- without either module
depending on the other.

## Milestone 1 scope (current)

- Clone/inspect the Tracker Radar dataset (see `fetch_dataset.sh`).
- Visit a curated list of ~20 sites (`config.SITES`), capture third-party
  domains via one homepage load each (`capture.py`).
- Look each domain up against the dataset (`dataset.py`), aggregate into a
  per-site profile, and score it with a plain, adjustable weighted rule --
  not a trained model (`score.py`).
- Output clean JSON per site (`run.py`).

Explicitly **not** in this milestone: multi-page crawls, scroll/interaction-triggered
capture, consent-banner handling, parallelized/scaled crawling, or any
learned scoring component. Those are reasonable next steps once the scoring
rule below has been validated against real output -- see "Known
limitations."

## Setup

```bash
pip install -r tracker_radar/requirements.txt
python3 -m playwright install chromium   # downloads a Chromium build
./tracker_radar/fetch_dataset.sh          # sparse-checks-out the dataset's US region
```

## Run

```bash
python3 -m tracker_radar.run                        # config.SITES, prints JSON to stdout
python3 -m tracker_radar.run --sites-file sites.txt  # one URL per line
python3 -m tracker_radar.run --out results.json      # write to a file instead
```

## Output schema

One JSON object per site. Top-level keys match the target schema exactly,
so this can be merged with the ToS;DR module's output without collisions:

```jsonc
{
  "site": "example.com",
  "trackerCount": 7,           // distinct third-party domains contacted
  "topCategories": ["Advertising", "Analytics", ...],  // top 5 by frequency
  "riskScore": 70.0,           // 0-100, or null if coverage was too thin -- see below
  "flaggedOwners": ["Google LLC", "Facebook, Inc."],    // owners of fingerprinting-heavy trackers

  // extra detail -- namespaced clearly, safe to ignore when merging:
  "distinctOwnerCount": 5,
  "highFingerprintingCount": 2,
  "fingerprintingBreakdown": {"none": 0, "low": 2, "medium": 2, "high": 2},
  "categoryBreakdown": {"Advertising": 4, "Analytics": 4, ...},
  "unmatchedDomains": ["some-tracker-not-in-dataset.example"],
  "coverage": {
    "matchedCount": 6, "totalThirdPartyDomains": 7, "coverageRatio": 0.86,
    "lowCoverage": false, "riskScoreWithheld": false,
    "note": "86% of captured third-party domains matched the dataset."
  }
}
```

## The scoring rule

Everything tunable lives in `config.py` as plain constants -- no training,
no model file. `score.classify_tracker()` is the ~15-line function that
turns one matched Tracker Radar entry into a `(bucket, weight)` pair; read
that plus `score.build_profile()` if you want to understand or change how
risk is computed.

**Per-tracker weight** (highest-precedence rule wins):

| Condition | Bucket | Weight |
|---|---|---|
| Category in {Session Replay, Malware, Unknown High Risk Behavior, Obscure Ownership}, OR fingerprinting score &ge; 2 | fingerprinting-heavy | 10 (or the score's own weight if higher) |
| Category in {Advertising, Ad Motivated Tracking, Ad Fraud, Analytics, Audience Measurement, Third-Party Analytics Marketing, Tag Manager, Action Pixels, Social Network/Share/Comment, Federated Login, SSO} | ad-tracking | 4 |
| Category in {CDN, Embedded Content, Badge, Online Payment, Non-Tracking, Support Chat Widget, Consent Management Platform, Fraud Prevention} | CDN/functional | 0.5 |
| Not found in the dataset | -- | 0, tracked separately (never guessed) |

DuckDuckGo's own fingerprinting field is a 0-3 scale (0 = no browser-API
use, 3 = excessive/near-certain tracking use). Rather than collapsing that
into a single "high" cutoff, the profile reports the full none/low/medium/high
breakdown (`fingerprintingBreakdown`); `highFingerprintingCount` and the
`flaggedOwners`/heavy-bucket classification currently use score &ge; 3 as
"high" (`config.HIGH_FINGERPRINTING_SCORE_FLOOR`) -- change that constant
if you want score 2 ("medium") to count too.

**Overall score:**

```
weighted_sum = sum(weight for each matched tracker)
riskScore = min(100, weighted_sum * (1 + 0.15 * distinct_owner_count))
```

More distinct companies touching the same site is treated as its own risk
signal (harder to reason about who has your data), independent of raw
tracker volume -- that's `config.COMPANY_SCALING_COEFFICIENT`.

## Coverage handling (never guess)

If a site has little or no Tracker Radar coverage, `riskScore` is `null`
rather than a misleadingly normal-looking number:

- **Zero third-party domains captured at all** -- could mean a genuinely
  clean site, or a capture failure (blocked automation, unfinished JS load).
  `coverage.riskScoreWithheld = true`.
- **Third-party domains captured, but none matched the dataset** -- a
  dataset coverage gap, not evidence of a clean site.
  `coverage.riskScoreWithheld = true`.
- **Some matched, but below `LOW_COVERAGE_RATIO_THRESHOLD` (default 40%)**
  -- still scored (from whatever did match), but `coverage.lowCoverage = true`
  with a note that the score likely undercounts.

## The site list

`config.SITES` mixes 14 major platforms with 6 smaller/independent sites
(including `duckduckgo.com` and `craigslist.org` as low-tracking sanity
checks) so the scoring rule gets validated against both ends of the
tracking spectrum, not just ad-heavy majors. Override with `--sites-file`.

## Known limitations (deliberately out of scope for this milestone)

- **Homepage only, one load.** Trackers that only fire on login, checkout,
  scroll, or after a consent-banner interaction won't be captured. This is
  the single biggest source of undercounting right now.
- **US dataset region only.** `fetch_dataset.sh` only pulls `domains/US`
  (20k+ entries) to keep the checkout small; a site whose trackers are
  primarily catalogued under another region will show artificially low
  coverage. Worth revisiting once this scales past the prototype stage.
- **Subdomain matching is a simple label-walk**, not the dataset's own
  `cnames`/`resources` regex matching -- see `dataset.lookup()`. Good
  enough for eTLD+1-level grouping, not a perfect reimplementation of how
  Tracker Radar itself matches requests.
- **Sequential, single-browser-process capture.** Fine for ~20 sites by
  hand; would need parallelization to scale.
- **No trained model, on purpose** -- this milestone is about validating
  the rule's shape and weights against real sites before considering
  anything more sophisticated.

## Dataset license

Tracker Radar is licensed **CC BY-NC-SA 4.0 (non-commercial)**. That's
fine for this prototype/validation stage, but worth a real look (not legal
advice here) before this data ends up under anything shipped commercially
-- DuckDuckGo's README points to contacting them directly for a commercial
license.
