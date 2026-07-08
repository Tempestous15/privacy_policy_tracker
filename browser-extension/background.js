/**
 * background.js (MV3 service worker)
 *
 * Orchestrates everything the popup UI doesn't do itself:
 *   1. find the active tab
 *   2. inject content.js (+ policyFinder.js) to scan its DOM for a privacy
 *      policy link -- only when asked, never on a schedule or on page load
 *   3. call the backend's /api/summarize-policy/ endpoint with whatever was
 *      found (or just the domain, if nothing was)
 *   4. relay results/errors back to the popup
 *
 * This file holds no persistent state and starts no timers/alarms. The only
 * things it listens for are one-off requests from the popup
 * (SCAN_PAGE / SUMMARIZE) and the one-off reply from an injected content
 * script (PPT_SCAN_RESULT). Nothing here runs unless the user has just
 * clicked something.
 */

// Change this if your Django dev server runs on a different host/port.
const BACKEND_BASE_URL = "http://127.0.0.1:8000";
const SUMMARIZE_ENDPOINT = BACKEND_BASE_URL + "/api/summarize-policy/";

const SCAN_MESSAGE_TIMEOUT_MS = 6000;
const FETCH_TIMEOUT_MS = 25000;

function isRestrictedUrl(url) {
  // chrome://, edge://, about:, chrome-extension://, the Chrome Web Store,
  // local files, view-source:, etc. -- content scripts can't be injected
  // into these regardless of permissions.
  return !/^https?:\/\//i.test(url);
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return null;
  }
}

/**
 * Inject policyFinder.js + content.js into the given tab and wait for the
 * one PPT_SCAN_RESULT message it sends back. Uses message-passing (rather
 * than relying on chrome.scripting.executeScript's return value) because
 * it's the more robust, well-documented MV3 pattern for a content script
 * reporting a result back.
 */
function scanTabForPrivacyPolicy(tabId) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error("Timed out inspecting the page."));
    }, SCAN_MESSAGE_TIMEOUT_MS);

    function listener(message, sender) {
      if (!sender.tab || sender.tab.id !== tabId) return;
      if (!message || message.type !== "PPT_SCAN_RESULT") return;
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      chrome.runtime.onMessage.removeListener(listener);
      if (message.error) {
        reject(new Error(message.error));
      } else {
        resolve(message.payload);
      }
    }

    chrome.runtime.onMessage.addListener(listener);

    chrome.scripting
      .executeScript({ target: { tabId }, files: ["policyFinder.js", "content.js"] })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        chrome.runtime.onMessage.removeListener(listener);
        reject(err);
      });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url) {
    throw new Error("No active tab found.");
  }
  return tab;
}

/**
 * Handles the popup's "Scan this site" click: locate the active tab and
 * (if possible) scan its DOM for a privacy-policy link. Does NOT call the
 * backend -- that's a separate step (handleSummarize) so the popup can show
 * the domain/URL immediately, then a distinct loading state while the
 * summary request is in flight.
 */
async function handleScanPage() {
  const tab = await getActiveTab();

  if (isRestrictedUrl(tab.url)) {
    return {
      siteUrl: tab.url,
      domain: safeHostname(tab.url) || tab.url,
      policyUrl: null,
      bestText: null,
      candidates: [],
      restricted: true,
      scanError: null,
    };
  }

  let scan;
  try {
    scan = await scanTabForPrivacyPolicy(tab.id);
  } catch (err) {
    // The DOM scan itself failed (e.g. a page that blocks script injection,
    // or simply timed out) -- we still know the domain from the tab URL, so
    // surface that and let the backend's own discovery fallback try.
    scan = { bestUrl: null, bestText: null, candidates: [], scanError: String(err.message || err) };
  }

  return {
    siteUrl: tab.url,
    domain: new URL(tab.url).hostname,
    policyUrl: scan.bestUrl || null,
    bestText: scan.bestText || null,
    candidates: scan.candidates || [],
    scanError: scan.scanError || null,
    restricted: false,
  };
}

/**
 * Handles the "request a summary" step: sends only site_url/domain/policy_url
 * to the backend -- never full browsing history, never any other tabs.
 */
async function handleSummarize({ siteUrl, domain, policyUrl }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(SUMMARIZE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site_url: siteUrl, domain, policy_url: policyUrl }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("The server took too long to respond.");
    }
    throw new Error("Couldn't reach the backend. Is it running at " + BACKEND_BASE_URL + "?");
  }
  clearTimeout(timeoutId);

  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new Error("The server returned a response that wasn't valid JSON.");
  }

  if (!response.ok) {
    throw new Error((body && body.error) || `Server error (${response.status}).`);
  }

  if (!body || typeof body.plain_english_summary !== "string" || !Array.isArray(body.red_flags)) {
    throw new Error("The server response was missing expected summary fields.");
  }

  return body;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || sender.id !== chrome.runtime.id) return undefined;

  // Scan-result pings from an injected content script are consumed by the
  // one-shot listener inside scanTabForPrivacyPolicy(); ignore them here.
  if (message.type === "PPT_SCAN_RESULT") return undefined;

  if (message.type === "SCAN_PAGE") {
    handleScanPage().then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
    return true; // keep the message channel open for the async response
  }

  if (message.type === "SUMMARIZE") {
    handleSummarize(message.payload || {}).then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
    return true;
  }

  return undefined;
});
