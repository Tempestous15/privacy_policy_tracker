// website/settings.html -- extUI4: concern-profile customization moved
// here from the extension popup (it was an in-popup "Customize what's
// recommended" picker; see popup.js's history comment above
// CLIPPRI_WEBSITE_SETTINGS_URL). Reads and writes the extension's
// concernProfileState directly via extension-bridge.js's two-way messages
// -- see website_bridge_background.js for the extension-side handlers.
//
// Every change here writes immediately (no separate "Save" button), same
// live-update behavior the old in-popup picker had. This page only ever
// changes what a future "Protect me from this site" recommends -- it
// can't block anything or clear any cookie itself; every actual action
// still requires its own explicit confirmation in the extension (see
// concern_profiles.js's header comment, unchanged by this move).

const els = {
  status: document.getElementById("status"),
  form: document.getElementById("settings-form"),
  profileOptions: document.getElementById("profile-options"),
  advancedOptions: document.getElementById("advanced-options"),
};

function renderProfileOptions(state) {
  els.profileOptions.innerHTML = "";
  for (const [id, profile] of Object.entries(CONCERN_PROFILES_DATA.PRESET_PROFILES)) {
    const label = document.createElement("label");
    label.className = "settings-option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "concern-profile";
    radio.value = id;
    radio.checked = state.activeProfile === id;
    radio.addEventListener("change", async () => {
      radio.disabled = true;
      const result = await ClipPriBridge.setActiveConcernProfile(id);
      radio.disabled = false;
      if (!result.ok) {
        showBridgeError();
        return;
      }
      renderAdvancedOptions(result.state);
    });
    label.appendChild(radio);
    const text = document.createElement("span");
    text.textContent = ` ${profile.label} — ${profile.description}`;
    label.appendChild(text);
    els.profileOptions.appendChild(label);
  }
}

function renderAdvancedOptions(state) {
  els.advancedOptions.innerHTML = "";
  const recommended = concernProfilesRecommendedCategoriesForState(state);
  for (const category of CONCERN_PROFILES_DATA.AUTO_FIX_CATEGORIES) {
    const alwaysOn = CONCERN_PROFILES_DATA.ALWAYS_RECOMMENDED_CATEGORIES.includes(category);
    const label = document.createElement("label");
    label.className = "settings-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = alwaysOn || recommended.has(category);
    checkbox.disabled = alwaysOn;
    checkbox.addEventListener("change", async () => {
      checkbox.disabled = true;
      const result = await ClipPriBridge.setConcernCategoryOverride(category, checkbox.checked);
      checkbox.disabled = alwaysOn; // stays disabled only if it's an always-on category
      if (!result.ok) {
        showBridgeError();
        return;
      }
    });
    label.appendChild(checkbox);
    const text = document.createElement("span");
    text.textContent = alwaysOn ? ` ${category} (always recommended)` : ` ${category}`;
    label.appendChild(text);
    els.advancedOptions.appendChild(label);
  }
}

function showBridgeError() {
  els.status.textContent =
    "Lost contact with the ClipPri extension while saving that change. Make sure it's still installed and enabled, then reload this page to try again.";
  els.status.classList.add("error");
}

async function init() {
  if (!ClipPriBridge.isExtensionMessagingSupported()) {
    els.status.textContent =
      "Settings require a Chromium-based browser (Chrome, Edge, Brave) with the ClipPri extension installed.";
    els.status.classList.add("error");
    return;
  }

  const result = await ClipPriBridge.requestConcernProfileStateFromExtension();

  if (!result.ok) {
    els.status.innerHTML =
      'No response from the ClipPri extension. Make sure it\'s installed and enabled, then reload this page. ' +
      '<a href="https://github.com/Tempestous15/privacy_policy_tracker/tree/main/extension" target="_blank" rel="noopener">Get the extension</a>.';
    return;
  }

  els.status.textContent = "Changes here save immediately and apply the next time you use \"Protect me from this site\" in the extension.";
  els.form.classList.remove("hidden");
  renderProfileOptions(result.state);
  renderAdvancedOptions(result.state);
}

init();
