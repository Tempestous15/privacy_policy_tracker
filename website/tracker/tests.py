"""
Tests for tracker.api_views (the browser extension's backend endpoint).

Uses Django's TestCase (not SimpleTestCase) since summarize_policy_api
writes to the database (Website/PolicySnapshot) as a best-effort side
effect. All network calls (page fetches, Anthropic API) are mocked --
nothing here makes a real HTTP request.

Run with: python manage.py test tracker
"""

import json
from unittest.mock import patch

from django.test import Client, TestCase

from .models import PolicySnapshot, Website


def _bs4(html):
    from bs4 import BeautifulSoup
    return BeautifulSoup(html, "html.parser")


SAMPLE_POLICY_HTML = """
<html><body>
<h1>Privacy Policy</h1>
<p>We collect your email address and usage data.</p>
<p>We do not sell your data to third parties.</p>
</body></html>
"""

MOCK_SUMMARY_KEYS = (
    "data_collected", "data_usage", "third_party_sharing", "retention",
    "user_rights", "red_flags", "plain_english_summary", "risk_level",
    "user_takeaways",
)


class SummarizePolicyApiTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.url = "/api/summarize-policy/"

    def post(self, payload):
        return self.client.post(
            self.url, data=json.dumps(payload), content_type="application/json"
        )

    # -- basic validation -----------------------------------------------

    def test_options_request_returns_cors_headers(self):
        response = self.client.options(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Access-Control-Allow-Origin"], "*")
        self.assertIn("POST", response["Access-Control-Allow-Methods"])

    def test_get_not_allowed(self):
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 405)

    def test_invalid_json_body(self):
        response = self.client.post(self.url, data="not json", content_type="application/json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.json())

    def test_missing_site_url_and_policy_url(self):
        response = self.post({"domain": "example.com"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.json())

    def test_response_has_cors_header_on_error_too(self):
        response = self.post({"domain": "example.com"})
        self.assertEqual(response["Access-Control-Allow-Origin"], "*")

    # -- happy path: client already found the policy URL -----------------

    @patch("tracker.api_views.scraper.get_soup")
    def test_summarizes_client_supplied_policy_url_in_mock_mode(self, mock_get_soup):
        mock_get_soup.return_value = _bs4(SAMPLE_POLICY_HTML)

        response = self.post({
            "site_url": "https://example.com",
            "domain": "example.com",
            "policy_url": "https://example.com/privacy",
            "mode": "mock",
        })

        self.assertEqual(response.status_code, 200)
        body = response.json()
        for key in MOCK_SUMMARY_KEYS:
            self.assertIn(key, body)
        self.assertEqual(body["policy_url"], "https://example.com/privacy")
        self.assertTrue(body["mock"])

    @patch("tracker.api_views.scraper.get_soup")
    def test_mock_mode_does_not_persist_a_snapshot(self, mock_get_soup):
        mock_get_soup.return_value = _bs4(SAMPLE_POLICY_HTML)

        self.post({
            "site_url": "https://example.com",
            "domain": "example.com",
            "policy_url": "https://example.com/privacy",
            "mode": "mock",
        })

        website = Website.objects.filter(url="https://example.com").first()
        self.assertIsNotNone(website)  # Website record is still upserted
        self.assertEqual(website.snapshots.count(), 0)  # but no snapshot in mock mode

    @patch("tracker.api_views.summarizer.summarize_policy")
    @patch("tracker.api_views.scraper.get_soup")
    def test_real_mode_persists_website_and_snapshot(self, mock_get_soup, mock_summarize):
        mock_get_soup.return_value = _bs4(SAMPLE_POLICY_HTML)
        mock_summarize.return_value = {
            "data_collected": ["email address"], "data_usage": ["service delivery"],
            "third_party_sharing": ["not sold"], "retention": ["not stated"],
            "user_rights": ["access, deletion"], "red_flags": [],
            "plain_english_summary": "A short summary.", "risk_level": "low",
            "user_takeaways": ["Nothing alarming here."],
        }

        response = self.post({
            "site_url": "https://example.com",
            "domain": "example.com",
            "policy_url": "https://example.com/privacy",
            "mode": "real",
        })

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["mock"])
        self.assertEqual(body["risk_level"], "low")

        website = Website.objects.get(url="https://example.com")
        self.assertEqual(website.privacy_policy_url, "https://example.com/privacy")
        self.assertEqual(website.snapshots.count(), 1)
        snapshot = website.snapshots.first()
        self.assertEqual(snapshot.summary["risk_level"], "low")

    # -- server-side fallback discovery (client found nothing) -----------
    #
    # tracker.policy_discovery.find_privacy_policy_with_text() itself has
    # its own dedicated test suite (test_policy_discovery.py) covering the
    # 7-stage pipeline in detail with mocked network calls. Here we only
    # need to confirm api_views.py wires it up correctly.

    @patch("tracker.api_views.policy_discovery.find_privacy_policy_with_text")
    def test_falls_back_to_discovery_when_no_client_policy_url(self, mock_discover):
        mock_discover.return_value = (
            {
                "found": True,
                "policy_url": "https://example.com/legal/privacy",
                "discovery_method": "common_path",
                "confidence": "high",
                "alternative_candidates": [],
                "reasoning": "Guessed path resolved successfully.",
                "next_action": "summarize",
            },
            "We collect your email. We do not sell your data.",
        )

        response = self.post({
            "site_url": "https://example.com",
            "domain": "example.com",
            "policy_url": None,
            "mode": "mock",
        })

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["policy_url"], "https://example.com/legal/privacy")
        self.assertEqual(body["discovery_method"], "common_path")
        self.assertEqual(body["discovery_confidence"], "high")
        mock_discover.assert_called_once()

    @patch("tracker.api_views.policy_discovery.find_privacy_policy_with_text")
    def test_returns_404_when_discovery_finds_nothing(self, mock_discover):
        mock_discover.return_value = (
            {
                "found": False,
                "reason": "Couldn't find a page that reliably looks like this site's privacy policy.",
                "attempted_methods": ["homepage_scan", "common_path_guessing"],
                "possible_candidates": [],
            },
            None,
        )

        response = self.post({
            "site_url": "https://example.com",
            "domain": "example.com",
            "policy_url": None,
        })

        self.assertEqual(response.status_code, 404)
        body = response.json()
        self.assertIn("error", body)
        self.assertEqual(body.get("domain"), "example.com")
        self.assertIn("homepage_scan", body.get("attempted_methods", []))

    def test_uses_cached_website_policy_url_when_client_sends_none(self):
        Website.objects.create(
            name="example.com", url="https://example.com",
            privacy_policy_url="https://example.com/cached-privacy",
        )
        with patch("tracker.api_views.policy_discovery.find_privacy_policy_with_text") as mock_discover:
            mock_discover.return_value = (
                {
                    "found": True,
                    "policy_url": "https://example.com/cached-privacy",
                    "discovery_method": "cached",
                    "confidence": "high",
                    "alternative_candidates": [],
                    "reasoning": "Previously discovered privacy policy URL for this site.",
                    "next_action": "summarize",
                },
                "Some policy text.",
            )
            response = self.post({"site_url": "https://example.com", "mode": "mock"})

        self.assertEqual(response.status_code, 200)
        # confirm the cached URL was passed through to find_privacy_policy_with_text
        _, kwargs = mock_discover.call_args
        self.assertEqual(kwargs.get("cached_policy_url"), "https://example.com/cached-privacy")

    # -- error handling ----------------------------------------------------

    @patch("tracker.api_views.scraper.get_soup")
    def test_fetch_failure_on_client_supplied_url_returns_502(self, mock_get_soup):
        mock_get_soup.side_effect = Exception("connection reset")

        response = self.post({
            "site_url": "https://example.com",
            "policy_url": "https://example.com/privacy",
        })

        self.assertEqual(response.status_code, 502)
        self.assertIn("error", response.json())

    @patch("tracker.api_views.scraper.get_soup")
    def test_empty_policy_text_returns_422(self, mock_get_soup):
        mock_get_soup.return_value = _bs4("<html><body></body></html>")

        response = self.post({
            "site_url": "https://example.com",
            "policy_url": "https://example.com/privacy",
        })

        self.assertEqual(response.status_code, 422)

    @patch("tracker.api_views.summarizer.summarize_policy")
    @patch("tracker.api_views.scraper.get_soup")
    def test_summarizer_error_returns_502(self, mock_get_soup, mock_summarize):
        from . import summarizer
        mock_get_soup.return_value = _bs4(SAMPLE_POLICY_HTML)
        mock_summarize.side_effect = summarizer.SummarizerConfigError("no API key configured")

        response = self.post({
            "site_url": "https://example.com",
            "policy_url": "https://example.com/privacy",
            "mode": "real",
        })

        self.assertEqual(response.status_code, 502)
        self.assertIn("error", response.json())
