// Client-side privacy-policy URL discovery. Replaces the old server-side
// tracker/scraper.py + tracker/policy_discovery.py pipeline -- there's no
// server anymore, so this runs entirely in the extension.
//
// The policy page is very often on a *different origin* than the site
// itself (e.g. google.com's privacy policy lives at policies.google.com) --
// activeTab only grants access to the tab's own origin, which isn't enough
// to fetch that. manifest.json therefore declares broad host_permissions
// (http(s)://*/*) so the fetch below works regardless of which domain the
// discovered policy link points to.
//
// `browserAPI` is declared once, in storage.js (loaded first) -- these are
// classic <script> tags sharing one global scope, not modules.

const COMMON_POLICY_PATHS = [
  "/privacy",
  "/privacy-policy",
  "/privacy_policy",
  "/legal/privacy",
  "/legal/privacy-policy",
  "/policies/privacy",
  "/en/privacy",
  "/about/privacy",
];

const LINK_KEYWORDS = ["privacy policy", "privacy notice", "privacy"];

// Injected into the page via chrome.scripting.executeScript -- runs in the
// page's own context, so it can read the DOM directly with no CORS/fetch
// involved. Must be a plain, self-contained function (no closures over
// outer variables) since executeScript serializes it to run in the tab.
function scanPageForPolicyLink() {
  const keywords = ["privacy policy", "privacy notice", "privacy"];
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  let best = null;
  let bestScore = -1;
  for (const a of anchors) {
    const text = (a.textContent || "").trim().toLowerCase();
    const href = a.getAttribute("href") || "";
    let score = -1;
    for (let i = 0; i < keywords.length; i++) {
      if (text.includes(keywords[i])) score = Math.max(score, keywords.length - i);
    }
    if (score < 0 && /privacy/i.test(href)) score = 0;
    if (score > bestScore) {
      bestScore = score;
      best = a.href; // resolved absolute URL
    }
  }
  return best;
}

async function tryCommonPaths(origin) {
  for (const path of COMMON_POLICY_PATHS) {
    const candidate = origin + path;
    try {
      const resp = await fetch(candidate, { method: "GET", redirect: "follow" });
      if (resp.ok) {
        const text = await resp.text();
        // A very short response, or one that's just the homepage re-served
        // for every unknown path, isn't a real policy page.
        if (text.length > 500) return candidate;
      }
    } catch {
      // network error / CORS / doesn't exist -- just try the next path
    }
  }
  return null;
}

// Returns { policyUrl, text, error }. `text`/`error` are mutually exclusive
// when `policyUrl` is set: a URL can be found (DOM link or common path) but
// still fail to fetch (dead link, blocked by the site, etc.) -- that's a
// different, more useful failure than "no policy found at all", so it's
// reported separately rather than collapsed into the same null result.
async function discoverPolicy(tabId, tabUrl) {
  const origin = new URL(tabUrl).origin;

  let policyUrl = null;
  try {
    const [{ result }] = await browserAPI.scripting.executeScript({
      target: { tabId },
      func: scanPageForPolicyLink,
    });
    policyUrl = result || null;
  } catch {
    // scripting API not available (e.g. restricted page) -- fall through to paths
  }

  if (!policyUrl) {
    policyUrl = await tryCommonPaths(origin);
  }

  if (!policyUrl) {
    return { policyUrl: null, text: null, error: null };
  }

  try {
    const resp = await fetch(policyUrl);
    if (!resp.ok) {
      return { policyUrl, text: null, error: `Server responded ${resp.status} for ${policyUrl}` };
    }
    const html = await resp.text();
    const text = extractText(html);
    return { policyUrl, text, error: null };
  } catch (err) {
    return { policyUrl, text: null, error: err.message };
  }
}

// Minimal HTML-to-text: strip script/style, then tags. Good enough for the
// classifier/summary, which only need running prose, not exact structure.
function extractText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
  return (doc.body ? doc.body.textContent : doc.documentElement.textContent || "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

window.PolicyDiscovery = { discoverPolicy };
