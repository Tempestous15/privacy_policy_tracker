// On-device bridge between the extension and ClipPri's own website, for the
// website's "scan history" page (website/history.html). Uses Chrome's
// externally_connectable API (see manifest.json), which is a same-device,
// in-browser message channel between a web page's own JS and this
// extension -- not a network request. Nothing here ever leaves the device:
// the website tab and this extension are both running locally in the same
// browser, on the same machine, and chrome.runtime.onMessageExternal is how
// they talk to each other without either one needing a server.
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
// Read-only, and reads only the "savedSites" key SiteStorage (storage.js)
// already manages -- this file never writes anything, and never touches any
// other extension storage. storage.js itself isn't reused here because it
// declares `window.SiteStorage`, and there's no `window` in a service
// worker (same reason tosdr_background_client.js re-implements a
// background-safe version of tosdr.js instead of reusing it directly).
//
// Composed into the shared service-worker scope by background_entry.js.
// No dependency on any other background file, so its position in that list
// doesn't matter relative to the others.

const _WEBSITE_BRIDGE_ALLOWED_ORIGINS = [
  "http://privacy-policy-tracker-website.s3-website-us-east-1.amazonaws.com",
  "http://localhost:8000",
];

const _WEBSITE_BRIDGE_SAVED_SITES_KEY = "savedSites";

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

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!_WEBSITE_BRIDGE_ALLOWED_ORIGINS.includes(sender.origin)) {
    // Should be unreachable given manifest.json's externally_connectable
    // scoping, but never assume that scoping alone is enough -- see header
    // comment. Silently refuse rather than responding with an error object,
    // so an unexpected sender learns nothing about this listener's shape.
    return false;
  }
  if (!message || message.type !== "getSavedSites") return false;

  _getSavedSitesForWebsite()
    .then((sites) => sendResponse({ ok: true, sites }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // async sendResponse
});
