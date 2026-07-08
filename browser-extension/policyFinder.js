/**
 * policyFinder.js
 *
 * Pure privacy-policy-link discovery logic -- the browser extension's
 * "stage 1 + stage 2" of the multi-stage discovery pipeline (current-page
 * link scan + footer/legal-nav boost). No chrome.* APIs are used anywhere
 * in this file -- it only reads the DOM (and URL) it's handed -- so it
 * stays testable and reusable independent of the extension runtime, and
 * keeps "how do we find the link" completely separate from "what do we do
 * with it" (that part lives in content.js / background.js / popup.js).
 *
 * This is deliberately a FAST, FREE, single-page check only. Stages 3-7
 * (common-path guessing, sitemap search, internal search, structured
 * metadata, LLM ranking) require hitting arbitrary URLs on the target site,
 * which a content script generally can't do across origins -- those live
 * server-side in tracker/policy_discovery.py and only run when this
 * quick check doesn't land a high-confidence result.
 *
 * Injected into the page (via chrome.scripting.executeScript, see
 * background.js) immediately before content.js, which calls
 * scanForPrivacyPolicy() and reports the result back.
 */

// Keyword tiers, from most to least trustworthy -- mirrors
// tracker/policy_discovery.py's STRONG/MODERATE/WEAK_PHRASES so the client
// and server agree on what counts as "obviously the privacy policy" vs. a
// weak fallback guess.
var PPF_STRONG_PHRASES = [
  "privacy policy", "privacy notice", "privacy statement", "data protection",
  "data policy", "data privacy", "your privacy", "legal/privacy",
];
var PPF_MODERATE_PHRASES = ["privacy"];
var PPF_WEAK_PHRASES = ["gdpr", "trust center", "trust centre", "cookies", "legal", "terms"];

function ppfNormalizeUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch (e) {
    return null;
  }
}

function ppfIsHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}

// Whether the *original* href attribute (before normalization) was already
// a fully-qualified URL, as opposed to a relative path like "/privacy".
function ppfIsOriginallyAbsolute(hrefRaw) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(hrefRaw) || hrefRaw.indexOf("//") === 0;
}

var PPF_FOOTER_AREA_CLASS_RE = /(footer|legal-nav|legal-menu|bottom-nav|bottom-bar)/i;

// Stage 2: is this element inside a <footer>, role="contentinfo", or a
// legal/bottom-nav-style container? Walks up the DOM tree from the link.
function ppfIsInFooterArea(el) {
  var node = el;
  while (node) {
    var tag = node.tagName ? node.tagName.toLowerCase() : "";
    if (tag === "footer") return true;
    var role = (node.getAttribute && node.getAttribute("role")) || "";
    if (role.trim().toLowerCase() === "contentinfo") return true;
    var cls = (node.className && node.className.toString) ? node.className.toString() : "";
    var id = node.id || "";
    if (PPF_FOOTER_AREA_CLASS_RE.test(cls) || PPF_FOOTER_AREA_CLASS_RE.test(id)) return true;
    node = node.parentElement;
  }
  return false;
}

function ppfMatchesAny(haystackLower, phrases) {
  for (var i = 0; i < phrases.length; i++) {
    if (haystackLower.indexOf(phrases[i]) !== -1) return true;
  }
  return false;
}

/**
 * Score a single <a> element using text, href, aria-label, AND title
 * attribute -- some sites only put "Privacy Policy" in one of those, not
 * the visible text. Returns null if it isn't privacy-related at all.
 * Higher score = better candidate. Tiers are spaced far apart so they never
 * blend into each other -- e.g. a tier-1 exact-text match always outranks
 * any number of lower-tier signals.
 */
function ppfScoreLink(anchor, baseUrl, pageHostname) {
  var text = (anchor.textContent || "").trim();
  var hrefRaw = anchor.getAttribute("href") || "";
  var ariaLabel = anchor.getAttribute("aria-label") || "";
  var titleAttr = anchor.getAttribute("title") || "";
  if (!hrefRaw) return null;

  var absoluteUrl = ppfNormalizeUrl(hrefRaw, baseUrl);
  if (!absoluteUrl || !ppfIsHttpUrl(absoluteUrl)) return null;

  var textLower = text.toLowerCase();
  var hrefLower = hrefRaw.toLowerCase();
  var combined = [textLower, hrefLower, ariaLabel.toLowerCase(), titleAttr.toLowerCase()].join(" ");

  var matchedStrong = ppfMatchesAny(combined, PPF_STRONG_PHRASES);
  var matchedModerate = ppfMatchesAny(combined, PPF_MODERATE_PHRASES);
  var matchedWeak = ppfMatchesAny(combined, PPF_WEAK_PHRASES);

  if (!matchedStrong && !matchedModerate && !matchedWeak) {
    return null; // not a privacy-related link at all
  }

  var score = 1; // base score for being a candidate

  // Tier 1: exact link text match
  if (textLower === "privacy policy") score += 1000;

  // Tier 2: href contains "/privacy"
  if (hrefLower.indexOf("/privacy") !== -1) score += 500;

  // Tier 3: link text contains "privacy"
  if (textLower.indexOf("privacy") !== -1) score += 250;

  // Tier 4: footer / contentinfo / legal-nav links
  var inFooter = ppfIsInFooterArea(anchor);
  if (inFooter) score += 100;

  // Tier 5: same-domain links over third-party links
  var sameDomain = false;
  try {
    var linkHost = new URL(absoluteUrl).hostname.replace(/^www\./, "");
    sameDomain = linkHost === pageHostname.replace(/^www\./, "");
  } catch (e) {
    /* ignore malformed URL */
  }
  if (sameDomain) score += 50;

  // Tier 6: absolute URLs (in the original href) over relative ones
  if (ppfIsOriginallyAbsolute(hrefRaw)) score += 10;

  if (!matchedStrong && !matchedModerate && matchedWeak) {
    // Only a generic/noisy keyword (terms, legal, cookies, gdpr...)
    // matched -- still admit it as a low-value fallback candidate.
    score += 20;
  }

  return {
    url: absoluteUrl,
    text: text || ariaLabel || titleAttr,
    score: score,
    sameDomain: sameDomain,
    inFooter: inFooter,
  };
}

function ppfFindCandidates(doc, baseUrl) {
  var pageHostname = new URL(baseUrl).hostname;
  var anchors = Array.prototype.slice.call(doc.querySelectorAll("a[href]"));
  var scored = [];

  for (var i = 0; i < anchors.length; i++) {
    var result = ppfScoreLink(anchors[i], baseUrl, pageHostname);
    if (result) scored.push(result);
  }

  // Dedupe by normalized URL, keeping the highest-scoring occurrence of each.
  var bestByUrl = {};
  for (var j = 0; j < scored.length; j++) {
    var c = scored[j];
    var existing = bestByUrl[c.url];
    if (!existing || c.score > existing.score) bestByUrl[c.url] = c;
  }

  var candidates = Object.keys(bestByUrl).map(function (u) { return bestByUrl[u]; });
  candidates.sort(function (a, b) { return b.score - a.score; });
  return candidates;
}

// Mirrors tracker/policy_discovery.py's confidence tiers (minus content
// validation, which only the backend can do -- it would require fetching
// the candidate page, which this quick client-side check deliberately
// doesn't do) so background.js can decide whether this result is good
// enough to skip the backend's full pipeline.
function ppfConfidenceFor(score) {
  if (score >= 1000) return "high";
  if (score >= 500) return "medium";
  if (score >= 1) return "low";
  return "low";
}

/**
 * Scan a document for its best privacy-policy link candidate.
 *
 * @param {string} baseUrl - the page's own URL, used to resolve relative hrefs.
 * @param {Document} doc - defaults to the global `document`.
 * @returns {{pageUrl:string, domain:string, bestUrl:string|null,
 *            bestText:string|null, confidence:string, candidates:Array}}
 */
function scanForPrivacyPolicy(baseUrl, doc) {
  doc = doc || document;
  baseUrl = baseUrl || doc.location.href;

  var candidates = ppfFindCandidates(doc, baseUrl);
  var best = candidates.length > 0 ? candidates[0] : null;

  return {
    pageUrl: baseUrl,
    domain: new URL(baseUrl).hostname,
    bestUrl: best ? best.url : null,
    bestText: best ? best.text : null,
    confidence: best ? ppfConfidenceFor(best.score) : "low",
    candidates: candidates.slice(0, 5).map(function (c) {
      return { url: c.url, text: c.text, score: c.score };
    }),
  };
}
