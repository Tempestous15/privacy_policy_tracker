#!/usr/bin/env bash
# Fetches the US region of DuckDuckGo's Tracker Radar dataset into
# tracker_radar/data/tracker-radar/ via a sparse checkout. The full dataset
# spans 9 regions (~1.5GB, 15k+ files each); the US region alone is 20k+
# domain entries, which is what dataset.py/config.py expect by default and
# is plenty to validate the scoring rule against.
#
# Dataset license: CC BY-NC-SA 4.0 (non-commercial). See
# https://github.com/duckduckgo/tracker-radar -- before this project (or
# anything built on top of this data) is used commercially, that license
# needs a real look, possibly reaching out to DuckDuckGo directly. Not
# legal advice -- just flagging it so it doesn't get missed.
set -euo pipefail

TARGET_DIR="$(cd "$(dirname "$0")" && pwd)/data/tracker-radar"

if [ -d "$TARGET_DIR/.git" ]; then
  echo "Dataset already present at $TARGET_DIR -- skipping. Delete it to re-fetch."
  exit 0
fi

mkdir -p "$(dirname "$TARGET_DIR")"

# --no-checkout first, then sparse-checkout, then check out main: this
# fetches the full pack (needed regardless, since GitHub's codeload tarball
# endpoint isn't always reachable from restrictive network setups) but only
# materializes the US + docs directories on disk, instead of all 9 regions.
git clone --depth 1 --no-checkout https://github.com/duckduckgo/tracker-radar.git "$TARGET_DIR"
cd "$TARGET_DIR"

# --no-cone (not --cone) because a handful of real tracker domains in this
# dataset are named like Windows' reserved device names (com1-com9,
# lpt1-lpt9, con, prn, aux, nul -- e.g. "com3.edgekey.net.json"). NTFS
# refuses to create files with those base names regardless of extension,
# so `git checkout` errors out and aborts on Windows unless those specific
# paths are excluded. --no-cone lets us use gitignore-style negation
# patterns to do that; this is a no-op on macOS/Linux, which don't have
# the restriction, so a handful of real (rare) domains just won't be
# checked out there either, for consistency.
git sparse-checkout init --no-cone
cat > .git/info/sparse-checkout <<'EOF'
domains/US/*
docs/*
!domains/US/con.*
!domains/US/prn.*
!domains/US/aux.*
!domains/US/nul.*
!domains/US/com[1-9].*
!domains/US/lpt[1-9].*
EOF

# git validates reserved-name paths across the WHOLE tree before writing
# anything -- including regions outside this sparse selection (CA/FR, etc.)
# -- and aborts the entire checkout if it finds any, even ones that would
# never actually be written. Disabling this pre-check is safe here because
# the sparse-checkout excludes above already stop the actual reserved
# files within domains/US from being written. No-op on macOS/Linux.
git config core.protectNTFS false
git checkout main

count=$(find domains/US -name '*.json' | wc -l | tr -d ' ')
echo "Done. $count domain entries at $TARGET_DIR/domains/US"
