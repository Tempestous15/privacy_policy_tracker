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

// Returns { ok: true, rating } | { ok: true, rating: null } (no review
// found) | { ok: false, reason: "cors-or-network" }. Never throws.
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
    return { ok: true, rating: service ? service.rating || "N/A" : null };
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
