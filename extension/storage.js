// Local-only saved-sites store. Replaces the old server-backed SavedSite
// list entirely -- everything here lives in chrome.storage.local, keyed by
// domain, and never leaves the browser.
//
// `browserAPI` is declared here because this is the first script popup.html
// loads that needs it; discovery.js and popup.js are classic <script> tags
// sharing this same global scope, so they reuse this declaration rather
// than redeclaring it.
const browserAPI = typeof browser !== "undefined" ? browser : chrome;

const SAVED_SITES_KEY = "savedSites";

async function getSavedSites() {
  const stored = await browserAPI.storage.local.get([SAVED_SITES_KEY]);
  return stored[SAVED_SITES_KEY] || {};
}

async function saveSite(domain, data) {
  const sites = await getSavedSites();
  sites[domain] = { ...data, domain, savedAt: Date.now() };
  await browserAPI.storage.local.set({ [SAVED_SITES_KEY]: sites });
  return sites[domain];
}

async function removeSite(domain) {
  const sites = await getSavedSites();
  delete sites[domain];
  await browserAPI.storage.local.set({ [SAVED_SITES_KEY]: sites });
}

async function listSavedSites() {
  const sites = await getSavedSites();
  return Object.values(sites).sort((a, b) => b.savedAt - a.savedAt);
}

window.SiteStorage = { saveSite, removeSite, listSavedSites, getSavedSites };
