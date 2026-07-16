// Minimal ToS;DR rating lookup for the background service worker.
//
// Deliberately NOT a reuse of tosdr.js: that file is popup-only (declares
// `window.TosdrClient`, and `window` doesn't exist in a service worker),
// and duplicating just the rating lookup here is simpler and lower-risk
// than restructuring tosdr.js (an existing, hand-authored file not owned
// by this branch) to work in both contexts. Same public API, same
// endpoints -- see tosdr.js for the fuller client (including review
// points, used by the popup) and its comments on why this is the only
// third-party network request the extension makes.
//
// Only fetches the rating letter, not points -- consent_prompt_background.js
// only needs a coarse disclosed-risk level to decide whether to warn, not
// the full point-by-point detail the popup shows.

const TOSDR_API_BASE = "https://api.tosdr.org";

function _bareDomain(domain) {
  return domain.replace(/^www\./, "");
}

async function lookupRating(domain) {
  const bareDomain = _bareDomain(domain);
  const searchResp = await fetch(`${TOSDR_API_BASE}/search/v5?query=${encodeURIComponent(bareDomain)}`);
  if (!searchResp.ok) throw new Error(`ToS;DR search failed (${searchResp.status})`);
  const searchData = await searchResp.json();
  const services = searchData.services || [];
  const exact = services.find((svc) =>
    (svc.urls || []).some((u) => {
      try {
        return new URL(u).hostname.replace(/^www\./, "") === bareDomain;
      } catch {
        return false;
      }
    })
  );
  const service = exact || services[0] || null;
  if (!service) return null;
  return { rating: service.rating || "N/A" };
}

self.TosdrBackgroundClient = { lookupRating };
