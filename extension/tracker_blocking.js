// declarativeNetRequest-based, per-site tracker blocking.
//
// Runs entirely in the popup's own extension context -- popup pages have
// the same declarativeNetRequest/storage privileges as the background
// service worker, and dynamic rules persist in Chrome's own rule store
// regardless of which extension page applied them. Deliberately NOT wired
// into background_entry.js, which is a teammate's active turf (see that
// file's own header comment) and has no need to know about this feature.
//
// Nothing in this file runs on its own. Every exported function is called
// only from an explicit, confirmed user action in popup.js -- see
// _buildProtectMeSection / the block-recommendation confirm step.
//
// Scoping: each rule blocks one tracker domain, but ONLY when the request
// was initiated by the specific site the user is protecting (condition.
// initiatorDomains), not everywhere that tracker domain appears -- see
// condition.requestDomains + condition.initiatorDomains below. This is a
// site-scoped allow/deny list, never a global blocklist.
//
// resourceTypes is intentionally left unset on every rule: declarativeNet-
// Request's own default (neither resourceTypes nor excludedResourceTypes
// given) blocks every resource type EXCEPT "main_frame" -- exactly the
// safety margin wanted here, so clicking a link from this site straight to
// a blocked tracker domain still navigates instead of silently failing.

const TRACKER_BLOCKING_STATE_KEY = "trackerBlockingState"; // { [siteDomain]: { rules: { [trackerDomain]: ruleId }, blockedAt } }

async function _getBlockingState() {
  const stored = await browserAPI.storage.local.get([TRACKER_BLOCKING_STATE_KEY]);
  return stored[TRACKER_BLOCKING_STATE_KEY] || {};
}

async function _setBlockingState(state) {
  await browserAPI.storage.local.set({ [TRACKER_BLOCKING_STATE_KEY]: state });
}

// The live dynamic rule set is the actual source of truth for what's
// blocked; the storage record above is just a human-readable index (which
// tracker domains, when) kept alongside it. Deriving the next rule ID from
// the live rules (rather than a separately-persisted counter) means the
// two can never drift out of sync with each other.
async function _nextRuleId() {
  const existing = await browserAPI.declarativeNetRequest.getDynamicRules();
  return existing.reduce((max, r) => Math.max(max, r.id), 0) + 1;
}

// Read-only -- safe to call on render, not just after a confirm click.
// Reflects prior confirmed blocking, it doesn't perform any new action.
async function getBlockedForSite(siteDomain) {
  const state = await _getBlockingState();
  const entry = state[siteDomain];
  if (!entry) return { domains: [], blockedAt: null };
  return { domains: Object.keys(entry.rules), blockedAt: entry.blockedAt };
}

// Adds one dynamic rule per tracker domain not already blocked on this
// site. Never called automatically -- see popup.js's confirm step.
async function applyBlockingForSite(siteDomain, trackerDomains) {
  if (!siteDomain || !trackerDomains || !trackerDomains.length) {
    return { blockedDomains: [] };
  }
  const state = await _getBlockingState();
  const entry = state[siteDomain] || { rules: {}, blockedAt: null };

  // Skip domains already blocked on this site -- re-running this after a
  // re-scan that finds the same trackers again shouldn't create duplicate
  // rules or duplicate rule IDs.
  const newDomains = trackerDomains.filter((d) => !entry.rules[d]);
  if (!newDomains.length) {
    return { blockedDomains: Object.keys(entry.rules) };
  }

  let nextId = await _nextRuleId();
  const addRules = newDomains.map((trackerDomain) => {
    const rule = {
      id: nextId++,
      priority: 1,
      action: { type: "block" },
      condition: {
        requestDomains: [trackerDomain],
        initiatorDomains: [siteDomain],
      },
    };
    entry.rules[trackerDomain] = rule.id;
    return rule;
  });

  await browserAPI.declarativeNetRequest.updateDynamicRules({ addRules, removeRuleIds: [] });

  entry.blockedAt = Date.now();
  state[siteDomain] = entry;
  await _setBlockingState(state);

  return { blockedDomains: Object.keys(entry.rules) };
}

// Reverses blocking for a site -- everything, or (if `onlyDomains` is
// given) just those specific tracker domains, so "unblock this one
// tracker" and "unblock everything on this site" share one function.
// Never called automatically -- see popup.js's confirm step.
async function removeBlockingForSite(siteDomain, onlyDomains) {
  const state = await _getBlockingState();
  const entry = state[siteDomain];
  if (!entry) return { remainingDomains: [] };

  const domainsToRemove = onlyDomains && onlyDomains.length ? onlyDomains : Object.keys(entry.rules);
  const ruleIdsToRemove = domainsToRemove.map((d) => entry.rules[d]).filter((id) => typeof id === "number");

  if (ruleIdsToRemove.length) {
    await browserAPI.declarativeNetRequest.updateDynamicRules({ addRules: [], removeRuleIds: ruleIdsToRemove });
  }
  for (const d of domainsToRemove) delete entry.rules[d];

  if (Object.keys(entry.rules).length) {
    state[siteDomain] = entry;
  } else {
    delete state[siteDomain];
  }
  await _setBlockingState(state);

  return { remainingDomains: state[siteDomain] ? Object.keys(state[siteDomain].rules) : [] };
}

window.TrackerBlocking = { getBlockedForSite, applyBlockingForSite, removeBlockingForSite };
