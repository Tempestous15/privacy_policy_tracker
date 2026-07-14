# Privacy Policy Tracker — browser extension

Manifest V3, no build step. Works as-is in Chrome, Edge, and Firefox 109+.

## Load it for testing

**Chrome / Edge**
1. Go to `chrome://extensions` (or `edge://extensions`), enable Developer mode.
2. "Load unpacked" → select this `extension/` directory.

**Firefox**
1. Go to `about:debugging#/runtime/this-firefox`.
2. "Load Temporary Add-on…" → select `manifest.json` in this directory.

## First run

The extension has no server hardcoded. On first open it asks for your
Privacy Policy Tracker server's URL (e.g. `http://127.0.0.1:8000` for local
dev, or your deployed domain), then a normal username/password login — the
same account you use on the website. It stores a long-lived API token
(`chrome.storage.local`), which you can revoke any time from the "Browser
extension access" panel on the website's Dashboard page.

## Before publishing to Firefox

`manifest.json`'s `browser_specific_settings.gecko.id` is a placeholder
(`privacy-policy-tracker@example.invalid`). Firefox requires a real, unique
add-on ID before it can be signed/published — generate one (e.g. a UUID in
`{...}@yourdomain` form) before submitting to addons.mozilla.org. Not needed
for local testing via "Load Temporary Add-on".
