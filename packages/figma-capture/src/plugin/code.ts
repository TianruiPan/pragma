import { buildCaptureBundle } from "./serializer.js";
import { normalizeBridgeEndpoint } from "../shared/bridge-url.js";

figma.showUI(__PRAGMA_UI_HTML__, { width: 520, height: 820, themeColors: true });

function selectionSummary() {
  return figma.currentPage.selection.map((node: any) => ({
    id: node.id,
    nodeId: node.id,
    name: node.name,
    type: node.type,
    width: node.width,
    height: node.height
  }));
}

function postSelection() {
  figma.ui.postMessage({
    type: "selection",
    selection: selectionSummary(),
    page: {
      id: figma.currentPage.id,
      name: figma.currentPage.name,
      type: figma.currentPage.type
    },
    fileName: figma.root?.name,
    fileKey: figma.fileKey
  });
}

figma.on("selectionchange", postSelection);
postSelection();

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

async function sendToBridge(bridgeUrl: string, bundle: unknown) {
  const endpoint = normalizeBridgeEndpoint(bridgeUrl);
  let healthResponse: Response;
  try {
    healthResponse = await fetch(endpoint.healthUrl);
  } catch {
    throw new Error("Local bridge is not reachable. Start it with: npm run bridge -- serve --host localhost --port 48732 --repo \"D:/path/to/repo\".");
  }
  if (!healthResponse.ok) {
    throw new Error(`Local bridge health check failed with HTTP ${healthResponse.status}. Check that the bridge is running on localhost:48732.`);
  }

  const response = await fetch(endpoint.captureUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundle })
  });
  const text = await response.text();
  let payload: unknown = text;
  try { payload = JSON.parse(text); } catch { /* bridge may return plain text */ }
  if (!response.ok) throw new Error(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
  return payload;
}

figma.ui.onmessage = async (message: any) => {
  try {
    if (message.type === "refresh-selection") {
      postSelection();
      return;
    }

    if (message.type === "close") {
      figma.closePlugin();
      return;
    }

    if (message.type === "export-capture" || message.type === "send-to-bridge") {
      const bundle = await buildCaptureBundle(message.request || {});
      if (message.type === "export-capture") {
        figma.ui.postMessage({ type: "export-ready", bundle });
        return;
      }

      const bridgeUrl = message.bridgeUrl || "http://localhost:48732/capture";
      const bridgeResult = await sendToBridge(bridgeUrl, bundle);
      figma.ui.postMessage({ type: "bridge-result", bridgeResult });
      return;
    }
  } catch (error) {
    figma.ui.postMessage({
      type: "error",
      message: readableError(error)
    });
  }
};
