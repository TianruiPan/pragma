import http from "node:http";
import { writePragmaInputBundle } from "./writer.js";
import type { PragmaInputBundle } from "../shared/types.js";

const BRIDGE_VERSION = "0.1.0";

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function readBody(req: http.IncomingMessage, limitBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) {
      const error = new Error(`Request body exceeds limit ${limitBytes} bytes.`) as Error & { code?: string };
      error.code = "BRIDGE_REQUEST_TOO_LARGE";
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) return String((error as { code?: unknown }).code);
  if (error instanceof SyntaxError) return "BRIDGE_INVALID_JSON";
  return "BRIDGE_CAPTURE_WRITE_FAILED";
}

export function createBridgeServer(options: { outputRoot?: string; repo?: string; limitBytes?: number } = {}) {
  const limitBytes = options.limitBytes || 100 * 1024 * 1024;
  let lastCaptureSummary: unknown = null;
  const serviceInfo = () => ({
    ok: true,
    service: "pragma-figma-capture-bridge",
    version: BRIDGE_VERSION,
    repo: options.repo || null,
    writeRoot: options.outputRoot || null,
    lastCaptureSummary
  });

  return http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return jsonResponse(res, 204, {});
      if (req.method === "GET" && (req.url === "/health" || req.url === "/detail")) return jsonResponse(res, 200, serviceInfo());
      if (req.method !== "POST" || !req.url?.startsWith("/capture")) {
        return jsonResponse(res, 404, { ok: false, code: "BRIDGE_ROUTE_NOT_FOUND", error: "not_found", hint: "Use POST http://localhost:48732/capture or GET /health." });
      }
      const body = await readBody(req, limitBytes);
      const parsed = JSON.parse(body || "{}");
      const bundle = (parsed.bundle || parsed) as PragmaInputBundle;
      const result = await writePragmaInputBundle(bundle, { out: parsed.out || options.outputRoot, repo: parsed.repo || options.repo });
      lastCaptureSummary = {
        outputDir: result.outputDir,
        statuses: result.statuses,
        captureTimings: result.captureTimings,
        diagnostics: result.diagnostics,
        captureSummaryPath: result.captureSummaryPath
      };
      return jsonResponse(res, 200, { ok: true, ...result });
    } catch (error) {
      return jsonResponse(res, 400, {
        ok: false,
        code: errorCode(error),
        error: error instanceof Error ? error.message : String(error),
        hint: "Check that the plugin is posting a pragma-figma-capture-bundle to http://localhost:48732/capture and that --repo/--out paths are writable."
      });
    }
  });
}

export async function startBridgeServer(options: { host?: string; port?: number; outputRoot?: string; repo?: string; limitBytes?: number } = {}) {
  const host = options.host || "localhost";
  const port = options.port || 48732;
  const server = createBridgeServer(options);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return { server, host, port, url: `http://${host}:${port}/capture` };
}
