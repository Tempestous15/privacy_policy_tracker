// Shared, feature-agnostic vocabulary for the product's tiered
// remediation model -- three tiers, used consistently anywhere the
// product gives a user something actionable to do about a finding:
//
//   AUTO_FIX        -- mechanically safe, narrow cases that can be
//                       handled directly, no user judgment call needed.
//   FLAG_AND_LINK    -- a real fix exists but requires the user to act
//                       (send them to the actual place to do it).
//   FLAG_AND_EXPLAIN -- nothing is technically fixable here; the user
//                       gets a clear, honest explanation of why.
//
// actionUI note: this is the FIRST real implementation of this model in
// the codebase -- there was no existing tiered-remediation code to
// extract when this branch was started (searched extension/, classifier/,
// website/, tracker_radar/; nothing found). It's split into its own
// module, deliberately empty of any tracker-specific knowledge, so a
// future feature (e.g. dark-pattern detection, the model's original
// intended use) can depend on this same file instead of a second copy --
// see tracker_remediation.js for the tracker-specific classification
// built on top of it.
const REMEDIATION_TIER = {
  AUTO_FIX: "auto-fix",
  FLAG_AND_LINK: "flag-and-link",
  FLAG_AND_EXPLAIN: "flag-and-explain",
};

// Buckets a flat list of already-classified items (each with a `.tier`
// property set to one of the REMEDIATION_TIER values) into the three
// tiers, in a fixed, predictable order. Generic over what an "item" is --
// works for trackers today, and for any future finding type that adopts
// the same three-tier shape.
function groupByRemediationTier(items) {
  const groups = { autoFix: [], flagAndLink: [], flagAndExplain: [] };
  for (const item of items) {
    if (item.tier === REMEDIATION_TIER.AUTO_FIX) groups.autoFix.push(item);
    else if (item.tier === REMEDIATION_TIER.FLAG_AND_LINK) groups.flagAndLink.push(item);
    else groups.flagAndExplain.push(item);
  }
  return groups;
}

window.RemediationTiers = { REMEDIATION_TIER, groupByRemediationTier };
