"""
Tests for tracker_radar.score -- the scoring rule itself. No network calls,
no Playwright, no real dataset checkout needed: a FakeDataset stands in for
dataset.TrackerRadarDataset, and the fixture entries below are shaped
exactly like real Tracker Radar entries (copied from real lookups against
the dataset -- google-analytics.com, doubleclick.net, facebook.net,
cloudflare.com, fullstory.com -- during development of this module) so the
tests double as a sanity check on classify_tracker()'s real-world behavior.

Run with: python3 -m unittest tracker_radar.test_score -v
"""

import unittest

from tracker_radar import config
from tracker_radar.score import build_profile, classify_tracker

# Real Tracker Radar entries (trimmed to the fields score.py reads),
# fetched from the dataset during development -- see README.md.
GOOGLE_ANALYTICS = {
    "domain": "google-analytics.com",
    "owner": {"name": "Google LLC", "displayName": "Google"},
    "fingerprinting": 1,
    "categories": ["Advertising", "Analytics", "Audience Measurement", "Third-Party Analytics Marketing"],
}
DOUBLECLICK = {
    "domain": "doubleclick.net",
    "owner": {"name": "Google LLC", "displayName": "Google"},
    "fingerprinting": 3,
    "categories": ["Ad Motivated Tracking", "Advertising"],
}
FACEBOOK_NET = {
    "domain": "facebook.net",
    "owner": {"name": "Facebook, Inc.", "displayName": "Facebook"},
    "fingerprinting": 2,
    "categories": ["Ad Motivated Tracking", "Advertising", "Analytics", "Social Network"],
}
CLOUDFLARE = {
    "domain": "cloudflare.com",
    "owner": {"name": "Cloudflare, Inc.", "displayName": "Cloudflare"},
    "fingerprinting": 2,
    "categories": ["Analytics", "CDN", "Embedded Content"],
}
PLAIN_CDN = {
    "domain": "jsdelivr.net",
    "owner": {"name": "jsDelivr", "displayName": "jsDelivr"},
    "fingerprinting": 0,
    "categories": ["CDN"],
}
FULLSTORY = {
    "domain": "fullstory.com",
    "owner": {"name": "FullStory", "displayName": "FullStory"},
    "fingerprinting": 2,
    "categories": ["Analytics", "Session Replay"],
}


class FakeDataset:
    """Minimal stand-in for dataset.TrackerRadarDataset -- exact-match only,
    which is all these tests need."""

    def __init__(self, entries: dict[str, dict]):
        self._entries = entries

    def lookup(self, domain: str):
        return self._entries.get(domain)


class ClassifyTrackerTests(unittest.TestCase):
    def test_plain_cdn_is_near_zero(self):
        bucket, weight = classify_tracker(PLAIN_CDN)
        self.assertEqual(bucket, "cdn_functional")
        self.assertEqual(weight, config.CDN_FUNCTIONAL_WEIGHT)

    def test_ad_tracking_category_gets_moderate_weight(self):
        bucket, weight = classify_tracker(GOOGLE_ANALYTICS)
        self.assertEqual(bucket, "ad_tracking")
        self.assertEqual(weight, config.AD_TRACKING_WEIGHT)

    def test_high_fingerprinting_score_wins_even_without_forced_category(self):
        # doubleclick.net: fingerprinting=3, categories are ad-tracking ones,
        # not in FORCE_HEAVY_CATEGORIES -- score alone should push it heavy.
        bucket, weight = classify_tracker(DOUBLECLICK)
        self.assertEqual(bucket, "fingerprinting_heavy")
        self.assertEqual(weight, config.FINGERPRINT_SCORE_WEIGHTS[3])

    def test_session_replay_is_forced_heavy_regardless_of_score(self):
        bucket, weight = classify_tracker(FULLSTORY)
        self.assertEqual(bucket, "fingerprinting_heavy")
        self.assertEqual(weight, config.FORCE_HEAVY_WEIGHT)

    def test_cdn_domain_with_moderate_fingerprinting_is_not_downgraded(self):
        # cloudflare.com: category is CDN-ish, but fingerprinting=2 should
        # still push it to fingerprinting_heavy, not cdn_functional.
        bucket, weight = classify_tracker(CLOUDFLARE)
        self.assertEqual(bucket, "fingerprinting_heavy")
        self.assertEqual(weight, config.FINGERPRINT_SCORE_WEIGHTS[2])


class BuildProfileTests(unittest.TestCase):
    def test_schema_has_required_top_level_keys(self):
        dataset = FakeDataset({"doubleclick.net": DOUBLECLICK})
        profile = build_profile("example.com", ["doubleclick.net"], dataset)
        for key in ("site", "trackerCount", "topCategories", "riskScore", "flaggedOwners"):
            self.assertIn(key, profile)

    def test_no_third_party_domains_withholds_score(self):
        dataset = FakeDataset({})
        profile = build_profile("example.com", [], dataset)
        self.assertIsNone(profile["riskScore"])
        self.assertTrue(profile["coverage"]["riskScoreWithheld"])
        self.assertEqual(profile["trackerCount"], 0)

    def test_all_domains_unmatched_withholds_score_instead_of_defaulting_to_zero(self):
        dataset = FakeDataset({})  # nothing in the dataset matches
        profile = build_profile("example.com", ["some-unknown-tracker.example"], dataset)
        self.assertIsNone(profile["riskScore"])
        self.assertTrue(profile["coverage"]["lowCoverage"])
        self.assertEqual(profile["unmatchedDomains"], ["some-unknown-tracker.example"])

    def test_low_coverage_still_scores_but_flags_it(self):
        # 1 of 4 captured domains found in the dataset -> below the 0.4
        # threshold, so it should score (not withhold) but flag lowCoverage.
        dataset = FakeDataset({"doubleclick.net": DOUBLECLICK})
        domains = ["doubleclick.net", "unknown-a.example", "unknown-b.example", "unknown-c.example"]
        profile = build_profile("example.com", domains, dataset)
        self.assertIsNotNone(profile["riskScore"])
        self.assertTrue(profile["coverage"]["lowCoverage"])
        self.assertEqual(len(profile["unmatchedDomains"]), 3)

    def test_more_distinct_owners_scores_higher_for_identical_weighted_sum(self):
        # Two forced-heavy trackers (weight 10 each, same weighted_sum=20 in
        # both cases) from a single owner vs. from two different owners --
        # only the owner count differs, so the company-scaling factor should
        # be the sole reason the second profile scores higher.
        tracker_a1 = {"domain": "a1.example", "owner": {"name": "Acme"}, "fingerprinting": 0, "categories": ["Malware"]}
        tracker_a2 = {"domain": "a2.example", "owner": {"name": "Acme"}, "fingerprinting": 0, "categories": ["Malware"]}
        tracker_b1 = {"domain": "b1.example", "owner": {"name": "Acme"}, "fingerprinting": 0, "categories": ["Malware"]}
        tracker_b2 = {"domain": "b2.example", "owner": {"name": "Zenith"}, "fingerprinting": 0, "categories": ["Malware"]}

        same_owner_dataset = FakeDataset({"a1.example": tracker_a1, "a2.example": tracker_a2})
        diff_owner_dataset = FakeDataset({"b1.example": tracker_b1, "b2.example": tracker_b2})

        same_owner_profile = build_profile("a.com", ["a1.example", "a2.example"], same_owner_dataset)
        diff_owner_profile = build_profile("b.com", ["b1.example", "b2.example"], diff_owner_dataset)

        self.assertEqual(same_owner_profile["distinctOwnerCount"], 1)
        self.assertEqual(diff_owner_profile["distinctOwnerCount"], 2)
        self.assertGreater(diff_owner_profile["riskScore"], same_owner_profile["riskScore"])

    def test_high_fingerprinting_count_uses_configured_floor(self):
        dataset = FakeDataset({
            "doubleclick.net": DOUBLECLICK,   # score 3 -> counts
            "facebook.net": FACEBOOK_NET,     # score 2 -> does not count at floor=3
        })
        profile = build_profile("example.com", ["doubleclick.net", "facebook.net"], dataset)
        self.assertEqual(profile["highFingerprintingCount"], 1)
        self.assertEqual(profile["fingerprintingBreakdown"]["high"], 1)
        self.assertEqual(profile["fingerprintingBreakdown"]["medium"], 1)

    def test_flagged_owners_only_includes_fingerprinting_heavy_bucket(self):
        dataset = FakeDataset({
            "doubleclick.net": DOUBLECLICK,        # fingerprinting_heavy -> Google flagged
            "google-analytics.com": GOOGLE_ANALYTICS,  # ad_tracking -> Google not flagged again (already is)
            "jsdelivr.net": PLAIN_CDN,             # cdn_functional -> jsDelivr not flagged
        })
        profile = build_profile(
            "example.com", ["doubleclick.net", "google-analytics.com", "jsdelivr.net"], dataset,
        )
        self.assertEqual(profile["flaggedOwners"], ["Google LLC"])
        self.assertEqual(profile["distinctOwnerCount"], 2)  # Google + jsDelivr


if __name__ == "__main__":
    unittest.main()
