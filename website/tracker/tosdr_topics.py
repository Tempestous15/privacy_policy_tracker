"""
tosdr_topics.py

Loads ToS;DR's topic taxonomy from the bundled dataset snapshot (see
fetch_tosdr_dataset.py) rather than the live API. At the time this was
written, api.tosdr.org's documented search/service endpoints had drifted
from what's actually deployed (query-filtering silently no-ops and dumps
an unfiltered service batch instead), so a static snapshot is used
instead -- it also keeps eval_tosdr.py runs reproducible and free of
rate limits regardless of API stability.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

DATASET_DIR = Path(__file__).parent / "tosdr_dataset"
TOPICS_CSV = DATASET_DIR / "topics.csv"

# A handful of topics in ToS;DR's own export have placeholder description
# text ("description", ".", "no text here", or blank) rather than real
# content -- fall back to the topic's subtitle in those cases instead of
# handing the model a useless description.
_PLACEHOLDER_DESCRIPTIONS = {"", ".", "description", "no text here"}


class TopicsNotFoundError(Exception):
    """Raised when the bundled topics.csv hasn't been fetched yet."""


def load_topics(csv_path: Path | None = None) -> list[dict[str, Any]]:
    """Load ToS;DR's topic taxonomy.

    Returns:
        [{"id": int, "name": str, "description": str}, ...]
        -- exactly the shape topic_classifier.classify_policy_topics()
        expects for its `topics` argument. "name" is topics.csv's "title"
        column, renamed for consistency with that function's parameter
        naming.

    Raises:
        TopicsNotFoundError: topics.csv hasn't been downloaded yet.
    """
    path = csv_path or TOPICS_CSV
    if not path.exists():
        raise TopicsNotFoundError(
            f"{path} not found. Run: python3 tracker/fetch_tosdr_dataset.py"
        )

    topics: list[dict[str, Any]] = []
    with path.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            topics.append({
                "id": int(row["id"]),
                "name": row["title"].strip(),
                "description": _clean_description(row.get("description", ""), row.get("subtitle", "")),
            })
    return topics


def _clean_description(description: str, subtitle: str) -> str:
    description = (description or "").strip()
    if description.lower() in _PLACEHOLDER_DESCRIPTIONS:
        return (subtitle or "").strip()
    return description
