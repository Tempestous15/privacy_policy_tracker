#!/usr/bin/env python3
"""
run.py

CLI entry point for this milestone: capture -> lookup -> aggregate -> score,
for the curated site list in config.py (or --sites-file).

Usage:
    python3 -m tracker_radar.run
    python3 -m tracker_radar.run --sites-file my_sites.txt
    python3 -m tracker_radar.run --out results.json

Requires the dataset to be fetched first:
    ./tracker_radar/fetch_dataset.sh
Requires Playwright's Chromium build:
    pip install -r tracker_radar/requirements.txt
    python3 -m playwright install chromium
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import config
from .capture import capture_sites
from .dataset import TrackerRadarDataset
from .score import build_profile


def _load_sites(sites_file: str | None) -> list[str]:
    if not sites_file:
        return config.SITES
    lines = Path(sites_file).read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip() and not line.startswith("#")]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sites-file", help="Text file, one site URL per line, overrides config.SITES")
    parser.add_argument("--out", help="Write JSON results to this file instead of stdout")
    parser.add_argument(
        "--dataset-dir", default=str(config.DATASET_DOMAINS_DIR),
        help="Path to a Tracker Radar domains/<region> directory (default: config.DATASET_DOMAINS_DIR)",
    )
    args = parser.parse_args()

    sites = _load_sites(args.sites_file)

    dataset = TrackerRadarDataset(Path(args.dataset_dir))
    try:
        dataset.load()
    except FileNotFoundError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"Loaded {len(dataset)} Tracker Radar entries from {args.dataset_dir}", file=sys.stderr)

    capture_results = capture_sites(sites)

    profiles = []
    for result in capture_results:
        profile = build_profile(result.site, result.third_party_domains, dataset)
        if not result.ok:
            # Capture didn't fully succeed (timeout/error) -- the profile
            # may still be built from partial data, but flag it so a
            # low/zero tracker count isn't mistaken for a clean site.
            profile["captureWarning"] = result.error
        profiles.append(profile)

    output = json.dumps(profiles, indent=2)
    if args.out:
        Path(args.out).write_text(output, encoding="utf-8")
        print(f"Wrote {len(profiles)} site profile(s) to {args.out}", file=sys.stderr)
    else:
        print(output)


if __name__ == "__main__":
    main()
