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

// Keep the prompt short: small local models have limited context and get
// less reliable as input grows, and this keeps first-token latency down.
const MAX_POLICY_CHARS = 6000;

const PROMPT_TEMPLATE = `You are a consumer privacy analyst. Read the privacy policy text below and explain \
it in plain, simple English for someone who is not a lawyer. Write 4-6 sentences covering: what data is \
collected, how it is used, whether it is shared or sold, and anything a user should know before using this \
service. Do not use legal jargon.

Privacy policy text:
"""
{policy_text}
"""

Plain-English summary:`;

let enginePromise = null;

function loadEngine(onProgress) {
  if (!enginePromise) {
    enginePromise = CreateExtensionServiceWorkerMLCEngine(MODEL_ID, {
      initProgressCallback: onProgress,
    });
  }
  return enginePromise;
}

// Returns a plain-English summary string. Deliberately not structured JSON --
// small on-device models are unreliable at strict schemas, and the red-flags
// categorization is already handled reliably by the local classifier
// (redflags-engine.js), so this only needs to carry the prose explanation.
async function summarizePolicy(policyText, onProgress) {
  const engine = await loadEngine(onProgress);
  const prompt = PROMPT_TEMPLATE.replace(
    "{policy_text}",
    policyText.slice(0, MAX_POLICY_CHARS)
  );
  const completion = await engine.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
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
