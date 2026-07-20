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
function _explainMatchedDomain(entry) {
  const label = entry.owner ? `${entry.domain} (${entry.owner})` : entry.domain;
  const explanations = [];
  for (const cat of entry.categories || []) {
    const text = window.TrackerCategoryGlossary && TrackerCategoryGlossary.explainCategory(cat);
    explanations.push(text || cat);
  }
  const fpExplain =
    entry.fingerprinting >= 2 && window.TrackerCategoryGlossary
      ? TrackerCategoryGlossary.explainFingerprinting(entry.fingerprinting)
      : null;
  const parts = [...new Set(explanations)];
  if (fpExplain) parts.push(fpExplain);
  return { label, detail: parts.join(" ") };
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

  const level = SiteRiskModel.observedLevelFromRiskScore(profile.riskScore);
  container.appendChild(riskBadge(level));

  const summary = document.createElement("p");
  summary.className = "summary-text";
  summary.textContent =
    profile.trackerCount === 0
      ? "No third-party requests detected."
      : `${profile.trackerCount} third-party domain(s) contacted across ${profile.distinctOwnerCount} compan${profile.distinctOwnerCount === 1 ? "y" : "ies"}.`;
  container.appendChild(summary);

  const matchedDomains = profile.matchedDomains || [];
  const flagged = matchedDomains.filter((d) => d.bucket === "fingerprinting_heavy");
  if (flagged.length) {
    const flagBlock = document.createElement("div");
    flagBlock.className = "observed-flagged";
    const heading = document.createElement("strong");
    heading.textContent = `⚠️ ${flagged.length} tracker${flagged.length === 1 ? "" : "s"} flagged for fingerprinting-heavy or high-risk behavior`;
    flagBlock.appendChild(heading);
    const ul = document.createElement("ul");
    for (const entry of flagged) {
      const { label, detail } = _explainMatchedDomain(entry);
      const li = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = label;
      li.appendChild(strong);
      if (detail) li.appendChild(document.createTextNode(" -- " + detail));
      ul.appendChild(li);
    }
    flagBlock.appendChild(ul);
    container.appendChild(flagBlock);
  }

  const otherMatched = matchedDomains.filter((d) => d.bucket !== "fingerprinting_heavy");
  if (otherMatched.length) {
    const details = document.createElement("details");
    details.className = "summary-section";
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = `${otherMatched.length} other tracker${otherMatched.length === 1 ? "" : "s"} detected`;
    details.appendChild(summaryEl);
    const ul = document.createElement("ul");
    for (const entry of otherMatched) {
      const { label, detail } = _explainMatchedDomain(entry);
      const li = document.createElement("li");
      li.textContent = detail ? `${label} -- ${detail}` : label;
      ul.appendChild(li);
    }
    details.appendChild(ul);
    container.appendChild(details);
  }

  if (profile.unmatchedDomains && profile.unmatchedDomains.length) {
    const details = document.createElement("details");
    details.className = "summary-section";
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = `${profile.unmatchedDomains.length} more domain(s) contacted, not yet in our tracker index`;
    details.appendChild(summaryEl);
    const ul = document.createElement("ul");
    for (const d of profile.unmatchedDomains) {
      const li = document.createElement("li");
      li.textContent = d;
      ul.appendChild(li);
    }
    details.appendChild(ul);
    container.appendChild(details);
    if (profile.coverage && profile.coverage.riskScoreWithheld) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "Not enough of what was contacted matched our tracker index to score confidently -- the list above is everything real that was seen, even though we cannot yet say what most of it does.";
      container.appendChild(note);
    }
  }

  const capturedNote = document.createElement("p");
  capturedNote.className = "muted";
  const isLive = typeof profile.snapshotSource === "string" && profile.snapshotSource.startsWith("live capture");
  capturedNote.textContent = isLive
    ? "Detected live from this tab's current page load -- not a continuous monitor; reload/revisit to refresh."
    : `Detected in a scan on ${profile.capturedAt ? new Date(profile.capturedAt).toLocaleDateString() : "an earlier scan"} -- not a live monitor of this tab.`;
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

// Cross-channel comparison banner -- now a pure render from already-
// settled results (see renderSiteResult), not an independent fetch. It
// used to call TosdrClient/TrackerRadarClient a second time for the same
// domain the section below it was already fetching for; sharing one
// Promise.allSettled result removes that duplication entirely.
function renderChannelAgreementBanner(container, tosdrSettled, observedSettled) {
  const tosdr = tosdrSettled.status === "fulfilled" ? tosdrSettled.value : null;
  const observed = observedSettled.status === "fulfilled" ? observedSettled.value : null;
  if (!tosdr || !observed) return; // nothing to compare -- stay quiet

  const disclosedLevel = SiteRiskModel.disclosedLevelFromTosdrRating(tosdr.rating);
  const observedLevel = SiteRiskModel.observedLevelFromRiskScore(observed.riskScore);
  const comparison = SiteRiskModel.compareChannels(disclosedLevel, observedLevel);
  if (!comparison.comparable || comparison.agree) return;

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
// -- the fast "just tell me simply" entry point), then an (usually empty)
// agreement banner, then two clearly separate channels -- "Disclosed"
// (classifier + ToS;DR, both readings of the policy text) and "Observed"
// (Tracker Radar, independent of the policy) -- never merged into one
// badge/score. See risk_model.js and root README.md "Two-channel risk
// model".
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
  // and by the Disclosed/Observed sections further down.
  const settledPromise = Promise.allSettled([
    TosdrClient.lookupDomain(site.domain),
    TrackerRadarClient.lookupDomain(site.domain, site.tabId),
  ]);

  addAiExplainBlock(container, site.text, classifierAnalysis, settledPromise);

  const bannerContainer = document.createElement("div");
  container.appendChild(bannerContainer);

  if (site.policyUrl) {
    const link = document.createElement("p");
    link.className = "muted";
    const a = document.createElement("a");
    a.href = site.policyUrl;
    a.target = "_blank";
    a.textContent = "View policy source";
    link.appendChild(a);
    container.appendChild(link);
  }

  const disclosedHeading = document.createElement("h3");
  disclosedHeading.className = "channel-heading";
  disclosedHeading.textContent = "Disclosed -- what the policy says";
  container.appendChild(disclosedHeading);

  const classifierContainer = document.createElement("div");
  renderClassifierResult(classifierContainer, classifierAnalysis);
  container.appendChild(classifierContainer);

  const tosdrContainer = document.createElement("div");
  tosdrContainer.innerHTML = '<p class="muted">Checking ToS;DR…</p>';
  container.appendChild(tosdrContainer);

  const observedHeading = document.createElement("h3");
  observedHeading.className = "channel-heading";
  observedHeading.textContent = "Observed -- what we can technically detect";
  container.appendChild(observedHeading);

  const observedContainer = document.createElement("div");
  observedContainer.innerHTML = '<p class="muted">Checking Tracker Radar…</p>';
  container.appendChild(observedContainer);

  const [tosdrSettled, observedSettled] = await settledPromise;

  renderChannelAgreementBanner(bannerContainer, tosdrSettled, observedSettled);
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
