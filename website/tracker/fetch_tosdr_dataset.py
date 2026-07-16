#!/usr/bin/env python3
"""
fetch_tosdr_dataset.py

Downloads ToS;DR's public Zenodo dataset export into tosdr_dataset/,
alongside this file. Plain HTTPS downloads via the standard library --
deliberately not a shell script like tracker_radar/fetch_dataset.sh, since
there's no git sparse-checkout complexity needed here (no Windows
reserved-filename issue like Tracker Radar's domain files hit) and a
cross-platform .py avoids the bash-vs-PowerShell friction that script
caused.

Source:  https://zenodo.org/records/15012282
         "ToS;DR policies dataset (raw) - 21/07/2023"
License: GNU GPLv3 -- copyleft, NOT the same permissive-ish CC BY-NC-SA
         license Tracker Radar uses. Worth a real look (not legal advice)
         before any of this data or derivatives of it ship in anything
         beyond this evaluation script.

Schema summary (see https://zenodo.org/records/15012282 for the full
field-by-field description):
    topics.csv    (~8 KB)    id, title, subtitle, description, ...
    cases.csv     (~87 KB)   id, classification, score, title, description,
                              topic_id, privacy_related, ...
    services.csv  (~1.3 MB)  id, name, url, slug, rating, ...
    points.csv    (~17 MB)   id, service_id, case_id, document_id, status,
                              quote_text, ...  (service <-> case linkage)
    documents.csv (~268 MB)  id, service_id, name, text, ...  (raw policy text)

points.csv is what actually links a service to a case -- cases.csv itself
has no service_id. See eval_tosdr.py for how these get joined.

Usage:
    python3 fetch_tosdr_dataset.py                          # topics, cases, services only (~1.4 MB, fast)
    python3 fetch_tosdr_dataset.py --include-points-and-documents  # + points.csv and documents.csv (~285 MB, slow)
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

DATASET_DIR = Path(__file__).parent / "tosdr_dataset"
BASE_URL = "https://zenodo.org/records/15012282/files"

SMALL_FILES = ("topics.csv", "cases.csv", "services.csv")
LARGE_FILES = ("points.csv", "documents.csv")

CHUNK_SIZE = 1024 * 1024  # 1 MB


def _download(filename: str) -> None:
    dest = DATASET_DIR / filename
    if dest.exists():
        print(f"  {filename} already present ({dest.stat().st_size:,} bytes) -- skipping. Delete it to re-fetch.")
        return

    url = f"{BASE_URL}/{filename}?download=1"
    print(f"  downloading {filename} from {url} ...")
    tmp_dest = dest.with_suffix(dest.suffix + ".part")

    with urllib.request.urlopen(url) as response, tmp_dest.open("wb") as out:
        total = response.headers.get("Content-Length")
        total = int(total) if total else None
        downloaded = 0
        while True:
            chunk = response.read(CHUNK_SIZE)
            if not chunk:
                break
            out.write(chunk)
            downloaded += len(chunk)
            if total:
                pct = downloaded / total * 100
                print(f"\r    {downloaded:,} / {total:,} bytes ({pct:.1f}%)", end="", flush=True)
            else:
                print(f"\r    {downloaded:,} bytes", end="", flush=True)
        print()

    tmp_dest.rename(dest)
    print(f"  done: {dest} ({dest.stat().st_size:,} bytes)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--include-points-and-documents", action="store_true",
        help="Also fetch points.csv (~17 MB) and documents.csv (~268 MB). Required for eval_tosdr.py; "
             "not required just to load the topic taxonomy via tosdr_topics.py.",
    )
    args = parser.parse_args()

    DATASET_DIR.mkdir(exist_ok=True)

    files = list(SMALL_FILES) + (list(LARGE_FILES) if args.include_points_and_documents else [])
    print(f"Fetching {len(files)} file(s) into {DATASET_DIR}/ ...")
    for filename in files:
        try:
            _download(filename)
        except Exception as e:
            print(f"  error fetching {filename}: {e}", file=sys.stderr)
            sys.exit(1)

    print("Done.")
    if not args.include_points_and_documents:
        print("Note: points.csv and documents.csv were skipped (needed for eval_tosdr.py). "
              "Re-run with --include-points-and-documents when you're ready to run the eval harness.")


if __name__ == "__main__":
    main()
