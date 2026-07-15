// Composes the two independent background responsibilities MV3 forces
// into one service worker -- Chrome's manifest.json only allows a single
// background.service_worker entry point (unlike Firefox's "scripts"
// array, which lists both files directly as an event page -- see
// manifest.json, no wrapper needed there):
//
//   1. background.js -- the WebLLM on-device model host. Generated,
//      untouched by this branch (see webllm/README / build.sh);
//      imported as-is.
//   2. tracker_radar_score.js + tracker_capture_background.js -- live
//      Observed-channel capture, added by siteBehaviorIntegration.
//
// Order matters: tracker_capture_background.js calls into
// TrackerRadarScore (from tracker_radar_score.js), so that must load
// first. background.js doesn't interact with either, so its position
// relative to them doesn't matter.
importScripts("background.js");
importScripts("tracker_radar_score.js");
importScripts("tracker_capture_background.js");
