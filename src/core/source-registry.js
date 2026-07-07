import fs from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";
import { generateChecksums, sha256File, sha256Text } from "./checksum.js";
import { parseFigmaUrl, figmaNodeIdForPath, normalizeFigmaNodeId } from "./figma-url.js";
import { ensureDir, listFilesRecursive, pathExists, readJson, relativePosix, safeJoin, writeJson } from "./fs.js";
import { asArray, normalizeAssets } from "./normalize.js";
import { buildComponents, buildLayerModel, buildTokens } from "./pixel-normalize.js";

const ROLES = new Set(["components", "assets"]);

function nowIso() {
  return new Date().toISOString();
}

function repoPathFromOptions(options, capture = {}) {
  const repo = options.repo || options["repo-path"] || capture.repo?.localPath;
  if (!repo) throw new CliError("--repo is required for shared design source registry commands.");
  return path.resolve(String(repo));
}

function registryRoot(repoPath, fileKey) {
  if (!fileKey) throw new CliError("Figma fileKey is required. Use --url or --file-key.");
  return safeJoin(repoPath, ".pragma", "design-sources", "figma", fileKey);
}

async function readRegistry(repoPath, fileKey) {
  const root = registryRoot(repoPath, fileKey);
  const registryPath = path.join(root, "registry.json");
  if (await pathExists(registryPath)) return readJson(registryPath);
  return {
    schemaVersion: "2.0",
    kind: "pragma-design-source-registry",
    fileKey,
    latest: {},
    roles: { components: [], assets: [] }
  };
}

async function writeRegistry(repoPath, fileKey, registry) {
  const root = registryRoot(repoPath, fileKey);
  await ensureDir(root);
  await writeJson(path.join(root, "registry.json"), registry);
}

async function writeSources(repoPath, fileKey, source) {
  const root = registryRoot(repoPath, fileKey);
  const sourcesPath = path.join(root, "sources.json");
  const current = await readJson(sourcesPath, { schemaVersion: "2.0", kind: "pragma-design-sources", fileKey, sources: [] }).catch(() => ({ schemaVersion: "2.0", kind: "pragma-design-sources", fileKey, sources: [] }));
  current.fileKey = fileKey;
  current.sources = asArray(current.sources);
  current.sources.push(source);
  await writeJson(sourcesPath, current);
}

function snapshotPath(repoPath, fileKey, snapshotId) {
  return path.join(registryRoot(repoPath, fileKey), "snapshots", snapshotId);
}

function snapshotRelPath(fileKey, snapshotId) {
  return `.pragma/design-sources/figma/${fileKey}/snapshots/${snapshotId}`;
}

function normalizeLatestEntry(registry, role) {
  const latest = registry.latest?.[role];
  if (!latest) return undefined;
  const snapshotId = typeof latest === "string" ? latest : latest.snapshotId;
  return asArray(registry.roles?.[role]).find((entry) => entry.snapshotId === snapshotId) || (snapshotId ? { snapshotId } : undefined);
}

function parseFrameOption(options, role) {
  const raw = options[role] || options[`${role}-frame`] || options[`${role}Frame`] || options[`${role}-node`] || options[`${role}Node`];
  if (raw === true || raw === undefined || raw === null || raw === "") return undefined;
  const text = String(raw);
  if (["none", "no", "false"].includes(text.toLowerCase())) return { explicitNone: true };
  return { nodeId: normalizeFigmaNodeId(text) };
}

function parsePageFrames(options, parsedUrl) {
  const raw = options.page || options["page-frame"] || options.pageFrame || options["page-node"] || options.pageNode || parsedUrl.nodeId;
  if (!raw || raw === true) throw new CliError("--page (or a Figma URL with node-id) is required for design prepare-figma-capture.");
  return String(raw).split(",").map((item) => item.trim()).filter(Boolean).map((item) => ({ nodeId: normalizeFigmaNodeId(item) }));
}

function boolOption(options, key) {
  const value = options[key] ?? options[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
  if (value === undefined) return false;
  if (value === true) return true;
  return !["0", "false", "no", "none"].includes(String(value).toLowerCase());
}

function planRole({ registry, role, frame, pageNeeds }) {
  if (frame?.explicitNone) return { status: "none", required: false };
  if (frame?.nodeId) return { status: "selected", frameNodeId: frame.nodeId, captureRequired: true, required: pageNeeds };
  const latest = normalizeLatestEntry(registry, role);
  if (latest?.snapshotId) {
    return {
      status: "reused",
      frameNodeId: latest.frameNodeId,
      snapshotId: latest.snapshotId,
      path: latest.path,
      checksum: latest.checksum,
      required: pageNeeds
    };
  }
  return { status: "missing", required: pageNeeds };
}

export async function prepareFigmaCapture(options) {
  const parsedUrl = parseFigmaUrl(options.url || options["figma-url"] || options.figmaUrl);
  const fileKey = options["file-key"] || options.fileKey || parsedUrl.fileKey;
  const repoPath = path.resolve(String(options.repo || options["repo-path"] || process.cwd()));
  const pageFrames = parsePageFrames(options, parsedUrl);
  const registry = await readRegistry(repoPath, fileKey);
  const pageHasInstances = boolOption(options, "page-has-instances");
  const pageHasUnresolvedAssets = boolOption(options, "page-has-unresolved-assets");
  const components = planRole({ registry, role: "components", frame: parseFrameOption(options, "components"), pageNeeds: pageHasInstances });
  const assets = planRole({ registry, role: "assets", frame: parseFrameOption(options, "assets"), pageNeeds: pageHasUnresolvedAssets });
  const blockers = [];
  if (components.status === "missing" && pageHasInstances) {
    blockers.push({ code: "MISSING_COMPONENTS_SNAPSHOT", message: "Page has component instances but no selected/reusable components snapshot is available." });
  }
  if (assets.status === "missing" && pageHasUnresolvedAssets) {
    blockers.push({ code: "MISSING_ASSETS_SNAPSHOT", message: "Page has unresolved asset refs but no selected/reusable assets snapshot is available." });
  }
  return {
    ok: blockers.length === 0,
    command: "design prepare-figma-capture",
    repoPath,
    figma: {
      url: parsedUrl.url,
      fileKey,
      branchKey: parsedUrl.branchKey,
      nodeId: parsedUrl.nodeId
    },
    frames: {
      page: pageFrames,
      components: components.frameNodeId ? { nodeId: components.frameNodeId } : undefined,
      assets: assets.frameNodeId ? { nodeId: assets.frameNodeId } : undefined
    },
    dependencies: {
      fileKey,
      pageFrames: pageFrames.map((frame) => ({ nodeId: frame.nodeId })),
      components,
      assets,
      rules: {
        lockDependencies: true,
        neverDependOnFloatingLatest: true,
        ifMissingComponentsAndPageHasInstances: "block",
        ifMissingAssetsAndPageHasUnresolvedRefs: "block"
      }
    },
    registry: {
      path: `.pragma/design-sources/figma/${fileKey}/registry.json`,
      latest: registry.latest || {}
    },
    blockers
  };
}

async function copyDirContents(from, to) {
  if (!(await pathExists(from))) return false;
  await ensureDir(to);
  await fs.cp(from, to, { recursive: true, force: true });
  return true;
}

async function buildComponentsSnapshot(inputDir) {
  const layerSource = await readJson(path.join(inputDir, "figma", "layers.json"), {}).catch(() => ({}));
  const variablesSource = await readJson(path.join(inputDir, "figma", "variables.json"), {}).catch(() => ({}));
  const componentsSource = await readJson(path.join(inputDir, "figma", "components.json"), {}).catch(() => ({}));
  const layerModel = buildLayerModel(layerSource, []);
  return {
    components: buildComponents(componentsSource, layerModel.rawNodes),
    tokens: buildTokens(variablesSource)
  };
}

async function buildAssetsContentKey(inputDir) {
  const manifest = await readJson(path.join(inputDir, "assets-manifest.json"), { assets: [] }).catch(() => ({ assets: [] }));
  const bindings = await readJson(path.join(inputDir, "asset-bindings.json"), { bindings: [] }).catch(() => ({ bindings: [] }));
  const assetsRoot = path.join(inputDir, "assets");
  const files = await listFilesRecursive(assetsRoot);
  const fileChecksums = [];
  for (const file of files) {
    fileChecksums.push({ path: relativePosix(assetsRoot, file), checksum: await sha256File(file) });
  }
  return { manifest, bindings, fileChecksums };
}

function hashNormalized(value) {
  const checksum = sha256Text(JSON.stringify(value));
  return { checksum, contentSha: checksum.replace(/^sha256:/, "") };
}

async function materializeSnapshot({ role, inputDir, snapshotDir }) {
  await ensureDir(snapshotDir);
  await ensureDir(path.join(snapshotDir, "normalized"));
  const capture = await readJson(path.join(inputDir, "capture.json"), {}).catch(() => ({}));
  await writeJson(path.join(snapshotDir, "capture.json"), capture);
  if (role === "components") {
    const normalized = await buildComponentsSnapshot(inputDir);
    await writeJson(path.join(snapshotDir, "normalized", "components.json"), normalized.components);
    await writeJson(path.join(snapshotDir, "normalized", "tokens.json"), normalized.tokens);
    await copyDirContents(path.join(inputDir, "screenshots"), path.join(snapshotDir, "screenshots"));
  } else {
    await copyDirContents(path.join(inputDir, "assets"), path.join(snapshotDir, "assets"));
    const bindings = await readJson(path.join(inputDir, "asset-bindings.json"), {}).catch(() => ({}));
    const assetsManifest = await readJson(path.join(inputDir, "assets-manifest.json"), undefined).catch(() => undefined);
    const assets = await normalizeAssets(snapshotDir, assetsManifest, asArray(bindings.bindings || bindings.assetBindings || bindings));
    await writeJson(path.join(snapshotDir, "normalized", "assets.json"), { schemaVersion: "2.0", kind: "pragma-design-assets", assets });
  }
  await generateChecksums(snapshotDir);
}

function frameNameFromInput(capture, role, frameNodeId) {
  const roleFrames = asArray(capture.figma?.frames?.[role]);
  const roleFrame = roleFrames.find((frame) => normalizeFigmaNodeId(frame.nodeId || frame.id) === frameNodeId) || roleFrames[0];
  if (roleFrame?.name) return roleFrame.name;
  const nodes = asArray(capture.figma?.frames?.page).concat(asArray(capture.figma?.nodeIds).map((nodeId) => ({ nodeId })));
  return nodes.find((node) => normalizeFigmaNodeId(node.nodeId || node.id) === frameNodeId)?.name;
}

export async function addDesignSourceSnapshot(options) {
  const inputDir = path.resolve(String(options.input || options["capture-dir"] || options.captureDir || ""));
  if (!inputDir || !(await pathExists(inputDir))) throw new CliError("--input is required and must point to a captured components/assets directory.");
  const capture = await readJson(path.join(inputDir, "capture.json"), {}).catch(() => ({}));
  const parsedUrl = parseFigmaUrl(options.url || options["figma-url"] || options.figmaUrl || capture.figma?.url);
  const fileKey = options["file-key"] || options.fileKey || parsedUrl.fileKey || capture.figma?.fileKey;
  const repoPath = repoPathFromOptions(options, capture);
  const role = String(options.role || options.type || "").toLowerCase();
  if (!ROLES.has(role)) throw new CliError("--role must be components or assets.");
  const captureRoleFrame = asArray(capture.figma?.frames?.[role])[0];
  const frameNodeId = normalizeFigmaNodeId(options.frame || options["frame-node-id"] || options.frameNodeId || options[`${role}-frame`] || captureRoleFrame?.nodeId || captureRoleFrame?.id || parsedUrl.nodeId);
  if (!frameNodeId) throw new CliError("--frame-node-id is required for source add/sync snapshots.");

  const content = role === "components" ? await buildComponentsSnapshot(inputDir) : await buildAssetsContentKey(inputDir);
  const { checksum, contentSha } = hashNormalized(content);
  const snapshotId = `${role}-${figmaNodeIdForPath(frameNodeId)}-${contentSha.slice(0, 12)}`;
  const relPath = snapshotRelPath(fileKey, snapshotId);
  const absPath = snapshotPath(repoPath, fileKey, snapshotId);
  const registry = await readRegistry(repoPath, fileKey);
  registry.kind = registry.kind || "pragma-design-source-registry";
  registry.schemaVersion = "2.0";
  registry.fileKey = fileKey;
  registry.latest = registry.latest || {};
  registry.roles = registry.roles || { components: [], assets: [] };
  registry.roles.components = asArray(registry.roles.components);
  registry.roles.assets = asArray(registry.roles.assets);

  const existing = registry.roles[role].find((entry) => entry.snapshotId === snapshotId || entry.contentSha === contentSha);
  const entry = existing || {
    snapshotId,
    frameNodeId,
    name: options.name || frameNameFromInput(capture, role, frameNodeId),
    checksum,
    contentSha,
    path: relPath,
    capturedAt: capture.capturedAt || nowIso()
  };

  if (options["dry-run"] || options.dryRun) {
    return { ok: true, dryRun: true, role, fileKey, frameNodeId, snapshotId: entry.snapshotId, path: entry.path, checksum: entry.checksum, reused: Boolean(existing), created: false };
  }

  if (!existing && !(await pathExists(absPath))) {
    await materializeSnapshot({ role, inputDir, snapshotDir: absPath });
  }
  if (!existing) registry.roles[role].push(entry);
  registry.latest[role] = entry.snapshotId;
  await writeRegistry(repoPath, fileKey, registry);
  await writeSources(repoPath, fileKey, {
    role,
    snapshotId: entry.snapshotId,
    frameNodeId,
    inputDir,
    capturedAt: capture.capturedAt || nowIso(),
    checksum: entry.checksum
  });

  return { ok: true, dryRun: false, role, fileKey, frameNodeId, snapshotId: entry.snapshotId, path: entry.path, checksum: entry.checksum, reused: Boolean(existing), created: !existing };
}

export async function syncDesignSources(options) {
  if (options.role || options.type) return addDesignSourceSnapshot(options);
  const results = [];
  if (await pathExists(path.join(String(options.input || options["capture-dir"] || options.captureDir), "figma", "components.json"))) {
    const frame = options["components-frame"] || options.componentsFrame || options.components;
    if (frame) results.push(await addDesignSourceSnapshot({ ...options, role: "components", frame }));
  }
  if (await pathExists(path.join(String(options.input || options["capture-dir"] || options.captureDir), "assets-manifest.json"))) {
    const frame = options["assets-frame"] || options.assetsFrame || options.assets;
    if (frame) results.push(await addDesignSourceSnapshot({ ...options, role: "assets", frame }));
  }
  if (!results.length) throw new CliError("source sync needs --role, or --components-frame/--assets-frame with matching capture files.");
  return { ok: true, results };
}

export async function resolveRegistrySnapshot(repoPath, fileKey, role, snapshotId) {
  const registry = await readRegistry(repoPath, fileKey).catch(() => undefined);
  const entry = asArray(registry?.roles?.[role]).find((item) => item.snapshotId === snapshotId);
  return entry;
}
