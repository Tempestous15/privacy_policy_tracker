#!/usr/bin/env bash
# Bundles @mlc-ai/web-llm + our two small wrapper modules into two
# dependency-free, committed files the extension loads directly:
#   ../background.js     (MV3 service worker: hosts the actual WebGPU engine)
#   ../webllm-client.js   (popup-side proxy, loaded as a plain <script>)
# Re-run this after editing background-src.js/client-src.js or bumping the
# @mlc-ai/web-llm version in package.json.
set -euo pipefail
cd "$(dirname "$0")"

npm install
npx esbuild background-src.js --bundle --format=iife --outfile=../background.js
npx esbuild client-src.js --bundle --format=iife --outfile=../webllm-client.js

echo "Wrote ../background.js and ../webllm-client.js"
