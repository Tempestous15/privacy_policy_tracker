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

// Renders the full result for one site (classifier + ToS;DR + AI-summary
// button) into `container`. `site` is { domain, policyUrl, text }.
function renderSiteResult(container, site) {
  container.innerHTML = "";

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

  const classifierContainer = document.createElement("div");
  renderClassifier(classifierContainer, site.text);
  container.appendChild(classifierContainer);

  const tosdrContainer = document.createElement("div");
  container.appendChild(tosdrContainer);
  renderTosdr(tosdrContainer, site.domain);

  addAiSummaryButton(container, site.text);
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
      const site = { domain, policyUrl, text };
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
