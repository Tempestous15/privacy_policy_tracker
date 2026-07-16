// Composes the background responsibilities MV3 forces into one service
// worker -- Chrome's manifest.json only allows a single
// background.service_worker entry point (unlike Firefox's "scripts"
// array, which lists all of these files directly as an event page -- see
// manifest.json, no wrapper needed there):
//
//   1. background.js -- the WebLLM on-device model host. Generated,
//      untouched by this branch (see webllm/README / build.sh);
//      imported as-is.
//   2. tracker_radar_score.js + tracker_capture_background.js -- live
//      Observed-channel capture, added by siteBehaviorIntegration.
//   3. tosdr_background_client.js + risk_model.js +
//      consent_prompt_background.js -- warn-at-consent-time decision
//      logic, added by popUpTiming.
//   4. website_bridge_background.js -- externally_connectable listener for
//      ClipPri's own website (scan history page), added by
//      websiteImprovement. No dependency on the other files, and nothing
//      depends on it.
//
// Order matters: each file after background.js depends on globals
// declared by an earlier one in this list (consent_prompt_background.js
// needs getCapture from tracker_capture_background.js, TrackerRadarScore
// from tracker_radar_score.js, TosdrBackgroundClient and SiteRiskModel
// from the two files listed just before it) -- see each file's own
// header comment for its specific dependency. background.js and
// website_bridge_background.js don't interact with any of the others, so
// their position relative to the rest doesn't matter.
importScripts("background.js");
importScripts("tracker_radar_score.js");
importScripts("tracker_capture_background.js");
importScripts("tosdr_background_client.js");
importScripts("risk_model.js");
importScripts("consent_prompt_background.js");
importScripts("website_bridge_background.js");
