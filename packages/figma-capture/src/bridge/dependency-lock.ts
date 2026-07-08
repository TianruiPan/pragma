import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { safeNodeIdSegment } from "../shared/assets.js";

async function readJsonIfExists(filePath: string, fallback: any = undefined) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readFileIfExists(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}

async function collectFileDigests(dirPath: string, prefix = ""): Promise<Array<{ path: string; checksum: string }>> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return [];
  }
  const records: Array<{ path: string; checksum: string }> = [];
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

function stableJson(value: unknown) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function frameIdsForRole(selection: any, role: "page" | "components" | "assets") {
  const value = selection?.frames?.[role];
  const frames = Array.isArray(value) ? value : value ? [value] : [];
  return new Set(frames.map((frame: any) => String(frame.nodeId || frame.id)).filter(Boolean));
}

function nodeIdentity(node: any) {
  return String(node?.figmaNodeId || node?.nodeId || node?.id || "");
}

function collectTreeNodeIds(nodes: any[]) {
  const ids = new Set<string>();
  const walk = (node: any) => {
    const id = nodeIdentity(node);
    if (id) ids.add(id);
    if (Array.isArray(node?.children)) node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return ids;
}

function selectRoleLayerRoots(layers: any, role: "page" | "components" | "assets", frameIds: Set<string>) {
  const roots = Array.isArray(layers?.nodes) ? layers.nodes : [];
  const selected = roots.filter((node: any) => node?.role === role || frameIds.has(nodeIdentity(node)));
  if (selected.length || role !== "page") return selected;
  return roots.filter((node: any) => frameIds.has(nodeIdentity(node)));
}

async function contentHash(inputDir: string, role: "page" | "components" | "assets") {
  const capture = await readJsonIfExists(path.join(inputDir, "capture.json"), {});
  const selection = await readJsonIfExists(path.join(inputDir, "figma", "selection.json"), {});
  const layers = await readJsonIfExists(path.join(inputDir, "figma", "layers.json"), {});
  const components = await readJsonIfExists(path.join(inputDir, "figma", "components.json"), {});
  const assetManifest = await readJsonIfExists(path.join(inputDir, "assets-manifest.json"), {});
  const assetBindings = await readJsonIfExists(path.join(inputDir, "asset-bindings.json"), {});
  const frameIds = frameIdsForRole(selection, role);
  const selectedLayers = selectRoleLayerRoots(layers, role, frameIds);
  const selectedNodeIds = collectTreeNodeIds(selectedLayers);
  const roleFrames = Array.isArray(selection?.frames?.[role])
    ? selection.frames[role]
    : selection?.frames?.[role] ? [selection.frames[role]] : [];

  const payload: Record<string, unknown> = {
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
    const relatedAssets = Array.isArray(assetManifest?.assets)
      ? assetManifest.assets.filter((asset: any) => {
        const sourceIds = Array.isArray(asset?.sourceNodeIds) ? asset.sourceNodeIds.map(String) : [];
        return asset?.role === "shared-assets-frame-export" || sourceIds.some((id: string) => selectedNodeIds.has(id));
      })
      : [];
    payload.assets = relatedAssets;
    payload.assetBindings = Array.isArray(assetBindings?.bindings)
      ? assetBindings.bindings.filter((binding: any) => selectedNodeIds.has(String(binding?.figmaNodeId || binding?.sourceNodeId || "")) || relatedAssets.some((asset: any) => asset.id === binding?.assetId))
      : [];
    payload.assetFiles = await collectFileDigests(path.join(inputDir, "assets"));
  }
  const full = createHash("sha256").update(stableJson(payload)).digest("hex");
  return { checksum: `sha256:${full}`, short: full.slice(0, 12) };
}

function registryEntry(registry: any, role: "components" | "assets", snapshotId: string | undefined) {
  if (!snapshotId) return undefined;
  const entries = Array.isArray(registry?.roles?.[role]) ? registry.roles[role] : [];
  return entries.find((entry: any) => entry.snapshotId === snapshotId) || { snapshotId };
}

function statusFromRegistry(input: {
  registry: any;
  role: "components" | "assets";
  fileKey: string;
  hasBlockingRefs: boolean;
}) {
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

function selectedStatus(input: { role: "components" | "assets"; frames: any[]; fileKey: string; hash: { checksum: string; short: string } }) {
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

function selectedFrames(selection: any, role: "components" | "assets") {
  const value = selection?.frames?.[role];
  if (Array.isArray(value)) return value;
  if (value) return [value];
  return [];
}

function pageFrames(selection: any) {
  return Array.isArray(selection?.frames?.page) ? selection.frames.page : [];
}

function hasComponentInstances(components: any, layers: any) {
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

function hasUnresolvedSharedAssetRefs(assetBindings: any) {
  const bindings = Array.isArray(assetBindings?.bindings) ? assetBindings.bindings : [];
  return bindings.some((binding: any) => binding.scope === "shared" || binding.unresolved === true);
}

export async function buildDependencyLock(inputDir: string, repoLocalPath?: string) {
  const capture = await readJsonIfExists(path.join(inputDir, "capture.json"), {});
  const selection = await readJsonIfExists(path.join(inputDir, "figma", "selection.json"), {});
  const components = await readJsonIfExists(path.join(inputDir, "figma", "components.json"), {});
  const layers = await readJsonIfExists(path.join(inputDir, "figma", "layers.json"), {});
  const assetBindings = await readJsonIfExists(path.join(inputDir, "asset-bindings.json"), {});
  const fileKey = capture?.figma?.fileKey || selection?.fileKey;
  if (!fileKey || fileKey === "unknown-file-key") throw new Error("Figma fileKey is required before writing dependency-lock.json.");
  const registryPath = repoLocalPath ? path.join(repoLocalPath, ".pragma", "design-sources", "figma", fileKey, "registry.json") : undefined;
  const registry = registryPath ? await readJsonIfExists(registryPath, null) : null;
  const componentsFrames = selectedFrames(selection, "components");
  const assetsFrames = selectedFrames(selection, "assets");
  const pageHash = await contentHash(inputDir, "page");

  const componentsStatus = componentsFrames.length
    ? selectedStatus({ role: "components", frames: componentsFrames, fileKey, hash: await contentHash(inputDir, "components") })
    : statusFromRegistry({ registry, role: "components", fileKey, hasBlockingRefs: hasComponentInstances(components, layers) });
  const assetsStatus = assetsFrames.length
    ? selectedStatus({ role: "assets", frames: assetsFrames, fileKey, hash: await contentHash(inputDir, "assets") })
    : statusFromRegistry({ registry, role: "assets", fileKey, hasBlockingRefs: hasUnresolvedSharedAssetRefs(assetBindings) });

  return {
    schemaVersion: "2.0",
    kind: "pragma-design-dependencies",
    fileKey,
    capturedAt: capture.capturedAt || new Date().toISOString(),
    pageFrames: pageFrames(selection).map((frame: any) => ({
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
