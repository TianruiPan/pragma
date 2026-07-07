import path from "node:path";
import { performance } from "node:perf_hooks";
import { CliError } from "./errors.js";
import { pathExists, readJson, writeJson } from "./fs.js";
import { normalizeFigmaNodeId } from "./figma-url.js";
import { prepareFigmaCapture } from "./source-registry.js";
import { packFromFigmaCapture } from "./pack-from-figma-capture.js";
import { elapsedMs } from "./timing.js";

async function inferPrepareOptions(inputDir, options) {
  const capture = await readJson(path.join(inputDir, "capture.json"), {}).catch(() => ({}));
  const selection = await readJson(path.join(inputDir, "figma", "selection.json"), {}).catch(() => ({}));
  const firstPage = options.page || options["page-frame"] || options.pageFrame || selection.frames?.page?.[0]?.nodeId || selection.nodes?.[0]?.id || capture.figma?.frames?.page?.[0]?.nodeId || capture.figma?.nodeIds?.[0];
  return {
    ...options,
    repo: options.repo || capture.repo?.localPath,
    url: options.url || options["figma-url"] || options.figmaUrl || capture.figma?.url,
    page: firstPage ? normalizeFigmaNodeId(firstPage) : undefined
  };
}

export async function fromFigma(options) {
  const startedAt = performance.now();
  const input = options.input || options["capture-dir"] || options.captureDir;
  if (!input) {
    throw new CliError("Figma Plugin / Capture Bridge output is required. Pass --input or --capture-dir pointing to a pragma-input directory; Pragma core does not connect to Figma tokens or Plugin UI directly.", 1, "PRAGMA_CAPTURE_INPUT_REQUIRED");
  }
  const inputDir = path.resolve(String(input));
  if (!(await pathExists(inputDir))) throw new CliError(`Capture input directory does not exist: ${inputDir}`);
  const resolveInputMs = elapsedMs(startedAt);
  let prepare;
  const prepareOptions = await inferPrepareOptions(inputDir, options);
  if (prepareOptions.url && prepareOptions.page && prepareOptions.repo) {
    prepare = await prepareFigmaCapture(prepareOptions);
  }
  const packed = await packFromFigmaCapture({ ...options, input: inputDir, repo: options.repo || prepareOptions.repo });
  const timings = { ...packed.timings, resolveInputMs: Math.round((resolveInputMs + (packed.timings?.resolveInputMs || 0)) * 100) / 100 };
  if (packed.summaryPath) {
    const summary = await readJson(packed.summaryPath);
    summary.command = "design from-figma";
    summary.prepare = prepare;
    summary.timings = timings;
    await writeJson(packed.summaryPath, summary);
  }
  return {
    ok: true,
    command: "design from-figma",
    prepare,
    ...packed,
    timings
  };
}
