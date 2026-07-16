// Note: the on-device AI summary (webllm-client.js) relies on chrome.runtime
// service-worker WebGPU support and is Chrome/Chromium-only as of this
// writing -- see extension/README.md. `browserAPI` (Chrome/Firefox promise
// API shim) is declared once, in storage.js, loaded before this file.

const els = {
  currentTabHost: document.getElementById("current-tab-host"),
  checkBtn: document.getElementById("check-btn"),
  lookupResult: document.getElementById("lookup-result"),
  savedList: document.getElementById("saved-list"),
  globalError: document.getElementById("global-error"),
};

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

// Primary, always-on result: runs RedFlagsEngine.analyze() (see
// redflags-engine.js / classifier/README.md) on raw policy text locally,
// with no network call and no API key needed.
function renderClassifier(container, text) {
  container.innerHTML = "";
  if (typeof RedFlagsEngine === "undefined" || !text) {
    container.appendChild(riskBadge("unknown"));
    return;
  }

  const analysis = RedFlagsEngine.analyze(text);
  container.appendChild(riskBadge(analysis.riskLevel));

  if (!analysis.categories.length) {
    const p = document.createElement("p");
    p.className = "summary-text";
    p.textContent = "No red flags detected by the automated scan.";
    container.appendChild(p);
    return;
  }

  const details = document.createElement("details");
  details.className = "summary-section red-flags";
  details.open = true;
  const summaryEl = document.createElement("summary");
  summaryEl.textContent = `🚩 Red flags (${analysis.categories.length})`;
  details.appendChild(summaryEl);
  const ul = document.createElement("ul");
  for (const cat of analysis.categories) {
    const li = document.createElement("li");
    li.textContent = cat.label + (cat.matches.length ? `: “${cat.matches[0]}”` : "");
    ul.appendChild(li);
  }
  details.appendChild(ul);
  container.appendChild(details);
}

const TOSDR_SEVERITY_ICON = { good: "✅", blocker: "🚫", bad: "⚠️", neutral: "ℹ️" };

// Supplementary badge from ToS;DR's public API (see tosdr.js) -- only shows
// up for sites ToS;DR has already reviewed. Never blocks the rest of the UI:
// failures here are shown inline and don't affect the classifier result.
async function renderTosdr(container, domain) {
  container.innerHTML = '<p class="muted">Checking ToS;DR…</p>';
  try {
    const result = await TosdrClient.lookupDomain(domain);
    container.innerHTML = "";
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
  } catch (err) {
    container.innerHTML = `<p class="muted">ToS;DR lookup unavailable: ${err.message}</p>`;
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

async function renderObserved(container, domain, tabId) {
  container.innerHTML = "<p class=\"muted\">Checking Tracker Radar...</p>";
  try {
    const profile = await TrackerRadarClient.lookupDomain(domain, tabId);
    container.innerHTML = "";
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
  } catch (err) {
    container.innerHTML = `<p class="muted">Tracker Radar lookup unavailable: ${err.message}</p>`;
  }
}

// Cross-channel comparison banner: fetches Disclosed (ToS;DR) and Observed
// (Tracker Radar) independently, via SiteRiskModel.compareChannels (see
// risk_model.js -- deliberately never a blended score), and surfaces a
// prominent note only when the two genuinely disagree. Silent when they
// agree or when either side has no data, so the UI doesn't clutter itself
// with a banner that has nothing useful to say. Runs alongside, not before,
// the two sections' own renders -- a slow/failed comparison never blocks
// renderClassifier/renderTosdr/renderObserved from showing their own
// results.
async function renderChannelAgreementBanner(container, domain, tabId) {
  container.innerHTML = "";
  const [tosdrResult, observedResult] = await Promise.allSettled([
    TosdrClient.lookupDomain(domain),
    TrackerRadarClient.lookupDomain(domain, tabId),
  ]);

  const tosdr = tosdrResult.status === "fulfilled" ? tosdrResult.value : null;
  const observed = observedResult.status === "fulfilled" ? observedResult.value : null;
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

// Optional, on-demand result -- only generated after the user clicks "Get
// AI summary". Runs a small model entirely on-device via WebGPU (see
// webllm-client.js); no policy text is ever sent anywhere for this. A plain
// paragraph rather than structured fields -- small local models are far
// less reliable at strict JSON schemas than a hosted frontier model, and the
// red-flags categorization is already handled reliably by the classifier.
function addAiSummaryButton(parent, policyText) {
  const block = document.createElement("div");
  block.className = "ai-summary-block";

  if (typeof WebLLMClient === "undefined" || !navigator.gpu) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "On-device AI summary needs a GPU with WebGPU support " +
      "(not available in this browser, or no compatible graphics hardware was found).";
    block.appendChild(p);
    parent.appendChild(block);
    return;
  }

  const btn = document.createElement("button");
  btn.className = "link-btn ai-summary-btn";
  btn.textContent = "Get AI summary (on-device)";

  const resultEl = document.createElement("div");

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    resultEl.textContent = "Starting local model…";
    try {
      const summary = await WebLLMClient.summarizePolicy(policyText, (report) => {
        resultEl.textContent = report.text || `Loading model… ${Math.round((report.progress || 0) * 100)}%`;
      });
      resultEl.innerHTML = "";
      const p = document.createElement("p");
      p.className = "summary-text";
      p.textContent = summary;
      resultEl.appendChild(p);
    } catch (err) {
      const message = (err && err.message) ||
        "the local model failed to load or run (often a missing/unsupported GPU)";
      resultEl.innerHTML = `<p class="error">Couldn't generate an on-device summary: ${message}</p>`;
    } finally {
      btn.disabled = false;
    }
  });

  block.appendChild(btn);
  block.appendChild(resultEl);
  parent.appendChild(block);
}

// Renders the full result for one site into `container`. `site` is
// { domain, policyUrl, text, tabId? }. tabId is optional and only set for
// the current tab's live "check this site" flow (see initMainScreen) --
// it lets the Observed channel try live capture; saved/historical sites
// omit it and go straight to the bundled snapshot.
//
// Layout: an (usually empty) agreement banner first, then two clearly
// separate channels -- "Disclosed" (classifier + ToS;DR, both readings of
// the policy text) and "Observed" (Tracker Radar, independent of the
// policy) -- never merged into one badge/score. See risk_model.js and
// root README.md "Two-channel risk model".
function renderSiteResult(container, site) {
  container.innerHTML = "";

  const bannerContainer = document.createElement("div");
  container.appendChild(bannerContainer);
  renderChannelAgreementBanner(bannerContainer, site.domain, site.tabId);

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
  renderClassifier(classifierContainer, site.text);
  container.appendChild(classifierContainer);

  const tosdrContainer = document.createElement("div");
  container.appendChild(tosdrContainer);
  renderTosdr(tosdrContainer, site.domain);

  addAiSummaryButton(container, site.text);

  const observedHeading = document.createElement("h3");
  observedHeading.className = "channel-heading";
  observedHeading.textContent = "Observed -- what we can technically detect";
  container.appendChild(observedHeading);

  const observedContainer = document.createElement("div");
  container.appendChild(observedContainer);
  renderObserved(observedContainer, site.domain, site.tabId);
}

async function getCurrentTab() {
  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function refreshSavedList() {
  els.savedList.innerHTML = "Loading…";
  try {
    const sites = await SiteStorage.listSavedSites();
    els.savedList.innerHTML = "";
    if (!sites.length) {
      els.savedList.innerHTML = '<p class="muted">Nothing saved yet.</p>';
      return;
    }
    for (const site of sites) {
      const div = document.createElement("div");
      div.className = "saved-item";

      const headerRow = document.createElement("div");
      headerRow.className = "saved-item-header";
      const name = document.createElement("strong");
      name.textContent = site.domain;
      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-btn";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        await SiteStorage.removeSite(site.domain);
        refreshSavedList();
      });
      headerRow.appendChild(name);
      headerRow.appendChild(removeBtn);
      div.appendChild(headerRow);

      const resultContainer = document.createElement("div");
      renderSiteResult(resultContainer, site);
      div.appendChild(resultContainer);

      els.savedList.appendChild(div);
    }
  } catch (err) {
    els.savedList.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

async function initMainScreen() {
  const tab = await getCurrentTab();
  const tabUrl = tab ? tab.url : null;
  els.currentTabHost.textContent = tabUrl ? new URL(tabUrl).hostname : "(no active tab)";

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
