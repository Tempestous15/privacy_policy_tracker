// Plain-language explanations for Tracker Radar categories and
// fingerprinting scores -- turns a raw category name like "Session
// Replay" or a bare number like "fingerprinting: 3" into something a
// non-technical user can actually act on. This is the whole point of the
// Observed channel: surfacing technically-detectable behavior a privacy
// policy wouldn't describe in these terms (or at all). A category name by
// itself doesn't do that job; this file is what does.
//
// Text intentionally says what a category *can* do, not what this
// specific tracker *does* do -- Tracker Radar's categories describe a
// tracker's general capability/purpose, not a certainty about this one
// instance's behavior on this one site.

const CATEGORY_EXPLANATIONS = {
  "Session Replay": "Can record your mouse movements, clicks, and what you type on this page.",
  "Malware": "Flagged by Tracker Radar as associated with malicious behavior.",
  "Unknown High Risk Behavior": "Exhibits behavior Tracker Radar's researchers flagged as high-risk but haven't categorized more specifically.",
  "Obscure Ownership": "Who actually operates this tracker isn't clearly disclosed.",
  "Advertising": "Used to target ads to you based on your behavior.",
  "Ad Motivated Tracking": "Tracks your behavior for ad-targeting purposes.",
  "Ad Fraud": "Ad-fraud detection/prevention infrastructure -- typically not tracking you personally.",
  "Analytics": "Tracks how you use this site for the company's own analytics.",
  "Audience Measurement": "Measures audience size/demographics across sites.",
  "Third-Party Analytics Marketing": "Analytics used for marketing purposes, not just this site's own metrics.",
  "Tag Manager": "Loads other tracking scripts dynamically -- what actually runs can change without this site updating anything.",
  "Action Pixels": "An invisible tracking image, often used to confirm you opened something (like an email) or completed an action.",
  "Social Network": "A social media company's tracking code -- can see that you visited this page even if you never click anything.",
  "Social - Share": "A share button from a social platform -- can track page visits even without being clicked.",
  "Social - Comment": "A comment widget from a third party -- can track page visits independent of commenting.",
  "Federated Login": "A login/identity service -- can potentially link your identity across the sites that use it.",
  "SSO": "Single sign-on identity service -- can potentially link your identity across the sites that use it.",
  "CDN": "Delivers files (images, scripts) faster -- usually infrastructure, not tracking-focused.",
  "Embedded Content": "Embeds content (like a video) from another site, which can load that site's own tracking.",
  "Badge": "A visual badge/widget pulled in from another service.",
  "Online Payment": "Payment processing.",
  "Non-Tracking": "Explicitly categorized by Tracker Radar as non-tracking infrastructure.",
  "Support Chat Widget": "Customer-support chat widget.",
  "Consent Management Platform": "Handles cookie-consent banners/preferences.",
  "Fraud Prevention": "Detects fraudulent activity, e.g. at checkout.",
};

const FINGERPRINTING_EXPLANATIONS = {
  0: "No detected use of browser APIs commonly used for device fingerprinting.",
  1: "Low use of fingerprinting-capable browser APIs.",
  2: "Medium use of fingerprinting-capable browser APIs.",
  3: "Heavy use of fingerprinting-capable browser APIs -- can potentially identify your device even without cookies, and even in private/incognito mode.",
};

function explainCategory(category) {
  return CATEGORY_EXPLANATIONS[category] || null;
}

function explainFingerprinting(score) {
  return FINGERPRINTING_EXPLANATIONS[score] ?? null;
}

window.TrackerCategoryGlossary = { explainCategory, explainFingerprinting };
