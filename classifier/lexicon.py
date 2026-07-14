"""
lexicon.py

Phase 1 of the red-flags engine: pure keyword/regex rules, no trained model.
This is the single source of truth for category definitions and patterns --
export_js.py reads CATEGORIES from here to generate dist/redflags-engine.js,
and analyze() here is the reference (Python) implementation used to sanity
check the rules against real policy text before they're shipped as JS.

Phase 2 (see train.py) can later attach a trained per-category classifier
score alongside these patterns without changing this file's shape or the
engine's public analyze() contract.
"""

from __future__ import annotations

import re
from typing import Any

# Cues that a match is being denied/negated rather than asserted, e.g.
# "we do not sell your data". Checked within the same sentence, before the
# matched phrase, to avoid flagging policies for explicitly ruling out the
# practice they're describing.
# Matched against text after _normalize_quotes(), so only straight
# apostrophes are needed here even though scraped text commonly uses smart
# quotes (e.g. "don’t").
NEGATION_WORDS = (
    "not", "never", "no longer", "won't", "will not", "don't", "does not",
    "doesn't", "without selling", "unless you", "except as", "n't",
)

CATEGORIES: list[dict[str, Any]] = [
    {
        "id": "data_selling",
        "label": "Sells or monetizes your data",
        "severity": "high",
        "patterns": [
            r"\bsells?\b[^.]{0,20}\b(your|users?'?s?|personal|customer)\b[^.]{0,20}\b(data|information)\b",
            r"\bmonetiz\w*\b[^.]{0,30}\bdata\b",
            r"\bin exchange for (?:monetary|valuable) consideration\b",
            r"\bmay sell\b[^.]{0,30}\b(?:information|data)\b",
        ],
    },
    {
        "id": "vague_sharing",
        "label": "Vague third-party sharing",
        "severity": "medium",
        "patterns": [
            r"\baffiliates and (?:business )?partners\b",
            r"\b(?:affiliates|partners)\b[^.]{0,30}\bthird[- ]part(?:y|ies)\b",
            r"\bthird[- ]part(?:y|ies)\b[^.]{0,20}\bfor (?:any|other) purposes?\b",
            r"\bshare\w*\b[^.]{0,30}\bwith (?:our )?partners\b",
            r"\bmarketing partners\b",
            r"\bvendors,?\s*partners,?\s*and\s*affiliates\b",
        ],
    },
    {
        "id": "indefinite_retention",
        "label": "Indefinite or unclear data retention",
        "severity": "medium",
        "patterns": [
            r"\bas long as (?:necessary|needed)\b",
            r"\bindefinite(?:ly)?\b[^.]{0,20}\bretain\w*\b",
            r"\bretain\w*\b[^.]{0,30}\bindefinite(?:ly)?\b",
            r"\bno (?:fixed|specific|set) retention period\b",
        ],
    },
    {
        "id": "biometric",
        "label": "Biometric or sensitive data collection",
        "severity": "high",
        "patterns": [
            r"\bbiometric\w*\b",
            r"\bfacial recognition\b",
            r"\bfingerprint\w*\b",
            r"\bvoiceprint\w*\b",
            r"\bgenetic (?:data|information)\b",
        ],
    },
    {
        "id": "broad_license",
        "label": "Broad content license grant",
        "severity": "high",
        "patterns": [
            r"\bperpetual,?\s*(?:irrevocable,?\s*)?(?:worldwide,?\s*)?(?:royalty[- ]free,?\s*)?license\b",
            r"\birrevocable\b[^.]{0,30}\blicense\b",
            r"\bright to use\b[^.]{0,30}\bany purpose\b",
            r"\bsublicensable\b",
        ],
    },
    {
        "id": "opt_out_only",
        "label": "Opt-out-only consent (buried opt-out)",
        "severity": "medium",
        "patterns": [
            r"\bunless you opt[- ]out\b",
            r"\bautomatically enroll\w*\b",
            r"\bdefault\w*\s+to\s+(?:on|enabled)\b",
            r"\bpre[- ]checked\b",
        ],
    },
    {
        "id": "unilateral_changes",
        "label": "Unilateral policy changes without notice",
        "severity": "medium",
        "patterns": [
            # Deliberately requires "without ... notice" rather than a bare
            # "reserve the right to change" -- nearly every policy reserves
            # that right, and plenty (e.g. ones that promise advance notice)
            # are doing the opposite of a red flag by disclosing it well.
            r"\bwithout\b[^.]{0,20}\bnotice\b",
            r"\bsole discretion\b[^.]{0,30}\b(?:modify|change)\b",
        ],
    },
    {
        "id": "arbitration",
        "label": "Binding arbitration / class-action waiver",
        "severity": "high",
        "patterns": [
            r"\bbinding\b[^.]{0,25}\barbitration\b",
            r"\bclass\s+actions?\b",
            r"\bwaive\w*\b[^.]{0,20}\bright to a jury trial\b",
            r"\bindividual basis\b[^.]{0,30}\barbitration\b",
            r"\bmandatory arbitration\b",
        ],
    },
    {
        "id": "weak_deletion_rights",
        "label": "Weak or limited deletion/access rights",
        "severity": "medium",
        "patterns": [
            r"\bcannot\b[^.]{0,20}\bguarantee\b[^.]{0,20}\bdeletion\b",
            r"\bmay retain\b[^.]{0,30}\bafter (?:deletion|account closure)\b",
            r"\bresidual copies\b",
            r"\bbackup (?:systems|copies)\b[^.]{0,30}\bretain\w*\b",
        ],
    },
    {
        "id": "tracking_profiling",
        "label": "Extensive tracking / behavioral profiling",
        "severity": "medium",
        "patterns": [
            r"\bbehavioral advertising\b",
            r"\bcross[- ]device tracking\b",
            r"\bthird[- ]party (?:analytics|advertising) (?:cookies|sdks?|pixels?)\b",
            r"\bprofile\w*\b[^.]{0,30}\bbased on your\b[^.]{0,30}\bactivity\b",
        ],
    },
]

_SEVERITY_RANK = {"none": 0, "low": 1, "medium": 2, "high": 3}
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+|\n+")

_COMPILED_CATEGORIES = [
    {
        **category,
        "_compiled": [re.compile(p, re.IGNORECASE) for p in category["patterns"]],
    }
    for category in CATEGORIES
]


# Scraped policy text overwhelmingly uses "smart" quotes/apostrophes
# (U+2018/2019/201C/201D); NEGATION_WORDS is written with straight ones, so
# without this normalization "don’t sell" wouldn't match "don't" and a
# denial like "We don’t sell your data" gets flagged as a red flag instead
# of correctly suppressed -- the exact opposite of the intended behavior.
_QUOTE_NORMALIZE = str.maketrans({
    "‘": "'", "’": "'", "“": '"', "”": '"',
})


def _normalize_quotes(text: str) -> str:
    return text.translate(_QUOTE_NORMALIZE)


def _is_negated(sentence: str, match_start: int) -> bool:
    prefix = sentence[:match_start].lower()
    return any(word in prefix for word in NEGATION_WORDS)


def analyze(text: str) -> dict[str, Any]:
    """Reference implementation mirroring dist/redflags-engine.js's analyze().
    Used to sanity-check the lexicon against real policy text before export.
    """
    if not text or not text.strip():
        return {"riskLevel": "unknown", "categories": []}

    text = _normalize_quotes(text)
    sentences = _SENTENCE_SPLIT_RE.split(text)
    results = []

    for category in _COMPILED_CATEGORIES:
        matches: list[str] = []
        for sentence in sentences:
            for pattern in category["_compiled"]:
                m = pattern.search(sentence)
                if m and not _is_negated(sentence, m.start()):
                    snippet = sentence.strip()
                    if snippet and snippet not in matches:
                        matches.append(snippet[:200])
                    break  # one match per pattern per sentence is enough
        if matches:
            results.append({
                "id": category["id"],
                "label": category["label"],
                "severity": category["severity"],
                "matches": matches[:3],
            })

    if not results:
        risk_level = "low"
    else:
        top_severity = max(_SEVERITY_RANK[r["severity"]] for r in results)
        risk_level = {3: "high", 2: "medium", 1: "low"}.get(top_severity, "low")

    return {"riskLevel": risk_level, "categories": results}
