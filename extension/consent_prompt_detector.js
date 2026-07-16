// Detects cookie/consent prompts and privacy-policy consent checkboxes as
// they appear on the page, and asks the background service worker
// (consent_prompt_background.js) whether this site is high-risk enough to
// warn about right now -- at the moment the user is actually being asked
// to accept something, not just whenever they happen to click the
// toolbar icon. See root README.md / extension/README.md "Timing the
// warning" for why this moment matters.
//
// Content script, isolated world (default), injected automatically via
// manifest.json's content_scripts on every top-level page -- this is a
// real behavior change from the rest of the extension, which otherwise
// only ever runs when the user clicks something (see popup.js/
// discovery.js). It does not read page content beyond checking for
// consent-prompt-shaped DOM elements and their visible button/label text;
// it never reads form field values, page body text generally, or
// anything else, and never fetches anything itself -- it only messages
// the background, which does its own lightweight, already-described
// lookups (see consent_prompt_background.js).
//
// Milestone 1 scope: detects the *presence* of a likely consent prompt
// via known CMP (Consent Management Platform) vendor markup plus a
// generic text+button+positioning heuristic. This is deliberately not a
// perfect classifier -- false negatives (a real prompt we don't
// recognize) are far more likely than false positives, given the
// precision gates below. See "Known limitations" in extension/README.md.

(() => {
  // Known CMP vendor DOM signatures -- catches a large share of real
  // sites since a handful of vendors dominate the market. High
  // confidence: a match here is essentially never a false positive.
  const CMP_SELECTORS = [
    "#onetrust-banner-sdk", "#onetrust-consent-sdk", ".ot-sdk-container",
    "#CybotCookiebotDialog", "#cookiebot",
    "#didomi-host", ".didomi-popup-container",
    ".qc-cmp2-container", "#qc-cmp2-container",
    "#usercentrics-root", "#usercentrics-cmp-ui",
    "#truste-consent-track", ".truste_box_overlay",
    "#osano-cm-window", ".osano-cm-dialog",
    "#termly-code-snippet-support", ".t-cw",
    ".cc-window", "#cookie-law-info-bar",
    "#cmpbox", ".cmpboxBG",
    "#sp_message_container",
    "#gdpr-consent-tool-wrapper",
  ];

  // Generic fallback heuristic thresholds.
  const TEXT_PATTERN = /cookie|consent|gdpr|privacy policy|we (use|process).{0,20}(data|cookies)/i;
  const ACTION_BUTTON_PATTERN = /^(accept|agree|allow|got it|ok|okay|continue|i understand|i agree|consent|allow all|accept all)\b/i;
  const CONTAINER_HINT_PATTERN = /cookie|consent|gdpr|banner|gdpr-modal|privacy-modal|overlay/i;

  // Sign-up / account-creation consent checkboxes -- a different moment
  // (agreeing to ToS/privacy policy to create an account or complete a
  // purchase), same "warn right now" treatment.
  const CHECKBOX_LABEL_PATTERN = /(i agree|i accept|i have read).{0,50}(privacy policy|terms of service|terms and conditions|terms & conditions)/i;

  const _seen = new WeakSet();
  let _warned = false;
  let _observer = null;
  let _timeoutId = null;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function findCmpMatch() {
    for (const selector of CMP_SELECTORS) {
      const el = document.querySelector(selector);
      if (el && isVisible(el) && !_seen.has(el)) return el;
    }
    return null;
  }

  // Generic heuristic: a visible element containing consent-ish text AND
  // an actionable button, gated on a positioning/container-naming signal
  // so an unrelated "Accept" button elsewhere on the page (e.g. a
  // checkout flow) doesn't false-positive just from a keyword match.
  function findGenericConsentBanner() {
    const candidates = document.querySelectorAll(
      "body > div, body > section, body > aside, [role='dialog'], [role='alertdialog']"
    );
    for (const el of candidates) {
      if (_seen.has(el) || !isVisible(el)) continue;
      const text = (el.textContent || "").slice(0, 2000);
      if (!TEXT_PATTERN.test(text)) continue;

      const buttons = el.querySelectorAll("button, a[role='button'], [class*='button'], [class*='btn']");
      const hasActionButton = Array.from(buttons).some((b) =>
        ACTION_BUTTON_PATTERN.test((b.textContent || "").trim())
      );
      if (!hasActionButton) continue;

      const style = window.getComputedStyle(el);
      const isOverlayPositioned = style.position === "fixed" || style.position === "sticky";
      const idAndClass = `${el.id || ""} ${el.className || ""}`;
      const hasContainerHint = CONTAINER_HINT_PATTERN.test(idAndClass);
      if (isOverlayPositioned || hasContainerHint) return el;
    }
    return null;
  }

  function findConsentCheckbox() {
    const checkboxes = document.querySelectorAll("input[type='checkbox']");
    for (const cb of checkboxes) {
      if (_seen.has(cb) || !isVisible(cb)) continue;
      let labelText = "";
      if (cb.id) {
        // Iterate rather than build a CSS selector from cb.id -- avoids
        // any dependency on CSS.escape() being available/correct, and
        // sidesteps selector-syntax edge cases in real-world ids.
        for (const label of document.querySelectorAll("label")) {
          if (label.htmlFor === cb.id) {
            labelText += " " + (label.textContent || "");
            break;
          }
        }
      }
      const parentLabel = cb.closest("label");
      if (parentLabel) labelText += " " + (parentLabel.textContent || "");
      // Nearby text siblings (some markup doesn't use <label> at all).
      if (cb.parentElement) labelText += " " + (cb.parentElement.textContent || "");
      if (CHECKBOX_LABEL_PATTERN.test(labelText)) return cb;
    }
    return null;
  }

  function anchorElementFor(match) {
    // Prefer a stable container to anchor the banner near -- the matched
    // checkbox itself is often tiny/inline, so anchor near its label's
    // container instead when that's what matched.
    return match.closest("form, [role='dialog'], [role='alertdialog']") || match;
  }

  function evaluateOnce() {
    if (_warned) return;
    const match = findCmpMatch() || findGenericConsentBanner() || findConsentCheckbox();
    if (!match) return;
    _seen.add(match);

    chrome.runtime.sendMessage(
      { type: "consentPromptDetected", domain: window.location.hostname },
      (response) => {
        if (chrome.runtime.lastError || !response || !response.warn) return;
        _warned = true;
        renderWarningBanner(anchorElementFor(match), response);
        stopObserving();
      }
    );
  }

  function stopObserving() {
    if (_observer) _observer.disconnect();
    if (_timeoutId) clearTimeout(_timeoutId);
  }

  function renderWarningBanner(anchorEl, decision) {
    if (document.getElementById("clippri-consent-warning")) return;

    const banner = document.createElement("div");
    banner.id = "clippri-consent-warning";
    banner.setAttribute("data-clippri", "true"); // excluded from our own mutation scanning, see observer callback below
    banner.style.cssText = [
      "position:fixed", "top:12px", "right:12px", "z-index:2147483647",
      "max-width:320px", "background:#fff8e6", "border:1px solid #e3c95c",
      "border-radius:10px", "box-shadow:0 4px 16px rgba(0,0,0,0.18)",
      "padding:12px 14px", "font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "color:#2c2117",
    ].join(";");

    const title = document.createElement("div");
    title.style.cssText = "font-weight:700;margin-bottom:4px;";
    title.textContent = "⚠️ ClipPri: worth a look before you agree";

    const body = document.createElement("div");
    body.style.cssText = "margin-bottom:8px;color:#4a3728;";
    body.textContent = decision.reason || "This site's disclosed policy and observed behavior are worth checking.";

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:12px;color:#8a7b6b;margin-bottom:8px;";
    hint.textContent = "Click the ClipPri icon in your toolbar to see the full picture.";

    const dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss";
    dismiss.style.cssText = [
      "background:#4a3728", "color:#fffdf7", "border:none", "border-radius:6px",
      "padding:5px 10px", "font-size:12px", "font-weight:600", "cursor:pointer",
    ].join(";");
    dismiss.addEventListener("click", () => banner.remove());

    banner.appendChild(title);
    banner.appendChild(body);
    banner.appendChild(hint);
    banner.appendChild(dismiss);
    document.documentElement.appendChild(banner);
  }

  function start() {
    evaluateOnce();
    _observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.dataset && node.dataset.clippri) continue; // ignore our own banner
          evaluateOnce();
          if (_warned) return;
        }
      }
    });
    _observer.observe(document.documentElement, { childList: true, subtree: true });
    // Consent prompts that never show up (or that we never recognize)
    // shouldn't leave an observer running indefinitely -- stop after a
    // reasonable window past page load.
    _timeoutId = setTimeout(stopObserving, 20000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
