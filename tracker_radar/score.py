"""
score.py

Pure, dependency-free aggregation and scoring logic -- no network calls, no
Playwright, no file I/O beyond what's handed to it. This is deliberate: the
whole point of this milestone is to validate the scoring *rule* itself, so
it needs to be easy to unit test (see test_score.py) and easy to read top
to bottom as "the rule," not buried inside crawling code.

classify_tracker() and build_profile() are the two functions to read if you
want to change how risk is computed -- everything else here is
aggregation/formatting around them. All the actual numbers live in
config.py.
"""

from __future__ import annotations

from collections import Counter

from . import config


def classify_tracker(entry: dict) -> tuple[str, float]:
    """Classify one matched Tracker Radar entry into a (bucket, weight) pair.

    Precedence: a forced-heavy category or a fingerprinting score of 2+
    both win over category-based ad-tracking/CDN classification -- e.g. a
    CDN domain that also does heavy fingerprinting is scored as
    fingerprinting-heavy, not as a CDN. Within the ad-tracking/CDN buckets,
    the higher of the category weight and the domain's own fingerprinting
    weight is used, so e.g. an "Advertising" domain with fingerprinting
    score 1 still gets at least the ad-tracking weight.
    """
    categories = set(entry.get("categories") or [])
    fp_score = entry.get("fingerprinting") or 0
    fp_weight = config.FINGERPRINT_SCORE_WEIGHTS.get(fp_score, 0)

    is_forced_heavy = bool(categories & config.FORCE_HEAVY_CATEGORIES)
    is_high_fingerprinting = fp_score >= 2

    if is_forced_heavy or is_high_fingerprinting:
        weight = max(fp_weight, config.FORCE_HEAVY_WEIGHT if is_forced_heavy else 0)
        return "fingerprinting_heavy", weight
    if categories & config.AD_TRACKING_CATEGORIES:
        return "ad_tracking", max(config.AD_TRACKING_WEIGHT, fp_weight)
    if categories & config.CDN_FUNCTIONAL_CATEGORIES:
        return "cdn_functional", max(config.CDN_FUNCTIONAL_WEIGHT, fp_weight)
    # Matched in the dataset but carries none of the categories above and
    # has a low/zero fingerprinting score -- rare, but don't force it into
    # a bucket it doesn't fit.
    return "other", fp_weight


def _owner_name(entry: dict) -> str | None:
    owner = entry.get("owner") or {}
    return owner.get("name") or owner.get("displayName") or None


def build_profile(site: str, third_party_domains: list[str], dataset) -> dict:
    """Turn one site's captured third-party domains into the profile and
    risk score described in the project spec.

    `dataset` is a loaded dataset.TrackerRadarDataset. Returns a dict whose
    top-level keys match the target schema exactly --
    { site, trackerCount, topCategories, riskScore, flaggedOwners } --
    plus additional detail fields (categoryBreakdown, coverage, etc.) that
    are safe to ignore when merging with the ToS;DR module's output.
    """
    matched: list[tuple[str, dict, str, float]] = []
    unmatched: list[str] = []

    for domain in third_party_domains:
        entry = dataset.lookup(domain)
        if entry is None:
            unmatched.append(domain)
            continue
        bucket, weight = classify_tracker(entry)
        matched.append((domain, entry, bucket, weight))

    category_counter: Counter = Counter()
    fingerprint_tier_counts = {label: 0 for label in config.FINGERPRINT_SCORE_LABELS.values()}
    owners: set[str] = set()
    flagged_owners: set[str] = set()
    weighted_sum = 0.0

    for _domain, entry, bucket, weight in matched:
        for cat in entry.get("categories") or []:
            category_counter[cat] += 1

        fp_score = entry.get("fingerprinting") or 0
        fingerprint_tier_counts[config.FINGERPRINT_SCORE_LABELS.get(fp_score, "none")] += 1

        owner_name = _owner_name(entry)
        if owner_name:
            owners.add(owner_name)
            if bucket == "fingerprinting_heavy":
                flagged_owners.add(owner_name)

        weighted_sum += weight

    total_third_party = len(third_party_domains)
    matched_count = len(matched)
    coverage_ratio = (matched_count / total_third_party) if total_third_party else None
    coverage = _build_coverage_note(total_third_party, matched_count, coverage_ratio)

    if coverage["riskScoreWithheld"]:
        risk_score = None
    else:
        raw_score = weighted_sum * (1 + config.COMPANY_SCALING_COEFFICIENT * len(owners))
        risk_score = round(min(config.RISK_SCORE_CAP, raw_score), 1)

    high_fingerprinting_count = sum(
        1 for _d, entry, _b, _w in matched
        if (entry.get("fingerprinting") or 0) >= config.HIGH_FINGERPRINTING_SCORE_FLOOR
    )

    return {
        # --- core schema (spec item 5) ---
        "site": site,
        "trackerCount": total_third_party,
        "topCategories": [cat for cat, _count in category_counter.most_common(5)],
        "riskScore": risk_score,
        "flaggedOwners": sorted(flagged_owners),
        # --- extra detail, namespaced clearly, safe to drop when merging ---
        "distinctOwnerCount": len(owners),
        "highFingerprintingCount": high_fingerprinting_count,
        "fingerprintingBreakdown": fingerprint_tier_counts,
        "categoryBreakdown": dict(category_counter),
        "unmatchedDomains": unmatched,
        "coverage": coverage,
    }


def _build_coverage_note(total: int, matched: int, ratio: float | None) -> dict:
    """Spec item 6: never silently guess or default a score when Tracker
    Radar coverage for a site is thin or absent. Returns a dict describing
    what was/wasn't found, and whether riskScore should be withheld
    (None) rather than reported as a normal-looking number.
    """
    if total == 0:
        return {
            "matchedCount": 0,
            "totalThirdPartyDomains": 0,
            "coverageRatio": None,
            "lowCoverage": True,
            "riskScoreWithheld": True,
            "note": (
                "No third-party requests were captured for this site. This "
                "could mean the site genuinely loads no third-party "
                "trackers, or that capture failed (blocked automation, a "
                "JS-heavy page that didn't finish loading, etc.) -- verify "
                "manually before concluding either way."
            ),
        }
    if matched == 0:
        return {
            "matchedCount": 0,
            "totalThirdPartyDomains": total,
            "coverageRatio": 0.0,
            "lowCoverage": True,
            "riskScoreWithheld": True,
            "note": (
                f"Captured {total} third-party domain(s) but none were "
                f"found in the Tracker Radar dataset. Risk score withheld "
                f"rather than defaulted to 0 -- this is a dataset coverage "
                f"gap, not evidence of a clean site."
            ),
        }
    low = ratio < config.LOW_COVERAGE_RATIO_THRESHOLD
    note = (
        f"Only {ratio:.0%} of captured third-party domains matched the "
        f"Tracker Radar dataset; the score reflects known trackers only "
        f"and likely undercounts."
        if low else
        f"{ratio:.0%} of captured third-party domains matched the dataset."
    )
    return {
        "matchedCount": matched,
        "totalThirdPartyDomains": total,
        "coverageRatio": round(ratio, 2),
        "lowCoverage": low,
        "riskScoreWithheld": False,
        "note": note,
    }
