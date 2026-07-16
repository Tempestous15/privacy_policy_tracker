// Website-side port of tracker_radar_client.js's snapshot lookup, for
// website/check.html (Feature 2: check a URL without installing the
// extension). Deliberately NOT the full tracker_radar_client.js -- that
// file's other path (_lookupLive) asks the extension's background worker
// for live, in-tab webRequest capture, which only exists for a page the
// extension actually watched you browse. A plain website has no such tab
// and cannot fetch it another way, so this only ever has the curated
// snapshot to offer -- see check.js and website/privacy.html for how that
// limited scope is explained to the user.
//
// tracker_radar_snapshot.json here is a synced copy of
// extension/tracker_radar_snapshot.json (same ~20-site curated capture --
// see that file's own header). Whoever refreshes the extension's copy
// (tracker_radar/run.py, see its README) should copy the result here too;
// this file will otherwise silently drift out of sync with the extension's.

const TRACKER_SNAPSHOT_URL = "assets/tracker_radar_snapshot.json";

let _snapshotPromise = null;

function _loadSnapshot() {
  if (!_snapshotPromise) {
    _snapshotPromise = fetch(TRACKER_SNAPSHOT_URL).then((resp) => {
      if (!resp.ok) throw new Error(`snapshot fetch failed (${resp.status})`);
      return resp.json();
    });
  }
  return _snapshotPromise;
}

// Matches tracker_radar_client.js's _bareDomain exactly, so "www.x.com" and
// "x.com" resolve to the same entry regardless of which form the user
// pasted or the snapshot's `site` URL uses.
function _bareDomain(hostOrUrl) {
  let host = hostOrUrl;
  try {
    if (hostOrUrl.includes("://")) host = new URL(hostOrUrl).hostname;
  } catch {
    // not a parseable URL -- assume it's already a bare hostname
  }
  return host.replace(/^www\./, "").toLowerCase();
}

// Returns null if this domain isn't in the curated snapshot -- callers
// must render an explicit "not in our current scan" state for that case,
// same rule as tracker_radar_client.js: never omit the Observed section or
// imply a clean/passing result just because there's no data.
async function lookupDomain(domain) {
  const snapshot = await _loadSnapshot();
  const target = _bareDomain(domain);
  const match = (snapshot.entries || []).find((entry) => _bareDomain(entry.site) === target);
  if (!match) return null;
  return { ...match, capturedAt: snapshot.capturedAt, snapshotSource: snapshot.source };
}

window.TrackerSnapshotLookup = { lookupDomain, _bareDomain };
