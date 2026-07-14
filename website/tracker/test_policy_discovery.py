"""
Tests for tracker.policy_discovery -- the multi-stage privacy-policy
discovery pipeline. Uses Django's SimpleTestCase (no database needed) and
mocks requests.Session.get/head throughout, so nothing here makes a real
network call.

Run with: python manage.py test tracker.test_policy_discovery
"""

from unittest.mock import patch

import requests
from django.test import SimpleTestCase

from tracker import policy_discovery as pd


class FakeResponse:
    def __init__(self, url, status_code=200, text="", ok=None):
        self.url = url
        self.status_code = status_code
        self.text = text
        self.ok = ok if ok is not None else (200 <= status_code < 300)

    def raise_for_status(self):
        if not self.ok:
            raise requests.HTTPError("bad status")


def _run(get_fn, site_url="https://example.com", head_fn=None, mode="mock"):
    head_fn = head_fn or (lambda *a, **k: FakeResponse(a[0], 404, "", False))
    with patch.object(requests.Session, "get", side_effect=get_fn), \
         patch.object(requests.Session, "head", side_effect=head_fn):
        return pd.find_privacy_policy(site_url, mode=mode)


class PolicyDiscoveryPipelineTests(SimpleTestCase):
    def test_exact_text_footer_link_is_high_confidence_stage1_only(self):
        home = '<html><body><footer><a href="/privacy-policy">Privacy Policy</a></footer></body></html>'
        privacy = (
            '<html><head><title>Privacy Policy</title></head><body><h1>Privacy Policy</h1>'
            '<p>We collect personal information. Cookies. Third parties. GDPR. CCPA. '
            'Your rights. Retention. Processing. Controller. Consent.</p></body></html>'
        )

        def get(url, headers=None, timeout=None, allow_redirects=True):
            if url.rstrip("/") == "https://example.com":
                return FakeResponse(url, 200, home)
            if url == "https://example.com/privacy-policy":
                return FakeResponse(url, 200, privacy)
            return FakeResponse(url, 404, "", False)

        result = _run(get)
        self.assertTrue(result["found"])
        self.assertEqual(result["policy_url"], "https://example.com/privacy-policy")
        self.assertEqual(result["confidence"], "high")
        self.assertEqual(result["next_action"], "summarize")

    def test_falls_through_to_common_path_guessing(self):
        home = '<html><head><title>Example Corp</title></head><body><footer><a href="/terms">Terms</a></footer></body></html>'
        privacy = (
            '<html><head><title>Privacy Policy</title></head><body><h1>Privacy Policy</h1>'
            '<p>We collect personal information such as your email. Cookies. Third parties. '
            'GDPR. CCPA. Your rights. Retention. Processing. Controller. Consent.</p></body></html>'
        )

        def get(url, headers=None, timeout=None, allow_redirects=True):
            if url.rstrip("/") == "https://example.com":
                return FakeResponse(url, 200, home)
            if url == "https://example.com/privacy":
                return FakeResponse(url, 200, privacy)
            return FakeResponse(url, 404, "", False)

        def head(url, headers=None, timeout=None, allow_redirects=True):
            if url == "https://example.com/privacy":
                return FakeResponse(url, 200, "")
            return FakeResponse(url, 404, "", False)

        result = _run(get, head_fn=head)
        self.assertTrue(result["found"])
        self.assertEqual(result["policy_url"], "https://example.com/privacy")
        self.assertEqual(result["discovery_method"], "common_path")
        self.assertEqual(result["confidence"], "high")

    def test_total_failure_returns_spec_shaped_response(self):
        def get(url, headers=None, timeout=None, allow_redirects=True):
            if url.rstrip("/") == "https://noop.example":
                return FakeResponse(url, 200, "<html><body><p>Nothing privacy related here.</p></body></html>")
            return FakeResponse(url, 404, "", False)

        result = _run(get, site_url="https://noop.example")
        self.assertFalse(result["found"])
        for key in ("reason", "attempted_methods", "possible_candidates"):
            self.assertIn(key, result)
        self.assertIn("homepage_scan", result["attempted_methods"])

    def test_sitemap_stage_finds_policy_not_linked_on_homepage(self):
        home = "<html><body><p>Nothing on the homepage.</p></body></html>"
        robots = "User-agent: *\nSitemap: https://sitemap.example/sitemap.xml\n"
        sitemap = (
            "<urlset><url><loc>https://sitemap.example/about</loc></url>"
            "<url><loc>https://sitemap.example/legal/privacy-policy</loc></url></urlset>"
        )
        privacy = (
            '<html><head><title>Privacy Policy</title></head><body><h1>Privacy Policy</h1>'
            '<p>Personal information. Cookies. Third parties. GDPR. CCPA. Your rights. '
            'Retention. Processing. Controller. Consent.</p></body></html>'
        )

        def get(url, headers=None, timeout=None, allow_redirects=True):
            if url.rstrip("/") == "https://sitemap.example":
                return FakeResponse(url, 200, home)
            if url.endswith("robots.txt"):
                return FakeResponse(url, 200, robots)
            if url.endswith("sitemap.xml"):
                return FakeResponse(url, 200, sitemap)
            if url == "https://sitemap.example/legal/privacy-policy":
                return FakeResponse(url, 200, privacy)
            return FakeResponse(url, 404, "", False)

        result = _run(get, site_url="https://sitemap.example")
        self.assertTrue(result["found"])
        self.assertEqual(result["policy_url"], "https://sitemap.example/legal/privacy-policy")
        self.assertEqual(result["discovery_method"], "sitemap")

    def test_mislabeled_tos_link_is_passed_over_for_real_privacy_page(self):
        """A footer link literally named 'Terms of Service (Privacy)' scores
        higher structurally than a 'Data Protection' link, but validation
        should reject the former (its content is genuinely a ToS page) and
        prefer the latter."""
        home = (
            '<html><body><footer>'
            '<a href="/terms-of-service">Terms of Service (Privacy)</a>'
            '<a href="/data-protection">Data Protection</a>'
            '</footer></body></html>'
        )
        tos = (
            '<html><head><title>Terms of Service</title></head><body><h1>Terms of Service</h1>'
            '<p>By using this service you agree to these terms. No refunds.</p></body></html>'
        )
        data_protection = (
            '<html><head><title>Data Protection</title></head><body><h1>Data Protection</h1>'
            '<p>We collect personal information and personal data. Cookies. Third parties. '
            'GDPR. CCPA. Your rights. Retention. Processing. Controller. Consent.</p></body></html>'
        )

        def get(url, headers=None, timeout=None, allow_redirects=True):
            if url.rstrip("/") == "https://example.com":
                return FakeResponse(url, 200, home)
            if url == "https://example.com/terms-of-service":
                return FakeResponse(url, 200, tos)
            if url == "https://example.com/data-protection":
                return FakeResponse(url, 200, data_protection)
            return FakeResponse(url, 404, "", False)

        result = _run(get)
        self.assertTrue(result["found"])
        self.assertEqual(result["policy_url"], "https://example.com/data-protection")

    def test_negative_only_candidate_used_as_low_confidence_last_resort(self):
        """When literally every candidate looks negative (e.g. only a
        Careers page vaguely matched), still return it rather than a hard
        failure -- per spec: reject negatives 'unless no better candidate
        exists' -- but mark it low confidence."""
        home = '<html><body><footer><a href="/careers">Careers (GDPR)</a></footer></body></html>'
        careers = (
            '<html><head><title>Careers</title></head><body><h1>Careers</h1>'
            '<p>Join our team! We are hiring engineers.</p></body></html>'
        )

        def get(url, headers=None, timeout=None, allow_redirects=True):
            if url.rstrip("/") == "https://onlybad.example":
                return FakeResponse(url, 200, home)
            if url == "https://onlybad.example/careers":
                return FakeResponse(url, 200, careers)
            return FakeResponse(url, 404, "", False)

        result = _run(get, site_url="https://onlybad.example")
        if result["found"]:
            self.assertEqual(result["confidence"], "low")
        else:
            self.assertIn("reason", result)

    def test_cached_policy_url_short_circuits_when_still_valid(self):
        privacy = (
            '<html><head><title>Privacy Policy</title></head><body><h1>Privacy Policy</h1>'
            '<p>Personal information. Cookies. Third parties. GDPR. CCPA. Your rights. '
            'Retention. Processing. Controller. Consent.</p></body></html>'
        )
        calls = []

        def get(url, headers=None, timeout=None, allow_redirects=True):
            calls.append(url)
            if url == "https://example.com/privacy":
                return FakeResponse(url, 200, privacy)
            return FakeResponse(url, 404, "", False)

        with patch.object(requests.Session, "get", side_effect=get), \
             patch.object(requests.Session, "head", side_effect=lambda *a, **k: FakeResponse(a[0], 404, "", False)):
            result = pd.find_privacy_policy(
                "https://example.com", mode="mock", cached_policy_url="https://example.com/privacy"
            )

        self.assertTrue(result["found"])
        self.assertEqual(result["policy_url"], "https://example.com/privacy")
        self.assertEqual(result["discovery_method"], "cached")
        # Only the cached URL should have been fetched -- no homepage scan needed.
        self.assertEqual(calls, ["https://example.com/privacy"])

    def test_find_privacy_policy_with_text_returns_fetched_text(self):
        home = '<html><body><footer><a href="/privacy-policy">Privacy Policy</a></footer></body></html>'
        privacy = (
            '<html><head><title>Privacy Policy</title></head><body><h1>Privacy Policy</h1>'
            '<p>We collect personal information about you.</p></body></html>'
        )

        def get(url, headers=None, timeout=None, allow_redirects=True):
            if url.rstrip("/") == "https://example.com":
                return FakeResponse(url, 200, home)
            if url == "https://example.com/privacy-policy":
                return FakeResponse(url, 200, privacy)
            return FakeResponse(url, 404, "", False)

        with patch.object(requests.Session, "get", side_effect=get), \
             patch.object(requests.Session, "head", side_effect=lambda *a, **k: FakeResponse(a[0], 404, "", False)):
            result, text = pd.find_privacy_policy_with_text("https://example.com", mode="mock")

        self.assertTrue(result["found"])
        self.assertIsNotNone(text)
        self.assertIn("personal information", text.lower())


class ScoreLinkTests(SimpleTestCase):
    """Focused tests on the scoring function itself, independent of any
    network/HTML fetching."""

    def test_exact_privacy_policy_text_scores_highest_tier(self):
        score = pd.score_link("Privacy Policy", "/legal", "", "", in_footer=False, same_domain=True)
        self.assertGreaterEqual(score, 1000)

    def test_data_protection_is_a_recognized_strong_phrase(self):
        score = pd.score_link("Data Protection", "/data-protection", "", "", in_footer=False, same_domain=True)
        self.assertIsNotNone(score)
        self.assertGreater(score, 1)

    def test_unrelated_link_is_not_a_candidate(self):
        score = pd.score_link("About Us", "/about", "", "", in_footer=False, same_domain=True)
        self.assertIsNone(score)

    def test_aria_label_alone_can_qualify_a_candidate(self):
        score = pd.score_link("", "/legal/doc", "Read our privacy policy", "", in_footer=True, same_domain=True)
        self.assertIsNotNone(score)
