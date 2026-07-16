"""
dataset.py

Loads a local checkout of DuckDuckGo's Tracker Radar dataset
(https://github.com/duckduckgo/tracker-radar, CC BY-NC-SA 4.0 --
non-commercial use only, see README.md) and indexes it by domain for fast
lookup.

This module never fetches the dataset itself -- see fetch_dataset.sh for a
one-time sparse-checkout that pulls just the US region (20k+ domain
entries, plenty to validate this prototype without cloning all 9 regions).
"""

from __future__ import annotations

import json
from pathlib import Path


class TrackerRadarDataset:
    """In-memory index of Tracker Radar domain entries, keyed by domain."""

    def __init__(self, domains_dir: Path):
        self.domains_dir = Path(domains_dir)
        self._index: dict[str, dict] = {}
        self._loaded = False

    def load(self) -> "TrackerRadarDataset":
        if self._loaded:
            return self
        if not self.domains_dir.exists():
            raise FileNotFoundError(
                f"Tracker Radar dataset not found at {self.domains_dir}. "
                f"Run tracker_radar/fetch_dataset.sh first (see README.md)."
            )
        skipped = 0
        for path in self.domains_dir.glob("*.json"):
            try:
                entry = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                skipped += 1
                continue
            domain = entry.get("domain")
            if domain:
                self._index[domain] = entry
        self._loaded = True
        if skipped:
            print(f"dataset.py: skipped {skipped} unreadable/malformed entries")
        return self

    def __len__(self) -> int:
        return len(self._index)

    def lookup(self, domain: str) -> dict | None:
        """Look up a captured third-party domain against the dataset.

        Tries an exact match first, then walks up the label hierarchy
        (e.g. 'connect.facebook.net' -> 'facebook.net') since Tracker
        Radar entries are keyed by each tracker's own base/registrable
        domain, not every subdomain that happens to serve requests from
        it. Stops at two labels ("domain.tld") so it never over-matches
        on a bare public suffix.
        """
        if not domain:
            return None
        domain = domain.lower().strip(".")
        if domain in self._index:
            return self._index[domain]
        labels = domain.split(".")
        while len(labels) > 2:
            labels = labels[1:]
            candidate = ".".join(labels)
            if candidate in self._index:
                return self._index[candidate]
        return None
