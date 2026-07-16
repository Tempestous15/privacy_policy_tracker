// Decides whether to warn the user right now, at the moment
// consent_prompt_detector.js finds a cookie-consent banner or a
// ToS/privacy consent checkbox on the page they're looking at. See that
// file for what triggers a message here, and README.md "Timing the
// warning" for why this moment specifically matters.
//
// Uses only two signals, both already cheap/available -- no automatic
// policy-page fetch+scan here, on purpose (see README.md "Trigger
// signals" for the reasoning):
//   - Observed: whatever tracker_capture_background.js has already
//     captured live for this tab (getCapture/_loadDatasetIndex are
//     defined there; this file relies on sharing its scope via
//     background_entry.js's importScripts, same as every other
//     background-side file in this extension).
//   - Disclosed: a single ToS;DR rating lookup (tosdr_background_client.js),
//     not the full points list, not a policy-text fetch.
//
// Composed into the shared service-worker scope by background_entry.js --
// must load after tracker_capture_background.js (needs getCapture),
// tosdr_background_client.js (needs TosdrBackgroundClient), and
// risk_model.js (needs SiteRiskModel).

// Badge stays until the tab navigates to a new top-level page --
// tracker_capture_background.js's webRequest listener clears it on every
// new main_frame request (see the small addition there), same place it
// already resets that tab's capture.
function _setWarningBadge(tabId) {
  try {
    chrome.action.setBadgeText({ tabId, text: "!" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#a33322" });
  } catch {
    // action API unavailable in some contexts (e.g. no matching tab) --
    // never let a badge-setting failure affect the warning itself.
  }
}

function _buildReason(disclosedLevel, observedRating, observedProfile, comparison) {
  const parts = [];
  if (comparison && comparison.comparable && !comparison.agree) {
    return comparison.note;
  }
  if (disclosedLevel === "high") {
    parts.push(`ToS;DR grade: ${observedRating || "poor"}.`);
  }
  if (observedProfile && observedProfile.coverage && !observedProfile.coverage.riskScoreWithheld && observedProfile.riskScore >= 60) {
    parts.push(`Heavy tracking activity detected on this page (${observedProfile.trackerCount} third-party domain(s)).`);
  }
  return parts.join(" ") || "Worth checking before you agree.";
}

async function _evaluate(domain, tabId) {
  // Observed: only from what's already been captured live for this tab --
  // no snapshot fallback here (unlike tracker_radar_client.js's popup-facing
  // lookup), since a consent prompt firing implies the page is already
  // loaded and live capture should have something if it's going to.
  let observedProfile = null;
  try {
    if (typeof getCapture === "function" && typeof _loadDatasetIndex === "function" && typeof TrackerRadarScore !== "undefined") {
      const capture = await getCapture(tabId);
      if (capture && capture.thirdPartyDomains) {
        const dataset = await _loadDatasetIndex();
        observedProfile = TrackerRadarScore.buildProfile(capture.firstPartyDomain || domain, capture.thirdPartyDomains, dataset);
      }
    }
  } catch {
    // Observed lookup failing must never block the Disclosed-only path.
  }

  let disclosedRating = null;
  try {
    const result = await TosdrBackgroundClient.lookupRating(domain);
    disclosedRating = result ? result.rating : null;
  } catch {
    // Same -- a ToS;DR failure must never block the Observed-only path.
  }

  const disclosedLevel = SiteRiskModel.disclosedLevelFromTosdrRating(disclosedRating);
  const observedLevel = observedProfile ? SiteRiskModel.observedLevelFromRiskScore(observedProfile.riskScore) : null;
  const comparison = SiteRiskModel.compareChannels(disclosedLevel, observedLevel);

  const shouldWarn =
    disclosedLevel === "high" ||
    observedLevel === "high" ||
    (comparison.comparable && !comparison.agree);

  if (!shouldWarn) return { warn: false };

  return {
    warn: true,
    reason: _buildReason(disclosedLevel, disclosedRating, observedProfile, comparison),
    disclosedLevel,
    observedLevel,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "consentPromptDetected") return false;
  const tabId = sender.tab && sender.tab.id;
  if (typeof tabId !== "number") {
    sendResponse({ warn: false });
    return false;
  }
  _evaluate(message.domain, tabId).then((decision) => {
    if (decision.warn) _setWarningBadge(tabId);
    sendResponse(decision);
  }).catch(() => sendResponse({ warn: false }));
  return true; // async sendResponse
});
