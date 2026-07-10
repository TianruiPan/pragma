import path from "node:path";
import { CliError } from "./errors.js";
import { ingestDesignContext } from "./ingest.js";
import { packDesignContext } from "./pack.js";
import { publishDesignContext } from "./publish.js";
import { createIssueFragment } from "./issue-fragment.js";
import { validateDesignContext } from "./validate.js";
import { preflightFigmaCapture } from "./preflight.js";
import { readDesignContext } from "./read.js";
import { emptyTimings, preflightSummary, timeStage } from "./timing.js";
import { writeJson } from "./fs.js";

function smokeCheckSummary(smokeRead) {
  return {
    ok: smokeRead.required !== false,
    manifestPath: smokeRead.manifestPath,
    agentContextPath: smokeRead.agentContextPath,
    agentWorkflowPath: smokeRead.agentWorkflowPath,
    designContextPath: smokeRead.designContextPath,
    pixelSpecPath: smokeRead.pixelSpecPath,
    layersPath: smokeRead.layersPath,
    dependenciesPath: smokeRead.dependenciesPath,
    assetsPath: smokeRead.assetsPath,
    tokensPath: smokeRead.tokensPath,
    componentsPath: smokeRead.componentsPath,
    renderInstructionsPath: smokeRead.renderInstructionsPath,
    visualBaselinePath: smokeRead.visualBaselinePath
  };
}

export async function writePipelineSummary({ command, options, ingest, pack, publish, fragmentOutput, fragment, validation, smokeRead, preflight, timings, prepare = undefined }) {
  const contextDir = ingest.contextDir;
  const summaryPath = path.join(contextDir, "handoff", "pipeline-summary.json");
  const summary = {
    schemaVersion: "2.0",
    kind: "pragma-pipeline-summary",
    command,
    generatedAt: new Date().toISOString(),
    input: path.resolve(String(options.input || options["capture-dir"] || options.captureDir || "")),
    repo: ingest.repoPath,
    contextDir,
    manifestPath: ingest.manifestPath,
    zipPath: pack.zipPath,
    issueFragmentPath: fragmentOutput,
    issueFragmentChecksum: fragment.checksum,
    artifact: publish.manifest.artifact,
    prepare,
    preflightSummary: preflightSummary(preflight),
    preflightRepairs: preflight.repairs || [],
    validationWarnings: validation.warnings || [],
    readSmokeCheck: smokeCheckSummary(smokeRead),
    timings
  };
  await writeJson(summaryPath, summary);
  return { summaryPath, summary };
}

export async function packFromFigmaCapture(options) {
  if (!options.input) throw new CliError("--input is required for design pack-from-figma-capture.");
  const timings = emptyTimings();
  await timeStage(timings, "resolveInputMs", async () => {
    path.resolve(String(options.input));
    if (options.repo) path.resolve(String(options.repo));
  });
  const preflight = await timeStage(timings, "preflightMs", () => preflightFigmaCapture({ ...options, fix: options.fix ?? true, json: true }));
  if (!preflight.ok) {
    const unresolved = preflight.issues.filter((issue) => !issue.fixed);
    throw new CliError(
      `pack-from-figma-capture preflight failed:\n- ${unresolved.map((issue) => `${issue.category} ${issue.code}: ${issue.message}`).join("\n- ")}`,
      2,
      "PRAGMA_PREFLIGHT_FAILED",
      { preflight }
    );
  }
  const ingest = await timeStage(timings, "ingestMs", () => ingestDesignContext({ ...options, input: preflight.inputDir, repo: preflight.repoPath }));
  const context = ingest.contextDir;
  const pack = await timeStage(timings, "packZipMs", () => packDesignContext({ ...options, context, zip: options.zip }));
  const publish = await timeStage(timings, "publishMs", () => publishDesignContext({ ...options, context, zip: pack.zipPath }));
  const fragmentOutput = options["issue-fragment-output"] || options.issueFragmentOutput || path.join(context, "handoff", "issue-fragment.md");
  const fragment = await timeStage(timings, "issueFragmentMs", () => createIssueFragment({ context, output: fragmentOutput }));
  const validation = await timeStage(timings, "validateMs", () => validateDesignContext({ context, checkRemote: options["check-remote"] || options.checkRemote }));
  if (!validation.ok) {
    throw new CliError(`pack-from-figma-capture produced an invalid package:\n- ${validation.errors.join("\n- ")}`);
  }
  const smokeRead = await timeStage(timings, "readSmokeCheckMs", () => readDesignContext({ context, checkRemote: options["check-remote"] || options.checkRemote }));
  const pipeline = await writePipelineSummary({
    command: "design pack-from-figma-capture",
    options,
    ingest,
    pack,
    publish,
    fragmentOutput,
    fragment,
    validation,
    smokeRead,
    preflight,
    timings
  });
  return {
    contextDir: context,
    manifestPath: ingest.manifestPath,
    zipPath: pack.zipPath,
    publishMode: publish.mode,
    artifact: publish.manifest.artifact,
    issueFragmentPath: fragmentOutput,
    issueFragmentChecksum: fragment.checksum,
    summaryPath: pipeline.summaryPath,
    timings,
    preflight,
    preflightSummary: pipeline.summary.preflightSummary,
    readSmokeCheck: pipeline.summary.readSmokeCheck,
    warnings: validation.warnings
  };
}
