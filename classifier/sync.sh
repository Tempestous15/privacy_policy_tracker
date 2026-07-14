#!/usr/bin/env bash
# Copies the generated engine into the two places that actually ship it.
# Run after export_js.py (or train.py once Phase 2 exists) regenerates
# dist/redflags-engine.js.
set -euo pipefail
cd "$(dirname "$0")"

SRC="dist/redflags-engine.js"
if [ ! -f "$SRC" ]; then
    echo "dist/redflags-engine.js not found -- run 'python3 export_js.py' first." >&2
    exit 1
fi

cp "$SRC" ../extension/redflags-engine.js
mkdir -p ../website/tracker/static/tracker/js
cp "$SRC" ../website/tracker/static/tracker/js/redflags-engine.js

echo "Synced $SRC to extension/ and website/tracker/static/tracker/js/"
