// src/bridge/server.ts
import http from "node:http";

// src/bridge/writer.ts
import { mkdir, readFile as readFile2, writeFile } from "node:fs/promises";
import path2 from "node:path";

// src/bridge/dependency-lock.ts
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// src/shared/assets.ts
function slugify(value, fallback = "item") {
  const normalized = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}
function safeNodeIdSegment(value) {
  return slugify(String(value).replace(/:/g, "-"), "node");
}

// src/bridge/dependency-lock.ts
async function readJsonIfExists(filePath, fallback = void 0) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}
async function readFileIfExists(filePath) {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}
async function collectFileDigests(dirPath, prefix = "") {
  let entries;
  try {
    entries = await readdir(dirPath);
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries.sort()) {
    const next = path.join(dirPath, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    try {
      await readdir(next);
      records.push(...await collectFileDigests(next, relative));
    } catch {
      const bytes = await readFileIfExists(next);
      if (bytes) records.push({ path: relative, checksum: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  return records;
}
function stableJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
  });
}
function frameIdsForRole(selection, role) {
  const value = selection?.frames?.[role];
  const frames = Array.isArray(value) ? value : value ? [value] : [];
  return new Set(frames.map((frame) => String(frame.nodeId || frame.id)).filter(Boolean));
}
function nodeIdentity(node) {
  return String(node?.figmaNodeId || node?.nodeId || node?.id || "");
}
function collectTreeNodeIds(nodes) {
  const ids = /* @__PURE__ */ new Set();
  const walk = (node) => {
    const id = nodeIdentity(node);
    if (id) ids.add(id);
    if (Array.isArray(node?.children)) node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return ids;
}
function selectRoleLayerRoots(layers, role, frameIds) {
  const roots = Array.isArray(layers?.nodes) ? layers.nodes : [];
  const selected = roots.filter((node) => node?.role === role || frameIds.has(nodeIdentity(node)));
  if (selected.length || role !== "page") return selected;
  return roots.filter((node) => frameIds.has(nodeIdentity(node)));
}
async function contentHash(inputDir, role) {
  const capture = await readJsonIfExists(path.join(inputDir, "capture.json"), {});
  const selection = await readJsonIfExists(path.join(inputDir, "figma", "selection.json"), {});
  const layers = await readJsonIfExists(path.join(inputDir, "figma", "layers.json"), {});
  const components = await readJsonIfExists(path.join(inputDir, "figma", "components.json"), {});
  const assetManifest = await readJsonIfExists(path.join(inputDir, "assets-manifest.json"), {});
  const assetBindings = await readJsonIfExists(path.join(inputDir, "asset-bindings.json"), {});
  const frameIds = frameIdsForRole(selection, role);
  const selectedLayers = selectRoleLayerRoots(layers, role, frameIds);
  const selectedNodeIds = collectTreeNodeIds(selectedLayers);
  const roleFrames = Array.isArray(selection?.frames?.[role]) ? selection.frames[role] : selection?.frames?.[role] ? [selection.frames[role]] : [];
  const payload = {
    schemaVersion: "2.0",
    role,
    fileKey: capture?.figma?.fileKey || selection?.fileKey,
    frames: roleFrames,
    layers: selectedLayers
  };
  if (role === "components") {
    payload.components = {
      componentSets: components?.componentSets || components?.components || [],
      codeConnect: components?.codeConnect || []
    };
  }
  if (role === "assets") {
    const relatedAssets = Array.isArray(assetManifest?.assets) ? assetManifest.assets.filter((asset) => {
      const sourceIds = Array.isArray(asset?.sourceNodeIds) ? asset.sourceNodeIds.map(String) : [];
      return asset?.role === "shared-assets-frame-export" || sourceIds.some((id) => selectedNodeIds.has(id));
    }) : [];
    payload.assets = relatedAssets;
    payload.assetBindings = Array.isArray(assetBindings?.bindings) ? assetBindings.bindings.filter((binding) => selectedNodeIds.has(String(binding?.figmaNodeId || binding?.sourceNodeId || "")) || relatedAssets.some((asset) => asset.id === binding?.assetId)) : [];
    payload.assetFiles = await collectFileDigests(path.join(inputDir, "assets"));
  }
  const full = createHash("sha256").update(stableJson(payload)).digest("hex");
  return { checksum: `sha256:${full}`, short: full.slice(0, 12) };
}
function registryEntry(registry, role, snapshotId) {
  if (!snapshotId) return void 0;
  const entries = Array.isArray(registry?.roles?.[role]) ? registry.roles[role] : [];
  return entries.find((entry) => entry.snapshotId === snapshotId) || { snapshotId };
}
function statusFromRegistry(input) {
  const latest = input.registry?.latest?.[input.role];
  const entry = registryEntry(input.registry, input.role, latest);
  if (entry?.snapshotId) {
    return {
      status: "reused",
      frameNodeId: entry.frameNodeId || null,
      snapshotId: entry.snapshotId,
      path: entry.path || `.pragma/design-sources/figma/${input.fileKey}/snapshots/${entry.snapshotId}`,
      checksum: entry.checksum || null,
      reason: "latest-shared-snapshot-from-repo-registry"
    };
  }
  return {
    status: input.hasBlockingRefs ? "missing" : "none",
    frameNodeId: null,
    snapshotId: null,
    path: null,
    checksum: null,
    reason: input.hasBlockingRefs ? "no-selected-frame-and-no-reusable-registry-snapshot" : "no-selected-frame-and-no-detected-page-references"
  };
}
function selectedStatus(input) {
  const firstFrame = input.frames[0] || {};
  const plannedSnapshotId = `${input.role}-${safeNodeIdSegment(firstFrame.nodeId || firstFrame.id || input.role)}-${input.hash.short}`;
  return {
    status: "selected",
    frameNodeId: firstFrame.nodeId || firstFrame.id || null,
    frameNodeIds: input.frames.map((frame) => frame.nodeId || frame.id).filter(Boolean),
    snapshotId: null,
    path: null,
    checksum: null,
    plannedSnapshotId,
    contentChecksum: input.hash.checksum,
    materializationStatus: "pending-preflight",
    needsSourceSync: true,
    reason: "selected-frame-needs-core-preflight-source-sync"
  };
}
function selectedFrames(selection, role) {
  const value = selection?.frames?.[role];
  if (Array.isArray(value)) return value;
  if (value) return [value];
  return [];
}
function pageFrames(selection) {
  return Array.isArray(selection?.frames?.page) ? selection.frames.page : [];
}
function hasComponentInstances(components, layers) {
  if (Array.isArray(components?.instances) && components.instances.length > 0) return true;
  const stack = Array.isArray(layers?.nodes) ? [...layers.nodes] : [];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (node.type === "INSTANCE" || node.componentRef) return true;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return false;
}
function hasUnresolvedSharedAssetRefs(assetBindings) {
  const bindings = Array.isArray(assetBindings?.bindings) ? assetBindings.bindings : [];
  return bindings.some((binding) => binding.scope === "shared" || binding.unresolved === true);
}
async function buildDependencyLock(inputDir, repoLocalPath) {
  const capture = await readJsonIfExists(path.join(inputDir, "capture.json"), {});
  const selection = await readJsonIfExists(path.join(inputDir, "figma", "selection.json"), {});
  const components = await readJsonIfExists(path.join(inputDir, "figma", "components.json"), {});
  const layers = await readJsonIfExists(path.join(inputDir, "figma", "layers.json"), {});
  const assetBindings = await readJsonIfExists(path.join(inputDir, "asset-bindings.json"), {});
  const fileKey = capture?.figma?.fileKey || selection?.fileKey;
  if (!fileKey || fileKey === "unknown-file-key") throw new Error("Figma fileKey is required before writing dependency-lock.json.");
  const registryPath = repoLocalPath ? path.join(repoLocalPath, ".pragma", "design-sources", "figma", fileKey, "registry.json") : void 0;
  const registry = registryPath ? await readJsonIfExists(registryPath, null) : null;
  const componentsFrames = selectedFrames(selection, "components");
  const assetsFrames = selectedFrames(selection, "assets");
  const pageHash = await contentHash(inputDir, "page");
  const componentsStatus = componentsFrames.length ? selectedStatus({ role: "components", frames: componentsFrames, fileKey, hash: await contentHash(inputDir, "components") }) : statusFromRegistry({ registry, role: "components", fileKey, hasBlockingRefs: hasComponentInstances(components, layers) });
  const assetsStatus = assetsFrames.length ? selectedStatus({ role: "assets", frames: assetsFrames, fileKey, hash: await contentHash(inputDir, "assets") }) : statusFromRegistry({ registry, role: "assets", fileKey, hasBlockingRefs: hasUnresolvedSharedAssetRefs(assetBindings) });
  return {
    schemaVersion: "2.0",
    kind: "pragma-design-dependencies",
    fileKey,
    capturedAt: capture.capturedAt || (/* @__PURE__ */ new Date()).toISOString(),
    pageFrames: pageFrames(selection).map((frame) => ({
      nodeId: frame.nodeId || frame.id,
      name: frame.name,
      snapshotId: `page-${safeNodeIdSegment(frame.nodeId || frame.id)}-${pageHash.short}`
    })),
    components: componentsStatus,
    assets: assetsStatus,
    rules: {
      lockDependencies: true,
      neverDependOnFloatingLatest: true,
      ifMissingComponentsAndPageHasInstances: "block",
      ifMissingAssetsAndPageHasUnresolvedRefs: "block"
    }
  };
}

// src/bridge/writer.ts
function nowMs() {
  return Date.now();
}
function elapsedMs(start) {
  return Math.max(0, Date.now() - start);
}
function numericMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : 0;
}
function assertBundle(bundle) {
  if (!bundle || bundle.kind !== "pragma-figma-capture-bundle" || !Array.isArray(bundle.files)) {
    throw new Error("Expected a pragma-figma-capture-bundle with files[].");
  }
}
function safeJoin(root, relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..")) throw new Error(`Unsafe bundle path: ${relativePath}`);
  const target = path2.resolve(root, normalized);
  const rootResolved = path2.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path2.sep)) throw new Error(`Bundle path escapes output root: ${relativePath}`);
  return target;
}
function decodeFile(file) {
  if (file.kind === "json") return `${JSON.stringify(file.content ?? {}, null, 2)}
`;
  if (file.kind === "text") return String(file.content ?? "");
  if (file.kind === "binary") {
    if (!file.base64) throw new Error(`Binary file is missing base64: ${file.path}`);
    return Buffer.from(file.base64, "base64");
  }
  throw new Error(`Unsupported bundle file kind: ${file.kind}`);
}
async function writeDecodedFile(target, decoded) {
  if (typeof decoded === "string") await writeFile(target, decoded, "utf8");
  else await writeFile(target, decoded);
}
async function readCaptureFromBundle(bundle) {
  const captureFile = bundle.files.find((file) => file.path === "capture.json");
  if (!captureFile) return {};
  if (captureFile.kind === "json") return captureFile.content || {};
  if (typeof captureFile.content === "string") return JSON.parse(captureFile.content);
  return {};
}
async function readJsonIfExists2(filePath, fallback = void 0) {
  try {
    return JSON.parse(await readFile2(filePath, "utf8"));
  } catch {
    return fallback;
  }
}
async function readTextIfExists(filePath, fallback = "") {
  try {
    return await readFile2(filePath, "utf8");
  } catch {
    return fallback;
  }
}
function timestampSegment(value = (/* @__PURE__ */ new Date()).toISOString()) {
  return value.replace(/[^0-9TZ]/g, "").replace(/T$/, "").slice(0, 15) || String(Date.now());
}
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === void 0 || value === null) return [];
  return [value];
}
function frameRoleSummary(selection) {
  const frames = selection?.frames || {};
  const summary = {};
  for (const role of ["page", "components", "assets"]) {
    const roleFrames = asArray(frames[role]);
    summary[role] = {
      count: roleFrames.length,
      nodeIds: roleFrames.map((frame) => frame?.nodeId || frame?.id).filter(Boolean),
      names: roleFrames.map((frame) => frame?.name).filter(Boolean)
    };
  }
  return summary;
}
function trustedChecksum(value) {
  return /^sha256:[0-9a-f]{64}$/i.test(String(value || ""));
}
function flattenLayerNodes(nodes) {
  const output = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    output.push(node);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return output;
}
function buildTimings(bundle, writeFilesMs, dependencyLockMs) {
  const source = bundle.summary?.captureTimings || {};
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
async function buildDiagnostics(outputDir, dependencyLock) {
  const selection = await readJsonIfExists2(path2.join(outputDir, "figma", "selection.json"), {});
  const layers = await readJsonIfExists2(path2.join(outputDir, "figma", "layers.json"), { nodes: [] });
  const components = await readJsonIfExists2(path2.join(outputDir, "figma", "components.json"), {});
  const variables = await readJsonIfExists2(path2.join(outputDir, "figma", "variables.json"), {});
  const assetManifest = await readJsonIfExists2(path2.join(outputDir, "assets-manifest.json"), { assets: [] });
  const assetBindings = await readJsonIfExists2(path2.join(outputDir, "asset-bindings.json"), { bindings: [] });
  const dynamicRegionNotes = await readTextIfExists(path2.join(outputDir, "dynamic-regions.md"), "");
  const assets = asArray(assetManifest?.assets);
  const bindings = asArray(assetBindings?.bindings);
  const layerNodes = flattenLayerNodes(asArray(layers?.nodes));
  const componentInstances = asArray(components?.instances);
  const componentMetadataMissingCount = Number.isFinite(Number(components?.metadataCompleteness?.componentMetadataMissingCount)) ? Number(components.metadataCompleteness.componentMetadataMissingCount) : componentInstances.filter((instance) => !instance?.mainComponentNodeId && !instance?.componentRef?.mainComponentNodeId).length;
  const visibilityFactsCount = Number.isFinite(Number(components?.metadataCompleteness?.visibilityFactsCount)) ? Number(components.metadataCompleteness.visibilityFactsCount) : layerNodes.filter((node) => typeof node?.visible === "boolean" || typeof node?.hidden === "boolean").length;
  const styleRefNodeCount = layerNodes.filter((node) => node?.styleIds && Object.keys(node.styleIds).length > 0).length;
  const variableRefNodeCount = layerNodes.filter((node) => node?.boundVariables || node?.tokenRefs?.boundVariables).length;
  const selectedPendingPreflight = ["components", "assets"].map((role) => ({ role, dependency: dependencyLock?.[role] })).filter((item) => item.dependency?.status === "selected" && item.dependency?.needsSourceSync === true).map((item) => ({
    role: item.role,
    frameNodeIds: item.dependency.frameNodeIds || (item.dependency.frameNodeId ? [item.dependency.frameNodeId] : []),
    plannedSnapshotId: item.dependency.plannedSnapshotId,
    materializationStatus: item.dependency.materializationStatus || "pending-preflight"
  }));
  const unresolvedSharedRefs = bindings.filter((binding) => binding?.scope === "shared" || binding?.unresolved === true);
  return {
    schemaVersion: "2.0",
    kind: "pragma-figma-capture-diagnostics",
    frameRoles: frameRoleSummary(selection),
    assetCount: assets.length,
    assetChecksumUnavailableCount: assets.filter((asset) => !trustedChecksum(asset?.checksum) && (asset?.checksumStatus === "unavailable" || !asset?.checksum)).length,
    componentInstanceCount: componentInstances.length,
    componentMetadataMissingCount,
    visibilityFactsCount,
    styleRefNodeCount,
    variableRefNodeCount,
    localVariableCount: asArray(variables?.variables).length,
    localStyleCount: asArray(variables?.styles).length,
    assetBindingCount: bindings.length,
    unresolvedSharedRefCount: unresolvedSharedRefs.length,
    unresolvedSharedRefs: unresolvedSharedRefs.map((binding) => ({ assetId: binding?.assetId, figmaNodeId: binding?.figmaNodeId, nodeId: binding?.nodeId })),
    dynamicRegionNotesMissing: dynamicRegionNotes.trim().length === 0,
    selectedPendingPreflight
  };
}
async function defaultOutputDir(bundle, explicitRepo) {
  const capture = await readCaptureFromBundle(bundle);
  const repo = explicitRepo || capture?.repo?.localPath || process.cwd();
  const issue = Number(capture?.designIssue?.number || 0) || "unknown";
  const stamp = timestampSegment(capture?.capturedAt);
  return path2.join(path2.resolve(repo), ".pragma", "incoming", "figma-captures", `issue-${issue}-${stamp}`, "pragma-input");
}
async function writePragmaInputBundle(bundle, options = {}) {
  const totalStart = nowMs();
  assertBundle(bundle);
  const outputDir = path2.resolve(options.out || await defaultOutputDir(bundle, options.repo));
  await mkdir(outputDir, { recursive: true });
  const writeStart = nowMs();
  for (const file of bundle.files) {
    const target = safeJoin(outputDir, file.path);
    await mkdir(path2.dirname(target), { recursive: true });
    await writeDecodedFile(target, decodeFile(file));
  }
  const writeFilesMs = elapsedMs(writeStart);
  const dependencyStart = nowMs();
  const capturePath = path2.join(outputDir, "capture.json");
  const capture = JSON.parse(await readFile2(capturePath, "utf8"));
  const repoLocalPath = options.repo || capture?.repo?.localPath;
  const dependencyLock = await buildDependencyLock(outputDir, repoLocalPath);
  await writeFile(path2.join(outputDir, "dependency-lock.json"), `${JSON.stringify(dependencyLock, null, 2)}
`, "utf8");
  const dependencyLockMs = elapsedMs(dependencyStart);
  const captureTimings = buildTimings(bundle, writeFilesMs, dependencyLockMs);
  captureTimings.totalMs = Math.max(captureTimings.totalMs, elapsedMs(totalStart));
  const diagnostics = await buildDiagnostics(outputDir, dependencyLock);
  const captureSummary = {
    schemaVersion: "2.0",
    kind: "pragma-figma-capture-summary",
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    outputDir,
    captureTimings,
    diagnostics,
    statuses: {
      components: dependencyLock.components.status,
      assets: dependencyLock.assets.status
    }
  };
  const captureSummaryPath = path2.join(outputDir, "capture-summary.json");
  await writeFile(captureSummaryPath, `${JSON.stringify(captureSummary, null, 2)}
`, "utf8");
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

// src/bridge/server.ts
var BRIDGE_VERSION = "0.1.0";
function jsonResponse(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(payload, null, 2));
}
async function readBody(req, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) {
      const error = new Error(`Request body exceeds limit ${limitBytes} bytes.`);
      error.code = "BRIDGE_REQUEST_TOO_LARGE";
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function errorCode(error) {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  if (error instanceof SyntaxError) return "BRIDGE_INVALID_JSON";
  return "BRIDGE_CAPTURE_WRITE_FAILED";
}
function createBridgeServer(options = {}) {
  const limitBytes = options.limitBytes || 100 * 1024 * 1024;
  let lastCaptureSummary = null;
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
      const bundle = parsed.bundle || parsed;
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
async function startBridgeServer(options = {}) {
  const host = options.host || "localhost";
  const port = options.port || 48732;
  const server = createBridgeServer(options);
  await new Promise((resolve) => server.listen(port, host, resolve));
  return { server, host, port, url: `http://${host}:${port}/capture` };
}
export {
  createBridgeServer,
  startBridgeServer
};
