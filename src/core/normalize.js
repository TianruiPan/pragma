import fs from "node:fs/promises";
import path from "node:path";
import { normalizeFigmaNodeId } from "./figma-url.js";
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

export function isFrameRenderAsset(asset = {}, relPath = "") {
  const text = [
    relPath,
    asset.path,
    asset.fileName,
    asset.filename,
    asset.name,
    asset.role,
    asset.type
  ].filter(Boolean).join(" ").toLowerCase();
  return /(^|[-_/\s])(frame[-_\s]?render|render[-_\s]?reference|visual[-_\s]?baseline|baseline[-_\s]?screenshot|screenshot|screen[-_\s]?shot)(?=\.|[-_/\s]|$)/i.test(text)
    || /(^|[-_/\s])render\.(png|jpe?g|webp|svg)$/i.test(text);
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
      if (isFrameRenderAsset(asset, outputRel)) continue;
      const id = asset.id || `asset-${slugify(path.basename(outputRel, path.extname(outputRel)), String(index + 1))}`;
      const metadata = await normalizeAssetMetadata({ contextDir, outputRel, asset, id });
      const matchingBindings = [
        ...asArray(asset.bindings),
        ...assetBindings.filter((binding) => binding.assetId === id)
      ];
      normalized.push({
        id,
        name: asset.name || path.basename(outputRel),
        role: asset.role || "implementation-asset",
        type: metadata.type,
        mime: metadata.mime,
        path: outputRel,
        width: metadata.width,
        height: metadata.height,
        sourceNodeIds: [...new Set([
          ...asArray(asset.sourceNodeIds || asset.sourceNodeId),
          ...matchingBindings.flatMap((binding) => asArray(binding.sourceNodeIds || binding.figmaNodeId))
        ].filter(Boolean).map(String))],
        usedByNodeIds: [...new Set([
          ...asArray(asset.usedByNodeIds || asset.usedByNodeId),
          ...matchingBindings.flatMap((binding) => asArray(binding.usedByNodeIds || binding.nodeId))
        ].filter(Boolean).map(String))],
        checksum: metadata.checksum,
        required: asset.required !== false
      });
    }
    return normalized;
  }

  const normalized = [];
  for (const [index, file] of files.entries()) {
    const rel = relativePosix(contextDir, file);
    if (isFrameRenderAsset({}, rel)) continue;
    const id = `asset-${slugify(path.basename(file, path.extname(file)), String(index + 1))}`;
    const metadata = await normalizeAssetMetadata({ contextDir, outputRel: rel, asset: {}, id });
    const matchingBindings = assetBindings.filter((binding) => binding.assetId === id);
    normalized.push({
      id,
      name: path.basename(file),
      role: "implementation-asset",
      type: metadata.type,
      mime: metadata.mime,
      path: rel,
      width: metadata.width,
      height: metadata.height,
      sourceNodeIds: [...new Set(matchingBindings.flatMap((binding) => asArray(binding.sourceNodeIds || binding.figmaNodeId)).filter(Boolean).map(String))],
      usedByNodeIds: [...new Set(matchingBindings.flatMap((binding) => asArray(binding.usedByNodeIds || binding.nodeId)).filter(Boolean).map(String))],
      checksum: metadata.checksum,
      required: true
    });
  }
  return normalized;
}

async function removeEmptyAssetDirs(dir, root) {
  if (!(await pathExists(dir))) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyAssetDirs(path.join(dir, entry.name), root);
  }
  const after = await fs.readdir(dir);
  if (after.length === 0 && path.resolve(dir) !== path.resolve(root)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function pruneUnreferencedAssetFiles(contextDir, assets = []) {
  const assetsRoot = path.join(contextDir, "assets");
  if (!(await pathExists(assetsRoot))) return;
  const keep = new Set(assets.map((asset) => normalizeRelativePosix(asset.path || "")).filter(Boolean));
  for (const file of await listFilesRecursive(assetsRoot)) {
    const rel = relativePosix(contextDir, file);
    if (!keep.has(rel)) await fs.rm(file, { force: true });
  }
  await removeEmptyAssetDirs(assetsRoot, assetsRoot);
}

export async function listContextFiles(contextDir, childDir) {
  const absolute = path.join(contextDir, childDir);
  if (!(await pathExists(absolute))) return [];
  const files = await listFilesRecursive(absolute);
  return files.map((file) => relativePosix(contextDir, file));
}

export function extractSelectionFrames(selection, role = "page") {
  const frames = selection?.frames;
  const roleFrames = frames && typeof frames === "object" && !Array.isArray(frames)
    ? frames[role]
    : (role === "page" ? frames : undefined);
  const candidates = [
    ...asArray(roleFrames),
    ...asArray(selection?.[`${role}Frames`])
  ];
  const seen = new Set();
  const result = [];
  for (const item of candidates) {
    const rawId = typeof item === "string" ? item : (item?.nodeId || item?.figmaNodeId || item?.id || item?.key);
    const nodeId = normalizeFigmaNodeId(rawId);
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    if (typeof item === "string") {
      result.push({ nodeId, figmaNodeId: nodeId, id: nodeId, name: nodeId, role });
      continue;
    }
    const bounds = item.bounds || item.absoluteBoundingBox;
    const viewport = item.viewport || (bounds || item.width || item.height ? {
      width: item.width ?? bounds?.width,
      height: item.height ?? bounds?.height
    } : undefined);
    result.push({
      ...item,
      id: item.id || nodeId,
      nodeId,
      figmaNodeId: item.figmaNodeId || nodeId,
      name: item.name || item.nodeName || nodeId,
      type: item.type || item.nodeType,
      role: item.role || role,
      bounds,
      viewport,
      width: item.width ?? bounds?.width ?? viewport?.width,
      height: item.height ?? bounds?.height ?? viewport?.height,
      url: item.url
    });
  }
  return result;
}

export function extractSelectionNodes(selection, capture) {
  const candidates = [
    ...extractSelectionFrames(selection, "page"),
    ...asArray(selection?.nodes),
    ...asArray(selection?.selection),
    ...asArray(capture?.figma?.nodeIds)
  ];
  const seen = new Set();
  const nodes = [];
  for (const item of candidates) {
    if (typeof item === "string") {
      const id = normalizeFigmaNodeId(item) || item;
      if (!seen.has(id)) {
        nodes.push({ id, name: id });
        seen.add(id);
      }
      continue;
    }
    if (item && typeof item === "object") {
      const id = normalizeFigmaNodeId(item.nodeId || item.figmaNodeId || item.id || item.key);
      if (!id || seen.has(id)) continue;
      const bounds = item.bounds || item.absoluteBoundingBox;
      const viewport = item.viewport;
      nodes.push({
        id,
        name: item.name || item.nodeName || id,
        type: item.type || item.nodeType,
        role: item.role,
        bounds,
        viewport,
        url: item.url,
        width: item.width ?? bounds?.width ?? viewport?.width,
        height: item.height ?? bounds?.height ?? viewport?.height
      });
      seen.add(id);
    }
  }
  return nodes;
}
