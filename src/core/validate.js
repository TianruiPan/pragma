import path from "node:path";
import fs from "node:fs/promises";
import { CliError } from "./errors.js";
import { isPathInside, listFilesRecursive, pathExists, readJson, resolveRepoRootFromContext } from "./fs.js";
import { canonicalPackageChecksum, sha256File } from "./checksum.js";
import { isConcreteSnapshotId, isValidDependencyStatus } from "./dependencies.js";
import { normalizeFigmaNodeId, parseFigmaUrl } from "./figma-url.js";
import { mimeForType, sniffAssetFile, typeFromExtension } from "./mime.js";
import { isFrameRenderAsset } from "./normalize.js";
import { utf8Diagnostics } from "./text-encoding.js";
import { isVersionDir, normalizeVersion, readCurrentPointer, resolveVersionContext } from "./versioning.js";
import { pragmaContextObjectKey, resolveMinioPublishConfig, statMinioObject } from "./minio.js";

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

function validationIssue(errors, issues, code, message, details = {}) {
  const issue = { level: "error", code, message, ...details };
  issues.push(issue);
  errors.push(`[${code}] ${message}`);
  return issue;
}

function validationWarning(warnings, issues, code, message, details = {}) {
  const issue = { level: "warning", code, message, ...details };
  issues.push(issue);
  warnings.push(`[${code}] ${message}`);
  return issue;
}

function hasSecretKey(value, trail = []) {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    const keyText = key.toLowerCase();
    if (["token", "access_token", "figma_token", "password", "secret", "credential", "credentials"].includes(keyText)) {
      return [...trail, key].join(".");
    }
    const found = hasSecretKey(child, [...trail, key]);
    if (found) return found;
  }
  return undefined;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function collectPropertyValues(value, matcher, results = []) {
  if (!value || typeof value !== "object") return results;
  for (const [key, child] of Object.entries(value)) {
    if (matcher(key) && typeof child === "string") results.push(child);
    if (Array.isArray(child)) {
      child.forEach((item) => collectPropertyValues(item, matcher, results));
    } else if (child && typeof child === "object") {
      collectPropertyValues(child, matcher, results);
    }
  }
  return results;
}

function collectAssetBindingRefs(pixelSpec) {
  const refs = [];
  for (const binding of asArray(pixelSpec?.assetBindings)) refs.push(binding);
  for (const node of asArray(pixelSpec?.nodes)) {
    if (node.assetBinding) refs.push({ ...node.assetBinding, nodeId: node.assetBinding.nodeId || node.id, figmaNodeId: node.assetBinding.figmaNodeId || node.figmaNodeId });
  }
  return refs;
}

const LAYER_INLINE_FORBIDDEN_FIELDS = [
  "bounds",
  "layout",
  "fills",
  "fill",
  "strokes",
  "stroke",
  "radius",
  "cornerRadius",
  "shadow",
  "shadows",
  "effects",
  "text",
  "assetBinding",
  "assetBindings",
  "fit",
  "crop",
  "placement",
  "componentRef"
];

const ASSET_INLINE_FORBIDDEN_FIELDS = ["bindings", "fit", "crop", "placement"];

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function validateTokenMapping(value, { path: fieldPath, type, tokenIds, errors, warnings, issues, allowMissingTokenId = true }) {
  if (value === undefined || value === null) return;
  if (!value || typeof value !== "object" || !hasOwn(value, "resolvedValue")) {
    validationIssue(errors, issues, "TOKEN_MAPPING_MISSING_RESOLVED_VALUE", `${fieldPath} must include resolvedValue${type ? ` for ${type}` : ""}`, { path: fieldPath, type });
    return;
  }
  if (value.tokenId) {
    assert(tokenIds.has(value.tokenId), `${fieldPath} references unknown tokenId ${value.tokenId}`, errors);
  } else if (allowMissingTokenId) {
    validationWarning(warnings, issues, "TOKEN_MAPPING_MISSING_TOKEN_ID", `${fieldPath} has resolvedValue but no tokenId`, { path: fieldPath, type });
  }
}

function validatePaintMappings(paints, fieldPath, tokenIds, errors, warnings, issues) {
  for (const [index, paint] of asArray(paints).entries()) {
    if (paint && typeof paint === "object" && hasOwn(paint, "color")) {
      validateTokenMapping(paint.color, { path: `${fieldPath}[${index}].color`, type: "color", tokenIds, errors, warnings, issues });
    }
  }
}

function validatePixelTokenMappings(pixelSpec, tokenIds, errors, warnings, issues) {
  for (const node of asArray(pixelSpec?.nodes)) {
    const nodePath = `pixel-spec node ${node.id || "<unknown>"}`;
    validatePaintMappings(node.fills, `${nodePath}.fills`, tokenIds, errors, warnings, issues);
    validatePaintMappings(node.strokes, `${nodePath}.strokes`, tokenIds, errors, warnings, issues);
    if (node.radius !== undefined && node.radius !== null) {
      validateTokenMapping(node.radius, { path: `${nodePath}.radius`, type: "radius", tokenIds, errors, warnings, issues });
    }
    for (const [index, shadow] of asArray(node.shadow).entries()) {
      validateTokenMapping(shadow, { path: `${nodePath}.shadow[${index}]`, type: "shadow", tokenIds, errors, warnings, issues });
    }
    if (node.text) {
      if (node.text.color !== undefined) {
        validateTokenMapping(node.text.color, { path: `${nodePath}.text.color`, type: "color", tokenIds, errors, warnings, issues });
      }
      if (node.text.typography !== undefined) {
        validateTokenMapping(node.text.typography, { path: `${nodePath}.text.typography`, type: "typography", tokenIds, errors, warnings, issues });
      } else if (["fontFamily", "fontWeight", "fontSize", "lineHeight", "letterSpacing"].some((key) => node.text[key] !== undefined)) {
        validationIssue(errors, issues, "TOKEN_MAPPING_MISSING_RESOLVED_VALUE", `${nodePath}.text.typography must include resolvedValue`, { path: `${nodePath}.text.typography`, type: "typography" });
      }
    }
  }
}

async function readEntrypointJson(contextDir, entrypoints, key, errors) {
  const rel = entrypoints[key];
  if (!rel) return undefined;
  const file = path.join(contextDir, rel);
  if (!(await pathExists(file))) return undefined;
  try {
    return await readJson(file);
  } catch (error) {
    errors.push(`${rel} is not valid JSON: ${error.message}`);
    return undefined;
  }
}


function routePath(route) {
  return typeof route === "string" ? route : route?.path;
}

function routeId(route) {
  return typeof route === "string" ? route : route?.id;
}

function resolveContextRelative(contextDir, relPath) {
  if (!relPath || path.isAbsolute(String(relPath))) return undefined;
  const resolved = path.resolve(contextDir, String(relPath).replace(/\\/g, "/"));
  return isPathInside(contextDir, resolved) ? resolved : undefined;
}

async function readContextJson(contextDir, relPath, errors, issues, code, message, details = {}) {
  const file = resolveContextRelative(contextDir, relPath);
  if (!file) {
    validationIssue(errors, issues, code, `${message}: invalid package path ${relPath}`, { ...details, path: relPath });
    return undefined;
  }
  if (!(await pathExists(file))) {
    validationIssue(errors, issues, code, `${message}: ${relPath}`, { ...details, path: relPath });
    return undefined;
  }
  try {
    return await readJson(file);
  } catch (error) {
    validationIssue(errors, issues, code, `${message}: ${error.message}`, { ...details, path: relPath });
    return undefined;
  }
}

function addUniqueNode(nodes, nodeIds, figmaNodeIds, node) {
  if (!node?.id || nodeIds.has(node.id)) return;
  nodes.push(node);
  nodeIds.add(node.id);
  if (node.figmaNodeId) figmaNodeIds.add(node.figmaNodeId);
}

function validatePixelNodeFacts(node, errors, issues, sourcePath) {
  assert(Boolean(node.id), "pixel-spec node.id is required", errors);
  assert(Boolean(node.figmaNodeId), `pixel-spec node ${node.id || "<unknown>"} figmaNodeId is required`, errors);
  assert(Boolean(node.layerRef), `pixel-spec node ${node.id || "<unknown>"} layerRef is required`, errors);
  assert(Boolean(node.name), `pixel-spec node ${node.id || "<unknown>"} name is required`, errors);
  assert(Boolean(node.type), `pixel-spec node ${node.id || "<unknown>"} type is required`, errors);
  assert(node.bounds && Number.isFinite(Number(node.bounds.width)) && Number.isFinite(Number(node.bounds.height)), `pixel-spec node ${node.id || "<unknown>"} bounds are required`, errors);
  if (Array.isArray(node.children) && node.children.length > 0) {
    validationIssue(errors, issues, "NORMALIZED_CANONICAL_OWNERSHIP", `pixel-spec node ${node.id || "<unknown>"} must not duplicate layer tree children`, { path: sourcePath, nodeId: node.id, field: "children" });
  }
}

function collectStateEntries(value) {
  return [...asArray(value?.states), ...asArray(value?.availableStates)];
}

function validateAvailableStateEntries(scope, states, pixelNodeIds, errors, issues) {
  for (const state of asArray(states)) {
    const stateText = [state?.name, state?.id, state?.source, state?.kind, state?.reason].filter(Boolean).join(" ").toLowerCase();
    if (state?.isRuntimeDefault === true || state?.runtimeDefault === true || /issue[-_\s]?runtime[-_\s]?default|business[-_\s]?runtime[-_\s]?default|runtime[-_\s]?default/.test(stateText)) {
      validationIssue(errors, issues, "ISSUE_RUNTIME_DEFAULT_STATE", `${scope} availableStates must not encode Issue runtime default state`, { scope, state: state?.name || state?.id });
    }
    for (const nodeId of asArray(state?.nodeIds)) {
      assert(pixelNodeIds.has(nodeId), `${scope} state ${state?.name || "<unknown>"} references unknown pixel node ${nodeId}`, errors);
    }
  }
}

function compareLegacyNodeSet({ legacy, actualIds, label, path: legacyPath, errors, issues }) {
  if (!legacy || !Array.isArray(legacy.nodes)) return;
  const legacyIds = new Set(legacy.nodes.map((node) => node.id).filter(Boolean));
  const missing = [...legacyIds].filter((id) => !actualIds.has(id));
  const extra = [...actualIds].filter((id) => !legacyIds.has(id));
  if (missing.length || extra.length) {
    validationIssue(errors, issues, "LEGACY_AGGREGATE_MISMATCH", `${legacyPath} must match ${label} shard node ids`, { path: legacyPath, missing, extra });
  }
}

async function readLegacyAggregate(contextDir, relPath) {
  const file = resolveContextRelative(contextDir, relPath);
  if (!file || !(await pathExists(file))) return undefined;
  return readJson(file).catch(() => undefined);
}

async function buildPixelValidationModel({ contextDir, pixelSpec, errors, warnings, issues }) {
  const nodes = [];
  const nodeIds = new Set();
  const figmaNodeIds = new Set();
  const dynamicRegions = [];
  const dynamicRegionIds = new Set();
  const stateEntries = [];
  let viewport = pixelSpec?.viewport;
  let isSharded = false;

  function mergePixelDoc(doc, sourcePath) {
    if (!viewport && doc?.viewport) viewport = doc.viewport;
    for (const node of asArray(doc?.nodes)) {
      validatePixelNodeFacts(node, errors, issues, sourcePath);
      addUniqueNode(nodes, nodeIds, figmaNodeIds, node);
      for (const state of asArray(node.availableStates)) {
        stateEntries.push({ ...state, nodeIds: [node.id].filter(Boolean) });
      }
    }
    for (const region of asArray(doc?.dynamicRegions)) {
      if (region?.id && !dynamicRegionIds.has(region.id)) {
        dynamicRegions.push(region);
        dynamicRegionIds.add(region.id);
      }
    }
    stateEntries.push(...collectStateEntries(doc));
  }

  if (pixelSpec) {
    assert(pixelSpec.schemaVersion === "2.0", "pixel-spec.schemaVersion must be 2.0", errors);
    if (pixelSpec.kind === "pragma-pixel-spec-index") {
      isSharded = true;
      assert(Number.isFinite(Number(pixelSpec.viewport?.width)) && Number(pixelSpec.viewport.width) >= 0, "pixel-spec.viewport.width must be numeric", errors);
      assert(Number.isFinite(Number(pixelSpec.viewport?.height)) && Number(pixelSpec.viewport.height) >= 0, "pixel-spec.viewport.height must be numeric", errors);
      assert(Array.isArray(pixelSpec.frames), "pixel-spec index frames must be an array", errors);
      assert(Array.isArray(pixelSpec.regions), "pixel-spec index regions must be an array", errors);
      for (const region of asArray(pixelSpec.dynamicRegions)) {
        if (region?.id && !dynamicRegionIds.has(region.id)) {
          dynamicRegions.push(region);
          dynamicRegionIds.add(region.id);
        }
      }
      stateEntries.push(...collectStateEntries(pixelSpec));
      for (const route of [...asArray(pixelSpec.frames), ...asArray(pixelSpec.regions)]) {
        const rel = routePath(route);
        const shard = await readContextJson(contextDir, rel, errors, issues, "PIXEL_SPEC_SHARD_MISSING", "pixel-spec shard is missing or invalid", { id: routeId(route) });
        if (!shard) continue;
        assert(["pragma-pixel-spec-frame", "pragma-pixel-spec-region"].includes(shard.kind), `${rel} kind must be pragma-pixel-spec-frame or pragma-pixel-spec-region`, errors);
        assert(Array.isArray(shard.nodes), `${rel} nodes must be an array`, errors);
        mergePixelDoc(shard, rel);
      }
      const legacy = await readLegacyAggregate(contextDir, "normalized/pixel-spec.json");
      compareLegacyNodeSet({ legacy, actualIds: nodeIds, label: "pixel-spec", path: "normalized/pixel-spec.json", errors, issues });
    } else {
      assert(pixelSpec.kind === "pragma-pixel-spec", "pixel-spec.kind must be pragma-pixel-spec or pragma-pixel-spec-index", errors);
      assert(Number.isFinite(Number(pixelSpec.viewport?.width)) && Number(pixelSpec.viewport.width) >= 0, "pixel-spec.viewport.width must be numeric", errors);
      assert(Number.isFinite(Number(pixelSpec.viewport?.height)) && Number(pixelSpec.viewport.height) >= 0, "pixel-spec.viewport.height must be numeric", errors);
      assert(Array.isArray(pixelSpec.nodes), "pixel-spec.nodes must be an array", errors);
      mergePixelDoc(pixelSpec, "normalized/pixel-spec.json");
    }
  }

  validateAvailableStateEntries("pixel-spec", stateEntries, nodeIds, errors, issues);
  return {
    isSharded,
    aggregate: pixelSpec ? { schemaVersion: "2.0", kind: "pragma-pixel-spec", viewport, nodes, dynamicRegions, states: stateEntries } : undefined,
    nodeIds,
    figmaNodeIds,
    dynamicRegionIds
  };
}

function validateLayerNodeFacts(node, errors, issues, sourcePath) {
  assert(Boolean(node.id), "layer node id is required", errors);
  assert(Boolean(node.figmaNodeId), "layer node figmaNodeId is required", errors);
  for (const field of LAYER_INLINE_FORBIDDEN_FIELDS) {
    if (hasOwn(node, field)) {
      validationIssue(errors, issues, "NORMALIZED_CANONICAL_OWNERSHIP", `layers node ${node.id || node.figmaNodeId || "<unknown>"} must not inline ${field}`, { path: sourcePath, nodeId: node.id || node.figmaNodeId, field });
    }
  }
}

function mergeLayerDoc(doc, sourcePath, nodes, layerIds, figmaNodeIds, errors, issues) {
  for (const node of asArray(doc?.nodes)) {
    validateLayerNodeFacts(node, errors, issues, sourcePath);
    if (node?.id && !layerIds.has(node.id)) {
      nodes.push(node);
      layerIds.add(node.id);
      if (node.figmaNodeId) figmaNodeIds.add(node.figmaNodeId);
    }
  }
}

async function buildLayerValidationModel({ contextDir, layers, errors, warnings, issues }) {
  const nodes = [];
  const layerIds = new Set();
  const figmaNodeIds = new Set();
  let rootNodeIds = [];
  let isSharded = false;

  if (layers) {
    assert(layers.schemaVersion === "2.0", "layers.schemaVersion must be 2.0", errors);
    if (layers.kind === "pragma-layer-tree-index") {
      isSharded = true;
      assert(Array.isArray(layers.rootNodeIds), "layers.rootNodeIds must be an array", errors);
      assert(Array.isArray(layers.frames), "layers index frames must be an array", errors);
      rootNodeIds = asArray(layers.rootNodeIds);
      for (const route of asArray(layers.frames)) {
        const rel = routePath(route);
        const shard = await readContextJson(contextDir, rel, errors, issues, "LAYER_TREE_SHARD_MISSING", "layer tree shard is missing or invalid", { id: routeId(route) });
        if (!shard) continue;
        assert(shard.kind === "pragma-layer-tree-frame", `${rel} kind must be pragma-layer-tree-frame`, errors);
        assert(Array.isArray(shard.rootNodeIds), `${rel} rootNodeIds must be an array`, errors);
        assert(Array.isArray(shard.nodes), `${rel} nodes must be an array`, errors);
        mergeLayerDoc(shard, rel, nodes, layerIds, figmaNodeIds, errors, issues);
      }
      const legacy = await readLegacyAggregate(contextDir, "normalized/layers.json");
      if (legacy) {
        mergeLayerDoc(legacy, "normalized/layers.json", [], new Set(), new Set(), errors, issues);
        compareLegacyNodeSet({ legacy, actualIds: layerIds, label: "layers", path: "normalized/layers.json", errors, issues });
      }
    } else {
      assert(layers.kind === "pragma-layer-tree", "layers.kind must be pragma-layer-tree or pragma-layer-tree-index", errors);
      assert(Array.isArray(layers.rootNodeIds), "layers.rootNodeIds must be an array", errors);
      assert(Array.isArray(layers.nodes), "layers.nodes must be an array", errors);
      rootNodeIds = asArray(layers.rootNodeIds);
      mergeLayerDoc(layers, "normalized/layers.json", nodes, layerIds, figmaNodeIds, errors, issues);
    }

    for (const rootNodeId of rootNodeIds) {
      assert(layerIds.has(rootNodeId) || figmaNodeIds.has(rootNodeId), `layers.rootNodeIds references unknown node ${rootNodeId}`, errors);
    }
    for (const node of nodes) {
      for (const child of asArray(node.children)) {
        assert(layerIds.has(child) || figmaNodeIds.has(child), `layer ${node.id || node.figmaNodeId || "<unknown>"} references unknown child ${child}`, errors);
      }
    }
  }

  return {
    isSharded,
    aggregate: layers ? { schemaVersion: "2.0", kind: "pragma-layer-tree", rootNodeIds, nodes } : undefined,
    layerIds,
    figmaNodeIds
  };
}

function dependencyRoleNeedsLock(role) {
  return role?.status === "selected" || role?.status === "reused";
}

function resolvePackageRelative(repoRoot, contextDir, relPath) {
  if (!relPath) return undefined;
  const normalized = String(relPath).replace(/\\/g, "/");
  const base = normalized.startsWith(".pragma/") && repoRoot ? repoRoot : contextDir;
  const resolved = path.resolve(base, normalized);
  if (repoRoot && !isPathInside(repoRoot, resolved)) return undefined;
  return resolved;
}

function collectComponentIds(components) {
  const ids = new Set();
  for (const component of asArray(components?.components)) if (component.id) ids.add(component.id);
  for (const component of asArray(components?.componentSets)) if (component.id) ids.add(component.id);
  return ids;
}

function collectOptionalComponentIds(components) {
  const ids = new Set();
  for (const component of [...asArray(components?.components), ...asArray(components?.componentSets)]) {
    if (component.id && (component.optional || component.external)) ids.add(component.id);
  }
  return ids;
}

function collectComponentInstances(components, pixelSpec) {
  const instances = asArray(components?.instances);
  if (instances.length) return instances;
  return asArray(pixelSpec?.nodes)
    .filter((node) => node.componentRef?.componentId)
    .map((node) => ({
      nodeId: node.id,
      figmaNodeId: node.figmaNodeId,
      name: node.name,
      componentSetId: node.componentRef.componentId,
      bounds: node.bounds,
      optional: node.componentRef.optional,
      external: node.componentRef.external
    }));
}

async function readSnapshotJson(repoRoot, dependency, fileName, errors) {
  if (!dependency?.path) return undefined;
  const snapshotRoot = resolvePackageRelative(repoRoot, repoRoot, dependency.path);
  if (!snapshotRoot) {
    errors.push(`dependency path is outside repo: ${dependency.path}`);
    return undefined;
  }
  const file = path.join(snapshotRoot, "normalized", fileName);
  if (!(await pathExists(file))) {
    errors.push(`locked snapshot file is missing: ${dependency.path}/normalized/${fileName}`);
    return undefined;
  }
  try {
    return await readJson(file);
  } catch (error) {
    errors.push(`locked snapshot ${fileName} is invalid JSON: ${error.message}`);
    return undefined;
  }
}

function assetRefsNeedingSharedSnapshot(assetsManifest) {
  return [
    ...asArray(assetsManifest?.sharedAssetRefs),
    ...asArray(assetsManifest?.assets).filter((asset) => asset.shared || asset.source === "shared-snapshot" || asset.snapshotId)
  ];
}

async function validateUtf8Tree(contextDir, errors) {
  for (const child of ["source", "normalized"]) {
    const root = path.join(contextDir, child);
    if (!(await pathExists(root))) continue;
    const files = (await listFilesRecursive(root)).filter((file) => /\.(json|md)$/i.test(file));
    for (const file of files) {
      const buffer = await fs.readFile(file);
      const diag = utf8Diagnostics(buffer);
      const rel = path.relative(contextDir, file).replace(/\\/g, "/");
      if (diag.hasBom) errors.push(`${rel} must be UTF-8 without BOM`);
      if (diag.hasReplacementCharacter) errors.push(`${rel} is not valid UTF-8`);
      if (diag.hasMojibake) errors.push(`${rel} contains likely mojibake`);
    }
  }
}

function assertFigmaSourceConsistency({ manifest, metadata, selection }, errors) {
  const url = manifest.source?.url || metadata?.requestedNode?.sourceUrl;
  if (!url) return;
  let parsed;
  try {
    parsed = parseFigmaUrl(url);
  } catch (error) {
    errors.push(error.message);
    return;
  }
  if (parsed.fileKey) {
    if (manifest.source?.fileKey) assert(manifest.source.fileKey === parsed.fileKey, `manifest.source.fileKey does not match Figma URL fileKey ${parsed.fileKey}`, errors);
    if (metadata?.fileKey) assert(metadata.fileKey === parsed.fileKey, `source metadata fileKey does not match Figma URL fileKey ${parsed.fileKey}`, errors);
    if (selection?.fileKey) assert(selection.fileKey === parsed.fileKey, `source selection fileKey does not match Figma URL fileKey ${parsed.fileKey}`, errors);
  }
  if (parsed.nodeId) {
    const normalized = normalizeFigmaNodeId(parsed.nodeId);
    const candidates = [
      manifest.source?.originalNodeId,
      metadata?.requestedNode?.id,
      selection?.page?.id,
      ...asArray(manifest.source?.nodes)
    ].filter(Boolean).map(normalizeFigmaNodeId);
    assert(candidates.includes(normalized), `Figma URL nodeId ${normalized} does not match metadata, selection, or manifest source nodes`, errors);
  }
}

function isTrustedSha256(value) {
  return /^sha256:[0-9a-f]{64}$/i.test(String(value || ""));
}

async function readJsonWithIssue(filePath, errors, warnings, issues, code, message, details = {}) {
  if (!(await pathExists(filePath))) {
    validationIssue(errors, issues, code, message, details);
    return undefined;
  }
  try {
    return await readJson(filePath);
  } catch (error) {
    validationIssue(errors, issues, code, `${message}: ${error.message}`, details);
    return undefined;
  }
}

function registrySnapshotEntry(registry, role, snapshotId) {
  return asArray(registry?.roles?.[role]).find((entry) => entry.snapshotId === snapshotId);
}

function snapshotRootFromPath(repoRoot, relPath) {
  if (!relPath) return undefined;
  const normalized = String(relPath).replace(/\\/g, "/");
  if (/\/latest(?:\/|$)|(^|\/)latest$/i.test(normalized)) return "floating-latest";
  if (path.isAbsolute(normalized)) return undefined;
  const resolved = path.resolve(repoRoot, normalized);
  if (!isPathInside(repoRoot, resolved)) return undefined;
  return resolved;
}

async function validateSnapshotChecksums({ repoRoot, snapshotDir, snapshotId, errors, warnings, issues }) {
  const checksumsPath = path.join(snapshotDir, "checksums.json");
  const checksums = await readJsonWithIssue(
    checksumsPath,
    errors,
    warnings,
    issues,
    "SNAPSHOT_PATH_MISSING",
    `Snapshot ${snapshotId} is missing checksums.json`,
    { snapshotId, path: checksumsPath }
  );
  if (!checksums) return;
  for (const entry of asArray(checksums.files)) {
    const file = path.resolve(snapshotDir, String(entry.path || ""));
    if (!isPathInside(snapshotDir, file)) {
      validationIssue(errors, issues, "SNAPSHOT_PATH_MISSING", `Snapshot ${snapshotId} checksum entry is outside snapshot root: ${entry.path}`, { snapshotId, path: entry.path });
      continue;
    }
    if (!(await pathExists(file))) {
      validationIssue(errors, issues, "SNAPSHOT_PATH_MISSING", `Snapshot ${snapshotId} checksum entry is missing: ${entry.path}`, { snapshotId, path: entry.path });
      continue;
    }
    const actual = await sha256File(file);
    if (actual !== entry.checksum) {
      validationIssue(errors, issues, "SNAPSHOT_CHECKSUM_MISMATCH", `Snapshot ${snapshotId} checksum mismatch: ${entry.path}`, { snapshotId, path: entry.path, expected: entry.checksum, actual });
    }
  }
}

async function validateSnapshotReference({ repoRoot, fileKey, role, entry, errors, warnings, issues }) {
  if (!entry?.snapshotId) {
    validationIssue(errors, issues, "SOURCE_ENTRY_MISSING", `Registry ${fileKey} ${role} entry is missing snapshotId`, { fileKey, role });
    return;
  }
  if (/latest/i.test(entry.snapshotId)) {
    validationIssue(errors, issues, "FLOATING_LATEST_REFERENCE", `Registry ${fileKey} ${role} references floating latest: ${entry.snapshotId}`, { fileKey, role, snapshotId: entry.snapshotId });
  }
  if (!isConcreteSnapshotId(entry.snapshotId, role)) {
    validationIssue(errors, issues, "SOURCE_ENTRY_MISSING", `Registry ${fileKey} ${role} snapshotId is not concrete: ${entry.snapshotId}`, { fileKey, role, snapshotId: entry.snapshotId });
  }
  if (!isTrustedSha256(entry.checksum)) {
    validationIssue(errors, issues, "SNAPSHOT_CHECKSUM_MISMATCH", `Registry ${fileKey} ${role} snapshot has invalid checksum: ${entry.snapshotId}`, { fileKey, role, snapshotId: entry.snapshotId });
  }
  const snapshotPath = entry.path || `.pragma/design-sources/figma/${fileKey}/snapshots/${entry.snapshotId}`;
  const snapshotDir = snapshotRootFromPath(repoRoot, snapshotPath);
  if (snapshotDir === "floating-latest") {
    validationIssue(errors, issues, "FLOATING_LATEST_REFERENCE", `Registry ${fileKey} ${role} snapshot path references floating latest: ${snapshotPath}`, { fileKey, role, snapshotId: entry.snapshotId, path: snapshotPath });
    return;
  }
  if (!snapshotDir || !(await pathExists(snapshotDir))) {
    validationIssue(errors, issues, "SNAPSHOT_PATH_MISSING", `Registry ${fileKey} ${role} snapshot path is missing: ${snapshotPath}`, { fileKey, role, snapshotId: entry.snapshotId, path: snapshotPath });
    return;
  }
  const normalizedFile = role === "components" ? "components.json" : "assets.json";
  const normalizedPath = path.join(snapshotDir, "normalized", normalizedFile);
  if (!(await pathExists(normalizedPath))) {
    validationIssue(errors, issues, "SNAPSHOT_PATH_MISSING", `Registry ${fileKey} ${role} snapshot normalized/${normalizedFile} is missing`, { fileKey, role, snapshotId: entry.snapshotId });
  }
  await validateSnapshotChecksums({ repoRoot, snapshotDir, snapshotId: entry.snapshotId, errors, warnings, issues });
}

async function listFigmaRegistryFileKeys(repoRoot, explicitFileKey) {
  if (explicitFileKey) return [explicitFileKey];
  const root = path.join(repoRoot, ".pragma", "design-sources", "figma");
  if (!(await pathExists(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function validateSourceRegistry(options) {
  const repoRoot = path.resolve(String(options.repo || ""));
  const errors = [];
  const warnings = [];
  const issues = [];
  if (!options.repo) {
    validationIssue(errors, issues, "SOURCE_REGISTRY_MISSING", "--repo is required for --source-registry validation");
    return { ok: false, errors, warnings, issues, repoRoot };
  }
  const figmaRoot = path.join(repoRoot, ".pragma", "design-sources", "figma");
  if (!(await pathExists(figmaRoot))) {
    validationIssue(errors, issues, "SOURCE_REGISTRY_MISSING", `Source registry root is missing: ${figmaRoot}`, { path: figmaRoot });
    return { ok: false, errors, warnings, issues, repoRoot, sourceRegistry: true };
  }
  const fileKeys = await listFigmaRegistryFileKeys(repoRoot, options["file-key"] || options.fileKey);
  if (!fileKeys.length) {
    validationIssue(errors, issues, "SOURCE_REGISTRY_MISSING", "No Figma source registry fileKey directories were found", { path: figmaRoot });
  }
  const checked = [];
  for (const fileKey of fileKeys) {
    const root = path.join(figmaRoot, fileKey);
    const registryPath = path.join(root, "registry.json");
    const sourcesPath = path.join(root, "sources.json");
    const registry = await readJsonWithIssue(registryPath, errors, warnings, issues, "SOURCE_REGISTRY_MISSING", `registry.json is missing or invalid for ${fileKey}`, { fileKey, path: registryPath });
    const sources = await readJsonWithIssue(sourcesPath, errors, warnings, issues, "SOURCE_ENTRY_MISSING", `sources.json is missing or invalid for ${fileKey}`, { fileKey, path: sourcesPath });
    if (!registry) continue;
    checked.push(fileKey);
    if (registry.fileKey && registry.fileKey !== fileKey) {
      validationIssue(errors, issues, "SOURCE_REGISTRY_MISSING", `registry.json fileKey ${registry.fileKey} does not match directory ${fileKey}`, { fileKey, registryFileKey: registry.fileKey });
    }
    for (const role of ["components", "assets"]) {
      const latest = typeof registry.latest?.[role] === "string" ? registry.latest[role] : registry.latest?.[role]?.snapshotId;
      if (latest) {
        if (/latest/i.test(latest)) {
          validationIssue(errors, issues, "FLOATING_LATEST_REFERENCE", `Registry latest.${role} must point to a concrete snapshot, not ${latest}`, { fileKey, role, snapshotId: latest });
        }
        const entry = registrySnapshotEntry(registry, role, latest);
        if (!entry) {
          validationIssue(errors, issues, "LATEST_POINTER_BROKEN", `Registry latest.${role} points to missing snapshot ${latest}`, { fileKey, role, snapshotId: latest });
        }
      }
      for (const entry of asArray(registry.roles?.[role])) {
        await validateSnapshotReference({ repoRoot, fileKey, role, entry, errors, warnings, issues });
      }
    }
    for (const source of asArray(sources?.sources)) {
      const role = source.role;
      const snapshotId = source.snapshotId;
      if (!["components", "assets"].includes(role) || !snapshotId) {
        validationWarning(warnings, issues, "SOURCE_ENTRY_MISSING", `sources.json entry is missing role or snapshotId for ${fileKey}`, { fileKey, source });
        continue;
      }
      if (!registrySnapshotEntry(registry, role, snapshotId)) {
        validationIssue(errors, issues, "SOURCE_ENTRY_MISSING", `sources.json references missing ${role} snapshot ${snapshotId}`, { fileKey, role, snapshotId });
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, issues, repoRoot, sourceRegistry: true, fileKeys: checked };
}

async function validateDependencySnapshotRecoverability({ repoRoot, fileKey, role, dependency, errors, warnings, issues }) {
  if (!dependencyRoleNeedsLock(dependency)) return;
  if (!repoRoot) {
    validationIssue(errors, issues, "DEPENDENCY_SNAPSHOT_UNRESOLVABLE", `Cannot resolve repo root for dependency ${role}`, { role, snapshotId: dependency.snapshotId });
    return;
  }
  const registryPath = path.join(repoRoot, ".pragma", "design-sources", "figma", fileKey || "", "registry.json");
  const registry = await readJsonWithIssue(
    registryPath,
    errors,
    warnings,
    issues,
    "SOURCE_REGISTRY_MISSING",
    `Source registry is missing for dependency ${role}`,
    { role, fileKey, path: registryPath }
  );
  if (!registry) return;
  const entry = registrySnapshotEntry(registry, role, dependency.snapshotId);
  if (!entry) {
    validationIssue(errors, issues, "DEPENDENCY_SNAPSHOT_UNRESOLVABLE", `Dependency ${role} snapshot is not present in registry: ${dependency.snapshotId}`, { role, fileKey, snapshotId: dependency.snapshotId });
    return;
  }
  if (entry.path && dependency.path && String(entry.path).replace(/\\/g, "/") !== String(dependency.path).replace(/\\/g, "/")) {
    validationIssue(errors, issues, "DEPENDENCY_SNAPSHOT_UNRESOLVABLE", `Dependency ${role} path does not match registry entry: ${dependency.snapshotId}`, { role, fileKey, snapshotId: dependency.snapshotId, dependencyPath: dependency.path, registryPath: entry.path });
  }
  if (entry.checksum && dependency.checksum && entry.checksum !== dependency.checksum) {
    validationIssue(errors, issues, "SNAPSHOT_CHECKSUM_MISMATCH", `Dependency ${role} checksum does not match registry entry: ${dependency.snapshotId}`, { role, fileKey, snapshotId: dependency.snapshotId, dependencyChecksum: dependency.checksum, registryChecksum: entry.checksum });
  }
  const snapshotDir = snapshotRootFromPath(repoRoot, dependency.path || entry.path);
  if (snapshotDir === "floating-latest") {
    validationIssue(errors, issues, "FLOATING_LATEST_REFERENCE", `Dependency ${role} path references floating latest`, { role, fileKey, snapshotId: dependency.snapshotId, path: dependency.path || entry.path });
    return;
  }
  if (!snapshotDir || !(await pathExists(snapshotDir))) {
    validationIssue(errors, issues, "SNAPSHOT_PATH_MISSING", `Dependency ${role} snapshot path is missing: ${dependency.path || entry.path}`, { role, fileKey, snapshotId: dependency.snapshotId, path: dependency.path || entry.path });
    return;
  }
  await validateSnapshotChecksums({ repoRoot, snapshotDir, snapshotId: dependency.snapshotId, errors, warnings, issues });
}

export async function validateDesignContext(options) {
  if (options["source-registry"] || options.sourceRegistry) {
    return validateSourceRegistry(options);
  }
  const requestedContextDir = path.resolve(String(options.context));
  const errors = [];
  const warnings = [];
  const issues = [];

  assert(await pathExists(requestedContextDir), `Context directory does not exist: ${requestedContextDir}`, errors);
  if (errors.length) return { ok: false, errors, warnings, issues, contextDir: requestedContextDir };

  let contextDir = requestedContextDir;
  let issueRoot;
  let current;
  const directManifest = path.join(requestedContextDir, "manifest.json");
  const rootCurrent = !isVersionDir(requestedContextDir) ? await readCurrentPointer(requestedContextDir).catch(() => undefined) : undefined;
  if (rootCurrent || !(await pathExists(directManifest))) {
    current = rootCurrent || await readCurrentPointer(requestedContextDir).catch(() => undefined);
    if (!current) {
      errors.push("manifest.json is missing and current.json was not found");
      return { ok: false, errors, warnings, issues, contextDir: requestedContextDir };
    }
    if (current.schemaVersion !== "2.0") errors.push("current.json schemaVersion must be 2.0");
    if (current.kind !== "pragma-design-context-current") errors.push("current.json kind must be pragma-design-context-current");
    if (!current.designIssue?.number) errors.push("current.json designIssue.number is required");
    if (!current.currentVersion) errors.push("current.json currentVersion is required");
    if (!current.currentManifest) errors.push("current.json currentManifest is required");
    if (current.currentVersion && current.currentManifest && current.currentManifest !== `versions/${normalizeVersion(current.currentVersion).version}/manifest.json`) {
      validationIssue(errors, issues, "CURRENT_POINTER_MISMATCH", "current.json currentManifest must point to versions/currentVersion/manifest.json", { currentVersion: current.currentVersion, currentManifest: current.currentManifest });
    }
    const resolvedCurrent = await resolveVersionContext({ context: requestedContextDir, version: options.version || "current" }).catch((error) => {
      errors.push(error.message);
      return undefined;
    });
    if (!resolvedCurrent) return { ok: false, errors, warnings, issues, contextDir: requestedContextDir };
    contextDir = resolvedCurrent.contextDir;
    issueRoot = requestedContextDir;
    assert(await pathExists(resolvedCurrent.manifestPath), `current.json points to missing manifest: ${current.currentManifest}`, errors);
    if (errors.length) return { ok: false, errors, warnings, issues, contextDir, current };
  } else if (isVersionDir(requestedContextDir)) {
    issueRoot = path.dirname(path.dirname(requestedContextDir));
  }

  const manifestPath = path.join(contextDir, "manifest.json");
  assert(await pathExists(manifestPath), "manifest.json is missing", errors);
  if (errors.length) return { ok: false, errors, warnings, issues, contextDir };

  let manifest;
  try {
    manifest = await readJson(manifestPath);
  } catch (error) {
    errors.push(`manifest.json is not valid JSON: ${error.message}`);
    return { ok: false, errors, warnings, issues, contextDir };
  }

  assert(manifest.schemaVersion === "2.0", "manifest.schemaVersion must be 2.0", errors);
  assert(manifest.integrationContractVersion === "pragma-integration/v2", "manifest.integrationContractVersion must be pragma-integration/v2", errors);
  assert(manifest.kind === "pragma-design-context-package", "manifest.kind must be pragma-design-context-package", errors);
  assert(Boolean(manifest.id), "manifest.id is required", errors);
  assert(Boolean(manifest.version), "manifest.version is required", errors);
  assert(Number.isInteger(manifest.versionNumber) && manifest.versionNumber > 0, "manifest.versionNumber must be a positive integer", errors);
  if (manifest.version) {
    const versionInfo = normalizeVersion(manifest.version);
    assert(manifest.version === versionInfo.version, "manifest.version must be normalized as vN", errors);
    assert(manifest.versionNumber === versionInfo.versionNumber, "manifest.versionNumber must match manifest.version", errors);
    if (isVersionDir(contextDir)) {
      assert(path.basename(contextDir) === manifest.version, "manifest.version must match versions/vN directory name", errors);
    }
  }
  assert(typeof manifest.changeSummary === "string" && manifest.changeSummary.length > 0, "manifest.changeSummary is required", errors);
  assert(/^sha256:[0-9a-f]{64}$/i.test(String(manifest.sourceChecksum || "")), "manifest.sourceChecksum must be sha256", errors);
  assert(/^sha256:[0-9a-f]{64}$/i.test(String(manifest.packageChecksum || "")), "manifest.packageChecksum must be sha256", errors);
  assert(manifest.issue?.provider === "gitea", "manifest.issue.provider must be gitea", errors);
  assert(Number.isInteger(manifest.issue?.number) && manifest.issue.number > 0, "manifest.issue.number must be a positive integer", errors);
  assert(Boolean(manifest.issue?.repo), "manifest.issue.repo is required", errors);
  assert(manifest.issue?.type === "design", "manifest.issue.type must be design", errors);
  assert(Array.isArray(manifest.linkedDevelopmentIssues), "manifest.linkedDevelopmentIssues must be an array", errors);
  assert(typeof manifest.compatibility === "object" && manifest.compatibility !== null, "manifest.compatibility is required", errors);
  if (manifest.compatibility) {
    assert(typeof manifest.compatibility.breakingChange === "boolean", "manifest.compatibility.breakingChange must be boolean", errors);
    assert(typeof manifest.compatibility.requiresDevIssueReview === "boolean", "manifest.compatibility.requiresDevIssueReview must be boolean", errors);
    assert(Boolean(manifest.compatibility.reason), "manifest.compatibility.reason is required", errors);
  }
  assert(Boolean(manifest.source?.provider), "manifest.source.provider is required", errors);
  assert(Boolean(manifest.source?.adapter), "manifest.source.adapter is required", errors);
  assert(Boolean(manifest.source?.capturedAt), "manifest.source.capturedAt is required", errors);
  if (manifest.artifact?.storage === "repo" && manifest.artifact?.checksum && manifest.packageChecksum) {
    assert(manifest.artifact.checksum === manifest.packageChecksum, "repo artifact.checksum must match manifest.packageChecksum", errors);
    assert(await canonicalPackageChecksum(contextDir) === manifest.packageChecksum, "manifest.packageChecksum does not match canonical package content", errors);
  }

  const entrypoints = manifest.entrypoints || {};
  const requiredEntrypoints = [
    "humanHandoff",
    "agentContext",
    "agentWorkflow",
    "designContext",
    "pixelSpec",
    "layers",
    "tokens",
    "components",
    "dependencies",
    "assetsManifest",
    "renderInstructions",
    "visualBaseline",
    "assetsDir",
    "screenshots"
  ];
  for (const key of requiredEntrypoints) {
    assert(Boolean(entrypoints[key]), `manifest.entrypoints.${key} is required`, errors);
  }

  for (const key of ["humanHandoff", "agentContext", "agentWorkflow", "designContext", "pixelSpec", "layers", "tokens", "components", "dependencies", "assetsManifest", "renderInstructions", "visualBaseline"]) {
    if (entrypoints[key]) {
      assert(await pathExists(path.join(contextDir, entrypoints[key])), `${entrypoints[key]} is missing`, errors);
    }
  }
  if (entrypoints.sourceDesignContext) {
    assert(await pathExists(path.join(contextDir, entrypoints.sourceDesignContext)), `${entrypoints.sourceDesignContext} is missing`, errors);
  }

  let agentWorkflowText = "";
  if (entrypoints.agentWorkflow) {
    try {
      agentWorkflowText = await fs.readFile(path.join(contextDir, entrypoints.agentWorkflow), "utf8");
    } catch (error) {
      errors.push(`${entrypoints.agentWorkflow} is missing or unreadable: ${error.message}`);
    }
  }
  if (agentWorkflowText) {
    const workflowLower = agentWorkflowText.toLowerCase();
    for (const required of ["read gate", "typography", "progressive disclosure", "business data safety", "css strategy"]) {
      assert(workflowLower.includes(required), `agent-workflow.md must include ${required}`, errors);
    }
  }

  const designContext = await readEntrypointJson(contextDir, entrypoints, "designContext", errors);
  const pixelSpec = await readEntrypointJson(contextDir, entrypoints, "pixelSpec", errors);
  const layers = await readEntrypointJson(contextDir, entrypoints, "layers", errors);
  const tokens = await readEntrypointJson(contextDir, entrypoints, "tokens", errors);
  const components = await readEntrypointJson(contextDir, entrypoints, "components", errors);
  const dependencies = await readEntrypointJson(contextDir, entrypoints, "dependencies", errors);
  const assetsManifest = await readEntrypointJson(contextDir, entrypoints, "assetsManifest", errors);
  const visualBaseline = await readEntrypointJson(contextDir, entrypoints, "visualBaseline", errors);
  const sourceMetadata = await readJson(path.join(contextDir, "source", "figma-metadata.json"), {}).catch(() => ({}));
  const sourceSelection = await readJson(path.join(contextDir, "source", "figma-selection.json"), {}).catch(() => ({}));
  const repoRoot = resolveRepoRootFromContext(contextDir);

  if (designContext) {
    assert(designContext.schemaVersion === "2.0", "design-context.schemaVersion must be 2.0", errors);
    assert(designContext.kind === "pragma-design-context", "design-context.kind must be pragma-design-context", errors);
    assert(Boolean(designContext.agentContext), "design-context.agentContext is required", errors);
    assert(Boolean(designContext.assetsManifest), "design-context.assetsManifest is required", errors);
    assert(Boolean(designContext.pixelSpec), "design-context.pixelSpec is required", errors);
    assert(Boolean(designContext.dependencies), "design-context.dependencies is required", errors);
    assert(Boolean(designContext.agentWorkflow), "design-context.agentWorkflow is required", errors);
    assert(Array.isArray(designContext.pageRegions) && designContext.pageRegions.length > 0, "design-context.pageRegions must contain at least one Page Region", errors);
    for (const region of asArray(designContext.pageRegions)) {
      assert(Boolean(region.id), "design-context pageRegion.id is required", errors);
      assert(Boolean(region.pixelSpec), `pageRegion ${region.id || "<unknown>"} pixelSpec shard path is required`, errors);
      if (region.pixelSpec) {
        assert(Boolean(resolveContextRelative(contextDir, region.pixelSpec)) && await pathExists(resolveContextRelative(contextDir, region.pixelSpec)), `pageRegion ${region.id || "<unknown>"} pixelSpec shard is missing: ${region.pixelSpec}`, errors);
      }
      for (const forbidden of ["bounds", "layout", "fills", "strokes", "radius", "shadow", "text", "assetBinding", "placement"]) {
        if (hasOwn(region, forbidden)) {
          validationIssue(errors, issues, "NORMALIZED_CANONICAL_OWNERSHIP", `pageRegion ${region.id || "<unknown>"} must not inline ${forbidden}; use pixel-spec shards`, { path: "normalized/design-context.json", pageRegionId: region.id, field: forbidden });
        }
      }
    }
  }

  const pixelValidation = await buildPixelValidationModel({ contextDir, pixelSpec, errors, warnings, issues });
  const pixelSpecForValidation = pixelValidation.aggregate;
  const pixelNodeIds = pixelValidation.nodeIds;
  const pixelFigmaNodeIds = pixelValidation.figmaNodeIds;
  const dynamicRegionIds = pixelValidation.dynamicRegionIds;

  const layerValidation = await buildLayerValidationModel({ contextDir, layers, errors, warnings, issues });
  const layersForValidation = layerValidation.aggregate;
  const layerIds = layerValidation.layerIds;
  const layerFigmaNodeIds = layerValidation.figmaNodeIds;

  if (pixelSpecForValidation && layersForValidation) {
    for (const node of asArray(pixelSpecForValidation.nodes)) {
      assert(layerIds.has(node.layerRef) || layerFigmaNodeIds.has(node.layerRef), `pixel-spec node ${node.id || "<unknown>"} references unknown layerRef ${node.layerRef}`, errors);
    }
  }

  const tokenIds = new Set(asArray(tokens?.tokens).map((token) => token.id).filter(Boolean));
  if (tokens) {
    assert(tokens.schemaVersion === "2.0", "tokens.schemaVersion must be 2.0", errors);
    assert(tokens.kind === "pragma-design-tokens", "tokens.kind must be pragma-design-tokens", errors);
    assert(Array.isArray(tokens.tokens), "tokens.tokens must be an array", errors);
  }
  if (pixelSpecForValidation) {
    const tokenRefs = collectPropertyValues(pixelSpecForValidation, (key) => /(^|\b)(tokenId|colorTokenId|fontTokenId|typographyTokenId|radiusTokenId|shadowTokenId)$/.test(key));
    for (const tokenId of tokenRefs) {
      assert(tokenIds.has(tokenId), `pixel-spec references unknown tokenId ${tokenId}`, errors);
    }
    validatePixelTokenMappings(pixelSpecForValidation, tokenIds, errors, warnings, issues);
  }

  const componentIds = collectComponentIds(components);
  const optionalComponentIds = collectOptionalComponentIds(components);
  if (components) {
    assert(components.schemaVersion === "2.0", "components.schemaVersion must be 2.0", errors);
    assert(components.kind === "pragma-components" || components.kind === "pragma-design-components", "components.kind must be pragma-components", errors);
    if (components.kind === "pragma-components") {
      assert(Array.isArray(components.instances), "components.instances must be an array", errors);
      assert(Array.isArray(components.componentSets), "components.componentSets must be an array", errors);
      for (const instance of asArray(components.instances)) {
        assert(Boolean(instance.nodeId), "component instance nodeId is required", errors);
        assert(Boolean(instance.figmaNodeId), `component instance ${instance.nodeId || "<unknown>"} figmaNodeId is required`, errors);
        if (hasOwn(instance, "bounds")) {
          validationIssue(errors, issues, "NORMALIZED_CANONICAL_OWNERSHIP", `component instance ${instance.nodeId || "<unknown>"} must not duplicate bounds; use pixel-spec node bounds`, { path: "normalized/components.json", nodeId: instance.nodeId, field: "bounds" });
        }
      }
    } else {
      assert(Array.isArray(components.components), "components.components must be an array", errors);
    }
  }
  if (pixelSpecForValidation) {
    for (const node of asArray(pixelSpecForValidation.nodes)) {
      const componentId = node.componentRef?.componentId;
      if (componentId) {
        assert(componentIds.has(componentId) || optionalComponentIds.has(componentId) || node.componentRef?.optional || node.componentRef?.external, `pixel-spec node ${node.id} references unknown componentRef ${componentId}`, errors);
      }
    }
  }

  let lockedComponentsSnapshot;
  let lockedAssetsSnapshot;
  if (dependencies) {
    assert(dependencies.schemaVersion === "2.0", "dependencies.schemaVersion must be 2.0", errors);
    assert(dependencies.kind === "pragma-design-dependencies", "dependencies.kind must be pragma-design-dependencies", errors);
    assert(Boolean(dependencies.fileKey), "dependencies.fileKey is required", errors);
    if (manifest.source?.fileKey && dependencies.fileKey) assert(dependencies.fileKey === manifest.source.fileKey, "dependencies.fileKey must match manifest.source.fileKey", errors);
    assert(Array.isArray(dependencies.pageFrames), "dependencies.pageFrames must be an array", errors);
    for (const pageFrame of asArray(dependencies.pageFrames)) {
      assert(Boolean(pageFrame.nodeId), "dependencies.pageFrames[].nodeId is required", errors);
      assert(Boolean(pageFrame.snapshotId), `dependencies page frame ${pageFrame.nodeId || "<unknown>"} snapshotId is required`, errors);
      assert(!/latest/i.test(String(pageFrame.snapshotId || "")), `dependencies page frame ${pageFrame.nodeId || "<unknown>"} must not use floating latest`, errors);
    }
    for (const role of ["components", "assets"]) {
      const dep = dependencies[role];
      assert(dep && typeof dep === "object", `dependencies.${role} is required`, errors);
      if (!dep) continue;
      assert(isValidDependencyStatus(dep.status), `dependencies.${role}.status is invalid`, errors);
      if (/latest/i.test(String(dep.snapshotId || ""))) {
        validationIssue(errors, issues, "FLOATING_LATEST_REFERENCE", `dependencies.${role}.snapshotId must not reference floating latest`, { role, snapshotId: dep.snapshotId });
      }
      if (/\/latest(?:\/|$)/i.test(String(dep.path || "").replace(/\\/g, "/"))) {
        validationIssue(errors, issues, "FLOATING_LATEST_REFERENCE", `dependencies.${role}.path must not reference floating latest`, { role, path: dep.path });
      }
      if (dependencyRoleNeedsLock(dep)) {
        assert(isConcreteSnapshotId(dep.snapshotId, role), `dependencies.${role}.snapshotId must lock a concrete ${role}-* snapshot`, errors);
        assert(Boolean(dep.path), `dependencies.${role}.path is required for ${dep.status}`, errors);
        if (!/^sha256:[0-9a-f]{64}$/i.test(String(dep.checksum || ""))) {
          validationIssue(errors, issues, "SNAPSHOT_CHECKSUM_MISMATCH", `dependencies.${role}.checksum must be sha256`, { role, snapshotId: dep.snapshotId });
        }
        if (dep.path && repoRoot) {
          const resolved = resolvePackageRelative(repoRoot, contextDir, dep.path);
          if (!resolved) {
            validationIssue(errors, issues, "DEPENDENCY_SNAPSHOT_UNRESOLVABLE", `dependencies.${role}.path is outside repo`, { role, path: dep.path });
          } else if (!(await pathExists(resolved))) {
            validationIssue(errors, issues, "SNAPSHOT_PATH_MISSING", `dependencies.${role}.path is missing: ${dep.path}`, { role, path: dep.path, snapshotId: dep.snapshotId });
          }
        }
      }
    }

    if (dependencyRoleNeedsLock(dependencies.components)) {
      await validateDependencySnapshotRecoverability({ repoRoot, fileKey: dependencies.fileKey, role: "components", dependency: dependencies.components, errors, warnings, issues });
      lockedComponentsSnapshot = repoRoot ? await readSnapshotJson(repoRoot, dependencies.components, "components.json", errors) : undefined;
    }
    if (dependencyRoleNeedsLock(dependencies.assets)) {
      await validateDependencySnapshotRecoverability({ repoRoot, fileKey: dependencies.fileKey, role: "assets", dependency: dependencies.assets, errors, warnings, issues });
      lockedAssetsSnapshot = repoRoot ? await readSnapshotJson(repoRoot, dependencies.assets, "assets.json", errors) : undefined;
    }

    const componentInstances = collectComponentInstances(components, pixelSpecForValidation);
    if (dependencies.components?.status === "missing" && dependencies.rules?.ifMissingComponentsAndPageHasInstances === "block" && componentInstances.length) {
      errors.push("dependencies.components is missing while page has component instances");
    }
    if (lockedComponentsSnapshot && componentInstances.length) {
      const snapshotIds = collectComponentIds(lockedComponentsSnapshot);
      for (const instance of componentInstances) {
        const componentId = instance.componentSetId || instance.componentId || instance.mainComponentNodeId;
        if (!componentId || instance.optional || instance.external) continue;
        assert(snapshotIds.has(componentId) || optionalComponentIds.has(componentId), `component instance ${instance.nodeId || instance.figmaNodeId} cannot be resolved in locked components snapshot: ${componentId}`, errors);
      }
    }
  }

  const assetsMayBeExternal = manifest.artifact?.storage === "minio-s3";
  const assetIds = new Set();
  if (assetsManifest) {
    assert(assetsManifest.schemaVersion === "2.0", "assets.schemaVersion must be 2.0", errors);
    assert(assetsManifest.kind === "pragma-design-assets", "assets.kind must be pragma-design-assets", errors);
    assert(Array.isArray(assetsManifest.assets), "assets.assets must be an array", errors);
    for (const asset of assetsManifest.assets || []) {
      assert(Boolean(asset.id), "asset.id is required", errors);
      if (asset.id) assetIds.add(asset.id);
      assert(Boolean(asset.path), `asset ${asset.id || "<unknown>"} path is required`, errors);
      assert(Boolean(asset.mime), `asset ${asset.id || "<unknown>"} mime is required`, errors);
      for (const field of ASSET_INLINE_FORBIDDEN_FIELDS) {
        if (hasOwn(asset, field)) {
          validationIssue(errors, issues, "NORMALIZED_CANONICAL_OWNERSHIP", `asset ${asset.id || "<unknown>"} must not inline ${field}; placement belongs in pixel-spec assetBinding`, { path: "normalized/assets.json", assetId: asset.id, field });
        }
      }
      if (asset.path) {
        if (isFrameRenderAsset(asset, asset.path)) {
          validationIssue(errors, issues, "ASSET_FRAME_RENDER_IN_ASSETS", `frame render or baseline screenshot must not be stored as an implementation asset: ${asset.path}`, { path: asset.path, assetId: asset.id });
        }
        const assetPath = path.join(contextDir, asset.path);
        const exists = await pathExists(assetPath);
        if (!exists && assetsMayBeExternal) {
          warnings.push(`asset ${asset.id} is not present in the lightweight repo context: ${asset.path}`);
        } else {
          assert(exists, `asset ${asset.id} file is missing: ${asset.path}`, errors);
        }
        if (asset.checksum && exists) {
          const actual = await sha256File(assetPath);
          assert(actual === asset.checksum, `asset ${asset.id} checksum mismatch`, errors);
        }
        if (exists) {
          const sniffed = await sniffAssetFile(assetPath);
          const extensionType = typeFromExtension(asset.path);
          const declaredType = String(asset.type || "").toLowerCase();
          const declaredMime = asset.mime || mimeForType(declaredType);
          assert(sniffed.type !== "binary", `asset ${asset.id} has unsupported or unknown magic bytes: ${asset.path}`, errors);
          if (extensionType) assert(extensionType === sniffed.type || (extensionType === "jpg" && sniffed.type === "jpeg"), `asset ${asset.id} extension .${extensionType} does not match magic type ${sniffed.type}`, errors);
          if (declaredType) assert(declaredType === sniffed.type || (declaredType === "jpg" && sniffed.type === "jpeg"), `asset ${asset.id} declared type ${declaredType} does not match magic type ${sniffed.type}`, errors);
          if (declaredMime) assert(declaredMime === sniffed.mime, `asset ${asset.id} MIME ${declaredMime} does not match magic MIME ${sniffed.mime}`, errors);
          if (asset.width !== undefined && sniffed.width !== undefined) assert(Number(asset.width) === Number(sniffed.width), `asset ${asset.id} width does not match file dimensions`, errors);
          if (asset.height !== undefined && sniffed.height !== undefined) assert(Number(asset.height) === Number(sniffed.height), `asset ${asset.id} height does not match file dimensions`, errors);
        }
      }
      for (const nodeId of asArray(asset.usedByNodeIds)) {
        assert(pixelNodeIds.has(nodeId), `asset ${asset.id || "<unknown>"} usedByNodeIds references unknown nodeId ${nodeId}`, errors);
      }
    }
  }
  const assetsDir = path.join(contextDir, entrypoints.assetsDir || "assets");
  if (await pathExists(assetsDir)) {
    for (const file of await listFilesRecursive(assetsDir)) {
      const rel = path.relative(contextDir, file).replace(/\\/g, "/");
      if (isFrameRenderAsset({}, rel)) {
        validationIssue(errors, issues, "ASSET_FRAME_RENDER_IN_ASSETS", `frame render or baseline screenshot must not be stored under assets/: ${rel}`, { path: rel });
      }
    }
  }
  if (pixelSpecForValidation) {
    for (const binding of collectAssetBindingRefs(pixelSpecForValidation)) {
      assert(assetIds.has(binding.assetId), `pixel-spec references unknown assetId ${binding.assetId}`, errors);
      assert(binding.nodeId || binding.figmaNodeId, `pixel-spec asset binding for ${binding.assetId || "<unknown>"} needs nodeId or figmaNodeId`, errors);
      if (binding.nodeId) assert(pixelNodeIds.has(binding.nodeId), `pixel-spec asset binding references unknown nodeId ${binding.nodeId}`, errors);
      if (binding.figmaNodeId) assert(pixelFigmaNodeIds.has(binding.figmaNodeId) || layerFigmaNodeIds.has(binding.figmaNodeId), `pixel-spec asset binding references unknown figmaNodeId ${binding.figmaNodeId}`, errors);
    }
  }
  const sharedAssetRefs = assetRefsNeedingSharedSnapshot(assetsManifest);
  if (dependencies?.assets?.status === "missing" && dependencies.rules?.ifMissingAssetsAndPageHasUnresolvedRefs === "block" && sharedAssetRefs.length) {
    errors.push("dependencies.assets is missing while page has unresolved/shared asset refs");
  }
  if (lockedAssetsSnapshot && sharedAssetRefs.length) {
    const snapshotAssetIds = new Set(asArray(lockedAssetsSnapshot.assets).map((asset) => asset.id).filter(Boolean));
    for (const ref of sharedAssetRefs) {
      const assetId = typeof ref === "string" ? ref : ref.id || ref.assetId;
      if (assetId) assert(snapshotAssetIds.has(assetId), `shared asset ref ${assetId} cannot be resolved in locked assets snapshot`, errors);
    }
  }

  if (visualBaseline) {
    assert(visualBaseline.schemaVersion === "2.0", "visual-baseline.schemaVersion must be 2.0", errors);
    assert(visualBaseline.kind === "pragma-visual-baseline", "visual-baseline.kind must be pragma-visual-baseline", errors);
    assert(Array.isArray(visualBaseline.viewports), "visual-baseline.viewports must be an array", errors);
    for (const viewport of asArray(visualBaseline.viewports)) {
      assert(Boolean(viewport.baselineScreenshot), `visual-baseline viewport ${viewport.id || "<unknown>"} baselineScreenshot is required`, errors);
      if (viewport.baselineScreenshot) {
        assert(await pathExists(path.join(contextDir, viewport.baselineScreenshot)), `visual-baseline screenshot is missing: ${viewport.baselineScreenshot}`, errors);
      }
      for (const regionId of [...asArray(viewport.diffThreshold?.ignoreRegions), ...asArray(viewport.diffThreshold?.warnOnlyRegions)]) {
        assert(dynamicRegionIds.has(regionId), `visual-baseline references unknown dynamic region ${regionId}`, errors);
      }
    }
  }

  await validateUtf8Tree(contextDir, errors);
  assertFigmaSourceConsistency({ manifest, metadata: sourceMetadata, selection: sourceSelection }, errors);

  const localContextZip = path.join(contextDir, manifest.artifact?.fileName || "context.zip");
  if (await pathExists(localContextZip)) {
    if (manifest.artifact?.storage === "repo") {
      validationIssue(errors, issues, "CONTEXT_ZIP_SHOULD_NOT_BE_COMMITTED", "context.zip must not be present in a repo-stored <=20MB Design Context Package", { path: path.relative(contextDir, localContextZip).replace(/\\/g, "/") });
    }
    if (manifest.artifact?.checksum) {
      const actual = await sha256File(localContextZip);
      assert(actual === manifest.artifact.checksum, "context.zip checksum does not match manifest.artifact.checksum", errors);
    }
  }

  const checksumsPath = path.join(contextDir, "checksums.json");
  if (await pathExists(checksumsPath)) {
    const checksums = await readJson(checksumsPath);
    for (const entry of checksums.files || []) {
      const file = path.join(contextDir, entry.path);
      assert(await pathExists(file), `checksums entry is missing: ${entry.path}`, errors);
      if (await pathExists(file)) {
        const actual = await sha256File(file);
        assert(actual === entry.checksum, `checksum mismatch: ${entry.path}`, errors);
      }
    }
  } else {
    warnings.push("checksums.json is missing");
  }

  const secretPath = hasSecretKey(manifest) || hasSecretKey(designContext) || hasSecretKey(pixelSpec) || hasSecretKey(pixelSpecForValidation) || hasSecretKey(layers) || hasSecretKey(layersForValidation) || hasSecretKey(tokens) || hasSecretKey(components) || hasSecretKey(dependencies) || hasSecretKey(assetsManifest);
  assert(!secretPath, `package metadata contains a forbidden secret-like key: ${secretPath}`, errors);

  if (manifest.artifact?.storage === "minio-s3") {
    assert(Boolean(manifest.artifact.bucket), "manifest.artifact.bucket is required for minio-s3", errors);
    assert(Boolean(manifest.artifact.objectKey), "manifest.artifact.objectKey is required for minio-s3", errors);
    assert(Boolean(manifest.artifact.checksum), "manifest.artifact.checksum is required for minio-s3", errors);
    try {
      const expectedObjectKey = pragmaContextObjectKey({
        objectPrefix: options["minio-object-prefix"] || options.minioObjectPrefix || process.env.PRAGMA_CONTEXT_MINIO_OBJECT_PREFIX,
        repo: manifest.issue?.repo,
        designIssue: manifest.issue?.number,
        version: manifest.version,
        fileName: manifest.artifact.fileName || "context.zip"
      });
      assert(manifest.artifact.objectKey === expectedObjectKey, "manifest.artifact.objectKey does not match package identity", errors);
    } catch (error) {
      errors.push(`manifest.artifact.objectKey is invalid: ${error.message}`);
    }
    assert(manifest.artifact.uri === `s3://${manifest.artifact.bucket}/${manifest.artifact.objectKey}`, "manifest.artifact.uri must match bucket and objectKey", errors);
    const localZip = path.join(contextDir, manifest.artifact.fileName || "context.zip");
    if (await pathExists(localZip) && manifest.artifact.checksum) {
      const actual = await sha256File(localZip);
      assert(actual === manifest.artifact.checksum, "context.zip checksum does not match manifest.artifact.checksum", errors);
    }
    if (options.checkRemote && manifest.artifact.bucket && manifest.artifact.objectKey) {
      try {
        const config = resolveMinioPublishConfig(options);
        assert(config.bucket === manifest.artifact.bucket, "Configured MinIO bucket does not match manifest.artifact.bucket", errors);
        const remote = await statMinioObject({
          config,
          bucket: manifest.artifact.bucket,
          objectKey: manifest.artifact.objectKey,
          client: options.minioClient
        });
        if (manifest.artifact.archiveSizeBytes) {
          assert(remote.size === manifest.artifact.archiveSizeBytes, "MinIO object size does not match manifest.artifact.archiveSizeBytes", errors);
        }
      } catch (error) {
        errors.push(`MinIO object check failed: ${error.message}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, issues, contextDir, manifest };
}

export async function assertValidDesignContext(options) {
  const result = await validateDesignContext(options);
  if (!result.ok) {
    throw new CliError(`Design context validation failed:\n- ${result.errors.join("\n- ")}`);
  }
  return result;
}
