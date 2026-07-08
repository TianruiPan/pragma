#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { startBridgeServer } from "./server.js";
import { writePragmaInputBundle } from "./writer.js";
import type { PragmaInputBundle } from "../shared/types.js";

function argValue(args: string[], name: string, fallback?: string) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function usage() {
  return `Usage:\n  pragma-figma-capture-bridge serve [--host localhost] [--port 48732] [--repo D:/repo] [--out D:/repo/.pragma/incoming/.../pragma-input]\n  pragma-figma-capture-bridge unpack --bundle pragma-input-bundle.json [--repo D:/repo] [--out D:/output/pragma-input]\n`;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "serve") {
    const host = argValue(args, "--host", "localhost");
    const port = Number(argValue(args, "--port", "48732"));
    const repo = argValue(args, "--repo");
    const outputRoot = argValue(args, "--out");
    const started = await startBridgeServer({ host, port, repo, outputRoot });
    console.log(JSON.stringify({ ok: true, url: started.url, repo, outputRoot }, null, 2));
    return;
  }

  if (command === "unpack") {
    const bundlePath = argValue(args, "--bundle");
    if (!bundlePath) throw new Error("Missing --bundle path.");
    const repo = argValue(args, "--repo");
    const out = argValue(args, "--out");
    const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as PragmaInputBundle;
    const result = await writePragmaInputBundle(bundle, { repo, out });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
