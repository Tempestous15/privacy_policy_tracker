"""
train.py -- Phase 2 (not run by anything yet; see README.md).

Skeleton for training one LogisticRegression per lexicon category on the
OPP-115 corpus. Requires manually downloading the corpus from
https://usableprivacy.org/data (non-commercial research license) and
pointing OPP115_DIR below at the extracted `consolidation/` directory
before this will run.

Not wired into export_js.py yet -- Phase 1 ships lexicon-only. When this is
filled in, export_js.py should merge each category's m2cgen-exported JS
scoring function alongside its existing regex patterns.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

from lexicon import CATEGORIES

OPP115_DIR = Path(__file__).parent / "data" / "opp115" / "consolidation"

# Maps our category ids to the closest OPP-115 practice-category label, for
# the subset where a reasonable mapping exists. Categories with no entry
# here (e.g. "arbitration", "broad_license") stay lexicon-only -- OPP-115
# doesn't label those practices, so there's nothing to train on.
OPP115_CATEGORY_MAP = {
    "vague_sharing": "Third Party Sharing/Collection",
    "indefinite_retention": "Data Retention",
    "opt_out_only": "User Choice/Control",
    "weak_deletion_rights": "User Access, Edit and Deletion",
    "unilateral_changes": "Policy Change",
    "tracking_profiling": "First Party Collection/Use",
}


def load_examples(opp115_dir: Path) -> list[tuple[str, str]]:
    """Return (sentence, opp115_category) pairs from the consolidated
    annotation CSVs. Left unimplemented until the corpus is available --
    the exact CSV schema should be checked against the downloaded data
    rather than assumed here.
    """
    raise NotImplementedError(
        "Download OPP-115 to classifier/data/opp115/ first (see README.md), "
        "then implement CSV parsing against the actual file schema."
    )


def train_category(category_id: str, examples: list[tuple[str, str]]):
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression

    opp115_label = OPP115_CATEGORY_MAP.get(category_id)
    if opp115_label is None:
        return None  # lexicon-only category, nothing to train

    texts = [text for text, _ in examples]
    labels = [1 if label == opp115_label else 0 for _, label in examples]

    vectorizer = TfidfVectorizer(max_features=2000, ngram_range=(1, 2))
    X = vectorizer.fit_transform(texts)
    clf = LogisticRegression(max_iter=1000, class_weight="balanced")
    clf.fit(X, labels)
    return vectorizer, clf


def main() -> None:
    if not OPP115_DIR.exists():
        print(
            f"OPP-115 not found at {OPP115_DIR}. Download it from "
            "https://usableprivacy.org/data and extract it there first.",
            file=sys.stderr,
        )
        sys.exit(1)

    examples = load_examples(OPP115_DIR)
    for category in CATEGORIES:
        result = train_category(category["id"], examples)
        if result is None:
            print(f"{category['id']}: lexicon-only, skipped")
        else:
            print(f"{category['id']}: trained (export wiring is Phase 2 TODO)")


if __name__ == "__main__":
    main()
