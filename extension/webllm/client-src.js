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
// source of facts (see FINDINGS_PROMPT_TEMPLATE below) -- so it can be
// fairly short. Kept smaller than the first llmUI pass to make room for
// the worked example below without ballooning total prompt size.
const MAX_EXCERPT_CHARS = 800;

// llmUI round 2: the first version of this prompt produced technically-
// correct but vague, unhelpful output ("this site collects data and may
// share it with partners") -- a 0.5B model left to its own devices
// defaults to generic-sounding text even when told to be specific. Adding
// one concrete worked example (few-shot) is the highest-leverage fix for
// that at this model size: it shows the model what "specific" actually
// looks like (naming the finding, not just gesturing at it) far more
// reliably than instructions alone. Also added a fourth line -- users
// asked not just "what's wrong" but "what do I do about it" -- so the
// model now has to name one concrete, checkable action (a setting, a
// habit, something to avoid) rather than stopping at describing the risk.
const FINDINGS_PROMPT_TEMPLATE =
  "You are a friendly consumer privacy explainer. An automated scan of this site's privacy policy already " +
  "found the facts listed below -- they are verified, do not re-derive or second-guess them. Explain what " +
  "they mean in short, plain, non-legal English, and suggest one concrete thing the person can do to protect " +
  "themselves. Be specific -- reference the actual findings, don't write generic advice that could apply to " +
  "any website. Do not invent facts that are not listed below.\n\n" +
  "Example findings:\n" +
  "- Vague third-party sharing (found in the policy text, medium severity)\n" +
  "- ToS;DR community rating: D\n" +
  "- 12 third-party tracker(s) actually detected loading on this site (independent of what the policy says), " +
  "across 5 companies\n\n" +
  "Example reply:\n" +
  "WHAT: This site tracks your activity and shares it with vague, unnamed \"partners.\"\n" +
  "CONCERNS: The sharing language is vague and 12 trackers from 5 different companies were actually seen " +
  "loading, so your activity is likely reaching advertisers well beyond this site.\n" +
  "PROTECT YOURSELF: Turn on \"block third-party cookies\" in your browser and avoid signing in with " +
  "Google or Facebook here, since that links your real identity to the tracking.\n" +
  "BOTTOM LINE: Usable, but assume anything you do here gets shared with advertisers by default.\n\n" +
  "Now do the same for this site.\n\n" +
  "Automated findings:\n{findings}\n\n" +
  "A short excerpt from the policy, for tone and context only:\n\"\"\"\n{policy_excerpt}\n\"\"\"\n\n" +
  "Reply with EXACTLY four lines, each starting with the label shown, and nothing else before or after them:\n" +
  "WHAT: one short sentence on what data this service collects or does.\n" +
  "CONCERNS: one short sentence on what to actually watch out for, referencing the findings above.\n" +
  "PROTECT YOURSELF: one concrete, specific action -- a setting to change, something to avoid, a habit. " +
  "Not generic advice like \"be careful\" or \"read the policy.\"\n" +
  "BOTTOM LINE: one short, actionable sentence for a regular person.";

// Used when the classifier found nothing to flag -- a different prompt
// rather than an empty "Automated findings" section, so the model isn't
// left guessing what to fill that gap with. Still asks for a protective
// tip: "no red flags found" doesn't mean "no privacy footprint."
const CLEAN_PROMPT_TEMPLATE =
  "You are a friendly consumer privacy explainer. An automated scan of this site's privacy policy did not " +
  "find any of the common red flags it checks for (vague data sharing, indefinite retention, broad content " +
  "licenses, and similar). Using only the short excerpt below, briefly explain in plain English roughly what " +
  "kind of data a service like this typically handles, and suggest one concrete, generally-good privacy habit " +
  "relevant to that kind of service. Do not invent specific facts the excerpt does not support, and don't " +
  "write vague advice like \"be careful\" -- name an actual setting or habit.\n\n" +
  "Example reply (for a photo-sharing site with no red flags found):\n" +
  "WHAT: This service stores the photos and account details you upload to it.\n" +
  "CONCERNS: The automated scan found none of the common red flags, but uploaded photos often carry hidden " +
  "location data (EXIF metadata) unless the app strips it.\n" +
  "PROTECT YOURSELF: Check the app's photo-upload settings for a \"remove location data\" or \"strip EXIF\" " +
  "option, or strip it yourself before uploading.\n" +
  "BOTTOM LINE: No red flags found -- a reasonable choice, with the usual care around what you upload.\n\n" +
  "Now do the same for this site.\n\n" +
  "A short excerpt from the policy:\n\"\"\"\n{policy_excerpt}\n\"\"\"\n\n" +
  "Reply with EXACTLY four lines, each starting with the label shown, and nothing else before or after them:\n" +
  "WHAT: one short sentence on what data this service appears to collect.\n" +
  "CONCERNS: one short sentence -- note plainly that the automated scan found no common red flags, but you " +
  "may add one realistic, non-alarmist consideration for this type of service.\n" +
  "PROTECT YOURSELF: one concrete, specific action -- a setting to change, something to avoid, a habit.\n" +
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
// instead. Returns the raw four-line model output as a string; popup.js
// owns parsing it into WHAT/CONCERNS/PROTECT YOURSELF/BOTTOM LINE rows.
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
    max_tokens: 280,
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
