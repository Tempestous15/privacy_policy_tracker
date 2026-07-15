// Client for ToS;DR's public API (https://docs.tosdr.org/) -- a free,
// crowdsourced, human-reviewed source of ratings/points for well-known
// services. Supplementary to the local classifier, not a replacement: this
// only has data for sites ToS;DR has already reviewed, and is a network
// call to ToS;DR (see manifest.json host_permissions) -- never to a server
// of ours, since we don't have one.
const TOSDR_API_BASE = "https://api.tosdr.org";

async function findServiceByDomain(domain) {
  const bareDomain = domain.replace(/^www\./, "");
  const resp = await fetch(
    `${TOSDR_API_BASE}/search/v5?query=${encodeURIComponent(bareDomain)}`
  );
  if (!resp.ok) throw new Error(`ToS;DR search failed (${resp.status})`);
  const data = await resp.json();
  const services = data.services || [];

  // Prefer a service whose listed URLs actually contain this domain, since
  // a free-text search can return loosely related results.
  const exact = services.find((svc) =>
    (svc.urls || []).some((u) => {
      try {
        return new URL(u).hostname.replace(/^www\./, "") === bareDomain;
      } catch {
        return false;
      }
    })
  );
  return exact || services[0] || null;
}

async function getServiceDetail(id) {
  const resp = await fetch(`${TOSDR_API_BASE}/service/v3?id=${encodeURIComponent(id)}`);
  if (!resp.ok) throw new Error(`ToS;DR service lookup failed (${resp.status})`);
  return resp.json();
}

// Returns null if ToS;DR has no review for this domain, otherwise
// { rating, points: [{ title, severity, description }] }.
async function lookupDomain(domain) {
  const service = await findServiceByDomain(domain);
  if (!service) return null;

  const detail = await getServiceDetail(service.id);
  const points = (detail.points || [])
    .filter((p) => p.case)
    .map((p) => ({
      title: p.title,
      severity: p.case.classification || "neutral", // e.g. "good" | "bad" | "blocker" | "neutral"
      description: p.case.description || "",
    }));

  return { rating: detail.rating || service.rating || "N/A", points };
}

window.TosdrClient = { lookupDomain };
