// On-device bridge between the extension and ClipPri's own website. Uses
// Chrome's externally_connectable API (see manifest.json), which is a
// same-device, in-browser message channel between a web page's own JS and
// this extension -- not a network request. Nothing here ever leaves the
// device: the website tab and this extension are both running locally in
// the same browser, on the same machine, and chrome.runtime.onMessageExternal
// is how they talk to each other without either one needing a server.
//
// Two layers of scoping, both required:
//   1. manifest.json's "externally_connectable.matches" -- Chrome itself
//      refuses to deliver a message here from any origin not listed there.
//      A website we don't control simply cannot reach this listener at all.
//   2. The sender.origin re-check below -- defense in depth, in case the
//      manifest list is ever loosened (e.g. someone adds a wildcard without
//      thinking it through). Never trust manifest scoping alone for
//      anything that reads local data.
//
// extUI4: originally read-only (website/history.html pulling saved sites).
// Now also handles two WRITE message types for website/settings.html, since
// concern-profile customization moved out of the popup and onto the
// website -- see popup.js's CLIPPRI_WEBSITE_SETTINGS_URL and
// website/assets/settings.js. Both the read and write paths only ever
// touch the two storage keys named below (savedSites, concernProfileState)
// -- nothing else in extension storage is reachable from here.
//
// storage.js/concern_profiles.js aren't reused directly here because they
// declare `window.SiteStorage`/`window.ConcernProfiles`, and there's no
// `window` in a service worker (same reason tosdr_background_client.js
// re-implements a background-safe version of tosdr.js instead of reusing
// it directly) -- the concern-profile read/write logic below is a
// window-free re-implementation of concern_profiles.js's own functions,
// kept in sync with it by hand; if concern_profiles.js's storage shape
// ever changes, this needs the same change.
//
// Composed into the shared service-worker scope by background_entry.js.
// No dependency on any other background file, so its position in that list
// doesn't matter relative to the others.

const _WEBSITE_BRIDGE_ALLOWED_ORIGINS = [
  "http://privacy-policy-tracker-website.s3-website-us-east-1.amazonaws.com",
  "http://localhost:8000",
];

const _WEBSITE_BRIDGE_SAVED_SITES_KEY = "savedSites";
const _WEBSITE_BRIDGE_CONCERN_PROFILE_KEY = "concernProfileState";
const _WEBSITE_BRIDGE_DEFAULT_PROFILE_ID = "adTracking";
// Keep in sync with concern_profiles.js's PRESET_PROFILES keys -- only the
// ids matter here (for validating a write), not the labels/descriptions,
// which the website already has its own copy of for rendering (see
// website/assets/concern_profiles_data.js).
const _WEBSITE_BRIDGE_VALID_PROFILE_IDS = new Set(["adTracking", "dataBrokers", "social"]);

// Per-saved-site payload sent to the website. Deliberately excludes tabId
// (meaningless outside the extension -- there's no corresponding tab in the
// website's context) and passes `text` (the raw policy text, already
// sitting in local storage) through as-is so the website can run its own
// bundled copy of the same local classifier (redflags-engine.js) rather
// than the extension needing to re-run analysis on its behalf. No new
// computation happens here -- this just reads and reshapes what's already
// stored.
function _publicSiteFields(site) {
  return {
    domain: site.domain,
    policyUrl: site.policyUrl || null,
    text: site.text || null,
    savedAt: site.savedAt || null,
  };
}

async function _getSavedSitesForWebsite() {
  const stored = await chrome.storage.local.get([_WEBSITE_BRIDGE_SAVED_SITES_KEY]);
  const sites = stored[_WEBSITE_BRIDGE_SAVED_SITES_KEY] || {};
  return Object.values(sites)
    .sort((a, b) => b.savedAt - a.savedAt)
    .map(_publicSiteFields);
}

// Window-free mirror of concern_profiles.js's getConcernProfileState --
// same default shape, same storage key.
async function _getConcernProfileStateForWebsite() {
  const stored = await chrome.storage.local.get([_WEBSITE_BRIDGE_CONCERN_PROFILE_KEY]);
  return (
    stored[_WEBSITE_BRIDGE_CONCERN_PROFILE_KEY] || {
      activeProfile: _WEBSITE_BRIDGE_DEFAULT_PROFILE_ID,
      categoryOverrides: {},
    }
  );
}

async function _setActiveProfileFromWebsite(profileId) {
  if (!_WEBSITE_BRIDGE_VALID_PROFILE_IDS.has(profileId)) {
    throw new Error(`Unknown concern profile: ${profileId}`);
  }
  const state = await _getConcernProfileStateForWebsite();
  state.activeProfile = profileId;
  await chrome.storage.local.set({ [_WEBSITE_BRIDGE_CONCERN_PROFILE_KEY]: state });
  return state;
}

// value === null clears an override and falls back to the active profile's
// default for that category again -- same contract as
// concern_profiles.js's setCategoryOverride.
async function _setCategoryOverrideFromWebsite(category, value) {
  if (typeof category !== "string" || !category) throw new Error("Missing category");
  const state = await _getConcernProfileStateForWebsite();
  if (value === null) delete state.categoryOverrides[category];
  else state.categoryOverrides[category] = !!value;
  await chrome.storage.local.set({ [_WEBSITE_BRIDGE_CONCERN_PROFILE_KEY]: state });
  return state;
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!_WEBSITE_BRIDGE_ALLOWED_ORIGINS.includes(sender.origin)) {
    // Should be unreachable given manifest.json's externally_connectable
    // scoping, but never assume that scoping alone is enough -- see header
    // comment. Silently refuse rather than responding with an error object,
    // so an unexpected sender learns nothing about this listener's shape.
    return false;
  }
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "getSavedSites") {
    _getSavedSitesForWebsite()
      .then((sites) => sendResponse({ ok: true, sites }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // async sendResponse
  }

  if (message.type === "getConcernProfileState") {
    _getConcernProfileStateForWebsite()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (message.type === "setConcernProfile") {
    _setActiveProfileFromWebsite(message.profileId)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (message.type === "setCategoryOverride") {
    _setCategoryOverrideFromWebsite(message.category, message.value)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  return false;
});
