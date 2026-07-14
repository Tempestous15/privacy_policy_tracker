// Chrome (MV3, 99+) and Firefox both resolve these APIs as Promises when no
// callback is passed, so a single codebase works on both without vendoring
// webextension-polyfill.
const browserAPI = typeof browser !== "undefined" ? browser : chrome;

const els = {
  headerActions: document.getElementById("header-actions"),
  logoutBtn: document.getElementById("logout-btn"),
  setupScreen: document.getElementById("setup-screen"),
  serverUrlInput: document.getElementById("server-url-input"),
  connectBtn: document.getElementById("connect-btn"),
  setupError: document.getElementById("setup-error"),
  loginScreen: document.getElementById("login-screen"),
  usernameInput: document.getElementById("username-input"),
  passwordInput: document.getElementById("password-input"),
  loginBtn: document.getElementById("login-btn"),
  loginError: document.getElementById("login-error"),
  changeServerBtn: document.getElementById("change-server-btn"),
  mainScreen: document.getElementById("main-screen"),
  currentTabHost: document.getElementById("current-tab-host"),
  checkBtn: document.getElementById("check-btn"),
  lookupResult: document.getElementById("lookup-result"),
  savedList: document.getElementById("saved-list"),
  globalError: document.getElementById("global-error"),
  apiKeyStatus: document.getElementById("api-key-status"),
  apiKeyInput: document.getElementById("api-key-input"),
  saveApiKeyBtn: document.getElementById("save-api-key-btn"),
  removeApiKeyBtn: document.getElementById("remove-api-key-btn"),
};

let state = { apiBaseUrl: null, token: null, hasApiKey: false };

function showScreen(name) {
  for (const s of ["setup-screen", "login-screen", "main-screen"]) {
    document.getElementById(s).classList.toggle("hidden", s !== name);
  }
  els.headerActions.classList.toggle("hidden", name !== "main-screen");
}

function showError(el, message) {
  el.textContent = message;
  el.classList.remove("hidden");
}

function clearError(el) {
  el.textContent = "";
  el.classList.add("hidden");
}

async function loadState() {
  const stored = await browserAPI.storage.local.get(["apiBaseUrl", "token"]);
  state.apiBaseUrl = stored.apiBaseUrl || null;
  state.token = stored.token || null;
}

async function saveState() {
  await browserAPI.storage.local.set({
    apiBaseUrl: state.apiBaseUrl,
    token: state.token,
  });
}

async function apiFetch(path, options = {}) {
  const headers = options.headers || {};
  if (state.token) {
    headers["Authorization"] = `Token ${state.token}`;
  }
  const resp = await fetch(state.apiBaseUrl + path, { ...options, headers });
  if (resp.status === 401) {
    state.token = null;
    await saveState();
    showScreen("login-screen");
    throw new Error("Session expired, please log in again.");
  }
  return resp;
}

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

function summarySection(title, items) {
  const details = document.createElement("details");
  details.className = "summary-section";
  const summary = document.createElement("summary");
  summary.textContent = title;
  details.appendChild(summary);
  const ul = document.createElement("ul");
  if (items && items.length) {
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item;
      ul.appendChild(li);
    }
  } else {
    const li = document.createElement("li");
    const em = document.createElement("em");
    em.textContent = "Not addressed.";
    li.appendChild(em);
    ul.appendChild(li);
  }
  details.appendChild(ul);
  return details;
}

// Primary, always-on result: runs RedFlagsEngine.analyze() (see
// redflags-engine.js / classifier/README.md) on raw policy text locally,
// with no server call and no API key needed. Mirrors
// templates/tracker/_summary_panel.html's classifier panel.
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

// Optional, on-demand result -- only rendered after the user clicks "Get AI
// summary" (see initAiSummaryButton). Mirrors the AI-summary half of
// templates/tracker/_summary_panel.html.
function renderAiSummary(container, summary, mock) {
  container.innerHTML = "";
  if (mock) {
    const banner = document.createElement("p");
    banner.className = "mock-banner";
    banner.textContent = "⚠️ Mock summary — no API call was made. Set ANTHROPIC_API_KEY for a real AI summary.";
    container.appendChild(banner);
  }

  const p = document.createElement("p");
  p.className = "summary-text";
  p.textContent = summary.plain_english_summary;
  container.appendChild(p);

  container.appendChild(summarySection("📋 Data collected", summary.data_collected));
  container.appendChild(summarySection("⚙️ How data is used", summary.data_usage));
  container.appendChild(summarySection("🔁 Third-party sharing", summary.third_party_sharing));
  container.appendChild(summarySection("🗂️ Retention", summary.retention));
  container.appendChild(summarySection("🙋 Your rights", summary.user_rights));

  if (summary.user_takeaways && summary.user_takeaways.length) {
    const h4 = document.createElement("h4");
    h4.textContent = "✅ Takeaways";
    container.appendChild(h4);
    const ul = document.createElement("ul");
    for (const item of summary.user_takeaways) {
      const li = document.createElement("li");
      li.textContent = item;
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }
}

// Appends a "Get AI summary" button + result container to `parent`, wired
// to POST /api/ai-summary/<websiteId>/ only when clicked -- never
// automatically. Disabled whenever state.hasApiKey is false; the API key
// itself is managed in one place, the "AI summary API key" card below, not
// here. Returns nothing; mutates `parent`.
function addAiSummaryButton(parent, websiteId) {
  const block = document.createElement("div");
  block.className = "ai-summary-block";

  const btn = document.createElement("button");
  btn.className = "link-btn ai-summary-btn";
  btn.textContent = "Get AI summary";
  if (!state.hasApiKey) {
    btn.disabled = true;
    btn.title = "Add your Anthropic API key below to enable this";
  }

  const resultEl = document.createElement("div");

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    resultEl.textContent = "Generating…";
    try {
      const resp = await apiFetch(`/api/ai-summary/${websiteId}/`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) {
        resultEl.innerHTML = `<p class="error">${data.error || "Couldn't generate a summary."}</p>`;
      } else if (!data.summary) {
        resultEl.innerHTML = `<p class="error">Couldn't generate an AI summary: ${data.summary_error || "unknown error"}</p>`;
      } else {
        renderAiSummary(resultEl, data.summary, data.mock);
      }
    } catch (err) {
      resultEl.innerHTML = `<p class="error">${err.message}</p>`;
    } finally {
      btn.disabled = false;
    }
  });

  if (!state.hasApiKey) {
    const hint = document.createElement("p");
    hint.className = "muted ai-summary-hint";
    hint.textContent = "Add your API key below to enable this.";
    block.appendChild(btn);
    block.appendChild(hint);
  } else {
    block.appendChild(btn);
  }
  block.appendChild(resultEl);
  parent.appendChild(block);
}

async function refreshApiKeyStatus() {
  try {
    const resp = await apiFetch("/api/api-key/status/");
    const data = await resp.json();
    state.hasApiKey = !!data.has_api_key;
    els.apiKeyStatus.textContent = data.has_saved_api_key ? "✓ API key saved" : "";
    els.removeApiKeyBtn.classList.toggle("hidden", !data.has_saved_api_key);
  } catch (err) {
    // best-effort -- AI-summary buttons just stay disabled if this fails
  }
}

async function getCurrentTabUrl() {
  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.url : null;
}

async function refreshSavedList() {
  els.savedList.innerHTML = "Loading…";
  try {
    const resp = await apiFetch("/api/saved/");
    if (!resp.ok) throw new Error("Couldn't load saved sites.");
    const items = await resp.json();
    els.savedList.innerHTML = "";
    if (!items.length) {
      els.savedList.innerHTML = '<p class="muted">Nothing saved yet.</p>';
      return;
    }
    for (const item of items) {
      const div = document.createElement("div");
      div.className = "saved-item";

      const headerRow = document.createElement("div");
      headerRow.className = "saved-item-header";
      const name = document.createElement("strong");
      name.textContent = item.website.name;
      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-btn";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        await apiFetch(`/api/saved/${item.website.id}/`, { method: "DELETE" });
        refreshSavedList();
      });
      headerRow.appendChild(name);
      headerRow.appendChild(removeBtn);
      div.appendChild(headerRow);

      const classifierContainer = document.createElement("div");
      renderClassifier(classifierContainer, item.content);
      div.appendChild(classifierContainer);
      addAiSummaryButton(div, item.website.id);

      els.savedList.appendChild(div);
    }
  } catch (err) {
    els.savedList.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

async function initMainScreen() {
  showScreen("main-screen");
  const tabUrl = await getCurrentTabUrl();
  els.currentTabHost.textContent = tabUrl ? new URL(tabUrl).hostname : "(no active tab)";
  els.checkBtn.onclick = async () => {
    if (!tabUrl) return;
    els.checkBtn.disabled = true;
    els.lookupResult.innerHTML = "Checking…";
    try {
      const resp = await apiFetch(
        `/api/lookup/?url=${encodeURIComponent(tabUrl)}&save=true`
      );
      const data = await resp.json();
      els.lookupResult.innerHTML = "";
      if (!resp.ok) {
        els.lookupResult.innerHTML = `<p class="error">${data.error || "Lookup failed."}</p>`;
      } else if (!data.result.found) {
        els.lookupResult.innerHTML = `<p class="muted">${data.result.error || "No privacy policy found."}</p>`;
      } else {
        renderClassifier(els.lookupResult, data.content);
        if (data.website) addAiSummaryButton(els.lookupResult, data.website.id);
        refreshSavedList();
      }
    } catch (err) {
      els.lookupResult.innerHTML = `<p class="error">${err.message}</p>`;
    } finally {
      els.checkBtn.disabled = false;
    }
  };

  els.saveApiKeyBtn.onclick = async () => {
    const apiKey = els.apiKeyInput.value.trim();
    if (!apiKey) return;
    els.saveApiKeyBtn.disabled = true;
    try {
      await apiFetch("/api/api-key/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ api_key: apiKey }),
      });
      els.apiKeyInput.value = "";
      await refreshApiKeyStatus();
      refreshSavedList();
    } finally {
      els.saveApiKeyBtn.disabled = false;
    }
  };

  els.removeApiKeyBtn.onclick = async () => {
    els.removeApiKeyBtn.disabled = true;
    try {
      await apiFetch("/api/api-key/", { method: "DELETE" });
      await refreshApiKeyStatus();
      refreshSavedList();
    } finally {
      els.removeApiKeyBtn.disabled = false;
    }
  };

  await refreshApiKeyStatus();
  refreshSavedList();
}

// Firefox's address bar hides the "http://" prefix when displaying a URL,
// so a value copied from it often arrives with no scheme at all. Default
// that case to http for loopback/private hosts (local dev servers), since
// defaulting to https would silently try (and fail) a TLS handshake against
// a plain-HTTP dev server.
function isLocalHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

els.connectBtn.addEventListener("click", async () => {
  clearError(els.setupError);
  let url = els.serverUrlInput.value.trim();
  if (!url) return;
  if (!/^https?:\/\//.test(url)) {
    const hostname = url.split(/[/:]/)[0];
    url = `${isLocalHost(hostname) ? "http" : "https"}://${url}`;
  }
  url = url.replace(/\/$/, "");

  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    showError(els.setupError, "That doesn't look like a valid URL.");
    return;
  }

  const granted = await browserAPI.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    showError(els.setupError, "Permission is required to connect to your server.");
    return;
  }

  state.apiBaseUrl = url;
  await saveState();
  showScreen("login-screen");
});

els.changeServerBtn.addEventListener("click", async () => {
  state.apiBaseUrl = null;
  state.token = null;
  await saveState();
  showScreen("setup-screen");
});

els.loginBtn.addEventListener("click", async () => {
  clearError(els.loginError);
  const username = els.usernameInput.value.trim();
  const password = els.passwordInput.value;
  if (!username || !password) return;

  try {
    const resp = await fetch(`${state.apiBaseUrl}/api/login/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      showError(els.loginError, "Incorrect username or password.");
      return;
    }
    state.token = data.token;
    await saveState();
    els.passwordInput.value = "";
    initMainScreen();
  } catch (err) {
    showError(els.loginError, "Couldn't reach the server.");
  }
});

els.logoutBtn.addEventListener("click", async () => {
  try {
    await apiFetch("/api/logout/", { method: "POST" });
  } catch {
    // token already invalid/expired -- fine, we're clearing it anyway
  }
  state.token = null;
  await saveState();
  showScreen("login-screen");
});

(async function init() {
  await loadState();
  if (!state.apiBaseUrl) {
    showScreen("setup-screen");
  } else if (!state.token) {
    showScreen("login-screen");
  } else {
    initMainScreen();
  }
})();
