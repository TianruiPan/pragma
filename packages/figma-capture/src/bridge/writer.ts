import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildDependencyLock } from "./dependency-lock.js";
import type { BundleFile, PragmaInputBundle } from "../shared/types.js";

export interface CaptureTimings {
  serializeMs: number;
  exportScreenshotsMs: number;
  exportAssetsMs: number;
  writeFilesMs: number;
  dependencyLockMs: number;
  totalMs: number;
}

function nowMs() {
  return Date.now();
}

function elapsedMs(start: number) {
  return Math.max(0, Date.now() - start);
}

function numericMs(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : 0;
}

function assertBundle(bundle: PragmaInputBundle) {
  if (!bundle || bundle.kind !== "pragma-figma-capture-bundle" || !Array.isArray(bundle.files)) {
    throw new Error("Expected a pragma-figma-capture-bundle with files[].");
  }
}

function safeJoin(root: string, relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..")) throw new Error(`Unsafe bundle path: ${relativePath}`);
  const target = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) throw new Error(`Bundle path escapes output root: ${relativePath}`);
  return target;
}

function decodeFile(file: BundleFile): Buffer | string {
  if (file.kind === "json") return `${JSON.stringify(file.content ?? {}, null, 2)}\n`;
  if (file.kind === "text") return String(file.content ?? "");
  if (file.kind === "binary") {
    if (!file.base64) throw new Error(`Binary file is missing base64: ${file.path}`);
    return Buffer.from(file.base64, "base64");
  }
  throw new Error(`Unsupported bundle file kind: ${(file as BundleFile).kind}`);
}

async function writeDecodedFile(target: string, decoded: Buffer | string) {
  if (typeof decoded === "string") await writeFile(target, decoded, "utf8");
  else await writeFile(target, decoded);
}

async function readCaptureFromBundle(bundle: PragmaInputBundle) {
  const captureFile = bundle.files.find((file) => file.path === "capture.json");
  if (!captureFile) return {};
  if (captureFile.kind === "json") return captureFile.content || {};
  if (typeof captureFile.content === "string") return JSON.parse(captureFile.content);
  return {};
}

async function readJsonIfExists(filePath: string, fallback: any = undefined) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readTextIfExists(filePath: string, fallback = "") {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function timestampSegment(value = new Date().toISOString()) {
  return value.replace(/[^0-9TZ]/g, "").replace(/T$/, "").slice(0, 15) || String(Date.now());
}

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function frameRoleSummary(selection: any) {
  const frames = selection?.frames || {};
  const summary: Record<string, unknown> = {};
  for (const role of ["page", "components", "assets"]) {
    const roleFrames = asArray(frames[role]);
    summary[role] = {
      count: roleFrames.length,
      nodeIds: roleFrames.map((frame: any) => frame?.nodeId || frame?.id).filter(Boolean),
      names: roleFrames.map((frame: any) => frame?.name).filter(Boolean)
    };
  }
  return summary;
}

function trustedChecksum(value: unknown) {
  return /^sha256:[0-9a-f]{64}$/i.test(String(value || ""));
}

function flattenLayerNodes(nodes: any[]) {
  const output: any[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    output.push(node);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return output;
}

function buildTimings(bundle: PragmaInputBundle, writeFilesMs: number, dependencyLockMs: number): CaptureTimings {
  const source = (bundle.summary?.captureTimings || {}) as Record<string, unknown>;
  const serializeMs = numericMs(source.serializeMs);
  const exportScreenshotsMs = numericMs(source.exportScreenshotsMs);
  const exportAssetsMs = numericMs(source.exportAssetsMs);
  const pluginTotalMs = numericMs(source.totalMs);
  const stageTotalMs = serializeMs + exportScreenshotsMs + exportAssetsMs + writeFilesMs + dependencyLockMs;
  return {
    serializeMs,
    exportScreenshotsMs,
    exportAssetsMs,
    writeFilesMs,
    dependencyLockMs,
    totalMs: pluginTotalMs ? pluginTotalMs + writeFilesMs + dependencyLockMs : stageTotalMs
  };
}

async function buildDiagnostics(outputDir: string, dependencyLock: any) {
  const selection = await readJsonIfExists(path.join(outputDir, "figma", "selection.json"), {});
  const layers = await readJsonIfExists(path.join(outputDir, "figma", "layers.json"), { nodes: [] });
  const components = await readJsonIfExists(path.join(outputDir, "figma", "components.json"), {});
  const variables = await readJsonIfExists(path.join(outputDir, "figma", "variables.json"), {});
  const assetManifest = await readJsonIfExists(path.join(outputDir, "assets-manifest.json"), { assets: [] });
  const assetBindings = await readJsonIfExists(path.join(outputDir, "asset-bindings.json"), { bindings: [] });
  const dynamicRegionNotes = await readTextIfExists(path.join(outputDir, "dynamic-regions.md"), "");
  const assets = asArray(assetManifest?.assets);
  const bindings = asArray(assetBindings?.bindings);
  const layerNodes = flattenLayerNodes(asArray(layers?.nodes));
  const componentInstances = asArray(components?.instances);
  const componentMetadataMissingCount = Number.isFinite(Number(components?.metadataCompleteness?.componentMetadataMissingCount))
    ? Number(components.metadataCompleteness.componentMetadataMissingCount)
    : componentInstances.filter((instance: any) => !instance?.mainComponentNodeId && !instance?.componentRef?.mainComponentNodeId).length;
  const visibilityFactsCount = Number.isFinite(Number(components?.metadataCompleteness?.visibilityFactsCount))
    ? Number(components.metadataCompleteness.visibilityFactsCount)
    : layerNodes.filter((node) => typeof node?.visible === "boolean" || typeof node?.hidden === "boolean").length;
  const styleRefNodeCount = layerNodes.filter((node) => node?.styleIds && Object.keys(node.styleIds).length > 0).length;
  const variableRefNodeCount = layerNodes.filter((node) => node?.boundVariables || node?.tokenRefs?.boundVariables).length;
  const selectedPendingPreflight = ["components", "assets"]
    .map((role) => ({ role, dependency: dependencyLock?.[role] }))
    .filter((item) => item.dependency?.status === "selected" && item.dependency?.needsSourceSync === true)
    .map((item) => ({
      role: item.role,
      frameNodeIds: item.dependency.frameNodeIds || (item.dependency.frameNodeId ? [item.dependency.frameNodeId] : []),
      plannedSnapshotId: item.dependency.plannedSnapshotId,
      materializationStatus: item.dependency.materializationStatus || "pending-preflight"
    }));
  const unresolvedSharedRefs = bindings.filter((binding: any) => binding?.scope === "shared" || binding?.unresolved === true);
  return {
    schemaVersion: "2.0",
    kind: "pragma-figma-capture-diagnostics",
    frameRoles: frameRoleSummary(selection),
    assetCount: assets.length,
    assetChecksumUnavailableCount: assets.filter((asset: any) => !trustedChecksum(asset?.checksum) && (asset?.checksumStatus === "unavailable" || !asset?.checksum)).length,
    componentInstanceCount: componentInstances.length,
    componentMetadataMissingCount,
    visibilityFactsCount,
    styleRefNodeCount,
    variableRefNodeCount,
    localVariableCount: asArray(variables?.variables).length,
    localStyleCount: asArray(variables?.styles).length,
    assetBindingCount: bindings.length,
    unresolvedSharedRefCount: unresolvedSharedRefs.length,
    unresolvedSharedRefs: unresolvedSharedRefs.map((binding: any) => ({ assetId: binding?.assetId, figmaNodeId: binding?.figmaNodeId, nodeId: binding?.nodeId })),
    dynamicRegionNotesMissing: dynamicRegionNotes.trim().length === 0,
    selectedPendingPreflight
  };
}

export async function defaultOutputDir(bundle: PragmaInputBundle, explicitRepo?: string) {
  const capture: any = await readCaptureFromBundle(bundle);
  const repo = explicitRepo || capture?.repo?.localPath || process.cwd();
  const issue = Number(capture?.designIssue?.number || 0) || "unknown";
  const stamp = timestampSegment(capture?.capturedAt);
  return path.join(path.resolve(repo), ".pragma", "incoming", "figma-captures", `issue-${issue}-${stamp}`, "pragma-input");
}

export interface WriteBundleOptions {
  out?: string;
  repo?: string;
}

export async function writePragmaInputBundle(bundle: PragmaInputBundle, options: WriteBundleOptions = {}) {
  const totalStart = nowMs();
  assertBundle(bundle);
  const outputDir = path.resolve(options.out || await defaultOutputDir(bundle, options.repo));
  await mkdir(outputDir, { recursive: true });

  const writeStart = nowMs();
  for (const file of bundle.files) {
    const target = safeJoin(outputDir, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeDecodedFile(target, decodeFile(file));
  }
  const writeFilesMs = elapsedMs(writeStart);

  const dependencyStart = nowMs();
  const capturePath = path.join(outputDir, "capture.json");
  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  const repoLocalPath = options.repo || capture?.repo?.localPath;
  const dependencyLock = await buildDependencyLock(outputDir, repoLocalPath);
  await writeFile(path.join(outputDir, "dependency-lock.json"), `${JSON.stringify(dependencyLock, null, 2)}\n`, "utf8");
  const dependencyLockMs = elapsedMs(dependencyStart);

  const captureTimings = buildTimings(bundle, writeFilesMs, dependencyLockMs);
  captureTimings.totalMs = Math.max(captureTimings.totalMs, elapsedMs(totalStart));
  const diagnostics = await buildDiagnostics(outputDir, dependencyLock);
  const captureSummary = {
    schemaVersion: "2.0",
    kind: "pragma-figma-capture-summary",
    generatedAt: new Date().toISOString(),
    outputDir,
    captureTimings,
    diagnostics,
    statuses: {
      components: dependencyLock.components.status,
      assets: dependencyLock.assets.status
    }
  };
  const captureSummaryPath = path.join(outputDir, "capture-summary.json");
  await writeFile(captureSummaryPath, `${JSON.stringify(captureSummary, null, 2)}\n`, "utf8");

  return {
    outputDir,
    dependencyLock,
    fileCount: bundle.files.length + 2,
    statuses: captureSummary.statuses,
    captureTimings,
    diagnostics,
    captureSummaryPath
  };
}
