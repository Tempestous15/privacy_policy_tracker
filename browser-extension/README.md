# Privacy Policy Tracker -- browser extension (MVP)

Finds the current site's privacy policy and asks your local Privacy Policy
Tracker backend to summarize it in plain English. Only scans when you click
the button -- no background monitoring, no browsing history sent anywhere.

## Setup

1. Start the backend:
   ```
   cd website
   python manage.py runserver
   ```
   (Optional: set `ANTHROPIC_API_KEY` in `website/.env` for real summaries.
   Without it, the backend automatically falls back to free mock summaries.)

2. Load the extension in Chrome/Edge:
   - Go to `chrome://extensions` (or `edge://extensions`)
   - Enable "Developer mode"
   - Click "Load unpacked" and select this `browser-extension/` folder

3. Visit any website, click the extension's toolbar icon, then click
   **Scan this site**.

If your backend runs somewhere other than `http://127.0.0.1:8000`, update
`BACKEND_BASE_URL` in `background.js` and the matching entry in
`manifest.json`'s `host_permissions`.

## How it works

- `policyFinder.js` -- pure DOM-scanning logic: scores every link on the
  page by how likely it is to be a privacy policy (exact text match > href
  containing `/privacy` > text containing "privacy" > footer link >
  same-domain > originally-absolute URL).
- `content.js` -- the actual content script. Injected on demand only (never
  auto-runs), calls `policyFinder.js`, and reports the result back.
- `background.js` -- the service worker. Finds the active tab, injects the
  content script, and calls the backend's `/api/summarize-policy/` endpoint
  with just the site URL, domain, and detected policy URL.
- `popup.html` / `popup.js` -- UI only. No scanning or network logic lives
  here; it just renders whatever `background.js` returns.

## What it does and doesn't do

- Scans only the active tab, only when you click the button.
- Sends only `site_url`, `domain`, and `policy_url` to the backend -- never
  full page content, browsing history, or other tabs.
- Never automatically changes the page, submits forms, or clicks anything.
- If no privacy policy link is found on the page, the backend will try its
  own fallback discovery (common URL paths); if that also fails, the popup
  shows a clear "couldn't find a privacy policy" message with the domain.
