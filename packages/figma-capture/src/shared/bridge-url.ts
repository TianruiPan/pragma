export interface BridgeEndpoint {
  captureUrl: string;
  healthUrl: string;
}

function normalizeLocalhostCaptureUrl(value: string | undefined | null) {
  const input = String(value || "http://localhost:48732/capture").trim();
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`;
  const withoutHash = withProtocol.split("#")[0];
  const withoutQuery = withoutHash.split("?")[0];
  const withoutTrailingSlash = withoutQuery.endsWith("/") ? withoutQuery.slice(0, -1) : withoutQuery;

  if (withoutTrailingSlash === "http://localhost:48732") return "http://localhost:48732/capture";
  if (withoutTrailingSlash === "http://localhost:48732/capture") return "http://localhost:48732/capture";
  return "";
}

export function normalizeBridgeEndpoint(value: string | undefined | null): BridgeEndpoint {
  const captureUrl = normalizeLocalhostCaptureUrl(value);
  if (!captureUrl) {
    throw new Error("Bridge URL must be http://localhost:48732/capture.");
  }

  return {
    captureUrl,
    healthUrl: "http://localhost:48732/health"
  };
}
