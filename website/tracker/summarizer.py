"""
summarizer.py

LLM-based privacy-policy summarization service.

Takes the *cleaned* privacy-policy text already produced by tracker/scraper.py
and turns it into a structured JSON summary using the Anthropic API. This
module does no scraping/fetching of its own -- it only summarizes text it's
handed, and it has no Django request/response concerns (no imports from
views.py, no HttpResponse, etc.) so it can be called from a view, a
management command, or a background task without change.

ANTHROPIC_API_KEY is read from an environment variable only. This module
must never be imported by anything that runs in the browser (templates,
static JS, etc.) -- it is server-side only.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

try:
    import anthropic
except ImportError:  # package not installed yet -- handled at call time, not import time
    anthropic = None


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class SummarizerError(Exception):
    """Base class for all summarizer failures. Callers that don't care about
    the distinction between failure modes can just catch this."""


class EmptyPolicyTextError(SummarizerError):
    """Raised when there's no policy text to summarize."""


class SummarizerConfigError(SummarizerError):
    """Raised for setup problems: missing 'anthropic' package or missing
    ANTHROPIC_API_KEY. Distinct from a runtime API failure."""


class AnthropicAPIError(SummarizerError):
    """Raised when the Anthropic API call itself fails (network error,
    rate limit, timeout, bad status, etc.)."""


class MalformedResponseError(SummarizerError):
    """Raised when the model responded but the output wasn't valid JSON, or
    didn't match the expected schema closely enough to trust."""


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-5"

# Guards against sending enormous policies -- keeps cost/latency bounded.
# Most privacy policies are a few thousand words; this is a generous ceiling.
MAX_POLICY_CHARS = 15000

REQUIRED_KEYS = (
    "data_collected",
    "data_usage",
    "third_party_sharing",
    "retention",
    "user_rights",
    "red_flags",
    "plain_english_summary",
    "risk_level",
    "user_takeaways",
)

LIST_KEYS = (
    "data_collected",
    "data_usage",
    "third_party_sharing",
    "retention",
    "user_rights",
    "red_flags",
    "user_takeaways",
)

VALID_RISK_LEVELS = ("low", "medium", "high", "unknown")

# Reusable prompt template -- {policy_text} is filled in at call time.
# The model is instructed to reply with ONLY JSON, and the API call itself
# prefills the assistant turn with "{" (see _call_model) so the response
# starts as JSON without leading commentary or markdown fences.
SUMMARY_PROMPT_TEMPLATE = """You are a consumer privacy analyst. Read the privacy policy text below and \
summarize it for an ordinary, non-lawyer website visitor who wants a quick, honest sense of what a \
company does with their data.

Respond with ONLY a single valid JSON object -- no markdown code fences, no commentary before or after \
-- matching exactly this shape:

{{
  "data_collected": [string, ...],
  "data_usage": [string, ...],
  "third_party_sharing": [string, ...],
  "retention": [string, ...],
  "user_rights": [string, ...],
  "red_flags": [string, ...],
  "plain_english_summary": string,
  "risk_level": "low" | "medium" | "high" | "unknown",
  "user_takeaways": [string, ...]
}}

Field guidance:
- data_collected: concrete categories of personal data the policy says it collects (e.g. "email address", \
"precise location", "browsing history"). Each entry short and specific.
- data_usage: the stated purposes data is used for (e.g. "personalizing ads", "fraud prevention").
- third_party_sharing: who data is shared/sold with and under what circumstances. If the policy denies \
sharing/selling, say so explicitly as one entry (e.g. "Policy states data is not sold to third parties").
- retention: how long data is kept, if stated. If not addressed, include one entry noting that.
- user_rights: what a user can do -- access, delete, opt out, correct, port their data, etc.
- red_flags: anything vague, unusually broad, one-sided, or privacy-invasive -- e.g. broad "affiliates and \
partners" sharing language, indefinite retention, silent unilateral policy changes, broad license grants \
to user content, arbitration clauses buried in a privacy policy, etc. Empty list if nothing genuinely \
stands out.
- plain_english_summary: 3-6 sentences, written the way you'd explain this policy to a friend who isn't a \
lawyer. Plain language, no legalese.
- risk_level: your overall judgment of how consumer-privacy-friendly this policy is -- "low" (limited \
collection, clear limits on sharing, real user control), "medium" (fairly typical, some broad language), \
"high" (extensive collection/sharing, vague or one-sided terms, weak user control), or "unknown" (the text \
doesn't give you enough to judge).
- user_takeaways: 2-5 short, actionable bullet points a consumer should know before using this service.

If the policy text doesn't address a section at all, say so briefly within that field (e.g. a single \
entry like "Not addressed in this policy") rather than inventing information. Do not speculate beyond what \
the text supports.

Privacy policy text:
\"\"\"
{policy_text}
\"\"\"
"""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def summarize_policy(policy_text: str, model: str = DEFAULT_MODEL, api_key: str | None = None) -> dict[str, Any]:
    """
    Turn cleaned privacy-policy text into a structured JSON summary.

    Args:
        policy_text: Cleaned policy text, e.g. from tracker.scraper.get_privacy_policy().
        model: Anthropic model id to use.
        api_key: Anthropic API key to use for this call. If omitted, falls
            back to the ANTHROPIC_API_KEY environment variable (this keeps
            the module usable standalone, e.g. from a script, without a
            caller needing to pass anything).

    Returns:
        A dict matching exactly:
            {
              "data_collected": [...], "data_usage": [...], "third_party_sharing": [...],
              "retention": [...], "user_rights": [...], "red_flags": [...],
              "plain_english_summary": "...", "risk_level": "low|medium|high|unknown",
              "user_takeaways": [...]
            }
        This is plain JSON-serializable data -- safe to store in
        PolicySnapshot.summary (a JSONField), return from a future API
        endpoint, or drop straight into a template context.

    Raises:
        EmptyPolicyTextError: policy_text is empty/whitespace-only.
        SummarizerConfigError: the 'anthropic' package isn't installed, or
            ANTHROPIC_API_KEY isn't set.
        AnthropicAPIError: the API call itself failed.
        MalformedResponseError: the model's response wasn't valid JSON or
            didn't match the expected schema.

    # NOTE for later integration: this is the one function a future
    # multi-site dashboard view and a browser-extension backend endpoint
    # should both call. Keep its input (raw text) and output (this JSON
    # shape) stable so both can consume it without caring how the summary
    # was produced.
    """
    if not policy_text or not policy_text.strip():
        raise EmptyPolicyTextError("policy_text is empty; nothing to summarize.")

    client = _get_client(api_key)
    prompt = SUMMARY_PROMPT_TEMPLATE.format(policy_text=policy_text.strip()[:MAX_POLICY_CHARS])
    raw_text = _call_model(client, prompt, model)
    return _parse_and_validate(raw_text)


def mock_summarize_policy(policy_text: str) -> dict[str, Any]:
    """
    Stand-in for summarize_policy() that makes no API call and costs
    nothing -- same JSON shape a real summary would return, but with
    placeholder content. Intended for trying out the site before you've
    added a paid ANTHROPIC_API_KEY. Callers should make sure mock output
    is never persisted/labeled as if it were a real summary.
    """
    lowered = policy_text.lower()
    mentions_selling = "sell" in lowered or "sold" in lowered
    return {
        "data_collected": ["email address (mock)", "device/browser info (mock)", "usage data (mock)"],
        "data_usage": ["operating the service (mock)", "personalization (mock)", "analytics (mock)"],
        "third_party_sharing": (
            ["Mock: policy text mentions selling/sharing data with third parties"]
            if mentions_selling
            else ["Mock: no clear mention of selling data found in this text"]
        ),
        "retention": ["Mock data -- retention not actually analyzed"],
        "user_rights": ["Mock: typically includes access, correction, deletion rights"],
        "red_flags": [
            "This is placeholder MOCK data, not a real analysis. "
            "Set ANTHROPIC_API_KEY and switch to real mode for a real one."
        ],
        "plain_english_summary": (
            "MOCK SUMMARY -- no API call was made. This placeholder shows how a real summary "
            "would be laid out. Set your ANTHROPIC_API_KEY environment variable and switch out "
            "of mock mode to get an actual AI-generated analysis of this policy."
        ),
        "risk_level": "unknown",
        "user_takeaways": ["This is mock data for testing only -- not a real privacy assessment."],
    }


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

def _get_client(api_key: str | None = None):
    if anthropic is None:
        raise SummarizerConfigError(
            "The 'anthropic' package isn't installed. Run: pip install anthropic"
        )

    api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise SummarizerConfigError(
            "No Anthropic API key available -- pass one in (e.g. a user's own "
            "saved key) or set ANTHROPIC_API_KEY server-side. Never send a key "
            "to the browser/frontend."
        )
    return anthropic.Anthropic(api_key=api_key)


def _call_model(client, prompt: str, model: str) -> str:
    """Call the API and return the raw response text. The assistant turn is
    prefilled with '{' so the model completes JSON directly instead of
    prefacing it with commentary or markdown fences."""
    try:
        response = client.messages.create(
            model=model,
            max_tokens=1500,
            messages=[
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": "{"},
            ],
        )
    except Exception as e:  # anthropic raises several exception types; treat uniformly
        raise AnthropicAPIError(f"Anthropic API request failed: {e}") from e

    if not response.content or not getattr(response.content[0], "text", None):
        raise AnthropicAPIError("Anthropic API returned an empty response.")

    # Re-prepend the "{" we prefilled -- the API only returns the completion.
    return "{" + response.content[0].text


def _parse_and_validate(raw_text: str) -> dict[str, Any]:
    parsed = _extract_json(raw_text)

    if not isinstance(parsed, dict):
        raise MalformedResponseError("Model response was valid JSON but not a JSON object.")

    missing = [key for key in REQUIRED_KEYS if key not in parsed]
    if missing:
        raise MalformedResponseError(f"Model response is missing expected keys: {missing}")

    # Normalize so the output always matches the schema exactly, in order,
    # even if the model added extra keys or used slightly wrong types.
    normalized: dict[str, Any] = {}
    for key in LIST_KEYS:
        value = parsed.get(key, [])
        normalized[key] = value if isinstance(value, list) else [str(value)]

    risk_level = str(parsed.get("risk_level", "unknown")).strip().lower()
    if risk_level not in VALID_RISK_LEVELS:
        risk_level = "unknown"

    summary_text = parsed.get("plain_english_summary", "")

    return {
        "data_collected": normalized["data_collected"],
        "data_usage": normalized["data_usage"],
        "third_party_sharing": normalized["third_party_sharing"],
        "retention": normalized["retention"],
        "user_rights": normalized["user_rights"],
        "red_flags": normalized["red_flags"],
        "plain_english_summary": str(summary_text) if summary_text else "",
        "risk_level": risk_level,
        "user_takeaways": normalized["user_takeaways"],
    }


def _extract_json(raw_text: str) -> Any:
    """Parse raw_text as JSON, tolerating minor formatting slop (stray
    markdown fences, leading/trailing text) before giving up."""
    raw_text = raw_text.strip()

    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        pass

    # Strip ```json ... ``` or ``` ... ``` fences if the model added them anyway.
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw_text)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Last resort: grab the outermost {...} block.
    brace_match = re.search(r"\{[\s\S]*\}", raw_text)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
            pass

    raise MalformedResponseError(
        "Model response could not be parsed as JSON. "
        f"Raw response (truncated): {raw_text[:300]!r}"
    )
