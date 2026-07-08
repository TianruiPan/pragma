import { createAssetRecord, extensionForMime, safeNodeIdSegment, sniffAssetBytes, slugify } from "../shared/assets.js";
import { binaryFile, createPragmaInputBundle, jsonFile, textFile } from "../shared/bundle.js";
import { buildFigmaUrl, parseFigmaUrl, resolveRequiredFigmaFileKey } from "../shared/figma-url.js";
import { availableStatesFromProperties, collectComponentInstances, collectVisualStateSources, flattenSerializedLayers, plain, serializeLayerNode } from "../shared/layer.js";
import { buildCaptureJson, buildPluginOnlyDependencyLock, buildSelectionJson } from "../shared/roles.js";
import type { BundleFile, CaptureFrame, CaptureFrames, CaptureRequest, FrameRole, RectLike } from "../shared/types.js";

const CAPTURABLE_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE", "COMPONENT_SET", "SECTION"]);

function nowMs(): number {
  return Date.now();
}

function elapsedMs(start: number): number {
  return Math.max(0, Date.now() - start);
}

type RoleAssignments = Record<string, FrameRole | "none" | undefined>;
type FrameSlots = Record<FrameRole, string[]>;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunk));
  }
  return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<string | undefined> {
  if (globalThis.crypto?.subtle) {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
    return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return undefined;
}

function requirePositiveInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

async function nodeById(nodeId: string) {
  if (typeof figma.getNodeByIdAsync === "function") return await figma.getNodeByIdAsync(nodeId);
  return figma.getNodeById(nodeId);
}

function normalizeFrameSlots(rawRequest: any): FrameSlots {
  const slots: FrameSlots = { page: [], components: [], assets: [] };
  const rawSlots = rawRequest.frameSlots || rawRequest.framesByRole;
  if (rawSlots && typeof rawSlots === "object") {
    for (const role of ["page", "components", "assets"] as FrameRole[]) {
      const rawIds = Array.isArray(rawSlots[role]) ? rawSlots[role] : [];
      slots[role] = rawIds.map((item: any) => String(item?.nodeId || item?.id || item)).filter(Boolean);
    }
    return slots;
  }

  const assignments: RoleAssignments = rawRequest.roleAssignments || {};
  for (const [nodeId, role] of Object.entries(assignments)) {
    if (!role || role === "none") continue;
    slots[role].push(nodeId);
  }
  return slots;
}

async function resolveAssignedFrames(rawRequest: any): Promise<Record<FrameRole, any[]>> {
  const slots = normalizeFrameSlots(rawRequest);
  const roles: Record<FrameRole, any[]> = { page: [], components: [], assets: [] };
  for (const role of ["page", "components", "assets"] as FrameRole[]) {
    for (const nodeId of slots[role]) {
      const node = await nodeById(nodeId);
      if (!node) throw new Error(`Selected ${role} node was not found: ${nodeId}`);
      if (!CAPTURABLE_TYPES.has(node.type)) throw new Error(`Node ${node.name} (${node.type}) cannot be captured as ${role}. Select a frame/section/component.`);
      roles[role].push(node);
    }
  }
  if (!roles.page.length) throw new Error("At least one page frame must be marked before export.");
  return roles;
}

function frameFromNode(node: any, role: FrameRole, fileKey: string): CaptureFrame {
  const bounds = placementOf(node);
  return {
    nodeId: node.id,
    name: node.name,
    type: node.type,
    width: node.width,
    height: node.height,
    bounds,
    viewport: { width: node.width || bounds.width || 0, height: node.height || bounds.height || 0 },
    role,
    optional: role !== "page",
    url: buildFigmaUrl(fileKey, node.id)
  };
}

function framesFromRoles(roles: Record<FrameRole, any[]>, fileKey: string): CaptureFrames {
  return {
    page: roles.page.map((node) => frameFromNode(node, "page", fileKey)),
    components: roles.components.map((node) => frameFromNode(node, "components", fileKey)),
    assets: roles.assets.map((node) => frameFromNode(node, "assets", fileKey))
  };
}

async function mainComponentOf(node: any) {
  if (node.type !== "INSTANCE") return null;
  try {
    if (typeof node.getMainComponentAsync === "function") return await node.getMainComponentAsync();
    return node.mainComponent || null;
  } catch {
    return null;
  }
}

function plainFigmaNode(node: any): Record<string, unknown> {
  const keys = [
    "id", "name", "type", "visible", "locked", "opacity", "blendMode",
    "absoluteBoundingBox", "relativeTransform", "width", "height",
    "constraints", "layoutMode", "primaryAxisSizingMode", "counterAxisSizingMode",
    "primaryAxisAlignItems", "counterAxisAlignItems", "layoutWrap", "itemSpacing",
    "layoutGrow", "layoutAlign", "layoutPositioning", "layoutSizingHorizontal", "layoutSizingVertical",
    "itemReverseZIndex", "strokesIncludedInLayout", "clipsContent", "overflowDirection",
    "minWidth", "maxWidth", "minHeight", "maxHeight",
    "inferredAutoLayout", "explicitVariableModes", "resolvedVariableModes",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "fills", "strokes", "strokeWeight", "cornerRadius", "rectangleCornerRadii",
    "effects", "characters", "fontName", "fontSize", "fontWeight",
    "lineHeight", "letterSpacing", "textAlignHorizontal", "textAlignVertical",
    "componentProperties", "variantProperties", "boundVariables",
    "fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId", "gridStyleId",
    "key", "description", "componentPropertyDefinitions", "exportSettings"
  ];
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    try {
      if (node[key] !== undefined) output[key] = node[key];
    } catch {
      // Some Figma getters throw when data is mixed/unloaded; omit those facts.
    }
  }
  output.parentId = node.parent?.id;
  output.parentName = node.parent?.name;
  output.pageId = figma.currentPage?.id;
  output.pageName = figma.currentPage?.name;
  output.children = [];
  return output;
}

async function serializeFigmaNode(node: any, role: FrameRole, zIndex = 0, parentNodeId?: string): Promise<any> {
  const mainComponent = await mainComponentOf(node);
  const childNodes = Array.isArray(node.children) ? node.children : [];
  const serialized = serializeLayerNode(plainFigmaNode(node), { role, zIndex, mainComponent, parentNodeId });
  serialized.children = [];
  for (let index = 0; index < childNodes.length; index += 1) {
    serialized.children.push(await serializeFigmaNode(childNodes[index], role, index, node.id));
  }
  return serialized;
}

async function serializeLayerRoots(roles: Record<FrameRole, any[]>) {
  const roots: any[] = [];
  for (const role of ["page", "components", "assets"] as FrameRole[]) {
    for (let index = 0; index < roles[role].length; index += 1) {
      roots.push(await serializeFigmaNode(roles[role][index], role, roots.length + index));
    }
  }
  return {
    schemaVersion: "2.0",
    kind: "pragma-layer-tree",
    rootNodeIds: roots.map((node) => node.figmaNodeId),
    nodes: roots
  };
}

function componentSource(node: any) {
  return node.role === "components" ? "selected-components-frame" : "page-inline";
}

function componentMetadataFromLayer(node: any) {
  return {
    id: node.nodeId,
    nodeId: node.figmaNodeId,
    figmaNodeId: node.figmaNodeId,
    parentNodeId: node.parentNodeId,
    name: node.name,
    type: node.type,
    role: node.role,
    source: componentSource(node),
    size: node.size,
    visible: node.visible,
    hidden: node.hidden,
    locked: node.locked,
    componentRef: node.componentRef,
    componentSetId: node.type === "COMPONENT" ? node.parentNodeId || node.componentRef?.componentSetId : node.componentRef?.componentSetId,
    componentProperties: node.componentProperties || {},
    variantProperties: node.variantProperties || {},
    componentPropertyDefinitions: node.componentPropertyDefinitions || {},
    availableStates: node.availableStates?.length
      ? node.availableStates
      : availableStatesFromProperties({
        variantProperties: node.variantProperties,
        componentProperties: node.componentProperties,
        componentPropertyDefinitions: node.componentPropertyDefinitions,
        visible: node.visible
      })
  };
}

function countVisibilityFacts(nodes: any[]) {
  return nodes.filter((node) => typeof node.visible === "boolean" || typeof node.hidden === "boolean").length;
}

function styleRecord(style: any) {
  return {
    id: style.id,
    key: style.key,
    name: style.name,
    type: style.type,
    description: style.description,
    remote: style.remote,
    paints: plain(style.paints),
    typeStyle: plain(style.typeStyle),
    effects: plain(style.effects),
    layoutGrids: plain(style.layoutGrids),
    documentationLinks: plain(style.documentationLinks)
  };
}

function buildComponentsJson(layerTree: any) {
  const allLayers = flattenSerializedLayers(layerTree.nodes || []);
  const instances = collectComponentInstances(layerTree.nodes || []);
  const visualStateSources = collectVisualStateSources(layerTree.nodes || []);
  const stateFrames = visualStateSources.filter((state) => state.type === "FRAME" || state.type === "SECTION");
  const componentSets = allLayers
    .filter((node) => node.type === "COMPONENT_SET")
    .map((node) => ({
      ...componentMetadataFromLayer(node),
      components: allLayers
        .filter((candidate) => candidate.type === "COMPONENT" && candidate.parentNodeId === node.figmaNodeId)
        .map(componentMetadataFromLayer)
    }));
  const components = allLayers
    .filter((node) => node.type === "COMPONENT")
    .map(componentMetadataFromLayer);
  const componentMetadataMissingCount = instances.filter((instance: any) => !instance.mainComponentNodeId).length;
  return {
    schemaVersion: "2.0",
    kind: "pragma-components",
    instances,
    components,
    componentSets,
    visualStateSources,
    stateFrames,
    metadataCompleteness: {
      instanceCount: instances.length,
      componentCount: components.length,
      componentSetCount: componentSets.length,
      visualStateSourceCount: visualStateSources.length,
      stateFrameCount: stateFrames.length,
      componentMetadataMissingCount,
      visibilityFactsCount: countVisibilityFacts(allLayers)
    },
    codeConnect: []
  };
}

async function buildVariablesJson() {
  const result: Record<string, unknown> = {
    schemaVersion: "2.0",
    kind: "pragma-figma-variables",
    variables: [],
    styles: []
  };
  try {
    if (figma.variables?.getLocalVariablesAsync) {
      result.variables = (await figma.variables.getLocalVariablesAsync()).map((variable: any) => ({
        id: variable.id,
        key: variable.key,
        name: variable.name,
        resolvedType: variable.resolvedType,
        variableCollectionId: variable.variableCollectionId,
        valuesByMode: variable.valuesByMode,
        scopes: variable.scopes,
        description: variable.description,
        remote: variable.remote
      }));
    }
  } catch (error) {
    result.variablesError = error instanceof Error ? error.message : String(error);
  }
  try {
    if (figma.getLocalPaintStylesAsync) {
      const paints = await figma.getLocalPaintStylesAsync();
      const texts = figma.getLocalTextStylesAsync ? await figma.getLocalTextStylesAsync() : [];
      const effects = figma.getLocalEffectStylesAsync ? await figma.getLocalEffectStylesAsync() : [];
      const grids = figma.getLocalGridStylesAsync ? await figma.getLocalGridStylesAsync() : [];
      result.styles = [...paints, ...texts, ...effects, ...grids].map(styleRecord);
      result.styleSummary = {
        paintCount: paints.length,
        textCount: texts.length,
        effectCount: effects.length,
        gridCount: grids.length
      };
    }
  } catch (error) {
    result.stylesError = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function buildMetadataJson(input: {
  request: CaptureRequest;
  frames: CaptureFrames;
  layerTree: any;
  components: any;
  capturedAt: string;
}) {
  const allLayers = flattenSerializedLayers(input.layerTree.nodes || []);
  const capturedFrames = (["page", "components", "assets"] as FrameRole[])
    .flatMap((role) => (input.frames[role] || []).map((frame) => ({
      nodeId: frame.nodeId,
      name: frame.name,
      type: frame.type,
      role,
      width: frame.width,
      height: frame.height,
      size: { width: frame.width || 0, height: frame.height || 0 },
      bounds: frame.bounds,
      viewport: frame.viewport,
      optional: frame.optional,
      url: frame.url
    })));
  const visibilityFacts = {
    total: allLayers.filter((node) => typeof node.visible === "boolean" || typeof node.hidden === "boolean").length,
    visible: allLayers.filter((node) => node.visible === true).length,
    hidden: allLayers.filter((node) => node.hidden === true).length
  };
  const nodeFacts = allLayers.map((node) => ({
    nodeId: node.nodeId,
    figmaNodeId: node.figmaNodeId,
    parentNodeId: node.parentNodeId,
    name: node.name,
    type: node.type,
    role: node.role,
    size: node.size,
    bounds: node.bounds,
    sourceOrder: node.sourceOrder,
    visible: node.visible,
    hidden: node.hidden,
    locked: node.locked,
    componentRef: node.componentRef,
    componentProperties: node.componentProperties,
    variantProperties: node.variantProperties,
    availableStates: node.availableStates,
    styleIds: node.styleIds,
    tokenRefs: node.tokenRefs
  }));
  return {
    schemaVersion: "2.0",
    kind: "pragma-figma-metadata",
    fileKey: input.request.figma.fileKey,
    fileName: input.request.figma.fileName,
    capturedAt: input.capturedAt,
    document: {
      fileKey: input.request.figma.fileKey,
      fileName: input.request.figma.fileName,
      editorType: figma.editorType,
      updatedAt: (figma.root as any)?.lastModified || (figma.root as any)?.updatedAt || null,
      updatedAtStatus: (figma.root as any)?.lastModified || (figma.root as any)?.updatedAt ? "captured" : "unavailable-in-plugin-api"
    },
    currentPage: {
      id: figma.currentPage.id,
      name: figma.currentPage.name,
      type: figma.currentPage.type,
      childCount: Array.isArray(figma.currentPage.children) ? figma.currentPage.children.length : undefined
    },
    capturedFrames,
    frameRoles: input.frames,
    nodeFacts,
    visibilityFacts,
    componentMetadataSummary: input.components.metadataCompleteness || {
      instanceCount: input.components.instances?.length || 0,
      componentCount: input.components.components?.length || 0,
      componentSetCount: input.components.componentSets?.length || 0
    },
    source: { provider: "figma", adapter: "figma-plugin-capture-bridge" }
  };
}

async function exportNodePng(node: any): Promise<Uint8Array> {
  return await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
}

async function addScreenshotFiles(files: BundleFile[], roles: Record<FrameRole, any[]>) {
  let index = 0;
  for (const node of [...roles.page, ...roles.components, ...roles.assets]) {
    const bytes = await exportNodePng(node);
    const checksum = await sha256(bytes);
    const role = roles.page.includes(node) ? "page" : roles.components.includes(node) ? "components" : "assets";
    files.push(binaryFile(`screenshots/${String(index).padStart(2, "0")}-${role}-${slugify(node.name, "frame")}.png`, bytesToBase64(bytes), "image/png", checksum));
    index += 1;
  }
}

function placementOf(node: any): RectLike {
  const box = node.absoluteBoundingBox || { x: 0, y: 0, width: node.width || 0, height: node.height || 0 };
  return { x: box.x || 0, y: box.y || 0, width: box.width || 0, height: box.height || 0 };
}

function imagePaints(node: any) {
  return Array.isArray(node.fills) ? node.fills.filter((fill: any) => fill && fill.type === "IMAGE" && fill.imageHash) : [];
}

function fitForImagePaint(fill: any) {
  if (fill.scaleMode === "FILL") return "cover";
  if (fill.scaleMode === "STRETCH") return "stretch";
  if (fill.scaleMode === "TILE") return "tile";
  return "contain";
}

function cropForImagePaint(fill: any) {
  if (fill.scaleMode !== "CROP") return null;
  return {
    scaleMode: fill.scaleMode,
    imageTransform: plain(fill.imageTransform) ?? null
  };
}

function walkNodes(nodes: any[], visit: (node: any) => void) {
  for (const node of nodes) {
    visit(node);
    if (Array.isArray(node.children)) walkNodes(node.children, visit);
  }
}

async function addImageFillAssets(files: BundleFile[], assetRecords: any[], bindings: any[], pageNodes: any[]) {
  const seen = new Set<string>();
  const candidates: any[] = [];
  walkNodes(pageNodes, (node) => {
    for (const fill of imagePaints(node)) candidates.push({ node, fill });
  });

  for (const { node, fill } of candidates) {
    const key = `${fill.imageHash}:${node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const image = figma.getImageByHash(fill.imageHash);
    if (!image) continue;
    const bytes = await image.getBytesAsync();
    const sniffed = sniffAssetBytes(bytes, "application/octet-stream");
    const mime = sniffed.mime;
    const checksum = await sha256(bytes);
    const ext = extensionForMime(mime);
    const assetId = `asset-image-${safeNodeIdSegment(node.id)}`;
    const assetPath = `assets/images/${assetId}.${ext}`;
    const binding = {
      assetId,
      nodeId: node.id,
      figmaNodeId: node.id,
      sourceNodeIds: [node.id],
      usedByNodeIds: [node.id],
      scope: "page" as const,
      fit: fitForImagePaint(fill),
      crop: cropForImagePaint(fill),
      placement: placementOf(node),
      sourcePaint: plain(fill)
    };
    bindings.push(binding);
    assetRecords.push(createAssetRecord({
      id: assetId,
      name: `${node.name} image fill`,
      role: "page-bound-image-fill",
      mime,
      path: assetPath,
      width: sniffed.width,
      height: sniffed.height,
      checksum,
      checksumStatus: checksum ? undefined : "unavailable",
      sourceNodeIds: [node.id],
      usedByNodeIds: [node.id],
      bindings: [binding],
      required: true
    }));
    files.push(binaryFile(assetPath, bytesToBase64(bytes), mime, checksum));
  }
}

async function addAssetsFrameExports(files: BundleFile[], assetRecords: any[], bindings: any[], assetsFrames: any[]) {
  for (const assetsFrame of assetsFrames) {
  const children = Array.isArray(assetsFrame.children) && assetsFrame.children.length ? assetsFrame.children : [assetsFrame];
  for (const node of children) {
    if (!CAPTURABLE_TYPES.has(node.type) && node.type !== "VECTOR" && node.type !== "BOOLEAN_OPERATION" && node.type !== "RECTANGLE") continue;
    const bytes = await exportNodePng(node);
    const checksum = await sha256(bytes);
    const sniffed = sniffAssetBytes(bytes, "image/png");
    const assetId = `asset-export-${safeNodeIdSegment(node.id)}`;
    const assetPath = `assets/exports/${assetId}.png`;
    const binding = {
      assetId,
      nodeId: node.id,
      figmaNodeId: node.id,
      sourceNodeIds: [node.id],
      usedByNodeIds: [node.id],
      scope: "shared" as const,
      fit: "contain",
      crop: null,
      placement: placementOf(node)
    };
    bindings.push(binding);
    assetRecords.push(createAssetRecord({
      id: assetId,
      name: node.name,
      role: "shared-assets-frame-export",
      mime: "image/png",
      path: assetPath,
      width: sniffed.width,
      height: sniffed.height,
      checksum,
      checksumStatus: checksum ? undefined : "unavailable",
      sourceNodeIds: [node.id],
      usedByNodeIds: [node.id],
      bindings: [binding],
      required: false
    }));
    files.push(binaryFile(assetPath, bytesToBase64(bytes), "image/png", checksum));
  }
  }
}

function getDesignContextFallback(request: CaptureRequest, frames: CaptureFrames) {
  const pageNames = frames.page.map((frame) => `${frame.name} (${frame.nodeId})`).join(", ");
  const componentNames = frames.components?.length ? frames.components.map((frame) => `${frame.name} (${frame.nodeId})`).join(", ") : "not selected";
  const assetNames = frames.assets?.length ? frames.assets.map((frame) => `${frame.name} (${frame.nodeId})`).join(", ") : "not selected";
  return `# Figma Plugin Capture Summary\n\n` +
    `This file was captured by the Pragma Figma Plugin. Figma MCP get_design_context text was not available in-plugin, so this is a provider/plugin summary only. Do not treat it as MCP output or generated implementation code.\n\n` +
    `- File key: ${request.figma.fileKey}\n` +
    `- Page frame(s): ${pageNames}\n` +
    `- Components frame(s): ${componentNames}\n` +
    `- Assets frame(s): ${assetNames}\n`;
}

function parseRequest(raw: any, frames: CaptureFrames, fileKey: string, fileName?: string): CaptureRequest {
  const issueNumber = requirePositiveInteger(raw.designIssueNumber, raw.designIssue?.number || 1);
  const repoName = String(raw.repoName || raw.repo?.name || "product-repo");
  const repoOwner = String(raw.repoOwner || raw.repo?.owner || "local");
  const parsedUrl = parseFigmaUrl(raw.figmaUrl);
  return {
    repo: {
      owner: repoOwner,
      name: repoName,
      localPath: raw.repoLocalPath || raw.repo?.localPath || undefined
    },
    designIssue: {
      number: issueNumber,
      title: raw.designIssueTitle || raw.designIssue?.title || undefined
    },
    targetDevIssues: raw.targetDevIssueNumber ? [{ number: requirePositiveInteger(raw.targetDevIssueNumber, 1), title: raw.targetDevIssueTitle || undefined }] : raw.targetDevIssues || [],
    figma: {
      fileKey: raw.fileKey || parsedUrl.fileKey || fileKey,
      fileName: raw.fileName || fileName,
      url: raw.figmaUrl || parsedUrl.url,
      selectionMode: "figma-plugin-explicit-frame-roles",
      frames
    },
    blueLakeUrl: raw.blueLakeUrl || undefined,
    designerNotes: raw.designerNotes || "",
    dynamicRegionNotes: raw.dynamicRegionNotes || ""
  };
}

export async function buildCaptureBundle(rawRequest: any) {
  const totalStart = nowMs();
  const serializeStart = nowMs();
  const fileKey = resolveRequiredFigmaFileKey({ override: rawRequest.fileKey, figmaUrl: rawRequest.figmaUrl, pluginFileKey: figma.fileKey });
  const roles = await resolveAssignedFrames(rawRequest || {});
  const frames = framesFromRoles(roles, fileKey);
  const request = parseRequest(rawRequest, frames, fileKey, figma.root?.name);
  const capturedAt = new Date().toISOString();
  const capture = buildCaptureJson(request, capturedAt);
  const selection = buildSelectionJson({
    fileKey: request.figma.fileKey,
    fileName: request.figma.fileName,
    page: { id: figma.currentPage.id, name: figma.currentPage.name, type: figma.currentPage.type },
    frames
  });
  const layerTree = await serializeLayerRoots(roles);
  const components = buildComponentsJson(layerTree);
  const variables = await buildVariablesJson();
  const serializeMs = elapsedMs(serializeStart);
  const files: BundleFile[] = [];
  const assets: any[] = [];
  const bindings: any[] = [];

  const screenshotsStart = nowMs();
  await addScreenshotFiles(files, roles);
  const exportScreenshotsMs = elapsedMs(screenshotsStart);
  const assetsStart = nowMs();
  await addImageFillAssets(files, assets, bindings, roles.page);
  await addAssetsFrameExports(files, assets, bindings, roles.assets);
  const exportAssetsMs = elapsedMs(assetsStart);

  const hasComponentInstances = components.instances.length > 0;
  const dependencyLock = buildPluginOnlyDependencyLock({
    fileKey: request.figma.fileKey,
    capturedAt,
    frames,
    hasComponentInstances,
    hasUnresolvedSharedAssetRefs: false
  });
  const metadata = buildMetadataJson({ request, frames, layerTree, components, capturedAt });

  files.push(jsonFile("capture.json", capture));
  files.push(jsonFile("dependency-lock.json", dependencyLock));
  files.push(jsonFile("figma/metadata.json", metadata));
  files.push(jsonFile("figma/selection.json", selection));
  files.push(jsonFile("figma/layers.json", layerTree));
  files.push(jsonFile("figma/variables.json", variables));
  files.push(jsonFile("figma/components.json", components));
  files.push(textFile("figma/get-design-context.md", getDesignContextFallback(request, frames)));
  files.push(jsonFile("assets-manifest.json", { schemaVersion: "2.0", kind: "pragma-design-assets", assets }));
  files.push(jsonFile("asset-bindings.json", { schemaVersion: "2.0", kind: "pragma-asset-bindings", bindings }));
  files.push(textFile("designer-notes.md", request.designerNotes || ""));
  files.push(textFile("dynamic-regions.md", request.dynamicRegionNotes || ""));

  const captureTimings = {
    serializeMs,
    exportScreenshotsMs,
    exportAssetsMs,
    writeFilesMs: 0,
    dependencyLockMs: 0,
    totalMs: elapsedMs(totalStart)
  };

  return createPragmaInputBundle(files, capturedAt, {
    fileKey: request.figma.fileKey,
    designIssue: request.designIssue.number,
    pageFrames: frames.page.length,
    componentsStatus: dependencyLock.components.status,
    assetsStatus: dependencyLock.assets.status,
    assetCount: assets.length,
    screenshotCount: files.filter((file) => file.path.startsWith("screenshots/")).length,
    captureTimings
  });
}
