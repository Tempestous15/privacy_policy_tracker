// Live "Observed" channel capture. Watches network requests for whatever
// tab is currently loading and records distinct third-party domains
// contacted -- the same signal tracker_radar/ captures via a Playwright
// homepage load (see that module's README), but live and for whatever
// site the user is actually on, not just the curated snapshot list in
// tracker_radar_snapshot.json.
//
// Composed into the single MV3 service worker via background_entry.js
// (Chrome only allows one background.service_worker entry point -- see
// that file and manifest.json). Needs TrackerRadarScore (see
// tracker_radar_score.js), loaded first by background_entry.js.
//
// Data lifecycle: chrome.storage.session -- cleared when the browser
// session ends, but (unlike a plain in-memory Map) survives the service
// worker itself being killed and restarted while idle, which MV3 does
// routinely. Keyed by tabId; reset on every new top-level navigation so a
// result never mixes two different page loads in the same tab.
//
// Degrades silently if the browser doesn't support chrome.storage.session
// (older Firefox) -- see the guard at the bottom. When that happens,
// tracker_radar_client.js's live-lookup call simply gets no response and
// falls back to the bundled snapshot, exactly as it does for a domain
// outside the snapshot's curated list.

const CAPTURE_STORAGE_PREFIX = "trackerCapture:";
const LIVE_CAPTURE_SUPPORTED = typeof chrome !== "undefined" && !!chrome.storage && !!chrome.storage.session;

const TRACKER_DATASET_INDEX_URL = "tracker_radar_dataset_index.json";
let _datasetPromise = null;
function _loadDatasetIndex() {
  if (!_datasetPromise) {
    _datasetPromise = fetch(chrome.runtime.getURL(TRACKER_DATASET_INDEX_URL))
      .then((resp) => resp.json())
      .then((wrapped) => wrapped.domains || {});
  }
  return _datasetPromise;
}

// Same simplified "walk up to two labels" approach as
// tracker_radar/dataset.py's lookup() uses for matching -- good enough
// for eTLD+1-level grouping in the common case, not a full
// public-suffix-list implementation (no PSL bundled here). See that
// file's docstring for the same caveat and tracker_radar/capture.py's
// registrable_domain() for the Python equivalent (which does use a real
// PSL via tldextract -- this is a deliberately simpler stand-in since
// pulling a PSL into the extension bundle is out of scope for this pass).
function registrableDomain(hostname) {
  if (!hostname) return "";
  const labels = hostname.toLowerCase().split(".");
  if (labels.length <= 2) return hostname.toLowerCase();
  return labels.slice(-2).join(".");
}

async function getCapture(tabId) {
  const key = CAPTURE_STORAGE_PREFIX + tabId;
  const stored = await chrome.storage.session.get([key]);
  return stored[key] || null;
}

async function setCapture(tabId, data) {
  const key = CAPTURE_STORAGE_PREFIX + tabId;
  await chrome.storage.session.set({ [key]: data });
}

async function clearCapture(tabId) {
  const key = CAPTURE_STORAGE_PREFIX + tabId;
  await chrome.storage.session.remove([key]);
}

if (LIVE_CAPTURE_SUPPORTED) {
  // A single listener does double duty: a `main_frame` request means a new
  // top-level navigation is starting (reset this tab's capture); anything
  // else is checked against the in-progress capture for that tab. Using
  // webRequest's own `type` field this way avoids needing the separate
  // webNavigation permission just to detect "new page load."
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return; // not associated with a real tab

      if (details.type === "main_frame") {
        let firstPartyDomain = null;
        try {
          firstPartyDomain = registrableDomain(new URL(details.url).hostname);
        } catch {
          // unparseable URL -- leave firstPartyDomain null, capture still
          // starts so third-party requests during this load aren't lost
        }
        setCapture(details.tabId, {
          firstPartyDomain,
          thirdPartyDomains: [],
          startedAt: Date.now(),
        });
        // A new page load also means any consent-prompt warning badge
        // from the *previous* page in this tab no longer applies -- see
        // consent_prompt_background.js, which is what sets it.
        try {
          chrome.action.setBadgeText({ tabId: details.tabId, text: "" });
        } catch {
          // ignore -- badge clearing is best-effort, never worth failing capture over
        }
        return;
      }

      getCapture(details.tabId).then((capture) => {
        if (!capture) return; // no navigation recorded yet for this tab
        let hostname;
        try {
          hostname = new URL(details.url).hostname;
        } catch {
          return;
        }
        const domain = registrableDomain(hostname);
        if (!domain || domain === capture.firstPartyDomain) return;
        if (!capture.thirdPartyDomains.includes(domain)) {
          capture.thirdPartyDomains.push(domain);
          setCapture(details.tabId, capture);
        }
      });
    },
    { urls: ["<all_urls>"] }
  );

  chrome.tabs.onRemoved.addListener((tabId) => clearCapture(tabId));
}

// Message API for the popup (see tracker_radar_client.js):
//   { type: "getLiveObservedProfile", tabId } ->
//     null (nothing captured yet / unsupported browser), or a profile
//     object shaped exactly like tracker_radar/README.md's "Output
//     schema" (site, trackerCount, topCategories, riskScore,
//     flaggedOwners, coverage, ...) plus { capturedAt, snapshotSource }.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "getLiveObservedProfile" || typeof message.tabId !== "number") {
    return false;
  }
  if (!LIVE_CAPTURE_SUPPORTED) {
    sendResponse(null);
    return false;
  }
  (async () => {
    const capture = await getCapture(message.tabId);
    if (!capture) {
      sendResponse(null);
      return;
    }
    const dataset = await _loadDatasetIndex();
    const profile = TrackerRadarScore.buildProfile(
      capture.firstPartyDomain || "(unknown)",
      capture.thirdPartyDomains,
      dataset
    );
    sendResponse({
      ...profile,
      capturedAt: new Date(capture.startedAt).toISOString(),
      snapshotSource: "live capture (this tab, this page load)",
    });
  })();
  return true; // keep the message channel open for the async sendResponse above
});
