// website/check.html -- Feature 2 (check a URL without the extension).
//
// Two independent lookups, same "never blended into one score" rule as the
// extension's risk_model.js -- see that file's header comment for why.
//
//   - Disclosed: a direct browser fetch to ToS;DR's public API
//     (api.tosdr.org), the same endpoint extension/tosdr.js calls. The
//     extension can always reach it because host_permissions grants it
//     broad cross-origin fetch access; this page has no such grant and
//     depends entirely on api.tosdr.org's own CORS headers allowing an
//     arbitrary website's JS to call it. That's outside this codebase's
//     control -- if it fails, we say so plainly rather than guessing why.
//     Unlike the extension, this page CANNOT fetch and locally scan an
//     arbitrary site's actual policy page (that would require fetching a
//     third *site's* pages cross-origin from plain page JS, which normal
//     browser CORS blocks regardless of ToS;DR's own policy -- only an
//     installed extension's host_permissions can do that). See check.html's
//     "Scope limits" paragraph.
//   - Observed: TrackerSnapshotLookup (tracker-snapshot-lookup.js), the
//     same curated ~20-site snapshot the extension falls back to when it
//     has no live capture for a domain. No live capture equivalent exists
//     here -- there's no tab for this page to have watched.

const TOSDR_API_BASE = "https://api.tosdr.org";

const els = {
  form: document.getElementById("check-form"),
  input: document.getElementById("domain-input"),
  status: document.getElementById("status"),
  result: document.getElementById("result"),
};

function bareDomain(input) {
  let host = input.trim();
  try {
    if (host.includes("://")) host = new URL(host).hostname;
  } catch {
    // not a parseable URL -- assume a bare domain was typed
  }
  return host.replace(/^www\./, "").toLowerCase();
}

function riskBadge(riskLevel) {
  const labels = {
    low: ["risk-low", "🟢 Low risk"],
    medium: ["risk-medium", "🟡 Medium risk"],
    high: ["risk-high", "🔴 High risk"],
  };
  const [cls, label] = labels[riskLevel] || ["risk-unknown", "⚪ Not available"];
  const span = document.createElement("span");
  span.className = `risk-badge ${cls}`;
  span.textContent = label;
  return span;
}

function tosdrRatingToLevel(rating) {
  if (!rating) return null;
  const r = String(rating).toUpperCase();
  if (r === "A" || r === "B") return "low";
  if (r === "C") return "medium";
  if (r === "D" || r === "E") return "high";
  return null;
}

const TOSDR_SEVERITY_ICON = { good: "✅", blocker: "🚫", bad: "⚠️", neutral: "ℹ️" };

// Returns { ok: true, rating, points } | { ok: true, rating: null, points: [] }
// (no review found) | { ok: false, reason: "cors-or-network" }. Never throws.
// `points` is the "what's contributing to this" detail -- ToS;DR's
// per-clause case list (same /service/v3 endpoint and same shape tosdr.js's
// getServiceDetail uses for the extension popup's "N ToS;DR points"
// collapsible). Fetched only after a service match is found, so a domain
// with no review costs one request, not two.
async function fetchTosdrRating(domain) {
  try {
    const searchResp = await fetch(`${TOSDR_API_BASE}/search/v5?query=${encodeURIComponent(domain)}`);
    if (!searchResp.ok) return { ok: false, reason: "cors-or-network" };
    const data = await searchResp.json();
    const services = data.services || [];
    const exact = services.find((svc) =>
      (svc.urls || []).some((u) => {
        try {
          return new URL(u).hostname.replace(/^www\./, "") === domain;
        } catch {
          return false;
        }
      })
    );
    const service = exact || services[0] || null;
    if (!service) return { ok: true, rating: null, points: [] };

    let points = [];
    try {
      const detailResp = await fetch(`${TOSDR_API_BASE}/service/v3?id=${encodeURIComponent(service.id)}`);
      if (detailResp.ok) {
        const detail = await detailResp.json();
        points = (detail.points || [])
          .filter((p) => p.case)
          .map((p) => ({
            title: p.title,
            severity: p.case.classification || "neutral",
            description: p.case.description || "",
          }));
      }
    } catch {
      // Points are supplementary detail -- losing them must never take
      // down the rating itself, which already succeeded above.
    }

    return { ok: true, rating: service.rating || "N/A", points };
  } catch {
    // A CORS block surfaces here as a generic "Failed to fetch" TypeError,
    // indistinguishable from an actual network failure -- see header
    // comment. We can't tell which happened, so we don't guess.
    return { ok: false, reason: "cors-or-network" };
  }
}

function renderDisclosed(container, tosdrResult) {
  const heading = document.createElement("div");
  heading.className = "channel-heading";
  heading.textContent = "Disclosed -- ToS;DR community rating";
  container.appendChild(heading);

  if (!tosdrResult.ok) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent =
      "Couldn't reach ToS;DR directly from this page (likely blocked by ToS;DR's own cross-origin " +
      "policy for plain websites). The extension doesn't hit this limit -- it's able to make this same " +
      "request directly.";
    container.appendChild(p);
    return;
  }
  if (!tosdrResult.rating) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No ToS;DR review found for this domain.";
    container.appendChild(p);
    return;
  }
  container.appendChild(riskBadge(tosdrRatingToLevel(tosdrResult.rating)));
  const p = document.createElement("p");
  p.className = "channel-source-note";
  p.style.marginTop = "0.4rem";
  p.textContent = `ToS;DR rating: ${tosdrResult.rating}`;
  container.appendChild(p);

  if (tosdrResult.points && tosdrResult.points.length) {
    const details = document.createElement("details");
    details.className = "summary-section";
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = `What's contributing to this: ${tosdrResult.points.length} ToS;DR point${tosdrResult.points.length === 1 ? "" : "s"}`;
    details.appendChild(summaryEl);
    const ul = document.createElement("ul");
    for (const point of tosdrResult.points.slice(0, 6)) {
      const li = document.createElement("li");
      li.textContent = `${TOSDR_SEVERITY_ICON[point.severity] || "ℹ️"} ${point.title}`;
      ul.appendChild(li);
    }
    details.appendChild(ul);
    container.appendChild(details);
  }
}

function observedRiskLevel(riskScore) {
  if (riskScore === null || riskScore === undefined) return null;
  if (riskScore < 25) return "low";
  if (riskScore < 60) return "medium";
  return "high";
}

async function renderObserved(container, domain) {
  const heading = document.createElement("div");
  heading.className = "channel-heading";
  heading.textContent = "Observed -- what we can technically detect";
  container.appendChild(heading);

  const profile = await TrackerSnapshotLookup.lookupDomain(domain);
  if (!profile || profile.coverage?.riskScoreWithheld) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = profile
      ? "Detected too little tracking activity to score confidently."
      : "Not in our current curated scan yet -- this page only covers a small set of sites so far. " +
        "The extension can detect this live for any site you actually visit.";
    container.appendChild(p);
    return;
  }
  container.appendChild(riskBadge(observedRiskLevel(profile.riskScore)));
  const p = document.createElement("p");
  p.className = "channel-source-note";
  p.style.marginTop = "0.4rem";
  const captured = profile.capturedAt ? new Date(profile.capturedAt).toLocaleDateString() : "an earlier scan";
  p.textContent = `${profile.trackerCount} third-party domain(s) detected in a scan on ${captured}.`;
  container.appendChild(p);

  // "What's contributing to this" detail, built entirely from the snapshot
  // entry's own aggregate fields (categoryBreakdown, flaggedOwners,
  // fingerprintingBreakdown, coverage, unmatchedDomains -- see
  // tracker_radar_snapshot.json's schemaNote). Deliberately NOT the
  // per-domain matchedDomains list popup.js's renderObserved shows -- that
  // field only exists on a *live capture* profile (built at runtime by
  // tracker_capture_background.js for the current tab), and this snapshot
  // is a static, pre-aggregated file with no per-tab capture behind it.
  const hasDetail =
    (profile.categoryBreakdown && Object.keys(profile.categoryBreakdown).length) ||
    (profile.flaggedOwners && profile.flaggedOwners.length) ||
    (profile.unmatchedDomains && profile.unmatchedDomains.length);
  if (!hasDetail) return;

  const details = document.createElement("details");
  details.className = "summary-section";
  const summaryEl = document.createElement("summary");
  summaryEl.textContent = "What's contributing to this";
  details.appendChild(summaryEl);

  if (profile.categoryBreakdown && Object.keys(profile.categoryBreakdown).length) {
    const ul = document.createElement("ul");
    for (const [category, count] of Object.entries(profile.categoryBreakdown)) {
      const li = document.createElement("li");
      const explain = window.TrackerCategoryGlossary && TrackerCategoryGlossary.explainCategory(category);
      li.textContent = `${category} (${count}): ${explain || "no plain-language explanation available yet."}`;
      ul.appendChild(li);
    }
    details.appendChild(ul);
  }

  if (profile.fingerprintingBreakdown) {
    const highCount = profile.fingerprintingBreakdown.high || 0;
    if (highCount > 0 && window.TrackerCategoryGlossary) {
      const fpP = document.createElement("p");
      fpP.className = "muted";
      fpP.style.marginTop = "0.3rem";
      fpP.textContent = `${highCount} domain(s) with heavy fingerprinting capability: ${TrackerCategoryGlossary.explainFingerprinting(3)}`;
      details.appendChild(fpP);
    }
  }

  if (profile.flaggedOwners && profile.flaggedOwners.length) {
    const ownersP = document.createElement("p");
    ownersP.className = "muted";
    ownersP.style.marginTop = "0.3rem";
    ownersP.textContent = `Companies behind these trackers: ${profile.flaggedOwners.join(", ")}.`;
    details.appendChild(ownersP);
  }

  if (profile.unmatchedDomains && profile.unmatchedDomains.length) {
    const unmatchedP = document.createElement("p");
    unmatchedP.className = "muted";
    unmatchedP.style.marginTop = "0.3rem";
    unmatchedP.textContent = `${profile.unmatchedDomains.length} more domain(s) contacted, not yet in our tracker index.`;
    details.appendChild(unmatchedP);
  }

  container.appendChild(details);
}

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = els.input.value;
  if (!raw.trim()) return;
  const domain = bareDomain(raw);

  els.status.textContent = `Checking ${domain}…`;
  els.status.classList.remove("error");
  els.result.innerHTML = "";

  const card = document.createElement("div");
  card.className = "check-result-card";
  const title = document.createElement("strong");
  title.textContent = domain;
  card.appendChild(title);

  const disclosedContainer = document.createElement("div");
  card.appendChild(disclosedContainer);
  const observedContainer = document.createElement("div");
  card.appendChild(observedContainer);

  els.result.appendChild(card);
  els.status.textContent = "";

  const tosdrResult = await fetchTosdrRating(domain);
  renderDisclosed(disclosedContainer, tosdrResult);
  await renderObserved(observedContainer, domain);
});
