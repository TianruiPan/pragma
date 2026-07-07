import path from "node:path";
import fs from "node:fs/promises";
import { CliError } from "./errors.js";
import { isPathInside, listFilesRecursive, pathExists, readJson, resolveRepoRootFromContext } from "./fs.js";
import { sha256File } from "./checksum.js";
import { isConcreteSnapshotId, isValidDependencyStatus } from "./dependencies.js";
import { normalizeFigmaNodeId, parseFigmaUrl } from "./figma-url.js";
import { mimeForType, sniffAssetFile, typeFromExtension } from "./mime.js";
import { utf8Diagnostics } from "./text-encoding.js";

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
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

export async function validateDesignContext(options) {
  const contextDir = path.resolve(String(options.context));
  const errors = [];
  const warnings = [];

  assert(await pathExists(contextDir), `Context directory does not exist: ${contextDir}`, errors);
  if (errors.length) return { ok: false, errors, warnings, contextDir };

  const manifestPath = path.join(contextDir, "manifest.json");
  assert(await pathExists(manifestPath), "manifest.json is missing", errors);
  if (errors.length) return { ok: false, errors, warnings, contextDir };

  let manifest;
  try {
    manifest = await readJson(manifestPath);
  } catch (error) {
    errors.push(`manifest.json is not valid JSON: ${error.message}`);
    return { ok: false, errors, warnings, contextDir };
  }

  assert(manifest.schemaVersion === "2.0", "manifest.schemaVersion must be 2.0", errors);
  assert(manifest.kind === "pragma-design-context-package", "manifest.kind must be pragma-design-context-package", errors);
  assert(Boolean(manifest.id), "manifest.id is required", errors);
  assert(manifest.issue?.provider === "gitea", "manifest.issue.provider must be gitea", errors);
  assert(Number.isInteger(manifest.issue?.number) && manifest.issue.number > 0, "manifest.issue.number must be a positive integer", errors);
  assert(Boolean(manifest.issue?.repo), "manifest.issue.repo is required", errors);
  assert(Boolean(manifest.source?.provider), "manifest.source.provider is required", errors);
  assert(Boolean(manifest.source?.adapter), "manifest.source.adapter is required", errors);
  assert(Boolean(manifest.source?.capturedAt), "manifest.source.capturedAt is required", errors);

  const entrypoints = manifest.entrypoints || {};
  const requiredEntrypoints = [
    "humanHandoff",
    "agentContext",
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

  for (const key of ["humanHandoff", "agentContext", "designContext", "pixelSpec", "layers", "tokens", "components", "dependencies", "assetsManifest", "renderInstructions", "visualBaseline"]) {
    if (entrypoints[key]) {
      assert(await pathExists(path.join(contextDir, entrypoints[key])), `${entrypoints[key]} is missing`, errors);
    }
  }
  if (entrypoints.sourceDesignContext) {
    assert(await pathExists(path.join(contextDir, entrypoints.sourceDesignContext)), `${entrypoints.sourceDesignContext} is missing`, errors);
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
  }

  const pixelNodeIds = new Set();
  const pixelFigmaNodeIds = new Set();
  const dynamicRegionIds = new Set();
  if (pixelSpec) {
    assert(pixelSpec.schemaVersion === "2.0", "pixel-spec.schemaVersion must be 2.0", errors);
    assert(pixelSpec.kind === "pragma-pixel-spec", "pixel-spec.kind must be pragma-pixel-spec", errors);
    assert(Number.isFinite(Number(pixelSpec.viewport?.width)) && Number(pixelSpec.viewport.width) >= 0, "pixel-spec.viewport.width must be numeric", errors);
    assert(Number.isFinite(Number(pixelSpec.viewport?.height)) && Number(pixelSpec.viewport.height) >= 0, "pixel-spec.viewport.height must be numeric", errors);
    assert(Array.isArray(pixelSpec.nodes), "pixel-spec.nodes must be an array", errors);
    for (const node of asArray(pixelSpec.nodes)) {
      assert(Boolean(node.id), "pixel-spec node.id is required", errors);
      assert(Boolean(node.figmaNodeId), `pixel-spec node ${node.id || "<unknown>"} figmaNodeId is required`, errors);
      assert(Boolean(node.name), `pixel-spec node ${node.id || "<unknown>"} name is required`, errors);
      assert(Boolean(node.type), `pixel-spec node ${node.id || "<unknown>"} type is required`, errors);
      assert(node.bounds && Number.isFinite(Number(node.bounds.width)) && Number.isFinite(Number(node.bounds.height)), `pixel-spec node ${node.id || "<unknown>"} bounds are required`, errors);
      if (node.id) pixelNodeIds.add(node.id);
      if (node.figmaNodeId) pixelFigmaNodeIds.add(node.figmaNodeId);
    }
    assert(Array.isArray(pixelSpec.dynamicRegions), "pixel-spec.dynamicRegions must be an array", errors);
    for (const region of asArray(pixelSpec.dynamicRegions)) {
      assert(Boolean(region.id), "dynamic region id is required", errors);
      if (region.id) dynamicRegionIds.add(region.id);
      for (const nodeId of asArray(region.nodeIds)) {
        assert(pixelNodeIds.has(nodeId), `dynamic region ${region.id || "<unknown>"} references unknown pixel node ${nodeId}`, errors);
      }
    }
    for (const state of asArray(pixelSpec.states)) {
      for (const nodeId of asArray(state.nodeIds)) {
        assert(pixelNodeIds.has(nodeId), `state ${state.name || "<unknown>"} references unknown pixel node ${nodeId}`, errors);
      }
    }
  }

  const layerFigmaNodeIds = new Set();
  if (layers) {
    assert(layers.schemaVersion === "2.0", "layers.schemaVersion must be 2.0", errors);
    assert(layers.kind === "pragma-layer-tree", "layers.kind must be pragma-layer-tree", errors);
    assert(Array.isArray(layers.rootNodeIds), "layers.rootNodeIds must be an array", errors);
    assert(Array.isArray(layers.nodes), "layers.nodes must be an array", errors);
    for (const node of asArray(layers.nodes)) {
      assert(Boolean(node.figmaNodeId), "layer node figmaNodeId is required", errors);
      if (node.figmaNodeId) layerFigmaNodeIds.add(node.figmaNodeId);
    }
    for (const rootNodeId of asArray(layers.rootNodeIds)) {
      assert(layerFigmaNodeIds.has(rootNodeId), `layers.rootNodeIds references unknown node ${rootNodeId}`, errors);
    }
    for (const node of asArray(layers.nodes)) {
      for (const child of asArray(node.children)) {
        assert(layerFigmaNodeIds.has(child), `layer ${node.figmaNodeId || "<unknown>"} references unknown child ${child}`, errors);
      }
    }
  }

  const tokenIds = new Set(asArray(tokens?.tokens).map((token) => token.id).filter(Boolean));
  if (tokens) {
    assert(tokens.schemaVersion === "2.0", "tokens.schemaVersion must be 2.0", errors);
    assert(tokens.kind === "pragma-design-tokens", "tokens.kind must be pragma-design-tokens", errors);
    assert(Array.isArray(tokens.tokens), "tokens.tokens must be an array", errors);
  }
  if (pixelSpec) {
    const tokenRefs = collectPropertyValues(pixelSpec, (key) => /(^|\b)(tokenId|colorTokenId|fontTokenId|typographyTokenId|radiusTokenId|shadowTokenId)$/.test(key));
    for (const tokenId of tokenRefs) {
      assert(tokenIds.has(tokenId), `pixel-spec references unknown tokenId ${tokenId}`, errors);
    }
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
        assert(instance.bounds && Number.isFinite(Number(instance.bounds.width)) && Number.isFinite(Number(instance.bounds.height)), `component instance ${instance.nodeId || "<unknown>"} bounds are required`, errors);
      }
    } else {
      assert(Array.isArray(components.components), "components.components must be an array", errors);
    }
  }
  if (pixelSpec) {
    for (const node of asArray(pixelSpec.nodes)) {
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
      assert(!/latest/i.test(String(dep.snapshotId || "")), `dependencies.${role}.snapshotId must not reference floating latest`, errors);
      assert(!/\/latest(?:\/|$)/i.test(String(dep.path || "").replace(/\\/g, "/")), `dependencies.${role}.path must not reference floating latest`, errors);
      if (dependencyRoleNeedsLock(dep)) {
        assert(isConcreteSnapshotId(dep.snapshotId, role), `dependencies.${role}.snapshotId must lock a concrete ${role}-* snapshot`, errors);
        assert(Boolean(dep.path), `dependencies.${role}.path is required for ${dep.status}`, errors);
        assert(/^sha256:[0-9a-f]{64}$/i.test(String(dep.checksum || "")), `dependencies.${role}.checksum must be sha256`, errors);
        if (dep.path && repoRoot) {
          const resolved = resolvePackageRelative(repoRoot, contextDir, dep.path);
          assert(Boolean(resolved), `dependencies.${role}.path is outside repo`, errors);
          if (resolved) assert(await pathExists(resolved), `dependencies.${role}.path is missing: ${dep.path}`, errors);
        }
      }
    }

    if (dependencyRoleNeedsLock(dependencies.components)) {
      lockedComponentsSnapshot = repoRoot ? await readSnapshotJson(repoRoot, dependencies.components, "components.json", errors) : undefined;
    }
    if (dependencyRoleNeedsLock(dependencies.assets)) {
      lockedAssetsSnapshot = repoRoot ? await readSnapshotJson(repoRoot, dependencies.assets, "assets.json", errors) : undefined;
    }

    const componentInstances = collectComponentInstances(components, pixelSpec);
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

  const assetsMayBeExternal = manifest.artifact?.storage === "gitea-generic-package";
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
      if (asset.path) {
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
      for (const binding of asArray(asset.bindings)) {
        assert(binding.nodeId || binding.figmaNodeId, `asset ${asset.id || "<unknown>"} binding needs nodeId or figmaNodeId`, errors);
        if (binding.nodeId) assert(pixelNodeIds.has(binding.nodeId), `asset ${asset.id || "<unknown>"} binding references unknown nodeId ${binding.nodeId}`, errors);
        if (binding.figmaNodeId) assert(pixelFigmaNodeIds.has(binding.figmaNodeId) || layerFigmaNodeIds.has(binding.figmaNodeId), `asset ${asset.id || "<unknown>"} binding references unknown figmaNodeId ${binding.figmaNodeId}`, errors);
      }
    }
  }
  if (pixelSpec) {
    for (const binding of collectAssetBindingRefs(pixelSpec)) {
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

  const secretPath = hasSecretKey(manifest) || hasSecretKey(designContext) || hasSecretKey(pixelSpec) || hasSecretKey(layers) || hasSecretKey(tokens) || hasSecretKey(components) || hasSecretKey(dependencies) || hasSecretKey(assetsManifest);
  assert(!secretPath, `package metadata contains a forbidden secret-like key: ${secretPath}`, errors);

  if (manifest.artifact?.storage === "gitea-generic-package") {
    assert(Boolean(manifest.artifact.downloadUrl), "manifest.artifact.downloadUrl is required for gitea-generic-package", errors);
    assert(Boolean(manifest.artifact.checksum), "manifest.artifact.checksum is required for gitea-generic-package", errors);
    const localZip = path.join(contextDir, manifest.artifact.fileName || "context.zip");
    if (await pathExists(localZip) && manifest.artifact.checksum) {
      const actual = await sha256File(localZip);
      assert(actual === manifest.artifact.checksum, "context.zip checksum does not match manifest.artifact.checksum", errors);
    }
    if (options.checkRemote && manifest.artifact.downloadUrl) {
      try {
        const response = await fetch(manifest.artifact.downloadUrl, { method: "HEAD" });
        assert(response.ok, `Gitea Package Registry URL is not reachable: HTTP ${response.status}`, errors);
      } catch (error) {
        errors.push(`Gitea Package Registry URL check failed: ${error.message}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, contextDir, manifest };
}

export async function assertValidDesignContext(options) {
  const result = await validateDesignContext(options);
  if (!result.ok) {
    throw new CliError(`Design context validation failed:\n- ${result.errors.join("\n- ")}`);
  }
  return result;
}
