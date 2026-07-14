// Renders the two independent halves of a summary panel:
//   1. the classifier result (RedFlagsEngine.analyze, from redflags-engine.js)
//      -- runs immediately, client-side, no server round trip.
//   2. the optional AI plain-English summary -- fetched on demand when the
//      "Get AI summary" button is clicked (see tracker.views.ai_summary).
(function () {
    function riskBadge(riskLevel) {
        var labels = {
            low: ["risk-low", "🟢 Low risk"],
            medium: ["risk-medium", "🟡 Medium risk"],
            high: ["risk-high", "🔴 High risk"],
        };
        var pair = labels[riskLevel] || ["risk-unknown", "⚪ Risk unknown"];
        var span = document.createElement("span");
        span.className = "risk-badge " + pair[0];
        span.textContent = pair[1];
        return span;
    }

    function renderClassifier(container, analysis) {
        container.innerHTML = "";
        container.appendChild(riskBadge(analysis.riskLevel));

        if (!analysis.categories.length) {
            var p = document.createElement("p");
            p.className = "summary-text";
            p.textContent = "No red flags detected by the automated scan.";
            container.appendChild(p);
            return;
        }

        var details = document.createElement("details");
        details.className = "summary-section red-flags";
        details.open = true;
        var summaryEl = document.createElement("summary");
        summaryEl.textContent = "🚩 Red flags (" + analysis.categories.length + ")";
        details.appendChild(summaryEl);
        var ul = document.createElement("ul");
        analysis.categories.forEach(function (cat) {
            var li = document.createElement("li");
            li.textContent = cat.label + (cat.matches.length ? ": “" + cat.matches[0] + "”" : "");
            ul.appendChild(li);
        });
        details.appendChild(ul);
        container.appendChild(details);
    }

    function initClassifierPanels() {
        if (typeof RedFlagsEngine === "undefined") return;
        document.querySelectorAll(".classifier-panel").forEach(function (container) {
            // Multi-panel pages (e.g. the dashboard's one row per saved
            // site) set data-content-id to their own json_script element;
            // single-panel pages (home.html/snapshot_detail.html) fall back
            // to the shared #policy-text-data id.
            var contentId = container.dataset.contentId || "policy-text-data";
            var dataEl = document.getElementById(contentId);
            if (!dataEl) return;
            var text = JSON.parse(dataEl.textContent);
            renderClassifier(container, RedFlagsEngine.analyze(text));
        });
    }

    function getCsrfToken() {
        var meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.content : null;
    }

    function summarySection(title, items) {
        var details = document.createElement("details");
        details.className = "summary-section";
        var summaryEl = document.createElement("summary");
        summaryEl.textContent = title;
        details.appendChild(summaryEl);
        var ul = document.createElement("ul");
        if (items && items.length) {
            items.forEach(function (item) {
                var li = document.createElement("li");
                li.textContent = item;
                ul.appendChild(li);
            });
        } else {
            var li = document.createElement("li");
            var em = document.createElement("em");
            em.textContent = "Not addressed.";
            li.appendChild(em);
            ul.appendChild(li);
        }
        details.appendChild(ul);
        return details;
    }

    function renderAiSummary(container, summary, mock) {
        container.innerHTML = "";
        if (mock) {
            var banner = document.createElement("p");
            banner.className = "mock-banner";
            banner.textContent = "⚠️ Mock summary — no API call was made. Set ANTHROPIC_API_KEY for a real AI summary.";
            container.appendChild(banner);
        }
        var p = document.createElement("p");
        p.className = "summary-text";
        p.textContent = summary.plain_english_summary;
        container.appendChild(p);
        container.appendChild(summarySection("📋 Data collected", summary.data_collected));
        container.appendChild(summarySection("⚙️ How data is used", summary.data_usage));
        container.appendChild(summarySection("🔁 Third-party sharing", summary.third_party_sharing));
        container.appendChild(summarySection("🗂️ Retention", summary.retention));
        container.appendChild(summarySection("🙋 Your rights", summary.user_rights));
        if (summary.user_takeaways && summary.user_takeaways.length) {
            var h4 = document.createElement("h4");
            h4.textContent = "✅ Takeaways";
            container.appendChild(h4);
            var ul = document.createElement("ul");
            summary.user_takeaways.forEach(function (item) {
                var li = document.createElement("li");
                li.textContent = item;
                ul.appendChild(li);
            });
            container.appendChild(ul);
        }
    }

    function initAiSummaryButtons() {
        // Buttons are disabled server-side (see _summary_panel.html) whenever
        // has_api_key is false, so a click here always has a usable key --
        // the API key itself is managed in one place, the dashboard.
        document.querySelectorAll(".ai-summary-btn").forEach(function (btn) {
            var block = btn.closest(".ai-summary-block");
            btn.addEventListener("click", function () {
                var websiteId = btn.dataset.websiteId;
                var resultEl = block.querySelector(".ai-summary-result");

                btn.disabled = true;
                resultEl.innerHTML = "Generating…";
                fetch("/site/" + websiteId + "/ai-summary/", {
                    method: "POST",
                    headers: { "X-CSRFToken": getCsrfToken() },
                })
                    .then(function (resp) {
                        return resp.json().then(function (data) {
                            return { ok: resp.ok, data: data };
                        });
                    })
                    .then(function (result) {
                        if (!result.ok) {
                            resultEl.innerHTML =
                                '<p class="mock-banner">' + (result.data.error || "Couldn't generate a summary.") + "</p>";
                            return;
                        }
                        if (!result.data.summary) {
                            resultEl.innerHTML =
                                '<p class="mock-banner">Couldn’t generate an AI summary: ' +
                                (result.data.summary_error || "unknown error") +
                                "</p>";
                            return;
                        }
                        renderAiSummary(resultEl, result.data.summary, result.data.mock);
                    })
                    .catch(function () {
                        resultEl.innerHTML = '<p class="mock-banner">Couldn’t reach the server.</p>';
                    })
                    .finally(function () {
                        btn.disabled = false;
                    });
            });
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        initClassifierPanels();
        initAiSummaryButtons();
    });
})();
