// Source for ../background.js (bundled by build.sh). Runs in the extension's
// MV3 service worker. WebGPU is available directly in service workers as of
// Chrome 124+, so the model itself runs here -- no offscreen document needed.
// See https://github.com/mlc-ai/web-llm/tree/main/examples/chrome-extension-webgpu-service-worker,
// which this is adapted from.
import { ExtensionServiceWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

let handler;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "web_llm_service_worker") return;
  if (handler === undefined) {
    handler = new ExtensionServiceWorkerMLCEngineHandler(port);
  } else {
    handler.setPort(port);
  }
  port.onMessage.addListener(handler.onmessage.bind(handler));
});
