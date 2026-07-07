import fs from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";
import { isPathInside, pathExists, readJson, safeJoin, writeJson } from "./fs.js";
import { packFromFigmaCapture } from "./pack-from-figma-capture.js";
import { preflightFigmaCapture } from "./preflight.js";
import { emptyTimings, preflightSummary, timeStage } from "./timing.js";

function positiveIssueNumber(value) {
  const issue = Number(value);
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new CliError("--issue must be a positive integer for design pack-latest-capture.", 1, "PRAGMA_ISSUE_REQUIRED");
  }
  return issue;
}

async function assertReadableDirectory(dir, code, label) {
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw new CliError(`${label} does not exist: ${dir}`, 1, code, { path: dir });
  }
  if (!stat.isDirectory()) {
    throw new CliError(`${label} is not a directory: ${dir}`, 1, code, { path: dir });
  }
}

function timestampKeyFromCaptureDir(name, issue) {
  const prefix = `issue-${issue}-`;
  if (!name.startsWith(prefix)) return undefined;
  const suffix = name.slice(prefix.length);
  const compact = suffix.match(/\d{8}T\d{6}/i)?.[0];
  if (compact) return compact.toUpperCase();
  const digits = suffix.match(/\d{14}/)?.[0];
  if (digits) return digits;
  const parsed = Date.parse(suffix);
  if (Number.isFinite(parsed)) return String(parsed).padStart(16, "0");
  return undefined;
}

async function captureCandidates(repoRoot, issue) {
  const incomingRoot = safeJoin(repoRoot, ".pragma", "incoming", "figma-captures");
  if (!(await pathExists(incomingRoot))) {
    return { incomingRoot, candidates: [] };
  }
  const entries = await fs.readdir(incomingRoot, { withFileTypes: true });
  const prefix = `issue-${issue}-`;
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const captureDir = path.join(incomingRoot, entry.name);
    const inputPath = path.join(captureDir, "pragma-input");
    if (!(await pathExists(inputPath))) continue;
    const inputStat = await fs.stat(inputPath).catch(() => undefined);
    if (!inputStat?.isDirectory()) continue;
    const captureStat = await fs.stat(captureDir);
    candidates.push({
      captureDir,
      inputPath,
      name: entry.name,
      timestampKey: timestampKeyFromCaptureDir(entry.name, issue),
      mtimeMs: captureStat.mtimeMs
    });
  }
  return { incomingRoot, candidates };
}

function chooseLatestCapture(candidates) {
  return [...candidates].sort((left, right) => {
    if (left.timestampKey && right.timestampKey && left.timestampKey !== right.timestampKey) {
      return right.timestampKey.localeCompare(left.timestampKey);
    }
    if (left.timestampKey && !right.timestampKey) return -1;
    if (!left.timestampKey && right.timestampKey) return 1;
    return right.mtimeMs - left.mtimeMs;
  })[0];
}

export async function resolveLatestCaptureInput(options) {
  if (!options.repo) throw new CliError("--repo is required for design pack-latest-capture.", 1, "PRAGMA_REPO_REQUIRED");
  const repoRoot = path.resolve(String(options.repo));
  await assertReadableDirectory(repoRoot, "PRAGMA_REPO_NOT_FOUND", "Repo");
  const issue = positiveIssueNumber(options.issue);

  const explicitInput = options.input || options["capture-dir"] || options.captureDir;
  if (explicitInput) {
    const inputPath = path.resolve(String(explicitInput));
    await assertReadableDirectory(inputPath, "PRAGMA_CAPTURE_INPUT_NOT_FOUND", "Capture input");
    return {
      repoRoot,
      issue,
      inputPath,
      source: "explicit",
      candidates: []
    };
  }

  const { incomingRoot, candidates } = await captureCandidates(repoRoot, issue);
  const latest = chooseLatestCapture(candidates);
  if (!latest) {
    throw new CliError(
      `No pragma-input directory found under ${incomingRoot} for issue #${issue}.`,
      2,
      "PRAGMA_LATEST_CAPTURE_NOT_FOUND",
      { repoRoot, issue, incomingRoot }
    );
  }
  return {
    repoRoot,
    issue,
    inputPath: latest.inputPath,
    source: "latest",
    incomingRoot,
    selectedCaptureDir: latest.captureDir,
    selectedCaptureName: latest.name,
    candidates: candidates.map((candidate) => ({
      name: candidate.name,
      inputPath: candidate.inputPath,
      timestampKey: candidate.timestampKey,
      mtimeMs: candidate.mtimeMs
    }))
  };
}

function contextDirForIssue(repoRoot, issue) {
  return safeJoin(repoRoot, ".pragma", "design-contexts", `issue-${issue}`);
}

async function assertCanWriteContext({ repoRoot, issue, force }) {
  const contextDir = contextDirForIssue(repoRoot, issue);
  if (!isPathInside(path.join(repoRoot, ".pragma", "design-contexts"), contextDir)) {
    throw new CliError("Resolved context path is outside .pragma/design-contexts.", 1, "PRAGMA_UNSAFE_CONTEXT_PATH", { contextDir });
  }
  if ((await pathExists(contextDir)) && !force) {
    throw new CliError(
      `Context already exists: ${contextDir}. Pass --force to overwrite it.`,
      2,
      "PRAGMA_CONTEXT_EXISTS",
      { contextDir, issue }
    );
  }
  return contextDir;
}

function boolOption(options, key) {
  const camel = key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
  const value = options[key] ?? options[camel];
  if (value === undefined) return false;
  if (value === true) return true;
  return !["0", "false", "no", "none"].includes(String(value).toLowerCase());
}

function validationSummaryFromPacked(packed) {
  return {
    ok: true,
    warnings: packed.warnings || [],
    errors: []
  };
}

async function updatePipelineSummary({ packed, resolved, mode, timings, validation }) {
  if (!packed.summaryPath) return undefined;
  const summary = await readJson(packed.summaryPath);
  summary.command = "design pack-latest-capture";
  summary.mode = mode;
  summary.input = resolved.inputPath;
  summary.inputPath = resolved.inputPath;
  summary.repo = resolved.repoRoot;
  summary.issue = resolved.issue;
  summary.latestCapture = {
    source: resolved.source,
    incomingRoot: resolved.incomingRoot,
    selectedCaptureDir: resolved.selectedCaptureDir,
    selectedCaptureName: resolved.selectedCaptureName,
    candidates: resolved.candidates
  };
  summary.validation = validation;
  summary.timings = timings;
  await writeJson(packed.summaryPath, summary);
  return summary;
}

export async function packLatestCapture(options) {
  const timings = emptyTimings();
  let resolved;
  await timeStage(timings, "resolveInputMs", async () => {
    resolved = await resolveLatestCaptureInput(options);
  });
  const force = boolOption(options, "force");
  const preflightOnly = boolOption(options, "preflight-only");

  if (preflightOnly) {
    const preflight = await timeStage(timings, "preflightMs", () => preflightFigmaCapture({
      ...options,
      input: resolved.inputPath,
      repo: resolved.repoRoot,
      fix: options.fix ?? true,
      json: true
    }));
    return {
      ok: preflight.ok,
      command: "design pack-latest-capture",
      mode: "preflight-only",
      inputPath: resolved.inputPath,
      inputSource: resolved.source,
      repo: resolved.repoRoot,
      issue: resolved.issue,
      preflight,
      preflightSummary: preflightSummary(preflight),
      repairs: preflight.repairs || [],
      warnings: [],
      timings,
      latestCapture: {
        source: resolved.source,
        incomingRoot: resolved.incomingRoot,
        selectedCaptureDir: resolved.selectedCaptureDir,
        selectedCaptureName: resolved.selectedCaptureName,
        candidates: resolved.candidates
      }
    };
  }

  await assertCanWriteContext({ repoRoot: resolved.repoRoot, issue: resolved.issue, force });
  const packed = await packFromFigmaCapture({
    ...options,
    input: resolved.inputPath,
    repo: resolved.repoRoot,
    issue: resolved.issue,
    force
  });
  timings.resolveInputMs = Math.round(((timings.resolveInputMs || 0) + (packed.timings?.resolveInputMs || 0)) * 100) / 100;
  for (const [key, value] of Object.entries(packed.timings || {})) {
    if (key !== "resolveInputMs") timings[key] = value;
  }
  const validation = validationSummaryFromPacked(packed);
  const summary = await updatePipelineSummary({ packed, resolved, mode: "full", timings, validation });
  return {
    ok: true,
    command: "design pack-latest-capture",
    mode: "full",
    inputPath: resolved.inputPath,
    inputSource: resolved.source,
    repo: resolved.repoRoot,
    issue: resolved.issue,
    contextDir: packed.contextDir,
    manifestPath: packed.manifestPath,
    zipPath: packed.zipPath,
    publishMode: packed.publishMode,
    artifact: packed.artifact,
    issueFragmentPath: packed.issueFragmentPath,
    issueFragmentChecksum: packed.issueFragmentChecksum,
    summaryPath: packed.summaryPath,
    preflight: {
      ok: packed.preflight?.ok,
      summary: packed.preflightSummary,
      repairs: packed.preflight?.repairs || [],
      issues: packed.preflight?.issues || []
    },
    preflightSummary: packed.preflightSummary,
    validation,
    readSmokeCheck: packed.readSmokeCheck,
    timings,
    latestCapture: summary?.latestCapture
  };
}
