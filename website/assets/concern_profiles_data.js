// Reference data for website/settings.html -- a deliberately duplicated,
// read-only copy of the same constants extension/concern_profiles.js and
// extension/tracker_remediation.js define, same convention already used
// for redflags-engine.js/tracker_category_glossary.js elsewhere in
// website/assets/ (see those files' own headers). This is presentation
// data only (labels, descriptions, the list of togglable categories) --
// the actual STATE (which profile is active, which categories are
// overridden) lives in the extension's chrome.storage.local and is read/
// written live via extension-bridge.js, never duplicated here.
//
// If extension/concern_profiles.js's PRESET_PROFILES or
// extension/tracker_remediation.js's AUTO_FIX_CATEGORIES ever change,
// this needs the same change or the settings page will render stale
// options (it will still function -- unknown categories just won't have a
// friendly toggle -- but should be kept in sync by hand).

const CONCERN_PROFILES_DATA = {
  DEFAULT_PROFILE_ID: "adTracking",

  ALWAYS_RECOMMENDED_CATEGORIES: ["Malware", "Unknown High Risk Behavior", "Obscure Ownership"],

  PRESET_PROFILES: {
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
  },

  // Every category the "advanced" section offers a toggle for -- mirrors
  // extension/tracker_remediation.js's AUTO_FIX_CATEGORIES exactly (concern
  // profiles only ever narrow the auto-fix tier, see that file's header).
  AUTO_FIX_CATEGORIES: [
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
  ],
};

// recommendedCategoriesForState mirrors concern_profiles.js's function of
// the same name exactly -- needed here so settings.js can show each
// advanced checkbox's correct current on/off state (profile default,
// overridden or not) without a round trip per checkbox.
function concernProfilesRecommendedCategoriesForState(state) {
  const profiles = CONCERN_PROFILES_DATA.PRESET_PROFILES;
  const profile = profiles[state.activeProfile] || profiles[CONCERN_PROFILES_DATA.DEFAULT_PROFILE_ID];
  const set = new Set([...CONCERN_PROFILES_DATA.ALWAYS_RECOMMENDED_CATEGORIES, ...profile.categories]);
  for (const [category, allowed] of Object.entries(state.categoryOverrides || {})) {
    if (allowed) set.add(category);
    else set.delete(category);
  }
  return set;
}

window.CONCERN_PROFILES_DATA = CONCERN_PROFILES_DATA;
window.concernProfilesRecommendedCategoriesForState = concernProfilesRecommendedCategoriesForState;
