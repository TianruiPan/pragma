import path from "node:path";
import { pathExists, listFilesRecursive, normalizeRelativePosix, relativePosix, safeJoin } from "./fs.js";
import { sha256File } from "./checksum.js";
import { mimeForType, sniffAssetFile, typeFromExtension } from "./mime.js";

export function slugify(value, fallback = "item") {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

export function detectAssetType(filePath, explicitType) {
  if (explicitType) return String(explicitType).replace(/^\./, "").toLowerCase();
  return typeFromExtension(filePath) || "binary";
}

async function normalizeAssetMetadata({ contextDir, outputRel, asset, id }) {
  const absolute = safeJoin(contextDir, outputRel);
  const sniffed = await sniffAssetFile(absolute);
  const explicitType = detectAssetType(outputRel, asset.type || asset.format);
  const type = sniffed.type !== "binary" ? sniffed.type : explicitType;
  const declaredChecksum = /^sha256:[0-9a-f]{64}$/i.test(String(asset.checksum || "")) ? asset.checksum : undefined;
  return {
    type,
    mime: sniffed.mime || asset.mime || mimeForType(type),
    width: sniffed.width ?? asset.width,
    height: sniffed.height ?? asset.height,
    checksum: declaredChecksum || await sha256File(absolute),
    detected: {
      type: sniffed.type,
      mime: sniffed.mime,
      width: sniffed.width,
      height: sniffed.height
    }
  };
}

export async function normalizeAssets(contextDir, inputManifest = undefined, assetBindings = []) {
  const assetsRoot = path.join(contextDir, "assets");
  const files = await listFilesRecursive(assetsRoot);
  const byRel = new Map(files.map((file) => [relativePosix(contextDir, file), file]));
  const byAssetRel = new Map(files.map((file) => [relativePosix(assetsRoot, file), file]));
  const rawAssets = Array.isArray(inputManifest?.assets) ? inputManifest.assets : [];

  if (rawAssets.length > 0) {
    const normalized = [];
    for (const [index, asset] of rawAssets.entries()) {
      const candidatePaths = [asset.path, asset.fileName, asset.filename, asset.name]
        .filter(Boolean)
        .map(String);
      let outputRel = undefined;
      for (const candidate of candidatePaths) {
        const cleaned = normalizeRelativePosix(candidate);
        const withAssets = cleaned.startsWith("assets/") ? cleaned : `assets/${cleaned}`;
        if (byRel.has(withAssets)) {
          outputRel = withAssets;
          break;
        }
        if (byAssetRel.has(cleaned)) {
          outputRel = `assets/${cleaned}`;
          break;
        }
      }
      if (!outputRel) continue;
      const id = asset.id || `asset-${slugify(path.basename(outputRel, path.extname(outputRel)), String(index + 1))}`;
      const metadata = await normalizeAssetMetadata({ contextDir, outputRel, asset, id });
      normalized.push({
        id,
        name: asset.name || path.basename(outputRel),
        role: asset.role || "implementation-asset",
        type: metadata.type,
        mime: metadata.mime,
        path: outputRel,
        width: metadata.width,
        height: metadata.height,
        sourceNodeIds: asset.sourceNodeIds || asset.sourceNodeId ? asArray(asset.sourceNodeIds || asset.sourceNodeId) : [],
        bindings: [
          ...asArray(asset.bindings),
          ...assetBindings.filter((binding) => binding.assetId === id)
        ].map((binding) => ({
          nodeId: binding.nodeId,
          figmaNodeId: binding.figmaNodeId,
          fit: binding.fit || "contain",
          crop: binding.crop ?? null,
          placement: binding.placement
        })),
        checksum: metadata.checksum,
        required: asset.required !== false
      });
    }
    return normalized;
  }

  const normalized = [];
  for (const [index, file] of files.entries()) {
    const rel = relativePosix(contextDir, file);
    const id = `asset-${slugify(path.basename(file, path.extname(file)), String(index + 1))}`;
    const metadata = await normalizeAssetMetadata({ contextDir, outputRel: rel, asset: {}, id });
    normalized.push({
      id,
      name: path.basename(file),
      role: "implementation-asset",
      type: metadata.type,
      mime: metadata.mime,
      path: rel,
      width: metadata.width,
      height: metadata.height,
      sourceNodeIds: [],
      bindings: assetBindings.filter((binding) => binding.assetId === id).map((binding) => ({
        nodeId: binding.nodeId,
        figmaNodeId: binding.figmaNodeId,
        fit: binding.fit || "contain",
        crop: binding.crop ?? null,
        placement: binding.placement
      })),
      checksum: metadata.checksum,
      required: true
    });
  }
  return normalized;
}

export async function listContextFiles(contextDir, childDir) {
  const absolute = path.join(contextDir, childDir);
  if (!(await pathExists(absolute))) return [];
  const files = await listFilesRecursive(absolute);
  return files.map((file) => relativePosix(contextDir, file));
}

export function extractSelectionNodes(selection, capture) {
  const candidates = [
    ...asArray(selection?.nodes),
    ...asArray(selection?.frames),
    ...asArray(selection?.selection),
    ...asArray(capture?.figma?.nodeIds)
  ];
  const seen = new Set();
  const nodes = [];
  for (const item of candidates) {
    if (typeof item === "string") {
      if (!seen.has(item)) {
        nodes.push({ id: item, name: item });
        seen.add(item);
      }
      continue;
    }
    if (item && typeof item === "object") {
      const id = item.id || item.nodeId || item.figmaNodeId || item.key;
      if (!id || seen.has(id)) continue;
      nodes.push({
        id,
        name: item.name || item.nodeName || id,
        type: item.type || item.nodeType,
        width: item.width || item.absoluteBoundingBox?.width || item.viewport?.width,
        height: item.height || item.absoluteBoundingBox?.height || item.viewport?.height
      });
      seen.add(id);
    }
  }
  return nodes;
}
