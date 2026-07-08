/**
 * popup.js
 *
 * Popup UI logic ONLY -- no DOM scanning, no privacy-policy scoring, no
 * fetch() to the backend. All of that lives in content.js/policyFinder.js
 * (page scanning) and background.js (orchestration + the backend request).
 * This file just: wires up the button, sends two messages to the
 * background service worker, and renders whatever comes back.
 */

const els = {
  scanBtn: document.getElementById("scanBtn"),
  status: document.getElementById("status"),
  errorBox: document.getElementById("errorBox"),
  siteInfo: document.getElementById("siteInfo"),
  domainText: document.getElementById("domainText"),
  policyLink: document.getElementById("policyLink"),
  noPolicyText: document.getElementById("noPolicyText"),
  discoveryNote: document.getElementById("discoveryNote"),
  summaryBox: document.getElementById("summaryBox"),
  mockBanner: document.getElementById("mockBanner"),
  riskBadge: document.getElementById("riskBadge"),
  summaryText: document.getElementById("summaryText"),
  dataCollectedList: document.getElementById("dataCollectedList"),
  dataUsageList: document.getElementById("dataUsageList"),
  thirdPartyList: document.getElementById("thirdPartyList"),
  retentionList: document.getElementById("retentionList"),
  userRightsList: document.getElementById("userRightsList"),
  redFlagsList: document.getElementById("redFlagsList"),
  redFlagsDetails: document.getElementById("redFlagsDetails"),
  takeawaysList: document.getElementById("takeawaysList"),
};

els.scanBtn.addEventListener("click", runScan);

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function runScan() {
  resetUI();
  els.scanBtn.disabled = true;
  setStatus("Scanning the current page…");

  let scanResponse;
  try {
    scanResponse = await sendMessage({ type: "SCAN_PAGE" });
  } catch (err) {
    finishWithError("Couldn't talk to the extension's background worker: " + err.message);
    return;
  }

  if (!scanResponse || !scanResponse.ok) {
    finishWithError((scanResponse && scanResponse.error) || "Couldn't inspect this tab.");
    return;
  }

  const scan = scanResponse.data;
  renderSiteInfo(scan);

  if (scan.restricted) {
    finishWithError("This is a browser/system page and can't be scanned.");
    return;
  }

  setStatus("Requesting a summary from your backend…");
  showLoading(true);

  let summaryResponse;
  try {
    summaryResponse = await sendMessage({
      type: "SUMMARIZE",
      payload: { siteUrl: scan.siteUrl, domain: scan.domain, policyUrl: scan.policyUrl },
    });
  } catch (err) {
    showLoading(false);
    finishWithError("Request failed: " + err.message);
    return;
  }

  showLoading(false);
  els.scanBtn.disabled = false;

  if (!summaryResponse || !summaryResponse.ok) {
    finishWithError((summaryResponse && summaryResponse.error) || "The backend couldn't summarize this policy.");
    return;
  }

  clearStatus();
  renderSummary(summaryResponse.data);
}

function resetUI() {
  hide(els.errorBox);
  hide(els.siteInfo);
  hide(els.summaryBox);
  hide(els.mockBanner);
  clearStatus();
}

function finishWithError(message) {
  els.scanBtn.disabled = false;
  showLoading(false);
  clearStatus();
  els.errorBox.textContent = message;
  show(els.errorBox);
}

function renderSiteInfo(scan) {
  els.domainText.textContent = scan.domain || "(unknown)";
  hide(els.discoveryNote);

  if (scan.policyUrl) {
    // A high-confidence match on the current page -- trusted as-is.
    els.policyLink.href = scan.policyUrl;
    els.policyLink.textContent = scan.policyUrl;
    show(els.policyLink);
    hide(els.noPolicyText);
  } else if (scan.pageCandidateUrl) {
    // Found *something* on this page, but not confidently enough to trust
    // outright -- show it as a weak guess while the backend double-checks.
    hide(els.policyLink);
    show(els.noPolicyText);
    els.noPolicyText.textContent = "No confident match on this page -- asking the server to check further…";
    els.discoveryNote.textContent = "Weak guess from this page: " + scan.pageCandidateUrl;
    show(els.discoveryNote);
  } else {
    hide(els.policyLink);
    show(els.noPolicyText);
    els.noPolicyText.textContent = "We couldn't automatically find a privacy policy on this page.";
  }

  show(els.siteInfo);
}

function renderSummary(summary) {
  if (summary.mock) {
    show(els.mockBanner);
  }

  // If the server discovered the policy URL itself (client-side scan found
  // nothing confident enough), reflect that back into the site-info panel,
  // including how it was found and how confident the pipeline is.
  if (summary.policy_url && !els.policyLink.href.endsWith(summary.policy_url)) {
    els.policyLink.href = summary.policy_url;
    els.policyLink.textContent = summary.policy_url;
    show(els.policyLink);
    hide(els.noPolicyText);
  }

  if (summary.discovery_method) {
    const confidence = (summary.discovery_confidence || "low").toLowerCase();
    els.discoveryNote.innerHTML = "";
    const label = document.createElement("span");
    label.textContent = "Found via " + humanizeDiscoveryMethod(summary.discovery_method) + ".";
    els.discoveryNote.appendChild(label);
    const tag = document.createElement("span");
    tag.className = "confidence-tag confidence-" + (["high", "medium", "low"].includes(confidence) ? confidence : "low");
    tag.textContent = confidence + " confidence";
    els.discoveryNote.appendChild(tag);
    show(els.discoveryNote);
  }

  const risk = (summary.risk_level || "unknown").toLowerCase();
  els.riskBadge.textContent = riskLabel(risk);
  els.riskBadge.className = "risk-badge risk-" + (["low", "medium", "high"].includes(risk) ? risk : "unknown");

  els.summaryText.textContent = summary.plain_english_summary || "No summary text was returned.";

  fillList(els.dataCollectedList, summary.data_collected);
  fillList(els.dataUsageList, summary.data_usage);
  fillList(els.thirdPartyList, summary.third_party_sharing);
  fillList(els.retentionList, summary.retention);
  fillList(els.userRightsList, summary.user_rights);
  fillList(els.takeawaysList, summary.user_takeaways);

  fillList(els.redFlagsList, summary.red_flags);
  els.redFlagsDetails.open = Array.isArray(summary.red_flags) && summary.red_flags.length > 0;

  show(els.summaryBox);
}

function humanizeDiscoveryMethod(method) {
  const labels = {
    cached: "a previously saved link",
    homepage_scan: "a link on the homepage",
    footer_scan: "a footer link",
    common_path: "guessing a common URL path",
    sitemap: "the site's sitemap",
    internal_search: "the site's own search",
    structured_metadata: "page metadata",
    llm_ranked: "AI-assisted ranking of candidate links",
  };
  return labels[method] || method;
}

function riskLabel(risk) {
  switch (risk) {
    case "low": return "Low risk";
    case "medium": return "Medium risk";
    case "high": return "High risk";
    default: return "Risk unknown";
  }
}

function fillList(ul, items) {
  ul.innerHTML = "";
  if (!items || items.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Not addressed.";
    li.style.color = "var(--text-muted)";
    ul.appendChild(li);
    return;
  }
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    ul.appendChild(li);
  });
}

function setStatus(text) {
  els.status.textContent = text;
  show(els.status);
}

function clearStatus() {
  els.status.textContent = "";
  hide(els.status);
}

function showLoading(isLoading) {
  if (isLoading) {
    setStatus("Requesting a summary from your backend…");
  }
}

function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }
