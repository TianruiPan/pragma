import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { CliError } from "./errors.js";
import { sha256File } from "./checksum.js";
import { normalizeFigmaNodeId } from "./figma-url.js";
import { ensureDir, normalizeRelativePosix, pathExists, safeJoin, writeJson, writeText } from "./fs.js";
import { sniffAssetFile, typeFromExtension } from "./mime.js";
import { asArray } from "./normalize.js";
import { addDesignSourceSnapshot } from "./source-registry.js";
import { elapsedMs, emptyTimings } from "./timing.js";

const TRUSTED_SHA256 = /^sha256:[0-9a-f]{64}$/i;
const REQUIRED_JSON = [
  "capture.json",
  "dependency-lock.json",
  "assets-manifest.json",
  "asset-bindings.json",
  "figma/metadata.json",
  "figma/selection.json",
  "figma/layers.json",
  "figma/variables.json",
  "figma/components.json"
];
const REQUIRED_DIRS = ["figma", "screenshots", "assets"];
const NOTES_FILES = ["designer-notes.md", "dynamic-regions.md"];

function boolOption(options, key) {
  const value = options[key] ?? options[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
  if (value === undefined) return false;
  if (value === true) return true;
  return !["0", "false", "no", "none"].includes(String(value).toLowerCase());
}

function isTrustedSha256(value) {
  return TRUSTED_SHA256.test(String(value || ""));
}

function isPlaceholderChecksum(value) {
  const text = String(value || "");
  return !text || /^sha256:plugin-webcrypto-unavailable-/i.test(text) || !isTrustedSha256(text);
}

function issue(report, category, code, message, details = {}) {
  const record = {
    category,
    code,
    message,
    fixable: category === "AUTO_FIXABLE",
    ...details
  };
  report.issues.push(record);
  return record;
}

function repair(report, code, message, details = {}) {
  report.repairs.push({ code, message, ...details });
}

function markFixed(report, record, code, message, details = {}) {
  record.fixed = true;
  repair(report, code, message, details);
}

async function readJsonForPreflight(inputDir, relPath, report, fix) {
  const filePath = safeJoin(inputDir, relPath);
  if (!(await pathExists(filePath))) {
    issue(report, "BLOCKING_INPUT", "MISSING_REQUIRED_JSON", `${relPath} is missing.`, { path: relPath });
    return undefined;
  }
  let text = await fs.readFile(filePath, "utf8");
  if (text.startsWith("\uFEFF")) {
    const record = issue(report, "AUTO_FIXABLE", "UTF8_BOM", `${relPath} has a UTF-8 BOM.`, { path: relPath });
    if (fix) {
      text = text.replace(/^\uFEFF/, "");
      await fs.writeFile(filePath, text, "utf8");
      markFixed(report, record, "UTF8_BOM_REMOVED", `Removed UTF-8 BOM from ${relPath}.`, { path: relPath });
    }
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    issue(report, "BLOCKING_INPUT", "INVALID_JSON", `${relPath} is not valid JSON: ${error.message}`, { path: relPath });
    return undefined;
  }
}

async function ensureRequiredPaths(inputDir, report, fix) {
  for (const dir of REQUIRED_DIRS) {
    if (!(await pathExists(safeJoin(inputDir, dir)))) {
      issue(report, "BLOCKING_INPUT", "MISSING_REQUIRED_DIRECTORY", `${dir}/ is missing.`, { path: dir });
    }
  }
  for (const rel of NOTES_FILES) {
    const file = safeJoin(inputDir, rel);
    if (await pathExists(file)) continue;
    const record = issue(report, "AUTO_FIXABLE", "MISSING_NOTES_FILE", `${rel} is missing.`, { path: rel });
    if (fix) {
      await writeText(file, "");
      markFixed(report, record, "NOTES_FILE_CREATED", `Created empty ${rel}.`, { path: rel });
    }
  }
}

function normalizeAssetPath(rawPath) {
  const cleaned = normalizeRelativePosix(rawPath || "");
  if (!cleaned) return undefined;
  return cleaned.startsWith("assets/") ? cleaned : `assets/${cleaned}`;
}

function normalizeManifestPath(rawPath) {
  const cleaned = normalizeRelativePosix(rawPath || "");
  if (!cleaned) return undefined;
  return cleaned.startsWith("assets/") ? cleaned.slice("assets/".length) : cleaned;
}

async function preflightAssets(inputDir, manifest, report, fix) {
  if (!manifest || !Array.isArray(manifest.assets)) return false;
  let dirty = false;
  for (const [index, asset] of manifest.assets.entries()) {
    const rawPath = asset.path || asset.fileName || asset.filename || asset.name;
    const label = asset.id || asset.name || `asset-${index + 1}`;
    let normalizedRel;
    let manifestRel;
    try {
      normalizedRel = normalizeAssetPath(rawPath);
      manifestRel = normalizeManifestPath(rawPath);
    } catch (error) {
      issue(report, "BLOCKING_INPUT", "UNSAFE_ASSET_PATH", `Asset ${label} path is unsafe: ${error.message}`, { assetId: asset.id, path: rawPath });
      continue;
    }
    if (!normalizedRel) {
      issue(report, "BLOCKING_INPUT", "ASSET_PATH_MISSING", `Asset ${label} has no path.`, { assetId: asset.id });
      continue;
    }
    if (asset.path && String(asset.path).includes("\\")) {
      const record = issue(report, "AUTO_FIXABLE", "ASSET_PATH_SEPARATOR", `Asset ${label} path uses backslashes.`, { assetId: asset.id, path: asset.path });
      if (fix) {
        asset.path = manifestRel;
        dirty = true;
        markFixed(report, record, "ASSET_PATH_NORMALIZED", `Normalized asset path for ${label}.`, { assetId: asset.id, path: asset.path });
      }
    }
    const absolute = safeJoin(inputDir, normalizedRel);
    if (!(await pathExists(absolute))) {
      issue(report, "BLOCKING_INPUT", "ASSET_FILE_MISSING", `Asset ${label} file is missing: ${normalizedRel}`, { assetId: asset.id, path: normalizedRel });
      continue;
    }
    const sniffed = await sniffAssetFile(absolute);
    const actualChecksum = await sha256File(absolute);
    if (isPlaceholderChecksum(asset.checksum) || asset.checksum !== actualChecksum) {
      const record = issue(report, "AUTO_FIXABLE", "ASSET_CHECKSUM_INVALID", `Asset ${label} checksum is missing, placeholder, or does not match the file.`, { assetId: asset.id, path: normalizedRel });
      if (fix) {
        asset.checksum = actualChecksum;
        delete asset.checksumStatus;
        dirty = true;
        markFixed(report, record, "ASSET_CHECKSUM_REPAIRED", `Recomputed checksum for ${label}.`, { assetId: asset.id, path: normalizedRel, checksum: actualChecksum });
      }
    }
    if (sniffed.width !== undefined && Number(asset.width) !== Number(sniffed.width)) {
      const record = issue(report, "AUTO_FIXABLE", "ASSET_WIDTH_MISMATCH", `Asset ${label} width does not match the exported file.`, { assetId: asset.id, expected: sniffed.width, actual: asset.width });
      if (fix) {
        asset.width = sniffed.width;
        dirty = true;
        markFixed(report, record, "ASSET_WIDTH_REPAIRED", `Repaired width for ${label}.`, { assetId: asset.id, width: sniffed.width });
      }
    }
    if (sniffed.height !== undefined && Number(asset.height) !== Number(sniffed.height)) {
      const record = issue(report, "AUTO_FIXABLE", "ASSET_HEIGHT_MISMATCH", `Asset ${label} height does not match the exported file.`, { assetId: asset.id, expected: sniffed.height, actual: asset.height });
      if (fix) {
        asset.height = sniffed.height;
        dirty = true;
        markFixed(report, record, "ASSET_HEIGHT_REPAIRED", `Repaired height for ${label}.`, { assetId: asset.id, height: sniffed.height });
      }
    }
    const extensionType = typeFromExtension(normalizedRel);
    if (sniffed.type !== "binary" && extensionType && extensionType !== sniffed.type && !(extensionType === "jpg" && sniffed.type === "jpeg")) {
      issue(report, "BLOCKING_INPUT", "ASSET_EXTENSION_MISMATCH", `Asset ${label} extension .${extensionType} does not match magic type ${sniffed.type}.`, { assetId: asset.id, path: normalizedRel });
    }
    if (sniffed.type !== "binary" && asset.mime && asset.mime !== sniffed.mime) {
      const record = issue(report, "AUTO_FIXABLE", "ASSET_MIME_MISMATCH", `Asset ${label} MIME does not match magic bytes.`, { assetId: asset.id, expected: sniffed.mime, actual: asset.mime });
      if (fix) {
        asset.mime = sniffed.mime;
        asset.type = sniffed.type;
        dirty = true;
        markFixed(report, record, "ASSET_MIME_REPAIRED", `Repaired MIME/type for ${label}.`, { assetId: asset.id, mime: sniffed.mime, type: sniffed.type });
      }
    }
  }
  if (dirty) await writeJson(path.join(inputDir, "assets-manifest.json"), manifest);
  return dirty;
}

function framesForRole(capture, selection, role) {
  const frames = [
    ...asArray(capture?.figma?.frames?.[role]),
    ...asArray(selection?.frames?.[role])
  ];
  const seen = new Set();
  const unique = [];
  for (const frame of frames) {
    const nodeId = normalizeFigmaNodeId(frame?.nodeId || frame?.id || frame);
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    unique.push(typeof frame === "object" ? { ...frame, nodeId } : { nodeId });
  }
  return unique;
}

function nodeIdentity(node) {
  return normalizeFigmaNodeId(node?.figmaNodeId || node?.nodeId || node?.id);
}

function roleLayerDataPresent(layers, role, frameIds) {
  const roots = asArray(layers?.nodes);
  return roots.some((node) => node?.role === role || frameIds.has(nodeIdentity(node)));
}

function frameIdsForDependency(dep, capture, selection, role) {
  const ids = [
    ...asArray(dep?.frameNodeIds),
    dep?.frameNodeId,
    dep?.nodeId,
    ...framesForRole(capture, selection, role).map((frame) => frame.nodeId)
  ];
  return [...new Set(ids.map((id) => normalizeFigmaNodeId(id)).filter(Boolean))];
}

function resolveSnapshotPath(repoPath, dep) {
  if (!dep?.path) return undefined;
  const normalized = String(dep.path).replace(/\\/g, "/");
  if (path.isAbsolute(normalized)) return undefined;
  return safeJoin(repoPath, normalized);
}

async function readRegistry(repoPath, fileKey) {
  if (!repoPath || !fileKey) return undefined;
  const registryPath = safeJoin(repoPath, ".pragma", "design-sources", "figma", fileKey, "registry.json");
  if (!(await pathExists(registryPath))) return undefined;
  try {
    return JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch {
    return undefined;
  }
}

function registryEntry(registry, role, snapshotId) {
  return asArray(registry?.roles?.[role]).find((entry) => entry.snapshotId === snapshotId);
}

function hasComponentInstances(components, layers) {
  if (asArray(components?.instances).length) return true;
  const stack = [...asArray(layers?.nodes)];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (node.type === "INSTANCE" || node.componentRef) return true;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return false;
}

function hasUnresolvedAssetRefs(assetManifest, assetBindings) {
  if (asArray(assetManifest?.sharedAssetRefs).length) return true;
  if (asArray(assetManifest?.assets).some((asset) => asset.shared || asset.source === "shared-snapshot" || asset.snapshotId)) return true;
  return asArray(assetBindings?.bindings).some((binding) => binding.scope === "shared" || binding.unresolved === true);
}

async function materializeSelectedDependency({ inputDir, repoPath, fileKey, lock, capture, selection, layers, role, report, fix }) {
  const dep = lock?.[role] || {};
  if (dep.status !== "selected") return false;
  const frameIds = frameIdsForDependency(dep, capture, selection, role);
  const selectedFrames = framesForRole(capture, selection, role);
  const hasFrameData = selectedFrames.length > 0 || roleLayerDataPresent(layers, role, new Set(frameIds));
  const snapshotPath = resolveSnapshotPath(repoPath, dep);
  const pathExistsOnDisk = snapshotPath ? await pathExists(snapshotPath) : false;
  const concrete = dep.snapshotId && dep.path && pathExistsOnDisk && isTrustedSha256(dep.checksum);
  if (concrete) return false;

  if (!hasFrameData || !frameIds.length) {
    issue(report, "BLOCKING_INPUT", "BLOCKING_DEPENDENCY_SNAPSHOT_MISSING", `Selected ${role} snapshot is missing and the selected ${role} frame data is absent. Re-capture the ${role} frame.`, { role });
    return false;
  }

  const record = issue(report, "AUTO_FIXABLE", "SELECTED_SNAPSHOT_MISSING", `Selected ${role} snapshot is not materialized.`, { role, frameNodeIds: frameIds });
  if (!fix) return false;

  const result = await addDesignSourceSnapshot({
    input: inputDir,
    repo: repoPath,
    fileKey,
    role,
    frame: frameIds[0]
  });
  lock[role] = {
    ...dep,
    status: "selected",
    frameNodeId: dep.frameNodeId || frameIds[0],
    frameNodeIds: frameIds,
    snapshotId: result.snapshotId,
    path: result.path,
    checksum: result.checksum,
    materializationStatus: "materialized",
    needsSourceSync: false,
    reason: dep.reason || "selected-in-current-plugin-upload"
  };
  delete lock[role].plannedSnapshotId;
  delete lock[role].contentChecksum;
  markFixed(report, record, "DEPENDENCY_SNAPSHOT_MATERIALIZED", `Materialized selected ${role} snapshot.`, { role, snapshotId: result.snapshotId, path: result.path, checksum: result.checksum });
  return true;
}

async function reconcileReusedDependency({ repoPath, fileKey, lock, role, registry, report, fix }) {
  const dep = lock?.[role] || {};
  if (dep.status !== "reused") return false;
  const entry = registryEntry(registry, role, dep.snapshotId);
  const snapshotPath = resolveSnapshotPath(repoPath, dep);
  const pathExistsOnDisk = snapshotPath ? await pathExists(snapshotPath) : false;
  if (dep.path && pathExistsOnDisk && isTrustedSha256(dep.checksum)) return false;
  if (!entry) {
    issue(report, "BLOCKING_INPUT", "DEPENDENCY_SNAPSHOT_MISSING", `Reused ${role} snapshot is missing from the registry.`, { role, snapshotId: dep.snapshotId });
    return false;
  }
  const record = issue(report, "AUTO_FIXABLE", "DEPENDENCY_LOCK_RECONCILE", `Reused ${role} dependency can be reconciled from registry.`, { role, snapshotId: entry.snapshotId });
  if (!fix) return false;
  lock[role] = {
    ...dep,
    frameNodeId: dep.frameNodeId || entry.frameNodeId,
    frameNodeIds: dep.frameNodeIds || (entry.frameNodeId ? [entry.frameNodeId] : undefined),
    snapshotId: entry.snapshotId,
    path: entry.path,
    checksum: entry.checksum,
    reason: dep.reason || "latest-shared-snapshot-from-repo-registry"
  };
  markFixed(report, record, "DEPENDENCY_LOCK_RECONCILED", `Reconciled reused ${role} dependency from registry.`, { role, snapshotId: entry.snapshotId, path: entry.path });
  return true;
}

async function preflightDependencies({ inputDir, repoPath, capture, selection, layers, components, assetManifest, assetBindings, lock, report, fix }) {
  if (!lock) return false;
  let dirty = false;
  const fileKey = lock.fileKey || capture?.figma?.fileKey || selection?.fileKey;
  if (!fileKey) {
    issue(report, "BLOCKING_INPUT", "FIGMA_FILE_KEY_MISSING", "Figma fileKey is required in capture, selection, or dependency-lock.");
    return dirty;
  }
  lock.fileKey = fileKey;
  const registry = await readRegistry(repoPath, fileKey);

  for (const role of ["components", "assets"]) {
    dirty = await materializeSelectedDependency({ inputDir, repoPath, fileKey, lock, capture, selection, layers, role, report, fix }) || dirty;
    dirty = await reconcileReusedDependency({ repoPath, fileKey, lock, role, registry, report, fix }) || dirty;
    const dep = lock[role];
    if (dep?.path && String(dep.path).includes("\\")) {
      const record = issue(report, "AUTO_FIXABLE", "DEPENDENCY_PATH_SEPARATOR", `Dependency ${role} path uses backslashes.`, { role, path: dep.path });
      if (fix) {
        dep.path = String(dep.path).replace(/\\/g, "/");
        dirty = true;
        markFixed(report, record, "DEPENDENCY_PATH_NORMALIZED", `Normalized dependency path for ${role}.`, { role, path: dep.path });
      }
    }
    if ((dep?.status === "selected" || dep?.status === "reused") && dep?.path) {
      const resolved = resolveSnapshotPath(repoPath, dep);
      if (!resolved || !(await pathExists(resolved))) {
        issue(report, "BLOCKING_INPUT", "DEPENDENCY_SNAPSHOT_PATH_MISSING", `Dependency ${role} snapshot path is missing: ${dep.path}`, { role, path: dep.path });
      }
      if (!isTrustedSha256(dep.checksum)) {
        issue(report, "BLOCKING_INPUT", "DEPENDENCY_CHECKSUM_INVALID", `Dependency ${role} checksum is not a trusted sha256.`, { role });
      }
    }
  }

  if (lock.components?.status === "missing" && lock.rules?.ifMissingComponentsAndPageHasInstances === "block" && hasComponentInstances(components, layers)) {
    issue(report, "BLOCKING_DESIGN", "MISSING_COMPONENTS_DEPENDENCY", "Page has component instances but no components snapshot or selected frame is available.");
  }
  if (lock.assets?.status === "missing" && lock.rules?.ifMissingAssetsAndPageHasUnresolvedRefs === "block" && hasUnresolvedAssetRefs(assetManifest, assetBindings)) {
    issue(report, "BLOCKING_DESIGN", "MISSING_ASSETS_DEPENDENCY", "Page has unresolved/shared asset refs but no assets snapshot or selected frame is available.");
  }

  if (dirty) await writeJson(path.join(inputDir, "dependency-lock.json"), lock);
  return dirty;
}

function preflightFigmaConsistency({ capture, metadata, selection, lock, report }) {
  const fileKeys = [
    capture?.figma?.fileKey,
    metadata?.fileKey,
    selection?.fileKey,
    lock?.fileKey
  ].filter(Boolean);
  const unique = new Set(fileKeys);
  if (unique.size > 1) {
    issue(report, "BLOCKING_INPUT", "FIGMA_FILE_KEY_MISMATCH", "Figma fileKey is inconsistent across capture, metadata, selection, and dependency-lock.", { fileKeys: [...unique] });
  }
  if (!fileKeys.length) issue(report, "BLOCKING_INPUT", "FIGMA_FILE_KEY_MISSING", "Figma fileKey is missing.");
  const issueNumber = Number(capture?.designIssue?.number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    issue(report, "BLOCKING_INPUT", "DESIGN_ISSUE_NUMBER_MISSING", "capture.designIssue.number must be a positive integer.");
  }
}

function finalize(report) {
  const unresolved = report.issues.filter((item) => !item.fixed && (item.category === "AUTO_FIXABLE" || item.category === "BLOCKING_INPUT" || item.category === "BLOCKING_DESIGN"));
  report.ok = unresolved.length === 0;
  report.status = report.ok ? "ok" : "blocked";
  report.summary = {
    issues: report.issues.length,
    unresolved: unresolved.length,
    repairs: report.repairs.length,
    autoFixable: report.issues.filter((item) => item.category === "AUTO_FIXABLE").length,
    blockingInput: report.issues.filter((item) => item.category === "BLOCKING_INPUT").length,
    blockingDesign: report.issues.filter((item) => item.category === "BLOCKING_DESIGN").length
  };
  return report;
}

export async function preflightFigmaCapture(options) {
  const startedAt = performance.now();
  const timings = emptyTimings();
  if (!options.input) throw new CliError("--input is required for design preflight.");
  if (!options.repo) throw new CliError("--repo is required for design preflight.");
  const inputDir = path.resolve(String(options.input));
  const repoPath = path.resolve(String(options.repo));
  timings.resolveInputMs = elapsedMs(startedAt);
  const fix = boolOption(options, "fix");
  const report = {
    ok: false,
    command: "design preflight",
    inputDir,
    repoPath,
    fix,
    timings,
    issues: [],
    repairs: []
  };
  if (!(await pathExists(inputDir))) {
    issue(report, "BLOCKING_INPUT", "INPUT_DIRECTORY_MISSING", `Input directory does not exist: ${inputDir}`, { path: inputDir });
    return finalize(report);
  }
  await ensureDir(repoPath);
  await ensureRequiredPaths(inputDir, report, fix);

  const json = {};
  for (const rel of REQUIRED_JSON) {
    json[rel] = await readJsonForPreflight(inputDir, rel, report, fix);
  }

  await preflightAssets(inputDir, json["assets-manifest.json"], report, fix);
  await preflightDependencies({
    inputDir,
    repoPath,
    capture: json["capture.json"],
    selection: json["figma/selection.json"],
    layers: json["figma/layers.json"],
    components: json["figma/components.json"],
    assetManifest: json["assets-manifest.json"],
    assetBindings: json["asset-bindings.json"],
    lock: json["dependency-lock.json"],
    report,
    fix
  });
  preflightFigmaConsistency({
    capture: json["capture.json"],
    metadata: json["figma/metadata.json"],
    selection: json["figma/selection.json"],
    lock: json["dependency-lock.json"],
    report
  });
  const finalized = finalize(report);
  finalized.timings.preflightMs = elapsedMs(startedAt);
  return finalized;
}
