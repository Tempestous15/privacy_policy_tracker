// Preset "concern profiles" + advanced per-category overrides -- the
// primary entry point for customizing what the blocking recommendation
// includes. This only narrows which of the already-computed auto-fix-tier
// trackers get RECOMMENDED for blocking; it never grants standing
// permission to block anything automatically -- every blocking action
// still goes through its own explicit confirm step in popup.js regardless
// of which profile (or overrides) are active.
//
// Categories here are a subset of tracker_remediation.js's
// AUTO_FIX_CATEGORIES -- concern profiles only ever narrow the auto-fix
// tier, never reach into flag-and-link/flag-and-explain, which were never
// eligible for blocking in the first place.
//
// All state lives in chrome.storage.local, same as everything else this
// extension stores (see storage.js) -- never synced, never sent anywhere.

const CONCERN_PROFILE_STATE_KEY = "concernProfileState";

// Stay recommended under every profile -- narrow, unambiguous categories
// where there's no reasonable case for excluding them from a blocking
// recommendation. (The fingerprinting-score override from
// tracker_remediation.js is handled the same way, but separately, in
// filterAutoFixByProfile below, since it isn't a category.)
const ALWAYS_RECOMMENDED_CATEGORIES = new Set(["Malware", "Unknown High Risk Behavior", "Obscure Ownership"]);

const PRESET_PROFILES = {
  adTracking: {
    label: "Ad tracking",
    description: "Advertising networks and ad-motivated tracking pixels.",
    categories: ["Advertising", "Ad Motivated Tracking", "Action Pixels"],
  },
  dataBrokers: {
    label: "Data brokers & analytics",
    description: "Analytics, audience measurement, and session-replay tools that build behavioral profiles.",
    categories: ["Analytics", "Audience Measurement", "Third-Party Analytics Marketing", "Session Replay"],
  },
  social: {
    label: "Social media tracking",
    description: "Social network widgets and share/comment embeds that track browsing outside their own site.",
    categories: ["Social Network", "Social - Share", "Social - Comment"],
  },
};

const DEFAULT_PROFILE_ID = "adTracking";

async function getConcernProfileState() {
  const stored = await browserAPI.storage.local.get([CONCERN_PROFILE_STATE_KEY]);
  return (
    stored[CONCERN_PROFILE_STATE_KEY] || {
      activeProfile: DEFAULT_PROFILE_ID,
      // { [category]: true|false } -- overrides the active profile's
      // default for that one category. Absent = "use the profile default."
      categoryOverrides: {},
    }
  );
}

async function setActiveProfile(profileId) {
  if (!PRESET_PROFILES[profileId]) throw new Error(`Unknown concern profile: ${profileId}`);
  const state = await getConcernProfileState();
  state.activeProfile = profileId;
  await browserAPI.storage.local.set({ [CONCERN_PROFILE_STATE_KEY]: state });
  return state;
}

// Pass value === null to clear an override and fall back to the active
// profile's default for that category again.
async function setCategoryOverride(category, value) {
  const state = await getConcernProfileState();
  if (value === null) delete state.categoryOverrides[category];
  else state.categoryOverrides[category] = !!value;
  await browserAPI.storage.local.set({ [CONCERN_PROFILE_STATE_KEY]: state });
  return state;
}

// The full set of categories a given state recommends, before applying it
// to any actual tracker list: always-recommended categories plus the
// active profile's categories, with advanced per-category overrides
// applied last -- so "advanced" really does have final say over "preset."
function recommendedCategoriesForState(state) {
  const profile = PRESET_PROFILES[state.activeProfile] || PRESET_PROFILES[DEFAULT_PROFILE_ID];
  const set = new Set([...ALWAYS_RECOMMENDED_CATEGORIES, ...profile.categories]);
  for (const [category, allowed] of Object.entries(state.categoryOverrides || {})) {
    if (allowed) set.add(category);
    else set.delete(category);
  }
  return set;
}

// Narrows an already-classified auto-fix list (tracker_remediation.js's
// groups.autoFix) down to what the active profile actually recommends. A
// tracker qualifies if it has a fingerprinting score at/above the
// auto-fix threshold (that override always stays recommended, same
// reasoning as ALWAYS_RECOMMENDED_CATEGORIES -- not currently
// user-overridable), or if any of its categories is in the recommended
// set.
function filterAutoFixByProfile(autoFixEntries, state) {
  const recommended = recommendedCategoriesForState(state);
  const threshold =
    (window.TrackerRemediation && window.TrackerRemediation.FINGERPRINTING_AUTO_FIX_THRESHOLD) || 2;
  return autoFixEntries.filter((entry) => {
    if ((entry.fingerprinting || 0) >= threshold) return true;
    const categories = entry.categories || [];
    return categories.some((c) => recommended.has(c));
  });
}

window.ConcernProfiles = {
  PRESET_PROFILES,
  ALWAYS_RECOMMENDED_CATEGORIES,
  DEFAULT_PROFILE_ID,
  getConcernProfileState,
  setActiveProfile,
  setCategoryOverride,
  recommendedCategoriesForState,
  filterAutoFixByProfile,
};
