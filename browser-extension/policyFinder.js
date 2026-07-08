/**
 * policyFinder.js
 *
 * Pure privacy-policy-link discovery logic. No chrome.* APIs are used
 * anywhere in this file -- it only reads the DOM (and URL) it's handed --
 * so it stays testable and reusable independent of the extension runtime,
 * and keeps "how do we find the link" completely separate from "what do we
 * do with it" (that part lives in content.js / background.js / popup.js).
 *
 * Injected into the page (via chrome.scripting.executeScript, see
 * background.js) immediately before content.js, which calls
 * scanForPrivacyPolicy() and reports the result back.
 */

// Phrases that make a link a *candidate* at all (checked against both the
// link's visible text and its href).
var PPF_KEYWORD_PHRASES = [
  "privacy policy",
  "privacy notice",
  "privacy statement",
  "data policy",
  "data protection",
  "legal/privacy",
  "terms/privacy",
  "privacy",
];

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

function ppfIsInFooter(el) {
  var node = el;
  while (node) {
    var tag = node.tagName ? node.tagName.toLowerCase() : "";
    if (tag === "footer") return true;
    var cls = (node.className && node.className.toString) ? node.className.toString() : "";
    var id = node.id || "";
    if (/footer/i.test(cls) || /footer/i.test(id)) return true;
    node = node.parentElement;
  }
  return false;
}

function ppfMatchesAnyPhrase(haystackLower) {
  for (var i = 0; i < PPF_KEYWORD_PHRASES.length; i++) {
    if (haystackLower.indexOf(PPF_KEYWORD_PHRASES[i]) !== -1) return true;
  }
  return false;
}

/**
 * Score a single <a> element. Returns null if it isn't privacy-related at
 * all. Higher score = better candidate. Tiers (highest to lowest, per the
 * product spec) are spaced far apart so they never blend into each other --
 * e.g. a tier-1 match always outranks any number of lower-tier signals.
 */
function ppfScoreLink(anchor, baseUrl, pageHostname) {
  var text = (anchor.textContent || "").trim();
  var hrefRaw = anchor.getAttribute("href") || "";
  if (!hrefRaw) return null;

  var absoluteUrl = ppfNormalizeUrl(hrefRaw, baseUrl);
  if (!absoluteUrl || !ppfIsHttpUrl(absoluteUrl)) return null;

  var textLower = text.toLowerCase();
  var hrefLower = hrefRaw.toLowerCase();

  if (!ppfMatchesAnyPhrase(textLower) && !ppfMatchesAnyPhrase(hrefLower)) {
    return null; // not a privacy-related link
  }

  var score = 1; // base score for being a candidate at all

  // Tier 1: exact link text match ("Privacy Policy")
  if (textLower === "privacy policy") score += 1000;

  // Tier 2: href contains "/privacy"
  if (hrefLower.indexOf("/privacy") !== -1) score += 500;

  // Tier 3: link text contains "privacy"
  if (textLower.indexOf("privacy") !== -1) score += 250;

  // Tier 4: footer links
  var inFooter = ppfIsInFooter(anchor);
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

  return { url: absoluteUrl, text: text, score: score, sameDomain: sameDomain, inFooter: inFooter };
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

/**
 * Scan a document for its best privacy-policy link candidate.
 *
 * @param {string} baseUrl - the page's own URL, used to resolve relative hrefs.
 * @param {Document} doc - defaults to the global `document`.
 * @returns {{pageUrl:string, domain:string, bestUrl:string|null,
 *            bestText:string|null, candidates:Array}}
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
    candidates: candidates.slice(0, 5).map(function (c) {
      return { url: c.url, text: c.text, score: c.score };
    }),
  };
}
