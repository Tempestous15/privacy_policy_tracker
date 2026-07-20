// Tracker-specific classification built on top of the feature-agnostic
// tiering vocabulary in remediation_tiers.js. This is the ONLY module that
// should know about Tracker Radar categories, fingerprinting scores, or
// opt-out URLs -- popup.js should only ever ask "what tier is this tracker
// in and what do I show the user", never re-derive the classification.
//
// Tier assignment is a fixed waterfall, checked in this order:
//
//   1. FLAG_AND_EXPLAIN_CATEGORIES is a hard override. These are categories
//      where blocking risks breaking the site itself (payment, login,
//      embedded content, etc). This check runs FIRST and wins even over a
//      high fingerprinting score, because "don't break the site" outranks
//      "this tracker looks aggressive."
//   2. Otherwise, a tracker is AUTO_FIX-eligible if its category is on the
//      user-approved auto-fix list, OR it has a fingerprinting score >= 2
//      (aggressive covert tracking) regardless of category.
//   3. Otherwise it's FLAG_AND_LINK: a company-specific opt-out page if one
//      has been verified, or the DAA's cross-industry opt-out tool as a
//      fallback (the DAA is the one industry-wide mechanism confirmed
//      working as of this writing -- see note on NAI below).
//
// Every category name below is expected to match Tracker Radar's own
// category strings exactly (see tracker_radar_dataset_index.json / entries'
// `.categories` arrays).

// Auto-fix: mechanically safe to preview-block, narrow enough that a false
// positive is unlikely to break a site. Approved list, from actionUI task
// planning -- do not add to this without re-confirming with product.
const AUTO_FIX_CATEGORIES = new Set([
  "Advertising",
  "Ad Motivated Tracking",
  "Analytics",
  "Audience Measurement",
  "Third-Party Analytics Marketing",
  "Action Pixels",
  "Session Replay",
  "Malware",
  "Unknown High Risk Behavior",
  "Obscure Ownership",
  "Social Network",
  "Social - Share",
  "Social - Comment",
]);

// A fingerprinting score at or above this threshold is treated as
// auto-fixable REGARDLESS of category, since covert device fingerprinting
// is exactly the kind of narrow, unambiguous case the auto-fix tier is for.
const FINGERPRINTING_AUTO_FIX_THRESHOLD = 2;

// Flag-and-explain: functionality-critical categories. Blocking these risks
// breaking the site the user is trying to use, so instead of offering a
// (fake) fix, we explain why nothing is being touched. This list is checked
// BEFORE the auto-fix list, so it wins even for high-fingerprinting entries.
const FLAG_AND_EXPLAIN_CATEGORIES = new Set([
  "CDN",
  "Embedded Content",
  "Online Payment",
  "Support Chat Widget",
  "Consent Management Platform",
  "Tag Manager",
  "Federated Login",
  "SSO",
  "Fraud Prevention",
  "Non-Tracking",
  "Badge",
]);

const CATEGORY_EXPLANATIONS = {
  CDN: "This loads core site resources (scripts, images, or styles) from a shared content delivery network -- blocking it could break the page.",
  "Embedded Content": "This is an embedded widget (video, map, or similar) built into the page -- blocking it would remove that content entirely.",
  "Online Payment": "This handles checkout or payment processing -- blocking it could prevent purchases from completing.",
  "Support Chat Widget": "This powers a live chat or support widget -- blocking it would remove that feature.",
  "Consent Management Platform": "This is the tool that shows the site's own cookie/consent banner -- blocking it can break consent controls or leave the banner stuck.",
  "Tag Manager": "This loads other scripts the site depends on -- blocking it can break unrelated site features.",
  "Federated Login": "This powers \"log in with...\" functionality -- blocking it would prevent that login option from working.",
  SSO: "This powers single sign-on -- blocking it would prevent that login option from working.",
  "Fraud Prevention": "This helps the site detect fraudulent activity -- blocking it is more likely to affect site security than your privacy.",
  "Non-Tracking": "Tracker Radar classifies this as non-tracking -- there's nothing to fix here.",
  Badge: "This is a visual badge or certification embed -- blocking it only affects a small piece of page content, not tracking.",
};

function explanationForCategory(category) {
  return (
    CATEGORY_EXPLANATIONS[category] ||
    "This tracker is tied to core site functionality and can't be safely blocked without risking breakage."
  );
}

// Verified, current, company-specific opt-out pages -- checked against the
// real destination (not a generic search) as of this writing. Keyed by the
// exact owner-name string Tracker Radar/tracker_radar_score.js produces via
// ownerName(entry) (see extension/tracker_radar_dataset_index.json).
//
// Deliberately small: only owners whose opt-out page was actually verified
// are listed here. Every other owner falls back to DAA_FALLBACK below
// rather than guessing at a URL -- overclaiming a "real, working" link that
// isn't would violate the whole point of this tier.
const OPT_OUT_DIRECTORY = {
  "Google LLC": {
    label: "Google Ad Center",
    url: "https://myadcenter.google.com/personalizationoff",
  },
  "Facebook, Inc.": {
    // Meta retired the old facebook.com/adpreferences/ad_settings deep link
    // in favor of the unified Accounts Center flow (Accounts Center > Ad
    // preferences), rolled out June/July 2026 -- link to the current hub.
    label: "Meta Accounts Center — Ad preferences",
    url: "https://accountscenter.facebook.com/ad_preferences",
  },
  "Microsoft Corporation": {
    label: "Microsoft privacy dashboard — ad settings",
    url: "https://account.microsoft.com/privacy/ad-settings",
  },
  "Amazon Technologies, Inc.": {
    label: "Amazon advertising preferences",
    url: "https://www.amazon.com/adprefs",
  },
};

// The Digital Advertising Alliance's WebChoices tool is a real,
// cross-industry opt-out covering many ad-tech companies at once. Used as
// the fallback for any owner without a verified company-specific page.
//
// NOTE: the Network Advertising Initiative's own opt-out tool ceased
// operating September 15, 2025 and now redirects to the DAA -- it is
// deliberately NOT listed here or anywhere in this file, since linking to
// it would not meet the "real, working" bar this tier requires.
const DAA_FALLBACK = {
  label: "Digital Advertising Alliance — WebChoices opt-out",
  url: "https://optout.aboutads.info/",
};

// Classifies a single already-matched tracker (the shape produced by
// tracker_radar_score.js's buildProfile(), i.e. one entry of
// `matchedDomains`: { domain, owner, categories, fingerprinting, bucket }).
// Returns the original fields plus `.tier` and, depending on tier,
// `.reason` (flag-and-explain) or `.optOut` (flag-and-link).
function classifyTracker(entry) {
  const categories = entry.categories || [];
  const fingerprinting = entry.fingerprinting || 0;
  const owner = entry.owner || null;
  const TIER = window.RemediationTiers.REMEDIATION_TIER;

  const explainCategory = categories.find((c) => FLAG_AND_EXPLAIN_CATEGORIES.has(c));
  if (explainCategory) {
    return {
      ...entry,
      tier: TIER.FLAG_AND_EXPLAIN,
      reason: explanationForCategory(explainCategory),
    };
  }

  const isAutoFixCategory = categories.some((c) => AUTO_FIX_CATEGORIES.has(c));
  if (isAutoFixCategory || fingerprinting >= FINGERPRINTING_AUTO_FIX_THRESHOLD) {
    return { ...entry, tier: TIER.AUTO_FIX };
  }

  const optOut = (owner && OPT_OUT_DIRECTORY[owner]) || DAA_FALLBACK;
  return { ...entry, tier: TIER.FLAG_AND_LINK, optOut };
}

// Classifies a full site's matchedDomains array and buckets the results by
// tier using the shared grouping helper from remediation_tiers.js.
function classifySite(matchedDomains) {
  const items = (matchedDomains || []).map(classifyTracker);
  return {
    items,
    groups: window.RemediationTiers.groupByRemediationTier(items),
  };
}

window.TrackerRemediation = {
  AUTO_FIX_CATEGORIES,
  FLAG_AND_EXPLAIN_CATEGORIES,
  FINGERPRINTING_AUTO_FIX_THRESHOLD,
  OPT_OUT_DIRECTORY,
  DAA_FALLBACK,
  classifyTracker,
  classifySite,
};
