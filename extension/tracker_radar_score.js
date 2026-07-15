// JS port of tracker_radar/score.py's classify_tracker() and
// build_profile() -- lets a *live* browser capture (see
// tracker_capture_background.js) get scored with the exact same rule as
// the Python milestone (tracker_radar/README.md "The scoring rule"),
// producing the identical output schema so tracker_radar_client.js and
// popup.js don't need to care whether a profile came from the bundled
// snapshot or a live capture.
//
// Weights/categories are duplicated from tracker_radar/config.py by hand
// -- there's no shared build step between the Python milestone and this
// browser-side port (different language, no bundler wiring them
// together). Keep these in sync manually if config.py's rule changes;
// that file is the source of truth and has the reasoning behind each
// number.
//
// Runs in the MV3 service worker (via background_entry.js's
// importScripts), not the popup -- uses `self`, not `window`.

const FINGERPRINT_SCORE_WEIGHTS = { 0: 0, 1: 2, 2: 6, 3: 10 };
const FINGERPRINT_SCORE_LABELS = { 0: "none", 1: "low", 2: "medium", 3: "high" };
const HIGH_FINGERPRINTING_SCORE_FLOOR = 3;

const AD_TRACKING_CATEGORIES = new Set([
  "Advertising", "Ad Motivated Tracking", "Ad Fraud", "Analytics",
  "Audience Measurement", "Third-Party Analytics Marketing", "Tag Manager",
  "Action Pixels", "Social Network", "Social - Share", "Social - Comment",
  "Federated Login", "SSO",
]);
const CDN_FUNCTIONAL_CATEGORIES = new Set([
  "CDN", "Embedded Content", "Badge", "Online Payment", "Non-Tracking",
  "Support Chat Widget", "Consent Management Platform", "Fraud Prevention",
]);
const FORCE_HEAVY_CATEGORIES = new Set([
  "Session Replay", "Malware", "Unknown High Risk Behavior", "Obscure Ownership",
]);

const AD_TRACKING_WEIGHT = 4;
const CDN_FUNCTIONAL_WEIGHT = 0.5;
const FORCE_HEAVY_WEIGHT = 10;

const COMPANY_SCALING_COEFFICIENT = 0.15;
const RISK_SCORE_CAP = 100;
const LOW_COVERAGE_RATIO_THRESHOLD = 0.4;

function classifyTracker(entry) {
  const categories = entry.categories || [];
  const fpScore = entry.fingerprinting || 0;
  const fpWeight = FINGERPRINT_SCORE_WEIGHTS[fpScore] || 0;

  const isForcedHeavy = categories.some((c) => FORCE_HEAVY_CATEGORIES.has(c));
  const isHighFingerprinting = fpScore >= 2;

  if (isForcedHeavy || isHighFingerprinting) {
    const weight = Math.max(fpWeight, isForcedHeavy ? FORCE_HEAVY_WEIGHT : 0);
    return { bucket: "fingerprinting_heavy", weight };
  }
  if (categories.some((c) => AD_TRACKING_CATEGORIES.has(c))) {
    return { bucket: "ad_tracking", weight: Math.max(AD_TRACKING_WEIGHT, fpWeight) };
  }
  if (categories.some((c) => CDN_FUNCTIONAL_CATEGORIES.has(c))) {
    return { bucket: "cdn_functional", weight: Math.max(CDN_FUNCTIONAL_WEIGHT, fpWeight) };
  }
  return { bucket: "other", weight: fpWeight };
}

function ownerName(entry) {
  const owner = entry.owner || {};
  return owner.name || owner.displayName || null;
}

// Mirrors dataset.py's lookup(): exact match first, then walk up the
// label hierarchy stopping at two labels -- same simplification, same
// caveats (see that file's docstring). `dataset` is a plain
// { domain: entry } object here, not a class instance.
function lookupDataset(dataset, domain) {
  if (!domain) return null;
  domain = domain.toLowerCase().replace(/\.+$/, "");
  if (dataset[domain]) return dataset[domain];
  const labels = domain.split(".");
  while (labels.length > 2) {
    labels.shift();
    const candidate = labels.join(".");
    if (dataset[candidate]) return dataset[candidate];
  }
  return null;
}

function buildCoverageNote(total, matched, ratio) {
  if (total === 0) {
    return {
      matchedCount: 0, totalThirdPartyDomains: 0, coverageRatio: null,
      lowCoverage: true, riskScoreWithheld: true,
      note: "No third-party requests were captured for this page load.",
    };
  }
  if (matched === 0) {
    return {
      matchedCount: 0, totalThirdPartyDomains: total, coverageRatio: 0,
      lowCoverage: true, riskScoreWithheld: true,
      note: `Captured ${total} third-party domain(s) but none matched our bundled tracker index -- likely an index coverage gap (see tracker_radar_dataset_index.json), not evidence of a clean site.`,
    };
  }
  const low = ratio < LOW_COVERAGE_RATIO_THRESHOLD;
  return {
    matchedCount: matched, totalThirdPartyDomains: total,
    coverageRatio: Math.round(ratio * 100) / 100, lowCoverage: low,
    riskScoreWithheld: false,
    note: low
      ? `Only ${Math.round(ratio * 100)}% of captured third-party domains matched our bundled tracker index; the score reflects known trackers only and likely undercounts.`
      : `${Math.round(ratio * 100)}% of captured third-party domains matched our bundled tracker index.`,
  };
}

// Same shape as tracker_radar/score.py's build_profile() -- see that
// file's docstring for what each field means. `dataset` is the plain
// object loaded from tracker_radar_dataset_index.json's "domains" key.
function buildProfile(site, thirdPartyDomains, dataset) {
  const matched = [];
  const unmatched = [];
  for (const domain of thirdPartyDomains) {
    const entry = lookupDataset(dataset, domain);
    if (!entry) { unmatched.push(domain); continue; }
    matched.push({ domain, entry, ...classifyTracker(entry) });
  }

  const categoryCounter = new Map();
  const fingerprintTierCounts = { none: 0, low: 0, medium: 0, high: 0 };
  const owners = new Set();
  const flaggedOwners = new Set();
  let weightedSum = 0;

  for (const { entry, bucket, weight } of matched) {
    for (const cat of entry.categories || []) {
      categoryCounter.set(cat, (categoryCounter.get(cat) || 0) + 1);
    }
    fingerprintTierCounts[FINGERPRINT_SCORE_LABELS[entry.fingerprinting || 0] || "none"] += 1;
    const owner = ownerName(entry);
    if (owner) {
      owners.add(owner);
      if (bucket === "fingerprinting_heavy") flaggedOwners.add(owner);
    }
    weightedSum += weight;
  }

  const total = thirdPartyDomains.length;
  const matchedCount = matched.length;
  const coverageRatio = total ? matchedCount / total : null;
  const coverage = buildCoverageNote(total, matchedCount, coverageRatio);

  let riskScore = null;
  if (!coverage.riskScoreWithheld) {
    const raw = weightedSum * (1 + COMPANY_SCALING_COEFFICIENT * owners.size);
    riskScore = Math.round(Math.min(RISK_SCORE_CAP, raw) * 10) / 10;
  }

  const highFingerprintingCount = matched.filter(
    ({ entry }) => (entry.fingerprinting || 0) >= HIGH_FINGERPRINTING_SCORE_FLOOR
  ).length;

  const topCategories = [...categoryCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat]) => cat);

  return {
    site,
    trackerCount: total,
    topCategories,
    riskScore,
    flaggedOwners: [...flaggedOwners].sort(),
    distinctOwnerCount: owners.size,
    highFingerprintingCount,
    fingerprintingBreakdown: fingerprintTierCounts,
    categoryBreakdown: Object.fromEntries(categoryCounter),
    unmatchedDomains: unmatched,
    coverage,
  };
}

self.TrackerRadarScore = { classifyTracker, buildProfile, lookupDataset };
