// Shared hover/focus tooltip component for glossary terms -- the reusable
// replacement for the old per-instance native <abbr title> pattern (see
// popup.js's git history: TERM_GLOSSARY/_abbr/_appendMixed). Content
// lives in glossary.js; this file only knows how to DISPLAY a term, not
// what any term means.
//
// One tooltip element, not one per trigger: every call to wrapTerm()
// below wires up a small trigger icon that shows/hides a single shared
// tooltip node (lazily created, appended to document.body once). This
// matters here specifically because more than one glossary trigger can
// exist on screen at once -- the current site's Observed tab plus any
// number of expanded Saved rows, each with their own tracker cards -- and
// a shared node avoids growing the DOM by one extra (mostly hidden)
// tooltip per occurrence.
//
// Positioning is measured fresh on every show() call via
// getBoundingClientRect() on the trigger -- popup.html's tab panels
// scroll (overflow-y: auto), and cards render inside <details> that can
// be anywhere in that scroll, so there's no static offset to precompute
// once. position: fixed (viewport-relative) is used deliberately instead
// of position: absolute, so the tooltip is never clipped by an
// overflow:hidden/auto ancestor (the tab panel, an open <details>, etc.)
// -- see the design spec's "must never get clipped or run off the edge"
// requirement.
(function () {
  const SHOW_DELAY_MS = 300;
  const HIDE_DELAY_MS = 100;
  const VIEWPORT_MARGIN = 8;
  const TRIGGER_GAP = 8;
  const TOOLTIP_ID = "glossary-tooltip";

  let tooltipEl = null;
  let arrowEl = null;
  let showTimer = null;
  let hideTimer = null;
  let activeTrigger = null;

  function ensureTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "glossary-tooltip";
    tooltipEl.id = TOOLTIP_ID;
    tooltipEl.setAttribute("role", "tooltip");
    // Keeps its own hover alive if the pointer moves from the trigger
    // onto the tooltip itself (e.g. to read a longer entry) instead of
    // hiding out from under the cursor.
    tooltipEl.addEventListener("mouseenter", cancelHide);
    tooltipEl.addEventListener("mouseleave", scheduleHide);

    arrowEl = document.createElement("div");
    arrowEl.className = "glossary-tooltip-arrow";
    tooltipEl.appendChild(arrowEl);

    const body = document.createElement("div");
    body.className = "glossary-tooltip-body";
    tooltipEl.appendChild(body);

    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function renderContent(entry) {
    const body = tooltipEl.querySelector(".glossary-tooltip-body");
    body.innerHTML = "";

    const heading = document.createElement("p");
    heading.className = "glossary-tooltip-term";
    heading.textContent = entry.term;
    body.appendChild(heading);

    const short = document.createElement("p");
    short.className = "glossary-tooltip-short";
    short.textContent = entry.short;
    body.appendChild(short);

    const example = document.createElement("p");
    example.className = "glossary-tooltip-example";
    const exampleLabel = document.createElement("strong");
    exampleLabel.textContent = "Example: ";
    example.appendChild(exampleLabel);
    example.appendChild(document.createTextNode(entry.example));
    body.appendChild(example);

    const why = document.createElement("p");
    why.className = "glossary-tooltip-why";
    const whyLabel = document.createElement("strong");
    whyLabel.textContent = "Why it matters: ";
    why.appendChild(whyLabel);
    why.appendChild(document.createTextNode(entry.why));
    body.appendChild(why);
  }

  // Measures at 0,0 with visibility hidden (still laid out, so
  // offsetWidth/offsetHeight are real) before computing the final
  // position -- the standard measure-then-place two-step, since the
  // tooltip's own size depends on its content and can't be assumed.
  function position(trigger) {
    tooltipEl.style.visibility = "hidden";
    tooltipEl.style.top = "0px";
    tooltipEl.style.left = "0px";
    tooltipEl.classList.remove("glossary-tooltip--above", "glossary-tooltip--below");

    const triggerRect = trigger.getBoundingClientRect();
    const tooltipWidth = tooltipEl.offsetWidth;
    const tooltipHeight = tooltipEl.offsetHeight;

    const spaceBelow = window.innerHeight - triggerRect.bottom - TRIGGER_GAP;
    const placeAbove = spaceBelow < tooltipHeight && triggerRect.top - TRIGGER_GAP > tooltipHeight;

    let top = placeAbove
      ? triggerRect.top - TRIGGER_GAP - tooltipHeight
      : triggerRect.bottom + TRIGGER_GAP;
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - tooltipHeight - VIEWPORT_MARGIN));

    let left = triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2;
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - tooltipWidth - VIEWPORT_MARGIN));

    tooltipEl.classList.add(placeAbove ? "glossary-tooltip--above" : "glossary-tooltip--below");
    tooltipEl.style.top = `${top}px`;
    tooltipEl.style.left = `${left}px`;

    // Arrow stays under the trigger's horizontal center even when the
    // tooltip itself had to shift to stay on-screen -- clamped to the
    // tooltip's own bounds so it never renders past its rounded corners.
    const triggerCenter = triggerRect.left + triggerRect.width / 2;
    let arrowLeft = triggerCenter - left;
    arrowLeft = Math.max(12, Math.min(arrowLeft, tooltipWidth - 12));
    arrowEl.style.left = `${arrowLeft}px`;

    tooltipEl.style.visibility = "visible";
  }

  function cancelShow() {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
  }

  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function onScrollWhileOpen() {
    hide();
  }

  function show(trigger, key, immediate) {
    const entry = window.Glossary.getGlossaryTerm(key);
    if (!entry) return; // unknown key -- fail quiet, never show a broken tooltip
    cancelHide();
    cancelShow();
    const run = () => {
      activeTrigger = trigger;
      ensureTooltip();
      renderContent(entry);
      position(trigger);
      tooltipEl.classList.add("glossary-tooltip--visible");
      trigger.setAttribute("aria-expanded", "true");
      window.addEventListener("scroll", onScrollWhileOpen, true);
    };
    if (immediate) run();
    else showTimer = setTimeout(run, SHOW_DELAY_MS);
  }

  function hide() {
    cancelShow();
    if (!tooltipEl) return;
    tooltipEl.classList.remove("glossary-tooltip--visible");
    if (activeTrigger) activeTrigger.setAttribute("aria-expanded", "false");
    activeTrigger = null;
    window.removeEventListener("scroll", onScrollWhileOpen, true);
  }

  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  }

  // Builds "Term <trigger icon>" as one inline unit and returns it --
  // callers append the returned node wherever the term should appear.
  // The icon is a small circled "i" (see popup.css's .glossary-trigger --
  // plain CSS shape, matching the rest of the popup's icon-free, emoji/
  // CSS-shape visual language rather than introducing an SVG icon set).
  //
  // Hover uses a short show delay (SHOW_DELAY_MS) so brushing past the
  // icon doesn't pop a tooltip, and a short hide delay (HIDE_DELAY_MS) so
  // moving from the icon onto the tooltip itself doesn't flicker it
  // closed. Keyboard focus shows immediately (no delay) since there's no
  // "brushing past" risk with deliberate tab navigation, and Escape
  // dismisses while focused -- see the design spec's keyboard/
  // aria-describedby nice-to-have.
  function wrapTerm(text, key) {
    const wrapper = document.createElement("span");
    wrapper.className = "glossary-term";

    const label = document.createElement("span");
    label.textContent = text;
    wrapper.appendChild(label);

    const trigger = document.createElement("span");
    trigger.className = "glossary-trigger";
    trigger.textContent = "i";
    trigger.setAttribute("tabindex", "0");
    trigger.setAttribute("role", "button");
    trigger.setAttribute("aria-label", `What is ${text}?`);
    trigger.setAttribute("aria-describedby", TOOLTIP_ID);
    trigger.setAttribute("aria-expanded", "false");

    trigger.addEventListener("mouseenter", () => show(trigger, key, false));
    trigger.addEventListener("mouseleave", scheduleHide);
    trigger.addEventListener("focus", () => show(trigger, key, true));
    trigger.addEventListener("blur", scheduleHide);
    trigger.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        hide();
        trigger.blur();
      }
    });

    wrapper.appendChild(trigger);
    return wrapper;
  }

  window.GlossaryTooltip = { wrapTerm, show, hide };
})();
