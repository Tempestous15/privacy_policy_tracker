/**
 * content.js
 *
 * The actual content script entry point. It is injected on demand -- via
 * chrome.scripting.executeScript from background.js -- and ONLY when the
 * user clicks "Scan this site" in the popup. It is never listed in
 * manifest.json's content_scripts, so it never runs automatically on page
 * load and leaves nothing behind afterwards: no persistent listeners, no
 * DOM changes, no state. That's deliberate -- this is a one-shot page
 * inspection, not passive/continuous monitoring.
 *
 * It reads nothing beyond the page's visible <a href> links (via
 * policyFinder.js, injected immediately before this file) and sends the
 * result back to background.js as a single message.
 */
(function () {
  try {
    var result = scanForPrivacyPolicy(document.location.href, document);
    chrome.runtime.sendMessage({ type: "PPT_SCAN_RESULT", payload: result });
  } catch (err) {
    chrome.runtime.sendMessage({
      type: "PPT_SCAN_RESULT",
      payload: null,
      error: String((err && err.message) || err),
    });
  }
})();
