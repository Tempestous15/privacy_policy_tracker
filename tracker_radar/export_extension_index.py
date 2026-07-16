#!/usr/bin/env python3
"""
export_extension_index.py

Builds extension/tracker_radar_dataset_index.json -- a compact
domain -> {owner, categories, fingerprinting} index -- from a local
Tracker Radar dataset checkout, for the browser extension's *live*
Observed-channel capture (see ../extension/tracker_capture_background.js
and ../extension/tracker_radar_score.js) to score arbitrary sites against,
not just the curated tracker_radar/config.SITES list that
tracker_radar_snapshot.json covers.

This is a new, standalone build step -- it doesn't touch dataset.py,
score.py, config.py, or run.py, and isn't part of the run.py pipeline.
It only reads the same on-disk dataset those modules already expect (see
fetch_dataset.sh), and only extracts the handful of fields
tracker_radar_score.js's JS port of score.py actually reads.

Why this exists as a separate script rather than just shipping the full
dataset: the raw Tracker Radar checkout is ~20k+ individual JSON files
(and the full dataset across all regions is ~1.5GB) -- far too much to
bundle into a browser extension wholesale. This script picks out just the
few fields the scoring rule needs and flattens everything into one file,
the same "extract only what's needed, ship one compact artifact" pattern
classifier/export_js.py already uses for redflags-engine.js.

Usage:
    ./tracker_radar/fetch_dataset.sh     # if not already done
    python3 -m tracker_radar.export_extension_index
    python3 -m tracker_radar.export_extension_index --out some/other/path.json
    python3 -m tracker_radar.export_extension_index --limit 500   # smaller index, faster to load

Note: this was written and tested against a *small, hand-picked* seed
(6 real entries, from tracker_radar/test_score.py's fixtures) because the
sandboxed environment this branch was developed in couldn't bulk-fetch the
full dataset (network allowlist blocked github.com/duckduckgo/tracker-radar
at the volume a full sparse-checkout needs). Run this for real on a
machine with normal internet access to get full coverage --
extension/tracker_radar_dataset_index.json documents how to tell the two
apart (see its "source"/"howToExpand" fields).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import config

# Only these fields are read by tracker_radar_score.js's JS port of
# score.py -- see classify_tracker()/build_profile() in both files.
_FIELDS_KEPT = ("owner", "categories", "fingerprinting")


def _extract_entry(raw: dict) -> dict:
    return {field: raw[field] for field in _FIELDS_KEPT if field in raw}


def build_index(dataset_dir: Path, limit: int | None = None) -> dict:
    if not dataset_dir.exists():
        raise FileNotFoundError(
            f"Tracker Radar dataset not found at {dataset_dir}. "
            f"Run tracker_radar/fetch_dataset.sh first (see README.md)."
        )
    domains: dict[str, dict] = {}
    skipped = 0
    paths = sorted(dataset_dir.glob("*.json"))
    if limit:
        paths = paths[:limit]
    for path in paths:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            skipped += 1
            continue
        domain = raw.get("domain")
        if not domain:
            skipped += 1
            continue
        domains[domain] = _extract_entry(raw)
    if skipped:
        print(f"export_extension_index.py: skipped {skipped} unreadable/malformed entries", file=sys.stderr)
    return domains


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--dataset-dir", default=str(config.DATASET_DOMAINS_DIR),
        help="Path to a Tracker Radar domains/<region> directory (default: config.DATASET_DOMAINS_DIR)",
    )
    parser.add_argument(
        "--out", default=str(Path(__file__).resolve().parent.parent / "extension" / "tracker_radar_dataset_index.json"),
        help="Output path (default: extension/tracker_radar_dataset_index.json)",
    )
    parser.add_argument("--limit", type=int, default=None, help="Only index the first N domain files (default: all)")
    args = parser.parse_args()

    domains = build_index(Path(args.dataset_dir), args.limit)

    output = {
        "schemaNote": (
            "domain -> {owner: {name, displayName}, categories: [...], "
            "fingerprinting: 0-3}, same fields tracker_radar/score.py reads "
            "off a real dataset.TrackerRadarDataset entry."
        ),
        "source": f"tracker_radar/export_extension_index.py against {args.dataset_dir}",
        "howToExpand": (
            "Re-run this script after re-running tracker_radar/fetch_dataset.sh "
            "to refresh against a newer dataset checkout."
        ),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "domains": domains,
    }

    out_path = Path(args.out)
    out_path.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"Wrote {len(domains)} domain(s) to {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
