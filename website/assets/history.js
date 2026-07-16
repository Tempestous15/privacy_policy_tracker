// website/history.html -- Feature 1 (scan history). Asks the installed
// ClipPri extension for saved sites via extension-bridge.js, then runs the
// same local classifier the extension itself uses (redflags-engine.js,
// synced copy -- see that file's header) directly in this page, on the
// text the extension already relayed. No network request happens anywhere
// in this file; the classifier is a pure regex-based lexicon scan.
//
// Deliberately does NOT re-fetch ToS;DR or Tracker Radar data per history
// item here (unlike the extension popup's live "Check this site" flow) --
// that would mean firing a request per saved site on every page load,
// which is slower and, more importantly, out of scope for "show me what
// I've already scanned." check.html (Feature 2) is the place for a fresh,
// live look at both channels for one URL at a time.

const els = {
  status: document.getElementById("status"),
  list: document.getElementById("history-list"),
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

function formatDate(ms) {
  if (!ms) return "unknown date";
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "unknown date";
  }
}

function renderSite(site) {
  const div = document.createElement("div");
  div.className = "saved-item";

  const header = document.createElement("div");
  header.className = "saved-item-header";
  const name = document.createElement("strong");
  name.textContent = site.domain;
  const date = document.createElement("span");
  date.className = "saved-item-date";
  date.textContent = `Scanned ${formatDate(site.savedAt)}`;
  header.appendChild(name);
  header.appendChild(date);
  div.appendChild(header);

  const heading = document.createElement("div");
  heading.className = "channel-heading";
  heading.textContent = "Disclosed -- local scan of the saved policy text";
  div.appendChild(heading);

  if (typeof RedFlagsEngine !== "undefined" && site.text) {
    const analysis = RedFlagsEngine.analyze(site.text);
    div.appendChild(riskBadge(analysis.riskLevel));
    if (analysis.categories.length) {
      // Collapsed by default (unlike the extension popup's always-open
      // version) -- this is the "if they want to" detail view, not the
      // primary result. Same severity icon + first matched snippet per
      // category as popup.js's renderClassifier, so the two surfaces
      // explain a match the same way.
      const details = document.createElement("details");
      details.className = "summary-section red-flags";
      const summaryEl = document.createElement("summary");
      summaryEl.textContent = `What's contributing to this: ${analysis.categories.length} red flag${analysis.categories.length === 1 ? "" : "s"} found`;
      details.appendChild(summaryEl);
      const ul = document.createElement("ul");
      for (const cat of analysis.categories) {
        const li = document.createElement("li");
        const icon = RED_FLAG_SEVERITY_ICON[cat.severity] || "ℹ️";
        li.textContent = `${icon} ${cat.label}` + (cat.matches.length ? `: “${cat.matches[0]}”` : "");
        ul.appendChild(li);
      }
      details.appendChild(ul);
      div.appendChild(details);
    } else {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "No red flags detected by the automated scan.";
      div.appendChild(p);
    }
  } else {
    div.appendChild(riskBadge("unknown"));
  }

  if (site.policyUrl) {
    const link = document.createElement("p");
    link.className = "channel-source-note";
    link.style.marginTop = "0.5rem";
    const a = document.createElement("a");
    a.href = site.policyUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "View the policy this was scanned from →";
    link.appendChild(a);
    div.appendChild(link);
  }

  return div;
}

async function init() {
  if (!ClipPriBridge.isExtensionMessagingSupported()) {
    els.status.textContent =
      "Scan history requires a Chromium-based browser (Chrome, Edge, Brave) with the ClipPri extension installed.";
    els.status.classList.add("error");
    return;
  }

  const result = await ClipPriBridge.requestSavedSitesFromExtension();

  if (!result.ok) {
    els.status.innerHTML =
      'No response from the ClipPri extension. Make sure it\'s installed and enabled, then reload this page. ' +
      '<a href="https://github.com/Tempestous15/privacy_policy_tracker/tree/main/extension" target="_blank" rel="noopener">Get the extension</a>.';
    return;
  }

  if (!result.sites.length) {
    els.status.textContent = "No sites saved yet -- use the extension's \"Check this site\" button, then come back here.";
    return;
  }

  els.status.textContent = `${result.sites.length} site(s) scanned, most recent first.`;
  for (const site of result.sites) {
    els.list.appendChild(renderSite(site));
  }
}

init();
