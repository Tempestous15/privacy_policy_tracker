// Website-side half of the extension<->website bridge (see
// extension/website_bridge_background.js for the extension-side listener
// and the same header comment's explanation of why this is a same-device,
// in-browser message channel and not a network request).
//
// extUI4: originally read-only (requestSavedSitesFromExtension, used by
// history.html). Now also exposes write functions for settings.html, since
// concern-profile customization moved off the popup and onto this website.
// requestSavedSitesFromExtension itself is left exactly as it was --
// deliberately not rewritten to call the new _sendToExtension helper below
// -- so its existing call sites/behavior don't change; the helper is only
// used by the new functions added for extUI4.

const CLIPPRI_EXTENSION_ID_PLACEHOLDER = null; // reserved, unused: sendMessage's extensionId
// arg is omitted below so Chrome infers the right extension automatically
// from which one has this origin in its externally_connectable list --
// see the same pattern in the original requestSavedSitesFromExtension.

function requestSavedSitesFromExtension(timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      resolve({ ok: false, error: "not-installed-or-restricted-browser" });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage({ type: "getSavedSites" }, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError || !response) {
          resolve({ ok: false, error: "not-installed-or-restricted-browser" });
          return;
        }
        resolve(response);
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String((err && err.message) || err) });
    }
  });
}

// Generic helper for the new extUI4 message types, added instead of
// modifying requestSavedSitesFromExtension above (see header comment).
// Same never-throws, always-resolves-with-{ok,...} contract.
function _sendToExtension(message, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      resolve({ ok: false, error: "not-installed-or-restricted-browser" });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError || !response) {
          resolve({ ok: false, error: "not-installed-or-restricted-browser" });
          return;
        }
        resolve(response);
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String((err && err.message) || err) });
    }
  });
}

function requestConcernProfileStateFromExtension(timeoutMs = 4000) {
  return _sendToExtension({ type: "getConcernProfileState" }, timeoutMs);
}

function setActiveConcernProfile(profileId, timeoutMs = 4000) {
  return _sendToExtension({ type: "setConcernProfile", profileId }, timeoutMs);
}

function setConcernCategoryOverride(category, value, timeoutMs = 4000) {
  return _sendToExtension({ type: "setCategoryOverride", category, value }, timeoutMs);
}

window.ClipPriBridge = {
  requestSavedSitesFromExtension,
  requestConcernProfileStateFromExtension,
  setActiveConcernProfile,
  setConcernCategoryOverride,
};
