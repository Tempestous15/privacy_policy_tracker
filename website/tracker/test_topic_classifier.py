"""
Tests for tracker.topic_classifier. Uses Django's SimpleTestCase (no
database needed, matching test_policy_discovery.py's convention) and
mocks the Anthropic client entirely -- nothing here makes a real API call.

Run with: python manage.py test tracker.test_topic_classifier
"""

import json
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from . import topic_classifier

TOPICS = [
    {"id": 25, "name": "Trackers", "description": "How are you tracked?"},
    {"id": 48, "name": "Third Parties", "description": "How much data is processed by external companies?"},
]

# Real-world-shaped fixture: explicit "we do not sell" language should be
# read as protective (good/neutral), not penalized as bad/blocker.
NO_SELL_POLICY_TEXT = """
We do not sell your personal data to third parties under any circumstances.
We use cookies solely to keep you logged in; we do not use third-party
advertising trackers or cross-site tracking technology of any kind.
"""


def _fake_response(completion_after_prefill: str):
    """Builds a fake anthropic.Anthropic().messages.create() return value.
    `completion_after_prefill` is what the model would return AFTER the
    assistant turn was prefilled with "[" -- i.e. it should NOT itself
    start with "[", matching what _call_model expects to re-prepend.
    """
    block = MagicMock()
    block.text = completion_after_prefill
    response = MagicMock()
    response.content = [block]
    return response


def _mock_client(findings_json_array: list) -> MagicMock:
    """findings_json_array is the full intended JSON array; this strips
    the leading '[' the way a real prefilled completion would arrive."""
    full_json = json.dumps(findings_json_array)
    assert full_json.startswith("[")
    client = MagicMock()
    client.messages.create.return_value = _fake_response(full_json[1:])
    return client


class ClassifyPolicyTopicsTests(SimpleTestCase):
    @patch("tracker.topic_classifier._get_client")
    def test_explicit_no_sell_language_classifies_as_protective(self, mock_get_client):
        mock_get_client.return_value = _mock_client([
            {
                "topic_id": 48,
                "topic_name": "Third Parties",
                "title": "No sale of personal data",
                "classification": "good",
                "evidence": "Policy explicitly states data is never sold to third parties.",
                "confidence": 0.95,
            },
        ])

        findings = topic_classifier.classify_policy_topics(NO_SELL_POLICY_TEXT, TOPICS, api_key="fake")

        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["topic_id"], 48)
        self.assertEqual(findings[0]["classification"], "good")
        self.assertNotIn(findings[0]["classification"], ("bad", "blocker"))

    @patch("tracker.topic_classifier._get_client")
    def test_schema_is_valid_for_every_finding(self, mock_get_client):
        mock_get_client.return_value = _mock_client([
            {"topic_id": 25, "topic_name": "Trackers", "title": "No third-party trackers",
             "classification": "good", "evidence": "No ad trackers used.", "confidence": 0.8},
            {"topic_id": 48, "topic_name": "Third Parties", "title": "No data sale",
             "classification": "good", "evidence": "Explicitly does not sell data.", "confidence": 0.9},
        ])

        findings = topic_classifier.classify_policy_topics(NO_SELL_POLICY_TEXT, TOPICS, api_key="fake")

        self.assertEqual(len(findings), 2)
        for finding in findings:
            for key in topic_classifier.REQUIRED_FINDING_KEYS:
                self.assertIn(key, finding)
            self.assertIn(finding["classification"], topic_classifier.VALID_CLASSIFICATIONS)
            self.assertIsInstance(finding["confidence"], float)
            self.assertTrue(0.0 <= finding["confidence"] <= 1.0)

    @patch("tracker.topic_classifier._get_client")
    def test_drops_finding_with_unknown_topic_id(self, mock_get_client):
        mock_get_client.return_value = _mock_client([
            {"topic_id": 999, "topic_name": "Made Up Topic", "title": "x",
             "classification": "bad", "evidence": "x", "confidence": 0.5},
        ])

        findings = topic_classifier.classify_policy_topics(NO_SELL_POLICY_TEXT, TOPICS, api_key="fake")

        self.assertEqual(findings, [])

    @patch("tracker.topic_classifier._get_client")
    def test_drops_finding_with_invalid_classification(self, mock_get_client):
        mock_get_client.return_value = _mock_client([
            {"topic_id": 25, "topic_name": "Trackers", "title": "x",
             "classification": "totally-fine", "evidence": "x", "confidence": 0.5},
        ])

        findings = topic_classifier.classify_policy_topics(NO_SELL_POLICY_TEXT, TOPICS, api_key="fake")

        self.assertEqual(findings, [])

    @patch("tracker.topic_classifier._get_client")
    def test_confidence_out_of_range_is_clamped(self, mock_get_client):
        mock_get_client.return_value = _mock_client([
            {"topic_id": 25, "topic_name": "Trackers", "title": "x",
             "classification": "bad", "evidence": "x", "confidence": 1.7},
        ])

        findings = topic_classifier.classify_policy_topics(NO_SELL_POLICY_TEXT, TOPICS, api_key="fake")

        self.assertEqual(findings[0]["confidence"], 1.0)

    @patch("tracker.topic_classifier._get_client")
    def test_topic_name_is_recomputed_not_trusted_from_model(self, mock_get_client):
        mock_get_client.return_value = _mock_client([
            {"topic_id": 25, "topic_name": "Wrong Name Entirely", "title": "x",
             "classification": "neutral", "evidence": "x", "confidence": 0.5},
        ])

        findings = topic_classifier.classify_policy_topics(NO_SELL_POLICY_TEXT, TOPICS, api_key="fake")

        self.assertEqual(findings[0]["topic_name"], "Trackers")

    @patch("tracker.topic_classifier._get_client")
    def test_non_array_response_raises_malformed_response_error(self, mock_get_client):
        client = MagicMock()
        client.messages.create.return_value = _fake_response('"topic_id": 25}')  # object, not array
        mock_get_client.return_value = client

        with self.assertRaises(topic_classifier.MalformedResponseError):
            topic_classifier.classify_policy_topics(NO_SELL_POLICY_TEXT, TOPICS, api_key="fake")

    def test_empty_policy_text_raises(self):
        with self.assertRaises(topic_classifier.EmptyPolicyTextError):
            topic_classifier.classify_policy_topics("   ", TOPICS, api_key="fake")

    def test_empty_topics_raises(self):
        with self.assertRaises(topic_classifier.NoTopicsProvidedError):
            topic_classifier.classify_policy_topics(NO_SELL_POLICY_TEXT, [], api_key="fake")
