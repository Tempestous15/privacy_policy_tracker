// Note: the on-device AI explainer (webllm-client.js) relies on chrome.runtime
// service-worker WebGPU support and is Chrome/Chromium-only as of this
// writing -- see extension/README.md. `browserAPI` (Chrome/Firefox promise
// API shim) is declared once, in storage.js, loaded before this file.
//
// extUI: this file was restructured around two complaints about the old
// popup -- (1) every saved site rendered its FULL Disclosed+Observed
// breakdown inline, permanently, so the popup only ever got longer as you
// saved more sites, and (2) each render independently re-fetched ToS;DR
// and Tracker Radar data for the banner *and* for each channel's own
// section (2x each), which is wasted network/live-capture work for no
// visible benefit. Both are fixed the same way: fetch once per site,
// share the result across every consumer that needs it, and only render
// full detail when the user actually asks to see it (tab switch, row
// expand, or a collapsed <details> click) -- see individual function
// comments below for where each of those choices lives.
//
// llmUI: the on-device AI explainer used to be a plain button wedged
// between the two channels that, on click, re-read the raw policy text
// from scratch and dumped a 4-6 sentence paragraph -- slow, sometimes
// repetitive (small models ramble), and disconnected from the red flags
// the local classifier had already found. It's now built around the
// classifier/ToS;DR/Observed results this file already computes: the
// model's job is just to explain those already-verified findings in
// plain English (see webllm/client-src.js), not re-derive them, and it's
// moved to right after the at-a-glance badges since that's the fastest
// "just tell me simply" entry point into the popup.
//
// llmUI round 2 (user feedback: button didn't look clickable, and the
// explanation itself was too vague to be useful): the button now uses
// the standard filled-button look instead of the muted text-link style
// (see addAiExplainBlock), and the model output gained a fourth line --
// "Protect yourself" -- with a worked example in the prompt (see
// webllm/client-src.js) steering the small model toward concrete,
// specific advice instead of generic "be careful" text.

const els = {
  currentTabHost: document.getElementById("current-tab-host"),
  siteFavicon: document.getElementById("site-favicon"),
  checkBtn: document.getElementById("check-btn"),
  lookupResult: document.getElementById("lookup-result"),
  savedList: document.getElementById("saved-list"),
  savedCount: document.getElementById("saved-count"),
  globalError: document.getElementById("global-error"),
  tabs: document.querySelectorAll(".tab"),
  tabPanels: document.querySelectorAll(".tab-panel"),
};

const RED_FLAG_SEVERITY_ICON = { high: "⚠️", medium: "🟡", low: "ℹ️" };

function riskBadge(riskLevel) {
  const labels = {
    low: ["risk-low", "🟢 Low risk"],
    medium: ["risk-medium", "🟡 Medium risk"],
    high: ["risk-high", "🔴 High risk"],
  };
  const [cls, label] = labels[riskLevel] || ["risk-unknown", "⚪ Risk unknown"];
  const span = document.createElement("span");
  span.className = `risk-badge ${cls}`;
  span.textContent = label;
  return span;
}

// ---------- Tabs ----------
// "This Site" and "Saved" used to be two cards stacked in one endless
// scroll (see popup.html's header comment). Switching is plain show/hide
// -- no re-render on switch, so toggling back and forth is instant and
// never re-fetches anything already on screen.
function initTabs() {
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      els.tabs.forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      els.tabPanels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
    });
  });
}

// ---------- Disclosed: local classifier ----------
// Takes an already-computed analysis (see renderSiteResult) rather than
// running RedFlagsEngine itself -- it's a cheap local regex scan, but
// there's no reason to run it twice when the glance row (below) already
// needs the same result.
function renderClassifierResult(container, analysis) {
  container.innerHTML = "";
  if (!analysis) {
    container.appendChild(riskBadge("unknown"));
    return;
  }

  container.appendChild(riskBadge(analysis.riskLevel));

  if (!analysis.categories.length) {
    const p = document.createElement("p");
    p.className = "summary-text";
    p.textContent = "No red flags detected by the automated scan.";
    container.appendChild(p);
    return;
  }

  // extUI: collapsed by default (was force-opened via `details.open =
  // true`) -- the single biggest contributor to "wall of text" on a site
  // with several flagged categories. A one-line teaser naming the top
  // (highest-severity, first-matched) flag stays visible even collapsed,
  // so nothing important is hidden, just not force-expanded.
  const top = analysis.categories[0];
  const teaser = document.createElement("p");
  teaser.className = "detail-teaser";
  teaser.textContent =
    analysis.categories.length === 1
      ? `Top concern: ${top.label}`
      : `Top concern: ${top.label} (+${analysis.categories.length - 1} more)`;
  container.appendChild(teaser);

  const details = document.createElement("details");
  details.className = "summary-section red-flags";
  const summaryEl = document.createElement("summary");
  summaryEl.textContent = `🚩 All red flags (${analysis.categories.length})`;
  details.appendChild(summaryEl);
  const ul = document.createElement("ul");
  for (const cat of analysis.categories) {
    const li = document.createElement("li");
    const icon = RED_FLAG_SEVERITY_ICON[cat.severity] || "ℹ️";
    li.textContent = `${icon} ${cat.label}` + (cat.matches.length ? `: “${cat.matches[0]}”` : "");
    ul.appendChild(li);
  }
  details.appendChild(ul);
  container.appendChild(details);
}

const TOSDR_SEVERITY_ICON = { good: "✅", blocker: "🚫", bad: "⚠️", neutral: "ℹ️" };

// ---------- Disclosed: ToS;DR (supplementary) ----------
// Takes the already-settled Promise.allSettled result for the ToS;DR
// lookup (see renderSiteResult) instead of fetching itself -- same
// dedup rationale as renderClassifierResult.
function renderTosdrResult(container, tosdrSettled) {
  container.innerHTML = "";
  if (tosdrSettled.status === "rejected") {
    container.innerHTML = `<p class="muted">ToS;DR lookup unavailable: ${tosdrSettled.reason && tosdrSettled.reason.message}</p>`;
    return;
  }
  const result = tosdrSettled.value;
  if (!result) {
    container.innerHTML = '<p class="muted">No ToS;DR review found for this site.</p>';
    return;
  }
  const badge = document.createElement("span");
  badge.className = "risk-badge tosdr-badge";
  badge.textContent = `ToS;DR grade: ${result.rating}`;
  container.appendChild(badge);

  if (result.points.length) {
    const details = document.createElement("details");
    details.className = "summary-section";
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = `${result.points.length} ToS;DR points`;
    details.appendChild(summaryEl);
    const ul = document.createElement("ul");
    for (const point of result.points.slice(0, 6)) {
      const li = document.createElement("li");
      li.textContent = `${TOSDR_SEVERITY_ICON[point.severity] || "ℹ️"} ${point.title}`;
      ul.appendChild(li);
    }
    details.appendChild(ul);
    container.appendChild(details);
  }
}

// "Observed" channel -- what's technically detectable happening on this
// site (third-party trackers, categories, fingerprinting), independent of
// anything the privacy policy claims. See tracker_radar_client.js: this is
// a bundled, point-in-time snapshot for a curated site list, not a live
// scan of the current tab -- the copy below says "detected in a scan on
// <date>", deliberately never "what this site is doing right now" or
// "what this site does with your data" (we can't observe that; only
// technically-detectable network behavior). Never blocks the Disclosed
// section: failures/misses here are shown inline only.
// Observed round 3 (user feedback: "third-party domain," "fingerprinting,"
// and "high-risk" aren't self-explanatory, but spelling them out in the
// always-visible text would bring back the "too much text" problem for
// anyone who already knows them). This round (glossaryUI) replaces that
// round's native <abbr title> (a bare browser tooltip -- no styling, no
// icon, one line max) with the shared GlossaryTooltip component: content
// now lives once in glossary.js, not scattered across this file as
// inline strings, and the same trigger/tooltip renders consistently
// everywhere a term appears -- see glossary_tooltip.js.
//
// Maps a raw Tracker Radar category name (the vocabulary
// tracker_category_glossary.js's CATEGORY_EXPLANATIONS is keyed on) to a
// glossary.js entry key. Deliberately partial: categories left unmapped
// here (Advertising, Analytics, Social Network, Ad Fraud, and the other
// plain/self-explanatory ones) still get their plain-English detail
// sentence from CATEGORY_EXPLANATIONS same as before, just without an
// extra hover chip -- see the branch summary for why those were judged
// not confusing enough to need one.
const CATEGORY_TO_GLOSSARY_KEY = {
  "Session Replay": "sessionReplay",
  "Obscure Ownership": "obscureOwnership",
  "Unknown High Risk Behavior": "unknownHighRisk",
  "Tag Manager": "tagManager",
  "Action Pixels": "trackingPixel",
  "Audience Measurement": "audienceMeasurement",
  "Federated Login": "federatedLogin",
  "SSO": "federatedLogin",
  "CDN": "cdn",
  "Consent Management Platform": "consentManagementPlatform",
};

// Observed round 2 (user feedback: too much text at once, not explainable
// enough): this used to concatenate EVERY matched category's full-sentence
// explanation plus the fingerprinting note into one long string per
// tracker -- for a tracker matched to 2-3 categories, that's 2-3 full
// sentences per bullet, times however many trackers were found. Now picks
// ONE explanation per tracker: the fingerprinting note if it's heavy (the
// most specific, most actionable signal), otherwise just the first
// matched category. Enough to say why it's listed, not everything Tracker
// Radar knows about it.
function _explainMatchedDomain(entry) {
  const label = entry.owner ? `${entry.domain} (${entry.owner})` : entry.domain;
  const categories = entry.categories || [];
  let detail = null;
  let glossaryKey = null;
  if (entry.fingerprinting >= 2 && window.TrackerCategoryGlossary) {
    detail = TrackerCategoryGlossary.explainFingerprinting(entry.fingerprinting);
    // No glossary chip here -- the Fingerprinting & High-Risk card's own
    // label already carries the "Fingerprinting" hover (see
    // _buildTrackerCard); repeating it on every heavy-fingerprinting
    // tracker's line underneath would be the same tooltip twice in one
    // card.
  }
  if (!detail && categories.length && window.TrackerCategoryGlossary) {
    detail = TrackerCategoryGlossary.explainCategory(categories[0]);
    glossaryKey = CATEGORY_TO_GLOSSARY_KEY[categories[0]] || null;
  }
  return { label, detail, glossaryKey };
}

// observedUI (design spec: "one card per tracker category, expandable to
// reveal individual trackers"). Round 4 (see git history) replaced three
// always-collapsed bucket toggles with one chip row + one combined
// toggle -- fewer decision points, but it also meant Advertising,
// Analytics, and Social all got flattened into a single "ad & tracking"
// chip, which isn't granular enough for the category-card layout the
// design spec asks for. This round keeps round 4's actual insight (don't
// force more than one decision per group) but gives each category its
// own small card -- collapsed by default, same as before, so "nothing
// expanded" is still the resting state.
//
// Card categories are a display-only regrouping of the same matched-
// domain data tracker_radar_score.js already computed (categories[],
// fingerprinting) -- this does not change scoring/weights, just which
// card a tracker is shown under. Priority mirrors classifyTracker()'s
// fingerprinting-first rule, but keeps Advertising/Analytics/Social as
// separate cards instead of one merged "ad_tracking" bucket. Keep this
// in sync by hand with tracker_radar_score.js's category sets if those
// ever change -- same manual-sync caveat that file already carries for
// tracker_radar/config.py.
const CARD_FORCE_FINGERPRINT_CATEGORIES = new Set([
  "Session Replay", "Malware", "Unknown High Risk Behavior", "Obscure Ownership",
]);
const CARD_ADVERTISING_CATEGORIES = new Set(["Advertising", "Ad Motivated Tracking", "Ad Fraud"]);
const CARD_ANALYTICS_CATEGORIES = new Set([
  "Analytics", "Audience Measurement", "Third-Party Analytics Marketing", "Tag Manager", "Action Pixels",
]);
const CARD_SOCIAL_CATEGORIES = new Set([
  "Social Network", "Social - Share", "Social - Comment", "Federated Login", "SSO",
]);

// Card definitions in fixed high-to-low severity display order. Severity
// reuses the same three-value scale (high/medium/low) as the risk badges
// and old chips -- one consistent color language, not a new one just for
// cards (see popup.css's .tracker-card--high/medium/low).
const CARD_DEFS = {
  fingerprinting: { label: "Fingerprinting & High-Risk", icon: "⚠️", severity: "high" },
  advertising: { label: "Advertising", icon: "🎯", severity: "medium" },
  analytics: { label: "Analytics", icon: "📊", severity: "medium" },
  social: { label: "Social", icon: "👥", severity: "medium" },
  infra: { label: "Infrastructure & Other", icon: "🔧", severity: "low" },
};
const CARD_ORDER = ["fingerprinting", "advertising", "analytics", "social", "infra"];

function _cardKeyForEntry(entry) {
  const categories = entry.categories || [];
  if ((entry.fingerprinting || 0) >= 2 || categories.some((c) => CARD_FORCE_FINGERPRINT_CATEGORIES.has(c))) {
    return "fingerprinting";
  }
  if (categories.some((c) => CARD_ADVERTISING_CATEGORIES.has(c))) return "advertising";
  if (categories.some((c) => CARD_ANALYTICS_CATEGORIES.has(c))) return "analytics";
  if (categories.some((c) => CARD_SOCIAL_CATEGORIES.has(c))) return "social";
  return "infra";
}

// Groups matched trackers into (at most 5) category cards, in the fixed
// severity order above, omitting any category with nothing in it -- an
// empty card would just be clutter with a "(0)" next to it.
function _groupByCard(matchedDomains) {
  const buckets = { fingerprinting: [], advertising: [], analytics: [], social: [], infra: [] };
  for (const entry of matchedDomains) buckets[_cardKeyForEntry(entry)].push(entry);
  return CARD_ORDER.map((key) => ({ key, def: CARD_DEFS[key], entries: buckets[key] })).filter(
    (group) => group.entries.length
  );
}

// One collapsed-by-default card per category -- "Advertising (4)" expands
// to the individual trackers found within it (design spec's card
// requirement). Native <details>/<summary>, same pattern as the saved-
// site rows and the old single toggle this replaces.
function _buildTrackerCard(group) {
  const details = document.createElement("details");
  details.className = `tracker-card tracker-card--${group.def.severity}`;

  const summaryEl = document.createElement("summary");
  summaryEl.className = "tracker-card-summary";
  const label = document.createElement("span");
  label.className = "tracker-card-label";
  // The Fingerprinting & High-Risk card's label carries the same
  // GlossaryTooltip used everywhere else a jargon term appears -- one
  // consistent hover-to-learn component, not a one-off for card labels.
  if (group.key === "fingerprinting") {
    label.appendChild(document.createTextNode(`${group.def.icon} `));
    label.appendChild(GlossaryTooltip.wrapTerm("Fingerprinting", "fingerprinting"));
    label.appendChild(document.createTextNode(" & High-Risk"));
  } else {
    label.textContent = `${group.def.icon} ${group.def.label}`;
  }
  const count = document.createElement("span");
  count.className = "tracker-card-count";
  count.textContent = String(group.entries.length);
  summaryEl.appendChild(label);
  summaryEl.appendChild(count);
  details.appendChild(summaryEl);

  const ul = document.createElement("ul");
  ul.className = "tracker-card-list";
  for (const entry of group.entries) {
    const { label: entryLabel, detail, glossaryKey } = _explainMatchedDomain(entry);
    const li = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = entryLabel;
    li.appendChild(strong);
    if (detail) li.appendChild(document.createTextNode(" -- " + detail));
    // Folds the raw category name in parenthetically, hoverable, right
    // after its already-plain-English explanation -- same "plain
    // English first, jargon term optional and hoverable" pattern the
    // summary sentence below uses for "third-party". Only categories
    // mapped in CATEGORY_TO_GLOSSARY_KEY get this; the self-explanatory
    // ones (Advertising, Analytics, ...) just keep their plain sentence.
    if (glossaryKey) {
      const entryTerm = window.Glossary.getGlossaryTerm(glossaryKey);
      if (entryTerm) {
        li.appendChild(document.createTextNode(" ("));
        li.appendChild(GlossaryTooltip.wrapTerm(entryTerm.term, glossaryKey));
        li.appendChild(document.createTextNode(")"));
      }
    }
    ul.appendChild(li);
  }
  details.appendChild(ul);
  return details;
}

// The "top few trackers" line shown directly under the Observed badge,
// before any card is expanded (design spec's at-a-glance requirement).
// Groups are already in severity order, so flattening them keeps the
// most-notable trackers first.
function _topTrackersLine(groups, max = 3) {
  const flat = [];
  for (const group of groups) for (const entry of group.entries) flat.push(entry);
  if (!flat.length) return null;
  const names = flat.slice(0, max).map((entry) => _explainMatchedDomain(entry).label);
  const extra = flat.length - names.length;
  return extra > 0 ? `${names.join(", ")}, +${extra} more` : names.join(", ");
}

// ---------- actionUI: "Protect me from this site" ----------
// Bulk remediation action for the Observed tab. Gated entirely behind an
// explicit button click -- nothing here runs on render, no tracker is
// touched and no opt-out link is followed until the user clicks something
// themselves (same reasoning as the product's no-data-collection stance:
// the user stays in control of anything leaving their device). Uses
// window.TrackerRemediation (tracker_remediation.js) for classification --
// this file only renders; it never re-derives which tier a tracker is in.
//
// IMPORTANT: manifest.json does not request the declarativeNetRequest
// permission (see actionUI branch notes), so "Auto-fix" cannot actually
// block network requests yet -- it is rendered honestly as a preview of
// what a real block would cover, not a live block. Adding real blocking
// later only requires wiring an actual declarativeNetRequest call in here;
// the tier classification and UI already reflect the real breakdown.
function _uniqueOptOutLinks(flagAndLinkEntries) {
  const byUrl = new Map();
  for (const entry of flagAndLinkEntries) {
    const optOut = entry.optOut || {};
    const key = optOut.url || "unknown";
    if (!byUrl.has(key)) {
      byUrl.set(key, { label: optOut.label || "Opt-out page", url: optOut.url, entries: [] });
    }
    byUrl.get(key).entries.push(entry);
  }
  return Array.from(byUrl.values());
}

function _buildProtectResultTier(iconLabel, className, countLabel) {
  const wrap = document.createElement("div");
  wrap.className = `protect-tier ${className}`;
  const header = document.createElement("p");
  header.className = "protect-tier-header";
  header.textContent = `${iconLabel} — ${countLabel}`;
  wrap.appendChild(header);
  return wrap;
}

function _renderProtectResults(resultsSlot, matchedDomains) {
  const { items, groups } = window.TrackerRemediation.classifySite(matchedDomains);
  resultsSlot.innerHTML = "";

  const summary = document.createElement("p");
  summary.className = "protect-summary";
  summary.textContent =
    `${groups.autoFix.length} tracker${groups.autoFix.length === 1 ? "" : "s"} blocked (preview), ` +
    `${groups.flagAndLink.length} opt-out link${groups.flagAndLink.length === 1 ? "" : "s"} available, ` +
    `${groups.flagAndExplain.length} couldn't be blocked`;
  resultsSlot.appendChild(summary);

  if (groups.autoFix.length) {
    const tier = _buildProtectResultTier("🛡️ Blocked (preview)", "protect-tier--autofix", String(groups.autoFix.length));
    const ul = document.createElement("ul");
    ul.className = "protect-tier-list";
    for (const entry of groups.autoFix) {
      const { label } = _explainMatchedDomain(entry);
      const li = document.createElement("li");
      li.textContent = label;
      ul.appendChild(li);
    }
    tier.appendChild(ul);
    const note = document.createElement("p");
    note.className = "muted protect-tier-note";
    note.textContent =
      "Preview only -- this extension doesn't yet have permission to actually block requests, so nothing was sent or blocked on your behalf.";
    tier.appendChild(note);
    resultsSlot.appendChild(tier);
  }

  if (groups.flagAndLink.length) {
    const tier = _buildProtectResultTier("🔗 Opt-out available", "protect-tier--link", String(groups.flagAndLink.length));
    const ul = document.createElement("ul");
    ul.className = "protect-tier-list";
    for (const group of _uniqueOptOutLinks(groups.flagAndLink)) {
      const li = document.createElement("li");
      const names = group.entries.map((e) => _explainMatchedDomain(e).label).join(", ");
      li.appendChild(document.createTextNode(`${names} -- `));
      const link = document.createElement("a");
      link.href = group.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "protect-optout-link";
      link.textContent = group.label;
      li.appendChild(link);
      ul.appendChild(li);
    }
    tier.appendChild(ul);
    const note = document.createElement("p");
    note.className = "muted protect-tier-note";
    note.textContent = "Opens the company's own opt-out page in a new tab -- nothing is sent unless you act on that page yourself.";
    tier.appendChild(note);
    resultsSlot.appendChild(tier);
  }

  if (groups.flagAndExplain.length) {
    const tier = _buildProtectResultTier("ℹ️ Couldn't be blocked", "protect-tier--explain", String(groups.flagAndExplain.length));
    const ul = document.createElement("ul");
    ul.className = "protect-tier-list";
    for (const entry of groups.flagAndExplain) {
      const { label } = _explainMatchedDomain(entry);
      const li = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = label;
      li.appendChild(strong);
      li.appendChild(document.createTextNode(" -- " + entry.reason));
      ul.appendChild(li);
    }
    tier.appendChild(ul);
    resultsSlot.appendChild(tier);
  }
}

// Builds the whole card: button + (once clicked) the tiered results below
// it. Returns null when there's nothing to act on -- renderObservedResult
// already gives a clean site its own positive empty state before this is
// ever reached, so in practice this always has at least one tracker.
function _buildProtectMeSection(matchedDomains) {
  if (!matchedDomains || !matchedDomains.length) return null;
  if (!window.TrackerRemediation) return null; // script not loaded -- fail quiet, not broken

  const section = document.createElement("div");
  section.className = "protect-section";

  const intro = document.createElement("p");
  intro.className = "protect-intro";
  intro.textContent = "See what can actually be done about the trackers found on this site.";
  section.appendChild(intro);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "protect-btn";
  button.textContent = "🛡️ Protect me from this site";
  section.appendChild(button);

  const resultsSlot = document.createElement("div");
  resultsSlot.className = "protect-results hidden";
  section.appendChild(resultsSlot);

  button.addEventListener("click", () => {
    _renderProtectResults(resultsSlot, matchedDomains);
    resultsSlot.classList.remove("hidden");
    button.textContent = "🛡️ Re-check this site";
  });

  return section;
}

// ---------- Observed: Tracker Radar ----------
// Takes the already-settled lookup result (see renderSiteResult). If
// `glanceBadgeSlot` is given, also fills in the glance row's Observed
// cell once resolved -- the glance row renders its skeleton immediately
// (classifier badge only, since that's synchronous) and this is what
// completes it, without a second lookup.
function renderObservedResult(container, observedSettled, glanceBadgeSlot) {
  container.innerHTML = "";
  const profile = observedSettled.status === "fulfilled" ? observedSettled.value : null;

  if (glanceBadgeSlot) {
    glanceBadgeSlot.innerHTML = "";
    const level = profile ? SiteRiskModel.observedLevelFromRiskScore(profile.riskScore) : null;
    glanceBadgeSlot.appendChild(riskBadge(level || "unknown"));
  }

  if (observedSettled.status === "rejected") {
    container.innerHTML = `<p class="muted">Tracker Radar lookup unavailable: ${observedSettled.reason && observedSettled.reason.message}</p>`;
    return;
  }
  if (!profile) {
    container.innerHTML =
      "<p class=\"muted\">This site is not in our tracker scan yet -- not in the bundled snapshot, and either no tabId was available or nothing was captured live for this tab yet (try reloading the page, then checking again).</p>";
    return;
  }

  // At-a-glance: severity badge first (color + icon + text label, never
  // color alone -- riskBadge already does this). Design spec's
  // accessibility note.
  const level = SiteRiskModel.observedLevelFromRiskScore(profile.riskScore);
  container.appendChild(riskBadge(level));

  const matchedDomains = profile.matchedDomains || [];
  const hasUnmatched = !!(profile.unmatchedDomains && profile.unmatchedDomains.length);
  const isLive = typeof profile.snapshotSource === "string" && profile.snapshotSource.startsWith("live capture");
  const capturedText = isLive
    ? "Detected live from this tab's current page load."
    : `Detected in a scan on ${profile.capturedAt ? new Date(profile.capturedAt).toLocaleDateString() : "an earlier scan"}.`;

  // observedUI (design spec's empty/good state): a genuinely clean result
  // -- nothing matched, nothing outstanding to even ask "what's this?"
  // about -- gets its own distinct, positively-framed state instead of
  // the card layout rendering with zero cards in it. An empty card list
  // would read like a broken/error state, not a good result; this reads
  // as a reward instead. Deliberately a strict threshold (trackerCount
  // === 0, not "very few") so it's predictable rather than fuzzy -- see
  // branch summary for the reasoning.
  if (profile.trackerCount === 0 && !hasUnmatched) {
    const empty = document.createElement("div");
    empty.className = "empty-state observed-good-state";
    empty.innerHTML =
      '<div class="empty-icon" aria-hidden="true">✅</div><p>No trackers detected on this site.</p>';
    container.appendChild(empty);
    const capturedNote = document.createElement("p");
    capturedNote.className = "muted observed-captured-note";
    capturedNote.textContent = capturedText;
    container.appendChild(capturedNote);
    return;
  }

  const groups = _groupByCard(matchedDomains);

  // Top few trackers, directly below the badge, visible with nothing
  // expanded -- design spec's at-a-glance requirement.
  const topLine = _topTrackersLine(groups);
  if (topLine) {
    const top = document.createElement("p");
    top.className = "observed-top-trackers";
    top.textContent = topLine;
    container.appendChild(top);
  }

  // Plain-English first: the sentence itself explains the concept ("other
  // companies' servers... in the background") without requiring anyone to
  // already know the term "third-party." The term is folded in
  // parenthetically, hoverable via the shared GlossaryTooltip for anyone
  // who wants the sharper definition or just wants to learn the
  // vocabulary.
  const summary = document.createElement("p");
  summary.className = "summary-text";
  if (profile.trackerCount === 0) {
    summary.textContent = "Nothing from another company loaded quietly in the background on this page.";
  } else {
    summary.appendChild(
      document.createTextNode(
        `${profile.trackerCount} other compan${profile.distinctOwnerCount === 1 ? "y's" : "ies'"} servers ` +
          `(often called `
      )
    );
    summary.appendChild(GlossaryTooltip.wrapTerm("third-party", "thirdParty"));
    summary.appendChild(
      document.createTextNode(` domains) quietly loaded in the background -- separate from what the site's own policy says.`)
    );
  }
  container.appendChild(summary);

  // actionUI: bulk remediation action, above the per-category cards so
  // it's visible without expanding anything -- design spec's placement
  // ("using the established visual system... cards, severity badges,
  // tabs"). Nothing here runs until the user clicks the button.
  const protectSection = _buildProtectMeSection(matchedDomains);
  if (protectSection) container.appendChild(protectSection);

  // One card per tracker category, collapsed by default -- design spec's
  // card layout. See _groupByCard/_buildTrackerCard above.
  if (groups.length) {
    const cardList = document.createElement("div");
    cardList.className = "tracker-card-list-wrap";
    for (const group of groups) cardList.appendChild(_buildTrackerCard(group));
    container.appendChild(cardList);
  }

  if (hasUnmatched) {
    const details = document.createElement("details");
    details.className = "tracker-card tracker-card--unknown";
    const summaryEl = document.createElement("summary");
    summaryEl.className = "tracker-card-summary";
    const label = document.createElement("span");
    label.className = "tracker-card-label";
    label.textContent = "❔ Not yet in our tracker index";
    const count = document.createElement("span");
    count.className = "tracker-card-count";
    count.textContent = String(profile.unmatchedDomains.length);
    summaryEl.appendChild(label);
    summaryEl.appendChild(count);
    details.appendChild(summaryEl);
    if (profile.coverage && profile.coverage.riskScoreWithheld) {
      const note = document.createElement("p");
      note.className = "muted tracker-card-note";
      note.textContent =
        "Not enough of what was contacted matched our tracker index to score confidently -- this list is " +
        "everything real that was seen, even though we cannot yet say what most of it does.";
      details.appendChild(note);
    }
    const ul = document.createElement("ul");
    ul.className = "tracker-card-list";
    for (const d of profile.unmatchedDomains) {
      const li = document.createElement("li");
      li.textContent = d;
      ul.appendChild(li);
    }
    details.appendChild(ul);
    container.appendChild(details);
  }

  const capturedNote = document.createElement("p");
  capturedNote.className = "muted observed-captured-note";
  capturedNote.textContent = capturedText;
  container.appendChild(capturedNote);
}

// ---------- At-a-glance dual badge row ----------
// New in extUI: both channels' badges side by side, above either
// section's detail -- an instant read without scrolling. Still two
// distinct badges (Disclosed = local classifier, Observed = Tracker
// Radar), never combined into one value -- see risk_model.js's "never
// blend" rule. Returns the Observed cell so the caller can fill it in
// once that lookup resolves (see renderObservedResult's glanceBadgeSlot
// param) -- the classifier badge renders immediately since it's
// synchronous.
function renderGlanceRow(container, classifierAnalysis) {
  const row = document.createElement("div");
  row.className = "glance-row";

  const disclosedCol = document.createElement("div");
  disclosedCol.className = "glance-col";
  const disclosedLabel = document.createElement("span");
  disclosedLabel.className = "glance-label";
  disclosedLabel.textContent = "Disclosed";
  disclosedCol.appendChild(disclosedLabel);
  disclosedCol.appendChild(riskBadge(classifierAnalysis ? classifierAnalysis.riskLevel : "unknown"));

  const observedCol = document.createElement("div");
  observedCol.className = "glance-col";
  const observedLabel = document.createElement("span");
  observedLabel.className = "glance-label";
  observedLabel.textContent = "Observed";
  observedCol.appendChild(observedLabel);
  const observedBadgeSlot = document.createElement("span");
  observedBadgeSlot.appendChild(riskBadge(null)); // placeholder until the shared lookup resolves
  observedCol.appendChild(observedBadgeSlot);

  row.appendChild(disclosedCol);
  row.appendChild(observedCol);
  container.appendChild(row);
  return observedBadgeSlot;
}

// Cross-channel comparison -- a pure computation from already-settled
// results (see renderSiteResult), not an independent fetch. It used to
// call TosdrClient/TrackerRadarClient a second time for the same domain
// the section below it was already fetching for; sharing one
// Promise.allSettled result removes that duplication entirely. Split out
// from rendering (below) because observedUI needs the same comparison in
// two places: the banner inside the Observed tab, and the small flag on
// the Observed tab button itself (see setObservedTabFlag) -- computing it
// twice with two separate SiteRiskModel calls would be easy to let drift.
function computeChannelDisagreement(tosdrSettled, observedSettled) {
  const tosdr = tosdrSettled.status === "fulfilled" ? tosdrSettled.value : null;
  const observed = observedSettled.status === "fulfilled" ? observedSettled.value : null;
  if (!tosdr || !observed) return null; // nothing to compare -- stay quiet

  const disclosedLevel = SiteRiskModel.disclosedLevelFromTosdrRating(tosdr.rating);
  const observedLevel = SiteRiskModel.observedLevelFromRiskScore(observed.riskScore);
  const comparison = SiteRiskModel.compareChannels(disclosedLevel, observedLevel);
  if (!comparison.comparable || comparison.agree) return null;
  return comparison;
}

// Renders the full disagreement explanation inside the Observed tab
// panel. Not shown at all when `comparison` is null (nothing to compare,
// or the two channels roughly agree).
function renderChannelAgreementBanner(container, comparison) {
  if (!comparison) return;
  const banner = document.createElement("div");
  banner.className = "channel-disagreement-banner";
  const title = document.createElement("strong");
  title.textContent = "Disclosed and observed signals disagree";
  const note = document.createElement("p");
  note.textContent = comparison.note;
  banner.appendChild(title);
  banner.appendChild(note);
  container.appendChild(banner);
}

// observedUI (design spec's cross-tab disagreement signal): a small dot
// on the Observed tab button is what lets a user notice a disagreement
// while still looking at the Disclosed tab, without switching. Kept
// deliberately subtle -- a dot plus a native title tooltip plus one
// screen-reader-only word, not a second loud banner competing with the
// fuller one already rendered inside the Observed tab (see
// renderChannelAgreementBanner just above). Hidden entirely when there's
// nothing to flag, never left visible-but-empty.
function setObservedTabFlag(flagDot, comparison) {
  flagDot.classList.toggle("hidden", !comparison);
}

// observedUI: Disclosed and Observed are now two tabs within the popup
// instead of two stacked "channel-heading" sections (see popup.html's
// header comment and renderSiteResult below) -- built fresh per call,
// not a singleton queried by id like the top-level "This Site"/"Saved"
// tabs (initTabs), because more than one of these can exist on screen at
// once: the current site's check result, plus any expanded Saved rows.
// Each instance's tab state lives in its own closure instead of a shared
// element.
function buildChannelTabs(container) {
  const nav = document.createElement("div");
  nav.className = "channel-tabs";
  nav.setAttribute("role", "tablist");

  const disclosedBtn = document.createElement("button");
  disclosedBtn.type = "button";
  disclosedBtn.className = "channel-tab active";
  disclosedBtn.setAttribute("role", "tab");
  disclosedBtn.setAttribute("aria-selected", "true");
  disclosedBtn.textContent = "Disclosed";

  const observedBtn = document.createElement("button");
  observedBtn.type = "button";
  observedBtn.className = "channel-tab";
  observedBtn.setAttribute("role", "tab");
  observedBtn.setAttribute("aria-selected", "false");
  observedBtn.appendChild(document.createTextNode("Observed"));
  const flagDot = document.createElement("span");
  flagDot.className = "channel-tab-flag hidden";
  flagDot.title = "Disclosed and observed signals disagree";
  const flagDotSrText = document.createElement("span");
  flagDotSrText.className = "sr-only";
  flagDotSrText.textContent = " (signals disagree)";
  flagDot.appendChild(flagDotSrText);
  observedBtn.appendChild(flagDot);

  nav.appendChild(disclosedBtn);
  nav.appendChild(observedBtn);

  const disclosedPanel = document.createElement("div");
  disclosedPanel.className = "channel-panel active";
  disclosedPanel.setAttribute("role", "tabpanel");

  const observedPanel = document.createElement("div");
  observedPanel.className = "channel-panel";
  observedPanel.setAttribute("role", "tabpanel");

  function activate(btn, panel) {
    for (const [b, p] of [[disclosedBtn, disclosedPanel], [observedBtn, observedPanel]]) {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-selected", b === btn ? "true" : "false");
      p.classList.toggle("active", p === panel);
    }
  }
  disclosedBtn.addEventListener("click", () => activate(disclosedBtn, disclosedPanel));
  observedBtn.addEventListener("click", () => activate(observedBtn, observedPanel));

  container.appendChild(nav);
  container.appendChild(disclosedPanel);
  container.appendChild(observedPanel);

  return { disclosedPanel, observedPanel, observedTabBtn: observedBtn, flagDot };
}

// ---------- AI explainer: findings context builder ----------
// Turns the classifier's already-verified categories (plus ToS;DR/Tracker
// Radar results, once the shared lookup resolves) into a short plain-text
// bullet list for the local model to explain -- see
// webllm/client-src.js's FINDINGS_PROMPT_TEMPLATE. This is the core of the
// llmUI change: the model's job shifts from "read the raw policy and find
// issues" (extraction -- unreliable at this model size) to "explain these
// already-verified facts in plain English" (paraphrasing -- much more
// reliable). Capped at a handful of items per source; nobody needs all 10
// possible red-flag categories spelled out to get the gist, and a shorter
// prompt keeps a small model's output shorter and more focused too.
function buildFindingsContext(analysis, tosdrResult, observedResult) {
  const lines = [];

  if (analysis && analysis.categories.length) {
    for (const cat of analysis.categories.slice(0, 4)) {
      lines.push(`- ${cat.label} (found in the policy text, ${cat.severity} severity)`);
    }
  }

  if (tosdrResult && tosdrResult.rating) {
    lines.push(`- ToS;DR community rating: ${tosdrResult.rating}`);
    for (const point of (tosdrResult.points || []).slice(0, 2)) {
      lines.push(`- ToS;DR: ${point.title}`);
    }
  }

  if (observedResult && observedResult.trackerCount > 0) {
    const companyWord = observedResult.distinctOwnerCount === 1 ? "company" : "companies";
    lines.push(
      `- ${observedResult.trackerCount} third-party tracker(s) actually detected loading on this site ` +
      `(independent of what the policy says), across ${observedResult.distinctOwnerCount} ${companyWord}`
    );
  }

  return lines.length ? lines.join("\n") : null;
}

// Leniently pulls WHAT/CONCERNS/PROTECT YOURSELF/BOTTOM LINE lines out of
// the model's raw reply. Small local models don't always follow
// formatting instructions exactly, so this tolerates a leading
// "-"/"*"/number, extra asterisks (markdown-style bold), and any-case
// labels -- and returns null if it can't find a single labelled line, so
// the caller falls back to showing the raw text (bounded) instead of
// empty rows.
function parseAiSummary(raw) {
  if (!raw) return null;
  const grab = (label) => {
    const re = new RegExp(`(?:^|\\n)\\s*[-*\\d.]*\\s*\\**\\s*${label}\\s*\\**\\s*:\\s*(.+)`, "i");
    const m = raw.match(re);
    if (!m) return null;
    return m[1].trim().replace(/\*+$/, "").trim();
  };
  const what = grab("WHAT");
  const concerns = grab("CONCERNS?");
  const protectYourself = grab("PROTECT\\s*YOURSELF");
  const bottomLine = grab("BOTTOM[\\s-]*LINE");
  if (!what && !concerns && !protectYourself && !bottomLine) return null;
  return { what, concerns, protectYourself, bottomLine };
}

// Truncates on a sentence boundary rather than mid-word/mid-clause --
// prefers the last ". "/"! "/"? " at or before `max` chars, falling back
// to a hard cut only if no sentence boundary exists that far into the
// text at all. Also acts as a safety net if the model's raw reply itself
// got cut off mid-sentence by hitting its token budget (see
// webllm/client-src.js's max_tokens) -- either way, nothing rendered
// ends on a dangling word.
function _capSentence(text, max) {
  if (!text) return text;
  if (text.length <= max) return _ensureSentenceEnds(text);
  const window = text.slice(0, max);
  const lastBoundary = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (lastBoundary > max * 0.4) {
    return window.slice(0, lastBoundary + 1).trim();
  }
  return `${window.trim()}…`;
}

// If the model's reply got cut off mid-sentence (hit its token budget
// before finishing, or just trailed off), the last visible character
// usually isn't sentence-ending punctuation -- append an ellipsis so it
// reads as "trails off" rather than a broken, unfinished sentence.
function _ensureSentenceEnds(text) {
  if (!text) return text;
  const trimmed = text.trim();
  if (/[.!?…]$/.test(trimmed)) return trimmed;
  return `${trimmed}…`;
}

// ---------- AI explainer ----------
// On-demand result -- only generated after the user clicks "Explain in
// plain English". Runs a small model entirely on-device via WebGPU (see
// webllm-client.js); no policy text is ever sent anywhere for this.
// `settledPromise` is the SAME Promise.allSettled already kicked off by
// renderSiteResult for the Disclosed/Observed sections below -- awaiting
// it here does not trigger a second ToS;DR/Observed lookup, it just waits
// for whichever finishes first.
function addAiExplainBlock(parent, policyText, analysis, settledPromise) {
  if (!policyText) return; // nothing to explain

  const block = document.createElement("div");
  block.className = "ai-explain-block";

  const heading = document.createElement("h3");
  heading.className = "ai-explain-heading";
  heading.textContent = "💬 Explain this simply";
  block.appendChild(heading);

  if (typeof WebLLMClient === "undefined" || !navigator.gpu) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Needs a GPU with WebGPU support (not available in this browser, or no compatible " +
      "graphics hardware was found).";
    block.appendChild(p);
    parent.appendChild(block);
    return;
  }

  const sub = document.createElement("p");
  sub.className = "muted ai-explain-sub";
  sub.textContent = "A small AI model runs entirely on this device -- your policy text is never sent anywhere.";
  block.appendChild(sub);

  // Deliberately NOT .link-btn -- this is the primary action in its own
  // card, not a secondary text link, and it was easy to miss/mistake for
  // plain text when styled that way (user feedback, llmUI round 2).
  // Inherits the standard filled-button look (see popup.css's base
  // `button` rule and .ai-explain-btn).
  const btn = document.createElement("button");
  btn.className = "ai-explain-btn";
  btn.textContent = "Explain in plain English";

  const progress = document.createElement("progress");
  progress.className = "ai-progress hidden";
  progress.max = 1;
  progress.value = 0;

  const statusEl = document.createElement("p");
  statusEl.className = "muted ai-status hidden";

  const resultEl = document.createElement("div");

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    progress.classList.remove("hidden");
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Starting local model…";
    try {
      const [tosdrSettled, observedSettled] = await settledPromise;
      const tosdrResult = tosdrSettled.status === "fulfilled" ? tosdrSettled.value : null;
      const observedResult = observedSettled.status === "fulfilled" ? observedSettled.value : null;
      const findings = buildFindingsContext(analysis, tosdrResult, observedResult);

      const raw = await WebLLMClient.summarizePolicy(policyText, findings, (report) => {
        if (typeof report.progress === "number") progress.value = report.progress;
        statusEl.textContent = report.text || `Loading model… ${Math.round((report.progress || 0) * 100)}%`;
      });

      progress.classList.add("hidden");
      statusEl.classList.add("hidden");
      resultEl.innerHTML = "";

      const parsed = parseAiSummary(raw);
      if (parsed) {
        // llmUI round 2: added "Protect yourself" -- users asked not just
        // "what's wrong" but "what do I do about it." Given its own
        // slightly emphasized style (ai-finding-row-protect) since it's
        // the actionable row, the one most worth a user's attention.
        const rows = [
          ["What it does", parsed.what, ""],
          ["Watch out for", parsed.concerns, ""],
          ["Protect yourself", parsed.protectYourself, "ai-finding-row-protect"],
          ["Bottom line", parsed.bottomLine, ""],
        ];
        for (const [label, text, extraClass] of rows) {
          if (!text) continue;
          const row = document.createElement("p");
          row.className = extraClass ? `ai-finding-row ${extraClass}` : "ai-finding-row";
          const strong = document.createElement("strong");
          strong.textContent = `${label}: `;
          row.appendChild(strong);
          row.appendChild(document.createTextNode(_capSentence(text, 220)));
          resultEl.appendChild(row);
        }
      } else {
        // Model didn't follow the format -- still show something useful
        // rather than nothing, but bounded rather than a raw wall of text.
        const p = document.createElement("p");
        p.className = "summary-text";
        const isLong = raw.length > 400;
        p.textContent = isLong ? _capSentence(raw, 400) : _ensureSentenceEnds(raw);
        resultEl.appendChild(p);
        if (isLong) {
          const toggle = document.createElement("button");
          toggle.className = "link-btn";
          toggle.textContent = "Show full response";
          toggle.addEventListener("click", () => {
            p.textContent = _ensureSentenceEnds(raw);
            toggle.remove();
          });
          resultEl.appendChild(toggle);
        }
      }
    } catch (err) {
      progress.classList.add("hidden");
      statusEl.classList.add("hidden");
      const message = (err && err.message) ||
        "the local model failed to load or run (often a missing/unsupported GPU)";
      resultEl.innerHTML = `<p class="error">Couldn't generate an explanation: ${message}</p>`;
    } finally {
      btn.disabled = false;
    }
  });

  block.appendChild(btn);
  block.appendChild(progress);
  block.appendChild(statusEl);
  block.appendChild(resultEl);
  parent.appendChild(block);
}

// Renders the full result for one site into `container`. `site` is
// { domain, policyUrl, text, tabId? }. tabId is optional and only set for
// the current tab's live "check this site" flow (see initMainScreen) --
// it lets the Observed channel try live capture; saved/historical sites
// omit it and go straight to the bundled snapshot.
//
// Layout: glance row first (instant classifier badge, Observed badge
// fills in once the shared lookup resolves), then the AI explainer (llmUI
// -- the fast "just tell me simply" entry point), then Disclosed and
// Observed as two tabs (observedUI -- see popup.html's header comment)
// instead of two stacked sections -- "Disclosed" (classifier + ToS;DR,
// both readings of the policy text) and "Observed" (Tracker Radar,
// independent of the policy) are still never merged into one badge/score,
// just no longer forced onto the same scroll. See risk_model.js and root
// README.md "Two-channel risk model".
//
// extUI/llmUI: ToS;DR and Tracker Radar are each fetched exactly once
// here via Promise.allSettled, and the settled results are threaded
// through to every function that needs them (the AI explainer, the
// banner, each channel's section, the glance row) -- previously each of
// those fetched independently, so a single render could fire two ToS;DR
// requests and two Observed lookups for the same domain.
async function renderSiteResult(container, site) {
  container.innerHTML = "";

  const classifierAnalysis =
    typeof RedFlagsEngine !== "undefined" && site.text ? RedFlagsEngine.analyze(site.text) : null;

  const glanceObservedSlot = renderGlanceRow(container, classifierAnalysis);

  // Not awaited here -- kicked off once, shared by the AI explainer below
  // and by the Disclosed/Observed tabs further down.
  const settledPromise = Promise.allSettled([
    TosdrClient.lookupDomain(site.domain),
    TrackerRadarClient.lookupDomain(site.domain, site.tabId),
  ]);

  addAiExplainBlock(container, site.text, classifierAnalysis, settledPromise);

  const { disclosedPanel, observedPanel, flagDot } = buildChannelTabs(container);

  if (site.policyUrl) {
    const link = document.createElement("p");
    link.className = "muted";
    const a = document.createElement("a");
    a.href = site.policyUrl;
    a.target = "_blank";
    a.textContent = "View policy source";
    link.appendChild(a);
    disclosedPanel.appendChild(link);
  }

  const classifierContainer = document.createElement("div");
  renderClassifierResult(classifierContainer, classifierAnalysis);
  disclosedPanel.appendChild(classifierContainer);

  const tosdrContainer = document.createElement("div");
  tosdrContainer.innerHTML = '<p class="muted">Checking ToS;DR…</p>';
  disclosedPanel.appendChild(tosdrContainer);

  // The (usually absent) disagreement banner lives inside the Observed
  // tab now, not above both tabs -- the small flag on the Observed tab
  // button (see setObservedTabFlag) is what surfaces it while someone is
  // still looking at Disclosed.
  const bannerSlot = document.createElement("div");
  observedPanel.appendChild(bannerSlot);

  const observedContainer = document.createElement("div");
  observedContainer.innerHTML = '<p class="muted">Checking Tracker Radar…</p>';
  observedPanel.appendChild(observedContainer);

  const [tosdrSettled, observedSettled] = await settledPromise;

  const comparison = computeChannelDisagreement(tosdrSettled, observedSettled);
  renderChannelAgreementBanner(bannerSlot, comparison);
  setObservedTabFlag(flagDot, comparison);
  renderTosdrResult(tosdrContainer, tosdrSettled);
  renderObservedResult(observedContainer, observedSettled, glanceObservedSlot);
}

async function getCurrentTab() {
  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// ---------- Saved sites: compact rows, lazy-expand ----------
// Each saved site used to render its FULL result inline, permanently, for
// every site, every time the popup opened -- the main cause of "scrolling
// is worse than reading the policy" (it also meant every saved site
// fired its own ToS;DR + Observed lookups on every popup open, whether
// or not you cared about that site right now). Now each row is a native
// <details>/<summary> pair: closed by default, shows only domain + saved
// date + a fast local classifier badge (no fetch), and the full
// Disclosed/Observed breakdown renders lazily the first time it's
// expanded -- toggling it closed and back open again reuses the same
// render rather than re-fetching.
function _savedRowBadge(site) {
  if (typeof RedFlagsEngine === "undefined" || !site.text) return riskBadge("unknown");
  return riskBadge(RedFlagsEngine.analyze(site.text).riskLevel);
}

function _formatSavedDate(ms) {
  if (!ms) return "unknown date";
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "unknown date";
  }
}

function buildSavedRow(site) {
  const item = document.createElement("details");
  item.className = "saved-item";

  const summary = document.createElement("summary");
  summary.className = "saved-row";

  const main = document.createElement("div");
  main.className = "saved-row-main";
  const name = document.createElement("strong");
  name.textContent = site.domain;
  const date = document.createElement("span");
  date.className = "saved-row-date";
  date.textContent = `Saved ${_formatSavedDate(site.savedAt)}`;
  main.appendChild(name);
  main.appendChild(date);

  const badges = document.createElement("div");
  badges.className = "saved-row-badges";
  badges.appendChild(_savedRowBadge(site));

  const chevron = document.createElement("span");
  chevron.className = "saved-row-chevron";
  chevron.textContent = "▸";
  chevron.setAttribute("aria-hidden", "true");

  summary.appendChild(main);
  summary.appendChild(badges);
  summary.appendChild(chevron);
  item.appendChild(summary);

  const detail = document.createElement("div");
  detail.className = "saved-item-detail";
  item.appendChild(detail);

  let rendered = false;
  item.addEventListener("toggle", () => {
    if (!item.open || rendered) return;
    rendered = true;
    renderSiteResult(detail, site);

    const removeRow = document.createElement("div");
    removeRow.className = "saved-item-header";
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      await SiteStorage.removeSite(site.domain);
      refreshSavedList();
    });
    removeRow.appendChild(removeBtn);
    detail.insertBefore(removeRow, detail.firstChild);
  });

  return item;
}

async function refreshSavedList() {
  els.savedList.innerHTML = "Loading…";
  try {
    const sites = await SiteStorage.listSavedSites();
    els.savedCount.textContent = String(sites.length);
    els.savedCount.classList.toggle("hidden", sites.length === 0);

    els.savedList.innerHTML = "";
    if (!sites.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = '<div class="empty-icon">🔖</div><p>Nothing saved yet -- check a site to add it here.</p>';
      els.savedList.appendChild(empty);
      return;
    }
    for (const site of sites) {
      els.savedList.appendChild(buildSavedRow(site));
    }
  } catch (err) {
    els.savedList.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

async function initMainScreen() {
  initTabs();

  const tab = await getCurrentTab();
  const tabUrl = tab ? tab.url : null;
  els.currentTabHost.textContent = tabUrl ? new URL(tabUrl).hostname : "(no active tab)";

  // Favicon -- available on the tab object under `activeTab` without any
  // extra permission (the popup opening counts as invoking activeTab).
  // Purely decorative/orienting; falls back to nothing if unavailable
  // (some pages, e.g. chrome:// pages, don't have one).
  if (tab && tab.favIconUrl) {
    const img = document.createElement("img");
    img.src = tab.favIconUrl;
    img.alt = "";
    img.onerror = () => { img.remove(); };
    els.siteFavicon.appendChild(img);
  }

  els.checkBtn.onclick = async () => {
    if (!tab || !tabUrl) return;
    els.checkBtn.disabled = true;
    els.lookupResult.innerHTML = "Checking…";
    try {
      const { policyUrl, text, error } = await PolicyDiscovery.discoverPolicy(tab.id, tabUrl);
      if (!policyUrl) {
        els.lookupResult.innerHTML = '<p class="muted">No privacy policy found for this site.</p>';
        return;
      }
      if (!text) {
        els.lookupResult.innerHTML = `<p class="error">Found a policy link (${policyUrl}) but couldn't fetch it: ${error}</p>`;
        return;
      }
      const domain = new URL(tabUrl).hostname;
      // tabId is included here (the live "check this site" path) so
      // Observed can try live capture -- see tracker_radar_client.js.
      // Saved/historical sites (refreshSavedList below) never set tabId,
      // since there's no live tab to ask about a past visit; they go
      // straight to the bundled snapshot, which is correct for them.
      const site = { domain, policyUrl, text, tabId: tab.id };
      renderSiteResult(els.lookupResult, site);
      await SiteStorage.saveSite(domain, site);
      refreshSavedList();
    } catch (err) {
      els.lookupResult.innerHTML = `<p class="error">${err.message}</p>`;
    } finally {
      els.checkBtn.disabled = false;
    }
  };

  refreshSavedList();
}

initMainScreen();
