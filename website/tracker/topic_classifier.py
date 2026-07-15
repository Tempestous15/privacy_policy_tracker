"""
topic_classifier.py

LLM-based privacy-policy topic classifier that mirrors ToS;DR's own
curation model: given a fixed taxonomy of topics, identify which topics a
policy's text actually addresses and rate each on ToS;DR's own
good/neutral/bad/blocker scale.

This is step 1 of a 3-step risk model. Step 2 (see tracker_radar/ on the
trackerRadarIntegration branch) independently observes what a site
actually does over the network, using DuckDuckGo's Tracker Radar dataset
-- no policy text involved. Step 3 will compare the two without caring how
either was produced. So, like summarizer.py, this module's contract is
kept deliberately narrow and stable: raw policy text + a topic list in, a
validated list of finding dicts out. No Django/view concerns, no
scraping/fetching of its own, no persistence.

ANTHROPIC_API_KEY is read from an environment variable only, same as
summarizer.py. Server-side only -- never import this into anything that
ships to the browser.

This module deliberately reuses summarizer.py's error hierarchy and its
_get_client()/_extract_json() helpers rather than duplicating them -- the
failure modes (missing API key, bad network call, non-JSON response) are
identical between the two modules. summarizer.py itself is untouched.
"""

from __future__ import annotations

import json
from typing import Any

from .summarizer import (
    AnthropicAPIError,
    MalformedResponseError,
    SummarizerError,
    _extract_json,
    _get_client,
)

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
# AnthropicAPIError, MalformedResponseError, and SummarizerConfigError
# (raised inside the imported _get_client()) all come from summarizer.py.
# Only the errors specific to *this* module's own input shape are defined
# here.

class EmptyPolicyTextError(SummarizerError):
    """Raised when there's no policy text to classify."""


class NoTopicsProvidedError(SummarizerError):
    """Raised when the topics list is empty -- there's nothing to classify against."""


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-5"

# Same guard rationale as summarizer.py's MAX_POLICY_CHARS -- bounds
# cost/latency on outlier-length policies.
MAX_POLICY_CHARS = 15000

VALID_CLASSIFICATIONS = ("good", "neutral", "bad", "blocker")

REQUIRED_FINDING_KEYS = (
    "topic_id", "topic_name", "title", "classification", "evidence", "confidence",
)

# Reusable prompt template -- {topics_json} and {policy_text} are filled in
# at call time. Same "respond with ONLY JSON" + assistant-turn-prefill
# pattern as summarizer.py, except the expected top-level shape here is a
# JSON *array* (prefilled with "[", see _call_model), not an object.
TOPIC_CLASSIFICATION_PROMPT_TEMPLATE = """You are annotating a privacy policy the same way ToS;DR curators \
do: identifying specific points in the text and rating each against a fixed topic taxonomy.

You will be given (1) a list of topics with their id, name, and description, and (2) the raw policy text. \
For each topic the text actually addresses, extract one finding. Skip topics the text doesn't address at \
all -- do not force a finding onto every topic just because it's in the list.

Respond with ONLY a single valid JSON array -- no markdown fences, no commentary before or after -- where \
each item matches exactly:

{{
  "topic_id": int,
  "topic_name": string,
  "title": string,          // short case-style label, e.g. "Broad third-party data sharing"
  "classification": "good" | "neutral" | "bad" | "blocker",
  "evidence": string,       // under 25 words, paraphrased in your own words -- not a verbatim quote
  "confidence": float       // 0.0-1.0, how confident you are in this classification
}}

Classification guidance (mirrors ToS;DR's own scale):
- "good": genuinely protective of the user, beyond typical baseline (e.g. clearly stated, short retention limits)
- "neutral": informative but doesn't meaningfully help or hurt the user
- "bad": works against the user's interests (e.g. broad third-party sharing, vague retention language)
- "blocker": severe enough that a privacy-conscious user should reconsider using the service at all \
(e.g. sells data to data brokers, no account deletion path)

Topics:
{topics_json}

Privacy policy text:
\"\"\"
{policy_text}
\"\"\"
"""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def classify_policy_topics(
    policy_text: str,
    topics: list[dict[str, Any]],
    model: str = DEFAULT_MODEL,
    api_key: str | None = None,
) -> list[dict[str, Any]]:
    """
    Classify a privacy policy's text against a fixed ToS;DR-style topic
    taxonomy.

    Args:
        policy_text: Raw (or cleaned) policy text.
        topics: List of {"id": int, "name": str, "description": str}. See
            tosdr_topics.load_topics() for a way to get ToS;DR's real
            taxonomy from a bundled dataset snapshot.
        model: Anthropic model id to use.
        api_key: Anthropic API key for this call. Falls back to the
            ANTHROPIC_API_KEY environment variable if omitted (keeps this
            usable standalone, e.g. from eval_tosdr.py or a script).

    Returns:
        A list of finding dicts, one per topic the policy text actually
        addresses (topics it doesn't address are simply absent -- this
        never pads the list to cover every input topic):
            [{
                "topic_id": int, "topic_name": str, "title": str,
                "classification": "good"|"neutral"|"bad"|"blocker",
                "evidence": str, "confidence": float,
            }, ...]
        Findings referencing a topic_id not present in the input `topics`,
        or an unrecognized classification value, are dropped rather than
        kept with fabricated/guessed data -- see _parse_and_validate().
        Plain JSON-serializable data -- safe to store, return from an API
        endpoint, or feed into eval_tosdr.py.

    Raises:
        EmptyPolicyTextError: policy_text is empty/whitespace-only.
        NoTopicsProvidedError: topics is empty.
        SummarizerConfigError: (from summarizer._get_client) the
            'anthropic' package isn't installed, or no API key is available.
        AnthropicAPIError: the API call itself failed.
        MalformedResponseError: the model's response wasn't valid JSON, or
            wasn't a JSON array.

    # NOTE for step 3: this is the one function a future comparison module
    # should call for the policy-text side. Keep this input/output shape
    # stable so step 3 doesn't need to care how classification was
    # produced -- same discipline as summarizer.summarize_policy().
    """
    if not policy_text or not policy_text.strip():
        raise EmptyPolicyTextError("policy_text is empty; nothing to classify.")
    if not topics:
        raise NoTopicsProvidedError("topics is empty; nothing to classify against.")

    client = _get_client(api_key)
    topics_json = json.dumps(
        [{"id": t["id"], "name": t["name"], "description": t.get("description", "")} for t in topics],
        indent=2,
    )
    prompt = TOPIC_CLASSIFICATION_PROMPT_TEMPLATE.format(
        topics_json=topics_json,
        policy_text=policy_text.strip()[:MAX_POLICY_CHARS],
    )
    raw_text = _call_model(client, prompt, model)
    valid_topic_ids = {t["id"] for t in topics}
    return _parse_and_validate(raw_text, valid_topic_ids, topics)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

def _call_model(client, prompt: str, model: str) -> str:
    """Call the API and return the raw response text. The assistant turn is
    prefilled with '[' (not '{' like summarizer.py) since this module's
    expected top-level shape is a JSON array, so the model completes the
    array directly instead of prefacing it with commentary or fences."""
    try:
        response = client.messages.create(
            model=model,
            max_tokens=4000,  # a full policy can surface many findings; summarizer.py's 1500 is too tight here
            messages=[
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": "["},
            ],
        )
    except Exception as e:  # anthropic raises several exception types; treat uniformly
        raise AnthropicAPIError(f"Anthropic API request failed: {e}") from e

    if not response.content or not getattr(response.content[0], "text", None):
        raise AnthropicAPIError("Anthropic API returned an empty response.")

    # Re-prepend the "[" we prefilled -- the API only returns the completion.
    return "[" + response.content[0].text


def _parse_and_validate(
    raw_text: str, valid_topic_ids: set[int], topics: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    parsed = _extract_json(raw_text)

    if not isinstance(parsed, list):
        raise MalformedResponseError("Model response was valid JSON but not a JSON array.")

    topic_names_by_id = {t["id"]: t["name"] for t in topics}
    findings: list[dict[str, Any]] = []

    for item in parsed:
        if not isinstance(item, dict):
            continue  # malformed entry -- skip rather than fail the whole batch

        missing = [key for key in REQUIRED_FINDING_KEYS if key not in item]
        if missing:
            continue  # incomplete finding -- skip rather than guess the missing fields

        topic_id = item.get("topic_id")
        if not isinstance(topic_id, int) or topic_id not in valid_topic_ids:
            # Hallucinated/out-of-taxonomy topic_id -- drop this finding
            # rather than keep a reference to a topic that doesn't exist
            # in the taxonomy we gave the model.
            continue

        classification = str(item.get("classification", "")).strip().lower()
        if classification not in VALID_CLASSIFICATIONS:
            # No natural "unknown" bucket on ToS;DR's four-value scale --
            # better to drop an unparseable classification than fabricate one.
            continue

        try:
            confidence = float(item.get("confidence", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0
        confidence = max(0.0, min(1.0, confidence))

        # topic_name is recomputed from the real taxonomy rather than
        # trusted from the model's echo, so it can't drift from topic_id.
        findings.append({
            "topic_id": topic_id,
            "topic_name": topic_names_by_id.get(topic_id, str(item.get("topic_name", ""))),
            "title": str(item.get("title", "")).strip(),
            "classification": classification,
            "evidence": str(item.get("evidence", "")).strip(),
            "confidence": confidence,
        })

    return findings
