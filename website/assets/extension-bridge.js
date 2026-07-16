// Shared helper for talking to the ClipPri browser extension via Chrome's
// externally_connectable messaging (see extension/website_bridge_background.js
// and extension/manifest.json). Same-device, same-browser messaging only --
// this never makes a network request. Used by history.js today; check.js
// (Feature 2) doesn't need it, since checking an arbitrary URL works
// without the extension installed at all.
//
// EXTENSION_ID must match extension/manifest.json's pinned "key" field
// (see websiteImprovement summary doc for how that key was generated).
// Chrome computes the ID deterministically from that key, so it's stable
// across installs/reloads -- but if the extension is ever repackaged with a
// different key (or published to the Chrome Web Store under a new key),
// this constant has to be updated to match, or every message here will
// silently fail (chrome.runtime.sendMessage to a nonexistent ID just
// resolves as "no such extension", it doesn't throw a helpful error).
const CLIPPRI_EXTENSION_ID = "oekejhnandbljcfcemgbjmbmbpjgchha";

// Whether this browser exposes chrome.runtime.sendMessage to page JS at
// all (Chrome/Chromium only -- Firefox doesn't support externally_connectable
// the same way, and Safari doesn't support it either). Callers should check
// this before attempting a message and show a clear "not supported in this
// browser" state rather than a confusing silent failure.
function isExtensionMessagingSupported() {
  return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.sendMessage;
}

// Resolves to { ok: true, sites: [...] } on success, or { ok: false,
// reason } on any failure -- including "extension not installed," which
// looks the same from the page's side as "extension installed but
// rejected the message" (Chrome gives no way to distinguish "no such
// extension" from "extension didn't answer"). Never throws.
function requestSavedSitesFromExtension(timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!isExtensionMessagingSupported()) {
      resolve({ ok: false, reason: "unsupported-browser" });
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: "no-response" });
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(CLIPPRI_EXTENSION_ID, { type: "getSavedSites" }, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError || !response || response.ok !== true) {
          resolve({ ok: false, reason: "not-installed-or-rejected" });
          return;
        }
        resolve({ ok: true, sites: response.sites || [] });
      });
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: "not-installed-or-rejected" });
      }
    }
  });
}

window.ClipPriBridge = { isExtensionMessagingSupported, requestSavedSitesFromExtension, CLIPPRI_EXTENSION_ID };
