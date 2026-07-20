// Single source of truth for every glossary term explained via a hover
// tooltip anywhere in the popup (see glossary_tooltip.js for the shared
// component that renders these). Adding a new hoverable term anywhere in
// the extension means adding one entry here -- never a hardcoded string
// in the component that displays it.
//
// Each entry has exactly three parts, on purpose (design spec): a short
// plain-English definition, a concrete/specific example (not an abstract
// restatement of the definition), and one line connecting it to why the
// user should care. Keep all three tight -- this renders in a popup
// tooltip with real width constraints, not a full glossary page.
//
// Scope (this round): Observed-channel/tracker-technical jargon only --
// see branch notes for why the Disclosed tab's legal/policy jargon
// (arbitration, biometric data, etc.) is a separate, not-yet-covered
// bucket.
const GLOSSARY = {
  fingerprinting: {
    term: "Fingerprinting",
    short: "Identifying your device using small technical details, instead of cookies.",
    example:
      "Sites can combine your screen size, fonts, timezone, and browser quirks -- even things like how your " +
      "device renders a canvas graphic -- into a signature that's nearly unique to your device.",
    why:
      "Clearing cookies or browsing in private mode doesn't stop this -- it's harder to block, and nothing has " +
      "to be stored on your device at all.",
  },
  thirdParty: {
    term: "Third-party",
    short: "A server or cookie controlled by a different company than the site you're actually visiting.",
    example:
      "Loading a page on site-a.com can quietly load code from ad-tech.com, or let ad-tech.com set a cookie " +
      "that site-b.com can also read later -- both are third parties.",
    why:
      "A third party can see you across many different sites, building a much bigger picture of your activity " +
      "than any single site could get on its own.",
  },
  sessionReplay: {
    term: "Session replay",
    short: "Software that records your mouse movements, clicks, scrolls, and sometimes keystrokes on a page.",
    example:
      "Some session-replay tools capture text typed into a form field in real time, even before you hit submit.",
    why:
      "It's a far more detailed record of your behavior than a typical page-view count -- closer to a screen " +
      "recording than to ordinary analytics.",
  },
  obscureOwnership: {
    term: "Obscure ownership",
    short: "Flagged when it isn't clear who actually operates or owns a tracker.",
    example: "A domain can load tracking code with no publicly listed company, privacy policy, or contact behind it.",
    why: "You can't look up a privacy policy or ask to opt out of something when you don't know who's actually running it.",
  },
  unknownHighRisk: {
    term: "Unknown high-risk behavior",
    short: "Flagged for activity that looks aggressive, but hasn't been sorted into a more specific category yet.",
    example: "A tracker might behave like known heavy fingerprinting scripts without matching an established category.",
    why: "\"Uncategorized\" doesn't mean harmless -- it means researchers noticed something concerning but haven't fully labeled it yet.",
  },
  tagManager: {
    term: "Tag manager",
    short: "A tool that loads other tracking scripts dynamically, after the page itself has already loaded.",
    example: "One tag-manager script on a page can decide, on the fly, to load five different ad and analytics trackers.",
    why: "What actually runs on a page can change at any time without the site updating its own code -- or its privacy policy.",
  },
  trackingPixel: {
    term: "Tracking pixel",
    short: "A tiny, invisible image used to confirm an action happened -- not to display anything.",
    example: "A marketing email can contain a 1x1-pixel image that quietly tells the sender the moment you open it.",
    why: "There's no visual cue you're being tracked at all -- unlike a cookie banner or a visible ad.",
  },
  audienceMeasurement: {
    term: "Audience measurement",
    short: "Tracking used to measure the size and makeup of a site's audience, often across many sites at once.",
    example: "A measurement company can track your visits across dozens of unrelated news sites to estimate advertiser \"reach.\"",
    why: "This builds a cross-site profile of you even if you never look at, or click, a single ad.",
  },
  federatedLogin: {
    term: "Federated login / SSO",
    short: "A \"sign in with...\" service that can log you into many different, unrelated sites with one account.",
    example: "Loading a \"Sign in with Google\" button can let Google potentially see that you visited, even if you never click it.",
    why: "The identity provider can potentially link your activity across every site that offers that sign-in option.",
  },
  cdn: {
    term: "CDN",
    short: "\"Content delivery network\" -- infrastructure that serves files like images and scripts faster.",
    example: "A site's images might load from a CDN's domain instead of the site's own domain, purely for speed.",
    why: "Usually just plumbing, not tracking -- but it does mean a separate company technically sees that request happen.",
  },
  consentManagementPlatform: {
    term: "Consent management platform",
    short: "The service that runs a site's cookie-consent banner and remembers your choices.",
    example: "Clicking \"Accept\" or \"Manage preferences\" on a cookie banner is usually handled by a separate CMP company, not the site itself.",
    why: "The tool asking for your consent is itself a third party that can see you visited -- even before you make a choice.",
  },
};

function getGlossaryTerm(key) {
  return GLOSSARY[key] || null;
}

window.Glossary = { GLOSSARY, getGlossaryTerm };
