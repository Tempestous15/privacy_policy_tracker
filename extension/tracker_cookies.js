// Cookie clearing for detected trackers only -- never a blanket
// chrome.browsingData.remove() scoped to the site's origin. That API's
// cookie removal is scoped to the whole registrable domain, not the
// specific origin, which would wipe login sessions and any other
// first-party data tied to the domain -- too blunt for "remove tracking
// cookies," so it's not used here. Instead this enumerates real cookie.*
// entries via chrome.cookies and only ever removes ones whose OWN domain
// matches a domain already in the site's detected tracker list.
//
// RELIABILITY NOTE (read before relying on or extending this): matching is
// by cookie domain only. That's reliable for trackers that set cookies
// under their own network-request domain, which is the overwhelming
// majority of what Tracker Radar detects. It will MISS tracker cookies set
// under a first-party-disguised domain (CNAME cloaking) -- Tracker Radar's
// own detection and this matching both key off the request/cookie domain,
// not deeper heuristics, so there is no fallback for that case here by
// design (per actionUI branch instructions: flag it rather than substitute
// a blunter mechanism). If cname-cloaked tracking turns out to matter for
// this product, it needs its own detection work upstream of this file --
// this module can only clear what's already correctly identified as a
// tracker domain.
//
// Also queries the partitioned (CHIPS) cookie jar for the current site as
// top-level site, in addition to the default unpartitioned query --
// chrome.cookies.getAll() only searches unpartitioned storage unless a
// partitionKey is given (Chrome 119+), so a plain domain-only query would
// silently miss a tracker cookie stored as Partitioned for this specific
// site. Older browsers without partitionKey support simply skip that half
// of the query -- the unpartitioned results still stand.

function _cookieDedupeKey(cookie) {
  const partition = cookie.partitionKey && cookie.partitionKey.topLevelSite;
  return [cookie.name, cookie.domain, cookie.path, cookie.storeId, partition || ""].join(" ");
}

// Read-only -- safe to call to populate a count/preview before any confirm
// step. Returns real chrome.cookies.Cookie objects (not just domain
// strings) since removal needs each cookie's storeId/partitionKey/path.
async function findTrackerCookies(trackerDomains, siteDomain) {
  const seen = new Set();
  const results = [];

  function addAll(list) {
    for (const c of list) {
      const key = _cookieDedupeKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(c);
    }
  }

  for (const domain of trackerDomains || []) {
    addAll(await browserAPI.cookies.getAll({ domain }));

    if (siteDomain) {
      try {
        addAll(
          await browserAPI.cookies.getAll({
            domain,
            partitionKey: { topLevelSite: `https://${siteDomain}` },
          })
        );
      } catch (err) {
        // partitionKey querying unsupported in this browser version --
        // the unpartitioned query above still covers the common case.
      }
    }
  }

  return results;
}

function _cookieRemovalUrl(cookie) {
  const domain = cookie.domain.replace(/^\./, "");
  return `${cookie.secure ? "https" : "http"}://${domain}${cookie.path}`;
}

// Removes only the specific cookie entries passed in (normally the exact
// output of findTrackerCookies) -- never a domain-wide or origin-wide
// wipe. Never called automatically -- see popup.js's confirm step.
async function clearTrackerCookies(cookies) {
  let removedCount = 0;
  const domains = new Set();
  for (const cookie of cookies) {
    const details = {
      url: _cookieRemovalUrl(cookie),
      name: cookie.name,
      storeId: cookie.storeId,
    };
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    const result = await browserAPI.cookies.remove(details);
    if (result) {
      removedCount++;
      domains.add(cookie.domain);
    }
  }
  return { removedCount, domains: Array.from(domains) };
}

window.TrackerCookies = { findTrackerCookies, clearTrackerCookies };
