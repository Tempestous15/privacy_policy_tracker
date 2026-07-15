// Client for the "Observed" channel -- DuckDuckGo Tracker Radar-derived
// data, captured independently of anything a site's privacy policy claims.
// See ../tracker_radar/README.md for how this data is produced, and
// tracker_capture_background.js for how live capture works.
//
// Two sources, picked by *confidence*, not just by which answers first:
//
//   1. Live capture for the current tab (tabId passed in), via the
//      background service worker's chrome.webRequest listener -- see
//      tracker_capture_background.js. Works for any site, not just a
//      curated list, but only "sees" what tracker_radar_dataset_index.json
//      recognizes (currently a small seed set -- see that file's
//      "howToExpand"), so it often captures real third-party domains that
//      don't match anything in that small index yet.
//   2. The bundled tracker_radar_snapshot.json -- a point-in-time capture
//      from tracker_radar/run.py (real headless-Chromium/Playwright
//      captures, can't run inside a popup/content script) for a curated
//      list of ~20 sites (tracker_radar/config.SITES).
//
// A source is "confident" when coverage.riskScoreWithheld is false (see
// tracker_radar/score.py's coverage handling / tracker_radar_score.js's
// port of it) -- i.e. it actually matched enough captured domains to
// produce a real score, not just an empty/mostly-unmatched result. Picking
// "whichever answered" instead of "whichever is confident" was a real bug:
// for a site like google.com, live capture might find 1-2 domains that
// don't match the (currently small) live index at all -- riskScoreWithheld
// -- while the snapshot already has a solid, real Playwright-captured
// result for that same site. Preferring live unconditionally threw the
// better answer away. So: try live first, use it only if confident; else
// try the snapshot, use it if confident; else fall back to whichever
// non-null result exists (live is fresher/page-specific, so preferred when
// neither is confident); else null.
//
// Returns null if NEITHER source has anything for this domain. Callers
// must render an explicit "not yet scanned" state for that case -- never
// silently omit the Observed section or imply a clean/passing result. And
// regardless of source, UI built on the result must say something like
// "detected in a scan on <date>" -- never phrase either source as
// continuous/passive monitoring of the current page.
//
// `browserAPI` is declared once, in storage.js (loaded before this file in
// popup.html) -- these are classic <script> tags sharing one global scope.

const TRACKER_RADAR_SNAPSHOT_URL = "tracker_radar_snapshot.json";

let _trackerRadarSnapshotPromise = null;

function _loadTrackerRadarSnapshot() {
  if (!_trackerRadarSnapshotPromise) {
    _trackerRadarSnapshotPromise = fetch(browserAPI.runtime.getURL(TRACKER_RADAR_SNAPSHOT_URL))
      .then((resp) => {
        if (!resp.ok) throw new Error(`snapshot fetch failed (${resp.status})`);
        return resp.json();
      });
  }
  return _trackerRadarSnapshotPromise;
}

// Matches tosdr.js's bareDomain handling so "www.example.com" and
// "example.com" resolve to the same snapshot entry regardless of which
// form the current tab's hostname or the snapshot's `site` URL uses.
function _bareDomain(hostOrUrl) {
  let host = hostOrUrl;
  try {
    if (hostOrUrl.includes("://")) host = new URL(hostOrUrl).hostname;
  } catch {
    // not a parseable URL -- assume it's already a bare hostname
  }
  return host.replace(/^www\./, "").toLowerCase();
}

async function _lookupSnapshot(domain) {
  const snapshot = await _loadTrackerRadarSnapshot();
  const target = _bareDomain(domain);
  const match = (snapshot.entries || []).find((entry) => _bareDomain(entry.site) === target);
  if (!match) return null;
  return { ...match, capturedAt: snapshot.capturedAt, snapshotSource: snapshot.source };
}

// Asks the background service worker for this tab's live capture (see
// tracker_capture_background.js). Resolves to null (not rejects) on any
// failure -- unsupported browser, no background listener, nothing
// captured yet, popup closed before a response, etc. -- so a live-capture
// problem always falls through to the snapshot rather than surfacing as
// an error the user has to interpret.
async function _lookupLive(tabId) {
  if (typeof tabId !== "number") return null;
  if (!browserAPI.runtime || !browserAPI.runtime.sendMessage) return null;
  try {
    const response = await browserAPI.runtime.sendMessage({ type: "getLiveObservedProfile", tabId });
    return response || null;
  } catch {
    // No listener registered (e.g. Firefox without chrome.storage.session
    // support -- tracker_capture_background.js never adds its listener in
    // that case) throws rather than resolving null in some browsers.
    return null;
  }
}

function _isConfident(profile) {
  return !!profile && !!profile.coverage && profile.coverage.riskScoreWithheld === false;
}

// `tabId` is optional. Pass the current tab's id to try live capture
// first (see above); omit it (e.g. when rendering a saved/historical
// site with no corresponding open tab) to skip straight to the snapshot.
// Returns null if neither source has anything at all for this domain.
async function lookupDomain(domain, tabId) {
  const live = await _lookupLive(tabId);
  if (_isConfident(live)) return live;

  const snapshot = await _lookupSnapshot(domain);
  if (_isConfident(snapshot)) return snapshot;

  // Neither source is confident -- still return whichever actually has
  // *something* (never invent a result), preferring live since it's
  // specific to the page the user is looking at right now.
  return live || snapshot || null;
}

window.TrackerRadarClient = { lookupDomain };
