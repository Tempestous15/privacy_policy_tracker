// Source for ../webllm-client.js (bundled by build.sh). Runs in the popup;
// proxies chat completions to the model actually running in the service
// worker (background.js) over a chrome.runtime.Port -- see
// CreateExtensionServiceWorkerMLCEngine. No network call to any server of
// ours; the only network traffic is the one-time model-weight download from
// the model's host (see manifest.json host_permissions).
import { CreateExtensionServiceWorkerMLCEngine } from "@mlc-ai/web-llm";

// A small instruct model chosen for fast load/inference in a popup context.
// Swappable later -- CreateExtensionServiceWorkerMLCEngine just takes a
// different model id from webllm.prebuiltAppConfig.
const MODEL_ID = "Qwen2-0.5B-Instruct-q4f16_1-MLC";

// llmUI: the excerpt is now flavor/tone context only, not the primary
// source of facts (see FINDINGS_PROMPT_TEMPLATE below) -- so it can be much
// shorter than before. Smaller input also means a smaller chance of a 0.5B
// model wandering off into a long, unfocused ramble, which was the main
// complaint driving this change.
const MAX_EXCERPT_CHARS = 1200;

// llmUI: previously this model read the *raw policy text* and tried to
// both find issues AND explain them in one pass -- extraction from legal
// text is exactly the kind of precise task a 0.5B model is bad at, and it
// duplicated work the local regex classifier (redflags-engine.js) already
// does reliably. Now the caller (popup.js) passes in the classifier's
// already-verified findings (plus ToS;DR/Tracker Radar results, if
// available) as `findings`, and the model's only job is to explain facts
// it's handed in plain English -- paraphrasing is a much easier, more
// reliable task for a model this size than extraction was.
//
// Output format: three short labelled lines rather than free prose or
// strict JSON. Small local models are unreliable at strict JSON schemas,
// but a fixed set of labels is enough structure for popup.js to render
// compact, scannable rows instead of one dense paragraph -- and it's much
// more likely a tiny model actually follows a 3-line template than a JSON
// schema. popup.js parses leniently and falls back to showing the raw
// text (truncated) if the labels aren't found.
const FINDINGS_PROMPT_TEMPLATE =
  "You are a friendly consumer privacy explainer. An automated scan of this site's privacy policy already " +
  "found the facts listed below -- they are verified, do not re-derive or second-guess them. Your only job " +
  "is to explain what they mean in short, plain, non-legal English for someone in a hurry. Do not invent " +
  "facts that are not listed below.\n\n" +
  "Automated findings:\n{findings}\n\n" +
  "A short excerpt from the policy, for tone and context only:\n\"\"\"\n{policy_excerpt}\n\"\"\"\n\n" +
  "Reply with EXACTLY three lines, each starting with the label shown, and nothing else before or after them:\n" +
  "WHAT: one short sentence on what data this service collects or does.\n" +
  "CONCERNS: one short sentence on what to actually watch out for, in plain terms.\n" +
  "BOTTOM LINE: one short, actionable sentence for a regular person.";

// Used when the classifier found nothing to flag -- a different prompt
// rather than an empty "Automated findings" section, so the model isn't
// left guessing what to fill that gap with.
const CLEAN_PROMPT_TEMPLATE =
  "You are a friendly consumer privacy explainer. An automated scan of this site's privacy policy did not " +
  "find any of the common red flags it checks for (vague data sharing, indefinite retention, broad content " +
  "licenses, and similar). Using only the short excerpt below, briefly explain in plain English roughly what " +
  "kind of data a service like this typically handles. Do not invent specific facts the excerpt does not " +
  "support.\n\n" +
  "A short excerpt from the policy:\n\"\"\"\n{policy_excerpt}\n\"\"\"\n\n" +
  "Reply with EXACTLY three lines, each starting with the label shown, and nothing else before or after them:\n" +
  "WHAT: one short sentence on what data this service appears to collect.\n" +
  "CONCERNS: one short sentence noting plainly that the automated scan found no common red flags.\n" +
  "BOTTOM LINE: one short, actionable sentence for a regular person.";

let enginePromise = null;

function loadEngine(onProgress) {
  if (!enginePromise) {
    enginePromise = CreateExtensionServiceWorkerMLCEngine(MODEL_ID, {
      initProgressCallback: onProgress,
    });
  }
  return enginePromise;
}

// `findings` is a plain-text bullet list built by popup.js from the local
// classifier (and ToS;DR/Tracker Radar results, when available) -- pass
// null/empty when nothing was flagged to use the CLEAN_PROMPT_TEMPLATE
// instead. Returns the raw three-line model output as a string; popup.js
// owns parsing it into WHAT/CONCERNS/BOTTOM LINE rows.
async function summarizePolicy(policyText, findings, onProgress) {
  const engine = await loadEngine(onProgress);
  const excerpt = (policyText || "").slice(0, MAX_EXCERPT_CHARS);
  const template = findings && findings.trim() ? FINDINGS_PROMPT_TEMPLATE : CLEAN_PROMPT_TEMPLATE;
  const prompt = template
    .replace("{findings}", findings || "")
    .replace("{policy_excerpt}", excerpt);
  const completion = await engine.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 220,
  });
  const text = completion.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("The local model returned an empty response.");
  return text;
}

async function unloadEngine() {
  if (enginePromise) {
    const engine = await enginePromise;
    await engine.unload();
    enginePromise = null;
  }
}

window.WebLLMClient = { summarizePolicy, unloadEngine, MODEL_ID };
