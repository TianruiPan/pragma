import path from "node:path";
import { slugify } from "./normalize.js";

export function normalizeNodeId(value, fallback = "node") {
  const text = String(value || fallback);
  if (text.startsWith("node-")) return slugify(text, "node");
  return `node-${slugify(text, "item")}`;
}

export function boundsFromRawNode(raw) {
  return normalizeBounds(raw);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function numberOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeBounds(raw) {
  const source = raw?.bounds || raw?.absoluteBoundingBox || raw?.rect || raw?.frame || raw?.viewport || raw || {};
  const width = source.width ?? raw?.width;
  const height = source.height ?? raw?.height;
  return {
    x: numberOr(source.x, 0),
    y: numberOr(source.y, 0),
    width: numberOr(width, 0),
    height: numberOr(height, 0)
  };
}

function normalizePadding(value) {
  if (!value) return undefined;
  if (typeof value === "number") {
    return { top: value, right: value, bottom: value, left: value };
  }
  return {
    top: numberOr(value.top, 0),
    right: numberOr(value.right, 0),
    bottom: numberOr(value.bottom, 0),
    left: numberOr(value.left, 0)
  };
}

function normalizeLayout(raw) {
  const layout = raw?.layout || {};
  return {
    mode: layout.mode || raw?.layoutMode?.toLowerCase?.() || undefined,
    position: layout.position || raw?.position || "absolute",
    constraints: layout.constraints || raw?.constraints || undefined,
    overflow: layout.overflow || raw?.overflow || "visible",
    gap: layout.gap ?? raw?.itemSpacing,
    padding: normalizePadding(layout.padding || raw?.padding)
  };
}

function normalizeText(raw) {
  const text = raw?.text || {};
  const content = text.content ?? raw?.characters ?? raw?.textContent;
  if (content === undefined && String(raw?.type || "").toLowerCase() !== "text") return null;
  const style = raw?.style || {};
  return {
    content: content ?? "",
    fontFamily: text.fontFamily || style.fontFamily || raw?.fontFamily,
    fontStyle: text.fontStyle || style.fontStyle || raw?.fontStyle,
    fontWeight: text.fontWeight || style.fontWeight || raw?.fontWeight,
    fontSize: text.fontSize || style.fontSize || raw?.fontSize,
    lineHeight: text.lineHeight || style.lineHeightPx || style.lineHeight || raw?.lineHeight,
    letterSpacing: text.letterSpacing || style.letterSpacing || raw?.letterSpacing || 0,
    align: text.align || style.textAlignHorizontal?.toLowerCase?.() || raw?.align || "left",
    color: text.color || raw?.color || style.color
  };
}

function normalizeRadius(raw) {
  const radius = raw?.radius ?? raw?.cornerRadius;
  if (radius === undefined || radius === null) return null;
  if (typeof radius === "number") {
    return { topLeft: radius, topRight: radius, bottomRight: radius, bottomLeft: radius };
  }
  return {
    topLeft: numberOr(radius.topLeft ?? radius.top_left, 0),
    topRight: numberOr(radius.topRight ?? radius.top_right, 0),
    bottomRight: numberOr(radius.bottomRight ?? radius.bottom_right, 0),
    bottomLeft: numberOr(radius.bottomLeft ?? radius.bottom_left, 0)
  };
}

function normalizeNodeType(type) {
  const normalized = String(type || "frame").toLowerCase();
  if (normalized === "text") return "text";
  if (normalized === "instance") return "instance";
  if (normalized === "component") return "component";
  if (normalized === "rectangle" || normalized === "image") return "image";
  return normalized;
}

function flattenTree(input) {
  const nodes = [];
  function walk(node) {
    if (!node || typeof node !== "object") return;
    nodes.push(node);
    for (const child of asArray(node.children)) {
      if (typeof child === "object") walk(child);
    }
  }
  if (Array.isArray(input)) {
    input.forEach(walk);
  } else if (Array.isArray(input?.nodes)) {
    input.nodes.forEach(walk);
  } else if (Array.isArray(input?.layers)) {
    input.layers.forEach(walk);
  } else if (input) {
    walk(input);
  }
  return nodes;
}

function figmaIdForNode(node, index) {
  return String(node.figmaNodeId || node.nodeId || node.id || `generated:${index}`);
}

function childFigmaRefs(node) {
  return asArray(node.children).map((child) => {
    if (typeof child === "string") return child;
    return String(child.figmaNodeId || child.nodeId || child.id || "");
  }).filter(Boolean);
}

export function buildLayerModel(layerSource, selectionNodes) {
  const rawNodes = flattenTree(layerSource);
  const fallbackNodes = rawNodes.length ? rawNodes : selectionNodes.map((node) => ({
    figmaNodeId: node.id,
    id: node.id,
    name: node.name,
    type: node.type || "FRAME",
    bounds: { x: 0, y: 0, width: node.width || 0, height: node.height || 0 },
    children: []
  }));

  const figmaToNormalized = new Map();
  const normalizedToFigma = new Map();
  fallbackNodes.forEach((node, index) => {
    const figmaNodeId = figmaIdForNode(node, index);
    const normalizedId = normalizeNodeId(node.normalizedNodeId || node.normalizedId || figmaNodeId, `node-${index + 1}`);
    figmaToNormalized.set(String(figmaNodeId), normalizedId);
    normalizedToFigma.set(normalizedId, String(figmaNodeId));
  });

  const parentByFigma = new Map();
  fallbackNodes.forEach((node, index) => {
    const parentFigmaId = figmaIdForNode(node, index);
    for (const childRef of childFigmaRefs(node)) {
      if (!parentByFigma.has(childRef)) parentByFigma.set(childRef, parentFigmaId);
    }
  });
  const normalizedIds = new Set(figmaToNormalized.values());

  const layers = fallbackNodes.map((node, index) => {
    const figmaNodeId = figmaIdForNode(node, index);
    const childRefs = childFigmaRefs(node)
      .map((childRef) => figmaToNormalized.get(childRef) || (normalizedIds.has(childRef) ? childRef : undefined))
      .filter(Boolean);
    const parentFigmaId = parentByFigma.get(figmaNodeId);
    const parentId = parentFigmaId ? figmaToNormalized.get(parentFigmaId) : undefined;
    const hidden = Boolean(node.hidden || node.visible === false);
    const type = node.type || "FRAME";
    const renderable = node.renderable ?? (!hidden && !["SECTION", "PAGE"].includes(String(type).toUpperCase()));
    const layer = {
      id: figmaToNormalized.get(figmaNodeId),
      figmaNodeId,
      normalizedNodeId: figmaToNormalized.get(figmaNodeId),
      name: node.name || figmaNodeId,
      type,
      parentId,
      children: childRefs,
      sourceOrder: Number.isFinite(Number(node.sourceOrder)) ? Number(node.sourceOrder) : index
    };
    if (renderable === false) layer.renderable = false;
    if (hidden) layer.hidden = true;
    if (node.locked) layer.locked = true;
    if (node.sectionId) layer.sectionId = node.sectionId;
    if (node.role) layer.role = node.role;
    return layer;
  });

  const explicitRoots = asArray(layerSource?.rootNodeIds)
    .map(String)
    .map((rootId) => figmaToNormalized.get(rootId) || (normalizedIds.has(rootId) ? rootId : undefined))
    .filter(Boolean);
  const allChildren = new Set(layers.flatMap((node) => node.children || []));
  const roots = explicitRoots.length ? explicitRoots : layers.map((node) => node.id).filter((id) => !allChildren.has(id));

  return {
    layers: {
      schemaVersion: "2.0",
      kind: "pragma-layer-tree",
      rootNodeIds: roots.length ? roots : layers.slice(0, 1).map((node) => node.id),
      nodes: layers
    },
    rawNodes: fallbackNodes,
    figmaToNormalized,
    normalizedToFigma
  };
}

function stableValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value).trim().toLowerCase();
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${key}:${stableValue(value[key])}`).join(",")}}`;
}

function comparableTokenValue(value, type) {
  if (value && typeof value === "object" && "resolvedValue" in value) return comparableTokenValue(value.resolvedValue, type);
  if (type === "color" && typeof value === "string") return value.trim().toLowerCase();
  if (type === "radius") {
    if (typeof value === "number") return `uniform:${value}`;
    if (value && typeof value === "object") {
      const corners = [value.topLeft, value.topRight, value.bottomRight, value.bottomLeft].map(Number);
      if (corners.every((corner) => Number.isFinite(corner)) && corners.every((corner) => corner === corners[0])) {
        return `uniform:${corners[0]}`;
      }
    }
  }
  return stableValue(value);
}

function buildTokenLookup(tokens) {
  const byValue = new Map();
  const bySource = new Map();
  for (const token of asArray(tokens?.tokens)) {
    if (!token?.id || !token.type) continue;
    if (token.value !== undefined) {
      const key = `${token.type}:${comparableTokenValue(token.value, token.type)}`;
      if (!byValue.has(key)) byValue.set(key, token.id);
    }
    for (const ref of sourceRefsForToken(token)) {
      if (!bySource.has(ref)) bySource.set(ref, token.id);
      const typed = `${token.type}:${ref}`;
      if (!bySource.has(typed)) bySource.set(typed, token.id);
    }
  }
  return { byValue, bySource };
}

function sourceRefsForToken(token) {
  const refs = [];
  const source = token?.source || {};
  for (const key of ["variableId", "id"]) {
    if (source[key]) refs.push(`variable:${source[key]}`);
  }
  if (source.styleId) refs.push(`style:${source.styleId}`);
  if (token?.id) refs.push(`token:${token.id}`);
  return refs;
}

function sourceRefId(value) {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object") return value.id || value.variableId || value.styleId || value.key;
  return undefined;
}

function collectVariableRefs(value, results = []) {
  if (!value) return results;
  if (Array.isArray(value)) {
    for (const item of value) collectVariableRefs(item, results);
    return results;
  }
  if (typeof value === "object") {
    const id = sourceRefId(value);
    if (id) results.push(`variable:${id}`);
    for (const child of Object.values(value)) collectVariableRefs(child, results);
  }
  return results;
}

function tokenRefsForNode(raw, slot) {
  const refs = [];
  const styleIds = raw?.tokenRefs?.styleIds || raw?.styleIds || {};
  const boundVariables = raw?.tokenRefs?.boundVariables || raw?.boundVariables || {};
  const styleKeyBySlot = {
    fills: ["fillStyleId"],
    strokes: ["strokeStyleId"],
    text: ["textStyleId"],
    typography: ["textStyleId"],
    effects: ["effectStyleId"],
    shadow: ["effectStyleId"],
    grids: ["gridStyleId"]
  };
  for (const key of styleKeyBySlot[slot] || []) {
    if (styleIds[key]) refs.push(`style:${styleIds[key]}`);
  }
  for (const key of [slot, slot === "shadow" ? "effects" : undefined, slot === "typography" ? "text" : undefined].filter(Boolean)) {
    refs.push(...collectVariableRefs(boundVariables[key]));
  }
  return [...new Set(refs)];
}

function mapTokenValue(value, type, tokenLookup, sourceRefs = []) {
  if (value === undefined || value === null) return undefined;
  if (value && typeof value === "object" && "resolvedValue" in value) return value;
  let tokenId;
  for (const ref of sourceRefs) {
    tokenId = tokenLookup.bySource.get(`${type}:${ref}`) || tokenLookup.bySource.get(ref);
    if (tokenId) break;
  }
  tokenId = tokenId || tokenLookup.byValue.get(`${type}:${comparableTokenValue(value, type)}`);
  return tokenId ? { tokenId, resolvedValue: value } : { resolvedValue: value };
}

function normalizePaints(value, tokenLookup, sourceRefs = []) {
  return asArray(value).filter(Boolean).map((paint) => {
    if (typeof paint === "string") {
      return { type: "solid", color: mapTokenValue(paint, "color", tokenLookup, sourceRefs) };
    }
    if (!paint || typeof paint !== "object") return paint;
    const normalized = { ...paint };
    const colorValue = paint.color ?? paint.value ?? paint.hex;
    if (colorValue !== undefined) normalized.color = mapTokenValue(colorValue, "color", tokenLookup, sourceRefs);
    return normalized;
  });
}

function normalizeShadows(value, tokenLookup, sourceRefs = []) {
  return asArray(value).filter(Boolean).map((shadow) => mapTokenValue(shadow, "shadow", tokenLookup, sourceRefs));
}

function normalizeTextWithTokens(raw, tokenLookup) {
  const text = normalizeText(raw);
  if (!text) return null;
  const typographyValue = {
    fontFamily: text.fontFamily,
    fontStyle: text.fontStyle,
    fontWeight: text.fontWeight,
    fontSize: text.fontSize,
    lineHeight: text.lineHeight,
    letterSpacing: text.letterSpacing
  };
  return {
    ...text,
    color: text.color !== undefined ? mapTokenValue(text.color, "color", tokenLookup, tokenRefsForNode(raw, "fills")) : undefined,
    typography: Object.values(typographyValue).some((item) => item !== undefined)
      ? mapTokenValue(typographyValue, "typography", tokenLookup, tokenRefsForNode(raw, "typography"))
      : undefined
  };
}

function normalizeNodeRefs(values, figmaToNormalized) {
  return [...new Set(asArray(values).map((value) => {
    const text = String(value || "");
    return figmaToNormalized.get(text) || text;
  }).filter(Boolean))];
}

function normalizeBinding(binding, figmaToNormalized) {
  const explicitFigmaNodeId = binding.figmaNodeId || binding.sourceNodeId || binding.nodeId;
  const figmaNodeId = explicitFigmaNodeId ? String(explicitFigmaNodeId) : undefined;
  const nodeId = binding.nodeId
    ? (figmaToNormalized.get(String(binding.nodeId)) || binding.nodeId)
    : (figmaNodeId ? figmaToNormalized.get(String(figmaNodeId)) : undefined);
  const normalized = {
    nodeId,
    figmaNodeId,
    assetId: binding.assetId,
    fit: binding.fit || "contain",
    crop: binding.crop ?? null,
    placement: binding.placement || binding.bounds || undefined,
    sourceNodeIds: normalizeNodeRefs(binding.sourceNodeIds || binding.sourceNodeId || figmaNodeId, figmaToNormalized),
    usedByNodeIds: normalizeNodeRefs(binding.usedByNodeIds || binding.usedByNodeId || nodeId || figmaNodeId, figmaToNormalized),
    scope: binding.scope || "page"
  };
  if (binding.sourcePaint !== undefined) normalized.sourcePaint = binding.sourcePaint;
  return normalized;
}

export function normalizeAssetBindings(assetBindingsSource, figmaToNormalized) {
  const rawBindings = Array.isArray(assetBindingsSource)
    ? assetBindingsSource
    : asArray(assetBindingsSource?.bindings || assetBindingsSource?.assetBindings);
  return rawBindings.map((binding) => normalizeBinding(binding, figmaToNormalized)).filter((binding) => binding.assetId);
}

function bindingForNode(bindings, pixelNode) {
  return bindings.find((binding) => binding.nodeId === pixelNode.id || binding.figmaNodeId === pixelNode.figmaNodeId) || null;
}


function normalizeComponentRefForPixelNode(node) {
  const componentRef = node.componentRef || (node.componentId ? { componentId: node.componentId, variant: node.variant } : null);
  if (!componentRef) return null;
  const normalized = { ...componentRef };
  if (node.variantProperties || componentRef.variantProperties) normalized.variantProperties = node.variantProperties || componentRef.variantProperties;
  if (node.componentProperties || componentRef.componentProperties) normalized.componentProperties = node.componentProperties || componentRef.componentProperties;
  if (node.availableStates || componentRef.availableStates) normalized.availableStates = asArray(node.availableStates || componentRef.availableStates);
  return normalized;
}

function componentPropertyValue(value) {
  if (value && typeof value === "object" && "value" in value) return value.value;
  return value;
}

function normalizeAvailableStates(node) {
  const states = [];
  for (const state of asArray(node.availableStates)) {
    if (!state || typeof state !== "object") continue;
    states.push({
      name: String(state.name || state.property || state.type || "state"),
      value: state.value,
      source: state.source || "figma-native-state"
    });
  }
  for (const [name, value] of Object.entries(node.variantProperties || node.componentRef?.variantProperties || {})) {
    states.push({ name, value, source: "figma-variant-property" });
  }
  for (const [name, rawValue] of Object.entries(node.componentProperties || node.componentRef?.componentProperties || {})) {
    states.push({ name, value: componentPropertyValue(rawValue), source: "figma-component-property" });
  }
  if (node.visible === false || node.hidden === true) states.push({ name: "visibility", value: "hidden", source: "figma-node-visibility" });
  if (node.visible === true || node.hidden === false) states.push({ name: "visibility", value: "visible", source: "figma-node-visibility" });
  const seen = new Set();
  return states.filter((state) => {
    const key = `${state.name}:${state.value}:${state.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return state.value !== undefined && state.value !== null && state.value !== "";
  });
}

function buildPixelAvailableStates(pixelNodes) {
  const byState = new Map();
  for (const node of pixelNodes) {
    for (const state of asArray(node.availableStates)) {
      const key = `${state.name}:${state.value}:${state.source}`;
      if (!byState.has(key)) byState.set(key, { ...state, nodeIds: [] });
      byState.get(key).nodeIds.push(node.id);
    }
    if (node.state && node.state !== "default") {
      const key = `state:${node.state}:figma-node-state`;
      if (!byState.has(key)) byState.set(key, { name: "state", value: node.state, source: "figma-node-state", nodeIds: [] });
      byState.get(key).nodeIds.push(node.id);
    }
  }
  return [...byState.values()].filter((state) => state.nodeIds.length > 0);
}

export function buildPixelSpec({ contextId, rawNodes, layers, figmaToNormalized, assetBindings, dynamicRegionNotes, tokens }) {
  const tokenLookup = buildTokenLookup(tokens);
  const pixelNodes = rawNodes.map((node, index) => {
    const figmaNodeId = figmaIdForNode(node, index);
    const normalizedId = figmaToNormalized.get(figmaNodeId) || normalizeNodeId(figmaNodeId, `node-${index + 1}`);
    const radius = normalizeRadius(node);
    const pixelNode = {
      id: normalizedId,
      figmaNodeId,
      layerRef: normalizedId,
      name: node.name || figmaNodeId,
      type: normalizeNodeType(node.type),
      zIndex: Number.isFinite(Number(node.zIndex)) ? Number(node.zIndex) : index,
      bounds: normalizeBounds(node),
      layout: normalizeLayout(node),
      fills: normalizePaints(node.fills || node.fill, tokenLookup, tokenRefsForNode(node, "fills")),
      strokes: normalizePaints(node.strokes || node.stroke, tokenLookup, tokenRefsForNode(node, "strokes")),
      radius: radius ? mapTokenValue(radius, "radius", tokenLookup, tokenRefsForNode(node, "radius")) : null,
      shadow: normalizeShadows(node.shadow || node.shadows || node.effects, tokenLookup, tokenRefsForNode(node, "shadow")),
      opacity: node.opacity ?? 1,
      blendMode: node.blendMode || "normal",
      text: normalizeTextWithTokens(node, tokenLookup),
      assetBinding: null,
      componentRef: normalizeComponentRefForPixelNode(node),
      state: node.state || "default",
      availableStates: normalizeAvailableStates(node)
    };
    pixelNode.assetBinding = bindingForNode(assetBindings, pixelNode);
    return pixelNode;
  });

  const rootIds = new Set(asArray(layers.rootNodeIds));
  const rootPixelNode = pixelNodes.find((node) => rootIds.has(node.id) || rootIds.has(node.figmaNodeId)) || pixelNodes[0];
  const viewportBounds = rootPixelNode?.bounds || { width: 0, height: 0 };
  const mapLikeNodeIds = pixelNodes
    .filter((node) => /map|地图|chart|图表|video|视频|3d|三维|realtime|实时/i.test(`${node.name} ${node.type}`))
    .map((node) => node.id);
  const dynamicRegions = dynamicRegionNotes || mapLikeNodeIds.length ? [{
    id: "region-dynamic-1",
    name: mapLikeNodeIds.length ? "Implementation-defined visual region" : "Dynamic region",
    type: mapLikeNodeIds.some((id) => /map|地图/i.test(pixelNodes.find((node) => node.id === id)?.name || "")) ? "map" : "implementation-defined",
    nodeIds: mapLikeNodeIds,
    rendering: "implementation-defined",
    pixelMatchRequired: false,
    notes: String(dynamicRegionNotes || "Dynamic rendering is implementation-defined for this region.").trim()
  }] : [];

  return {
    schemaVersion: "2.0",
    kind: "pragma-pixel-spec",
    id: contextId,
    viewport: {
      width: numberOr(viewportBounds.width, 0),
      height: numberOr(viewportBounds.height, 0),
      deviceScale: 1
    },
    nodes: pixelNodes,
    states: buildPixelAvailableStates(pixelNodes),
    dynamicRegions
  };
}


function nodeTextForSearch(pixelNode) {
  return [pixelNode?.name, pixelNode?.type, pixelNode?.text?.content].filter(Boolean).join(" ").toLowerCase();
}

function isDynamicCandidate(pixelNode) {
  return /map|chart|video|3d|realtime|radar|globe|heatmap|trajectory|\u5730\u56fe|\u56fe\u8868|\u89c6\u9891|\u4e09\u7ef4|\u5b9e\u65f6|\u96f7\u8fbe|\u6001\u52bf/i.test(nodeTextForSearch(pixelNode));
}

function normalizeRole(pixelNode, title) {
  const text = [pixelNode?.name, pixelNode?.type, title].filter(Boolean).join(" ").toLowerCase();
  if (/map|globe|gis|\u5730\u56fe/.test(text)) return "dynamic-map";
  if (/chart|graph|trend|\u56fe\u8868|\u8d8b\u52bf/.test(text)) return "dynamic-chart";
  if (/video|camera|\u89c6\u9891|\u76d1\u63a7/.test(text)) return "dynamic-video";
  if (/3d|three|\u4e09\u7ef4/.test(text)) return "dynamic-3d";
  if (/realtime|live|radar|\u5b9e\u65f6|\u96f7\u8fbe|\u6001\u52bf/.test(text)) return "realtime-data";
  if (/header|top|nav|\u6807\u9898|\u5bfc\u822a/.test(text)) return "header";
  if (/sidebar|aside|menu|\u4fa7\u8fb9|\u83dc\u5355/.test(text)) return "sidebar";
  if (/filter|search|query|\u7b5b\u9009|\u641c\u7d22|\u67e5\u8be2/.test(text)) return "filter-bar";
  if (/table|list|\u5217\u8868|\u8868\u683c/.test(text)) return "data-list";
  if (/panel|card|module|\u9762\u677f|\u5361\u7247|\u6a21\u5757/.test(text)) return "panel";
  return "content";
}

function isContainerLayer(layer) {
  const type = String(layer?.type || "").toUpperCase();
  return ["FRAME", "GROUP", "INSTANCE", "COMPONENT", "COMPONENT_SET", "SECTION", "PAGE"].includes(type);
}

function isVisibleLayer(layer) {
  return layer && layer.hidden !== true && layer.renderable !== false;
}

function layerLookup(layers) {
  const byId = new Map();
  for (const layer of asArray(layers?.nodes)) byId.set(layer.id, layer);
  return byId;
}

function pixelLookup(pixelSpec) {
  const byId = new Map();
  for (const node of asArray(pixelSpec?.nodes)) byId.set(node.id, node);
  return byId;
}

function descendantLayerIds(rootId, byLayerId) {
  const result = [];
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    const layer = byLayerId.get(id);
    for (const child of asArray(layer?.children)) stack.push(child);
  }
  return result;
}

function firstTitleForRegion(rootId, byLayerId, byPixelId) {
  for (const id of descendantLayerIds(rootId, byLayerId)) {
    const pixelNode = byPixelId.get(id);
    const content = String(pixelNode?.text?.content || "").trim();
    if (content) return content.slice(0, 120);
  }
  return undefined;
}

function regionConfidence(layer, pixelNode, title, depth) {
  if (isDynamicCandidate(pixelNode)) return 0.95;
  if (String(layer?.type || "").toUpperCase() === "INSTANCE") return 0.9;
  if (isContainerLayer(layer) && title) return depth <= 1 ? 0.85 : 0.75;
  if (isContainerLayer(layer)) return depth <= 1 ? 0.72 : 0.6;
  return 0.45;
}

function makeRegionId(layer, seen) {
  const base = `region-${slugify(layer?.name || layer?.id || "region")}-${slugify(layer?.id || "node")}`;
  let id = base;
  let index = 2;
  while (seen.has(id)) id = `${base}-${index++}`;
  seen.add(id);
  return id;
}

function candidateRegionLayers(rootId, byLayerId, byPixelId) {
  const candidates = [];
  const root = byLayerId.get(rootId);
  const direct = asArray(root?.children).filter((id) => isVisibleLayer(byLayerId.get(id)));
  for (const childId of direct) {
    const child = byLayerId.get(childId);
    const pixelNode = byPixelId.get(childId);
    const includeChild = isContainerLayer(child) || isDynamicCandidate(pixelNode) || String(child?.type || "").toUpperCase() === "INSTANCE";
    if (includeChild) candidates.push({ layer: child, depth: 1 });
    for (const grandChildId of asArray(child?.children)) {
      const grandChild = byLayerId.get(grandChildId);
      if (!isVisibleLayer(grandChild)) continue;
      const grandPixel = byPixelId.get(grandChildId);
      const includeGrandChild = isContainerLayer(grandChild) || isDynamicCandidate(grandPixel) || String(grandChild?.type || "").toUpperCase() === "INSTANCE";
      if (includeGrandChild) candidates.push({ layer: grandChild, depth: 2 });
    }
  }
  if (!candidates.length && root) candidates.push({ layer: root, depth: 0 });
  return candidates;
}

function frameLayerId(frame, layers) {
  const byId = layerLookup(layers);
  if (frame?.rootLayerId && byId.has(frame.rootLayerId)) return frame.rootLayerId;
  const byFigma = new Map(asArray(layers?.nodes).map((layer) => [String(layer.figmaNodeId), layer.id]));
  if (frame?.figmaNodeId && byFigma.has(String(frame.figmaNodeId))) return byFigma.get(String(frame.figmaNodeId));
  if (frame?.nodeId && byFigma.has(String(frame.nodeId))) return byFigma.get(String(frame.nodeId));
  return undefined;
}

function ensureFrameRoutes(frames, layers, pixelSpec) {
  const byLayerId = layerLookup(layers);
  const byPixelId = pixelLookup(pixelSpec);
  const routed = [];
  const seenRoots = new Set();
  for (const frame of asArray(frames)) {
    const rootLayerId = frameLayerId(frame, layers) || asArray(layers?.rootNodeIds)[routed.length];
    if (!rootLayerId || !byLayerId.has(rootLayerId)) continue;
    const pixelNode = byPixelId.get(rootLayerId);
    const id = frame.id || `frame-${slugify(frame.name || rootLayerId)}`;
    routed.push({
      ...frame,
      id,
      rootLayerId,
      figmaNodeId: frame.figmaNodeId || byLayerId.get(rootLayerId)?.figmaNodeId,
      name: frame.name || byLayerId.get(rootLayerId)?.name || id,
      type: frame.type || byLayerId.get(rootLayerId)?.type,
      viewport: frame.viewport || (pixelNode?.bounds ? { width: pixelNode.bounds.width, height: pixelNode.bounds.height } : undefined)
    });
    seenRoots.add(rootLayerId);
  }
  for (const rootLayerId of asArray(layers?.rootNodeIds)) {
    if (!byLayerId.has(rootLayerId) || seenRoots.has(rootLayerId)) continue;
    const layer = byLayerId.get(rootLayerId);
    if (layer.role && layer.role !== "page") continue;
    const pixelNode = byPixelId.get(rootLayerId);
    const id = `frame-${slugify(layer.name || rootLayerId, slugify(rootLayerId))}`;
    routed.push({
      id,
      rootLayerId,
      figmaNodeId: layer.figmaNodeId,
      name: layer.name || id,
      type: layer.type,
      viewport: pixelNode?.bounds ? { width: pixelNode.bounds.width, height: pixelNode.bounds.height } : undefined
    });
  }
  return routed;
}

export function buildPageRegions({ frames, layers, pixelSpec, dynamicRegionNotes }) {
  const byLayerId = layerLookup(layers);
  const byPixelId = pixelLookup(pixelSpec);
  const routedFrames = ensureFrameRoutes(frames, layers, pixelSpec);
  const seenRegionIds = new Set();
  const pageRegions = [];
  const dynamicRegions = [];

  for (const frame of routedFrames) {
    const candidates = candidateRegionLayers(frame.rootLayerId, byLayerId, byPixelId);
    for (const candidate of candidates) {
      const layer = candidate.layer;
      if (!layer?.id || pageRegions.some((region) => region.layerRefs.includes(layer.id))) continue;
      const pixelNode = byPixelId.get(layer.id);
      const title = firstTitleForRegion(layer.id, byLayerId, byPixelId);
      const role = normalizeRole(pixelNode || layer, title);
      const confidence = regionConfidence(layer, pixelNode, title, candidate.depth);
      const regionId = makeRegionId(layer, seenRegionIds);
      const nodeIds = descendantLayerIds(layer.id, byLayerId).filter((id) => byPixelId.has(id));
      const region = {
        id: regionId,
        name: layer.name || pixelNode?.name || regionId,
        frameId: frame.id,
        role,
        semanticLabel: title || layer.name || pixelNode?.name || regionId,
        confidence,
        source: {
          type: candidate.depth === 0 ? "page-frame" : "visible-layer",
          depth: candidate.depth,
          figmaNodeIds: [layer.figmaNodeId].filter(Boolean),
          layerRefs: [layer.id]
        },
        layerRefs: [layer.id],
        nodeIds,
        pixelSpec: `normalized/pixel-spec/regions/${regionId}.json`
      };
      if (confidence < 0.7) region.notes = "Low-confidence region inferred from visible geometry; verify against the design intent.";
      pageRegions.push(region);
      if (role.startsWith("dynamic-") || ["realtime-data"].includes(role) || isDynamicCandidate(pixelNode)) {
        dynamicRegions.push({
          id: `${regionId}-dynamic`,
          pageRegionId: regionId,
          name: region.name,
          type: role.replace(/^dynamic-/, ""),
          nodeIds,
          rendering: "implementation-defined",
          pixelMatchRequired: false,
          notes: String(dynamicRegionNotes || "Dynamic rendering is implementation-defined for this Page Region.").trim()
        });
      }
    }
  }

  if (!pageRegions.length && routedFrames[0]) {
    const rootLayer = byLayerId.get(routedFrames[0].rootLayerId);
    if (rootLayer) {
      const regionId = makeRegionId(rootLayer, seenRegionIds);
      pageRegions.push({
        id: regionId,
        name: rootLayer.name || regionId,
        frameId: routedFrames[0].id,
        role: "content",
        semanticLabel: rootLayer.name || regionId,
        confidence: 0.5,
        source: { type: "page-frame-fallback", figmaNodeIds: [rootLayer.figmaNodeId].filter(Boolean), layerRefs: [rootLayer.id] },
        layerRefs: [rootLayer.id],
        nodeIds: descendantLayerIds(rootLayer.id, byLayerId).filter((id) => byPixelId.has(id)),
        pixelSpec: `normalized/pixel-spec/regions/${regionId}.json`,
        notes: "Fallback Page Region for a frame with no visible container children."
      });
    }
  }

  return { frames: routedFrames, pageRegions, dynamicRegions };
}

function filterStatesForNodes(states, nodeIdSet) {
  return asArray(states)
    .map((state) => ({ ...state, nodeIds: asArray(state.nodeIds).filter((nodeId) => nodeIdSet.has(nodeId)) }))
    .filter((state) => state.nodeIds.length > 0);
}

function collectAssetBindings(nodes) {
  return nodes
    .filter((node) => node.assetBinding)
    .map((node) => ({ ...node.assetBinding, nodeId: node.assetBinding.nodeId || node.id, figmaNodeId: node.assetBinding.figmaNodeId || node.figmaNodeId }));
}

export function buildPixelSpecPackage({ pixelSpec, layers, frames, pageRegions, dynamicRegions }) {
  const routedFrames = ensureFrameRoutes(frames, layers, pixelSpec);
  const byLayerId = layerLookup(layers);
  const byPixelId = pixelLookup(pixelSpec);
  const frameShards = [];
  const regionShards = [];

  for (const frame of routedFrames) {
    const nodeIds = descendantLayerIds(frame.rootLayerId, byLayerId).filter((id) => byPixelId.has(id));
    const nodeIdSet = new Set(nodeIds);
    const nodes = nodeIds.map((id) => byPixelId.get(id));
    const pathRel = `normalized/pixel-spec/frames/${frame.id}.json`;
    frameShards.push({
      path: pathRel,
      data: {
        schemaVersion: "2.0",
        kind: "pragma-pixel-spec-frame",
        id: `${pixelSpec.id}-${frame.id}`,
        frame: {
          id: frame.id,
          figmaNodeId: frame.figmaNodeId,
          name: frame.name,
          rootLayerId: frame.rootLayerId,
          screenshot: frame.screenshot
        },
        viewport: frame.viewport || pixelSpec.viewport,
        nodes,
        assetBindings: collectAssetBindings(nodes),
        availableStates: filterStatesForNodes(pixelSpec.states, nodeIdSet),
        dynamicRegions: asArray(dynamicRegions).filter((region) => asArray(region.nodeIds).some((nodeId) => nodeIdSet.has(nodeId)))
      }
    });
  }

  for (const region of asArray(pageRegions)) {
    const regionNodeIds = asArray(region.nodeIds).length
      ? asArray(region.nodeIds)
      : asArray(region.layerRefs).flatMap((layerRef) => descendantLayerIds(layerRef, byLayerId));
    const nodeIds = [...new Set(regionNodeIds)].filter((id) => byPixelId.has(id));
    const nodeIdSet = new Set(nodeIds);
    const nodes = nodeIds.map((id) => byPixelId.get(id));
    regionShards.push({
      path: region.pixelSpec || `normalized/pixel-spec/regions/${region.id}.json`,
      data: {
        schemaVersion: "2.0",
        kind: "pragma-pixel-spec-region",
        id: `${pixelSpec.id}-${region.id}`,
        region: {
          id: region.id,
          name: region.name,
          frameId: region.frameId,
          role: region.role,
          semanticLabel: region.semanticLabel,
          confidence: region.confidence,
          layerRefs: region.layerRefs
        },
        nodes,
        assetBindings: collectAssetBindings(nodes),
        availableStates: filterStatesForNodes(pixelSpec.states, nodeIdSet),
        dynamicRegions: asArray(dynamicRegions).filter((dynamicRegion) => dynamicRegion.pageRegionId === region.id)
      }
    });
  }

  const packagedNodeIds = new Set(frameShards.flatMap((shard) => shard.data.nodes.map((node) => node.id)));
  const index = {
    schemaVersion: "2.0",
    kind: "pragma-pixel-spec-index",
    id: pixelSpec.id,
    viewport: pixelSpec.viewport,
    frames: frameShards.map((shard) => ({
      id: shard.data.frame.id,
      figmaNodeId: shard.data.frame.figmaNodeId,
      name: shard.data.frame.name,
      rootLayerId: shard.data.frame.rootLayerId,
      path: shard.path,
      regionIds: pageRegions.filter((region) => region.frameId === shard.data.frame.id).map((region) => region.id),
      nodeCount: shard.data.nodes.length
    })),
    regions: regionShards.map((shard) => ({
      id: shard.data.region.id,
      frameId: shard.data.region.frameId,
      name: shard.data.region.name,
      role: shard.data.region.role,
      confidence: shard.data.region.confidence,
      path: shard.path,
      nodeCount: shard.data.nodes.length,
      hasTypography: shard.data.nodes.some((node) => node.text?.typography || node.text?.fontSize !== undefined)
    })),
    dynamicRegions: asArray(dynamicRegions),
    availableStates: filterStatesForNodes(pixelSpec.states, packagedNodeIds)
  };

  return {
    index,
    frameShards,
    regionShards,
    legacy: {
      ...pixelSpec,
      nodes: asArray(pixelSpec.nodes).filter((node) => packagedNodeIds.has(node.id)),
      states: filterStatesForNodes(pixelSpec.states, packagedNodeIds),
      dynamicRegions: asArray(dynamicRegions)
    }
  };
}

export function buildLayerTreePackage({ layers, frames, pixelSpec, pageRegions }) {
  const routedFrames = ensureFrameRoutes(frames, layers, pixelSpec);
  const byLayerId = layerLookup(layers);
  const regionByLayer = new Map();
  for (const region of asArray(pageRegions)) {
    for (const layerRef of asArray(region.layerRefs)) regionByLayer.set(layerRef, region.id);
  }
  const frameShards = [];
  for (const frame of routedFrames) {
    const nodeIds = descendantLayerIds(frame.rootLayerId, byLayerId).filter((id) => byLayerId.has(id));
    const nodes = nodeIds.map((id) => {
      const layer = { ...byLayerId.get(id) };
      layer.pixelRef = `normalized/pixel-spec/frames/${frame.id}.json#nodes/${layer.id}`;
      if (regionByLayer.has(layer.id)) layer.pageRegionId = regionByLayer.get(layer.id);
      return layer;
    });
    frameShards.push({
      path: `normalized/layers/frames/${frame.id}.tree.json`,
      data: {
        schemaVersion: "2.0",
        kind: "pragma-layer-tree-frame",
        id: `layers-${frame.id}`,
        frame: {
          id: frame.id,
          figmaNodeId: frame.figmaNodeId,
          name: frame.name,
          rootLayerId: frame.rootLayerId
        },
        rootNodeIds: [frame.rootLayerId],
        nodes
      }
    });
  }
  const packagedNodeIds = new Set(frameShards.flatMap((shard) => shard.data.nodes.map((node) => node.id)));
  const index = {
    schemaVersion: "2.0",
    kind: "pragma-layer-tree-index",
    rootNodeIds: routedFrames.map((frame) => frame.rootLayerId),
    frames: frameShards.map((shard) => ({
      id: shard.data.frame.id,
      figmaNodeId: shard.data.frame.figmaNodeId,
      name: shard.data.frame.name,
      rootLayerId: shard.data.frame.rootLayerId,
      path: shard.path,
      nodeCount: shard.data.nodes.length
    }))
  };
  return {
    index,
    frameShards,
    legacy: {
      ...layers,
      rootNodeIds: index.rootNodeIds,
      nodes: asArray(layers.nodes).filter((node) => packagedNodeIds.has(node.id))
    }
  };
}

export function buildAgentWorkflow() {
  return `# Agent Workflow\n\n` +
    `## Read Gate\n` +
    `In a normal automated development turn, use the Runner-supplied pragma-context-descriptor/v1 and its read-only entrypoints. Do not invoke Pragma CLI, download Registry artifacts, or follow a newer current.json. Stop before implementation until manifest.json, normalized/agent-context.md, this workflow, normalized/design-context.json, and the required pixel-spec shards for the target Page Regions have been read. Do not use broad full-package searches as the primary way to find typography or bounds.\n\n` +
    `## Typography\n` +
    `Read Page Regions from normalized/design-context.json, then open normalized/pixel-spec/index.json and only the region shards listed by the target regions. Typography facts live in region shard nodes[].text and must be preserved from resolvedValue even when tokenId is absent.\n\n` +
    `## Progressive Disclosure Rules\n` +
    `Start with manifest and the package map, choose the relevant Page Region, then read its pixel-spec region shard, layer tree frame shard, assets, tokens, and components only as needed. Fall back to source/figma-get-design-context.md only when normalized facts are insufficient.\n\n` +
    `## State Responsibility\n` +
    `Pragma can list Figma-native available states such as variants, visible or hidden state frames, and component properties. It does not choose the business runtime default state for an Issue; use the development Issue and acceptance criteria for that.\n\n` +
    `## Business Data Safety\n` +
    `Do not add fake runtime data, fallback records, forced selected/open states, or production-only bypasses just to match a screenshot. If visual parity needs sample data or a forced state, ask the user first and keep it preview/dev-only unless the Issue explicitly requires it.\n\n` +
    `## CSS Strategy\n` +
    `Prefer scoped styles, local component changes, design-token mapping, or component refactoring. Tail-of-file global overrides are only allowed as a short spike after explicit user approval and must be removed or localized before production work continues.\n`;
}

function figmaColorToCss(value) {
  if (!value || typeof value !== "object") return value;
  if (!["r", "g", "b"].every((key) => Number.isFinite(Number(value[key])))) return value;
  const channel = (key) => Math.max(0, Math.min(255, Math.round(Number(value[key]) * 255)));
  const alpha = value.a === undefined ? 1 : Number(value.a);
  if (!Number.isFinite(alpha) || alpha >= 1) {
    return `#${[channel("r"), channel("g"), channel("b")].map((item) => item.toString(16).padStart(2, "0")).join("")}`;
  }
  return `rgba(${channel("r")}, ${channel("g")}, ${channel("b")}, ${Math.max(0, Math.min(1, alpha))})`;
}

function firstModeValue(valuesByMode) {
  if (!valuesByMode || typeof valuesByMode !== "object") return undefined;
  const first = Object.values(valuesByMode)[0];
  return figmaColorToCss(first);
}

function tokenTypeFromVariable(variable) {
  const resolvedType = String(variable?.resolvedType || variable?.type || "").toUpperCase();
  const scopes = asArray(variable?.scopes).join(" ").toLowerCase();
  const name = String(variable?.name || "").toLowerCase();
  if (resolvedType === "COLOR" || scopes.includes("color")) return "color";
  if (name.includes("radius") || name.includes("radii")) return "radius";
  if (name.includes("shadow")) return "shadow";
  if (name.includes("font") || name.includes("typography")) return "typography";
  return "spacing";
}

function tokenTypeFromStyle(style) {
  const type = String(style?.type || style?.styleType || "").toUpperCase();
  if (type.includes("TEXT")) return "typography";
  if (type.includes("EFFECT")) return "shadow";
  if (type.includes("GRID")) return "layoutGrid";
  return "color";
}

function valueFromStyle(style, type) {
  if (style.value !== undefined) return style.value;
  if (type === "typography") return style.typeStyle || style.typography;
  if (type === "shadow") return style.effects || style.effect;
  if (type === "layoutGrid") return style.layoutGrids || style.layoutGrid;
  const paints = asArray(style.paints || style.paint);
  if (paints.length) {
    const first = paints[0];
    if (first?.color !== undefined) return figmaColorToCss(first.color);
    return first;
  }
  return undefined;
}

export function buildTokens(variablesSource) {
  const tokens = [];
  const ids = new Set();
  const pushToken = (token) => {
    if (!token?.id || ids.has(token.id)) return;
    ids.add(token.id);
    tokens.push(token);
  };
  const pushGroup = (group, type) => {
    if (!group || typeof group !== "object") return;
    for (const [name, value] of Object.entries(group)) {
      const source = value && typeof value === "object" ? value : { value };
      pushToken({
        id: `${type}-${slugify(name)}`,
        type,
        name,
        value: figmaColorToCss(source.value ?? source.color ?? source),
        source: source.id || source.variableId || source.styleId ? {
          provider: "figma",
          variableId: source.variableId || source.id,
          styleId: source.styleId,
          key: source.key,
          remote: source.remote
        } : undefined
      });
    }
  };
  pushGroup(variablesSource?.colors || variablesSource?.color, "color");
  pushGroup(variablesSource?.typography || variablesSource?.fonts, "typography");
  pushGroup(variablesSource?.spacing || variablesSource?.space, "spacing");
  pushGroup(variablesSource?.radius || variablesSource?.radii, "radius");
  pushGroup(variablesSource?.shadow || variablesSource?.shadows, "shadow");

  for (const variable of asArray(variablesSource?.variables || variablesSource?.localVariables)) {
    if (!variable || typeof variable !== "object") continue;
    const type = tokenTypeFromVariable(variable);
    const value = figmaColorToCss(variable.value ?? variable.resolvedValue ?? variable.color ?? firstModeValue(variable.valuesByMode));
    pushToken({
      id: `${type}-${slugify(variable.name || variable.key || variable.id)}`,
      type,
      name: variable.name || variable.key || variable.id,
      value,
      description: variable.description,
      scopes: asArray(variable.scopes),
      source: {
        provider: "figma",
        variableId: variable.id || variable.variableId,
        key: variable.key,
        collectionId: variable.variableCollectionId,
        remote: variable.remote === true
      }
    });
  }

  for (const style of asArray(variablesSource?.styles || variablesSource?.localStyles)) {
    if (!style || typeof style !== "object") continue;
    const type = tokenTypeFromStyle(style);
    pushToken({
      id: `${type}-${slugify(style.name || style.key || style.id)}`,
      type,
      name: style.name || style.key || style.id,
      value: valueFromStyle(style, type),
      description: style.description,
      documentationLinks: asArray(style.documentationLinks),
      source: {
        provider: "figma",
        styleId: style.id || style.styleId,
        key: style.key,
        remote: style.remote === true
      }
    });
  }
  return {
    schemaVersion: "2.0",
    kind: "pragma-design-tokens",
    tokens
  };
}

export function buildComponents(componentsSource, rawNodes = [], figmaToNormalized = new Map()) {
  const explicitSets = asArray(componentsSource?.componentSets);
  const listedComponents = asArray(componentsSource?.components);
  const sourceIsArray = Array.isArray(componentsSource);
  const rawComponentSets = sourceIsArray
    ? componentsSource
    : (explicitSets.length
      ? explicitSets
      : listedComponents.filter((component) => String(component?.type || "").toUpperCase() !== "COMPONENT"));
  const rawComponents = sourceIsArray
    ? []
    : [
      ...(explicitSets.length ? listedComponents : listedComponents.filter((component) => String(component?.type || "").toUpperCase() === "COMPONENT")),
      ...rawComponentSets.flatMap((componentSet) => asArray(componentSet?.components))
    ];

  const componentSets = rawComponentSets.filter((component) => component && typeof component === "object").map((component) => {
    const id = component.id || component.componentSetId || component.componentId || `component-set-${slugify(component.name || component.key || "component")}`;
    const variants = asArray(component.variants || component.variant || component.components).map((variant) => {
      if (typeof variant === "string") return { name: variant };
      return {
        ...variant,
        id: variant?.id || variant?.nodeId || variant?.figmaNodeId,
        name: variant?.name || variant?.id || variant?.nodeId || variant?.figmaNodeId
      };
    });
    return {
      id,
      name: component.name || id,
      type: component.type || "COMPONENT_SET",
      source: component.source || "capture",
      snapshotId: component.snapshotId,
      nodeId: component.nodeId || component.figmaNodeId,
      variants,
      componentIds: asArray(component.components).map((child) => child?.id || child?.nodeId || child?.figmaNodeId).filter(Boolean),
      states: asArray(component.states || component.availableStates),
      variantProperties: component.variantProperties,
      componentProperties: component.componentProperties,
      visualStateSources: asArray(component.visualStateSources),
      stateFrames: asArray(component.stateFrames),
      metadataCompleteness: component.metadataCompleteness,
      optional: component.optional === true,
      external: component.external === true
    };
  });
  const setIds = new Set(componentSets.map((component) => component.id));
  const components = [];
  const componentIds = new Set();
  for (const component of rawComponents.filter((candidate) => candidate && typeof candidate === "object")) {
    const id = component.id || component.componentId || component.nodeId || component.figmaNodeId || `component-${slugify(component.name || component.key || "component")}`;
    if (componentIds.has(id)) continue;
    componentIds.add(id);
    components.push({
      id,
      name: component.name || id,
      type: component.type || "COMPONENT",
      source: component.source || "capture",
      snapshotId: component.snapshotId,
      nodeId: component.nodeId || component.figmaNodeId,
      componentSetId: component.componentSetId,
      states: asArray(component.states || component.availableStates),
      variantProperties: component.variantProperties,
      componentProperties: component.componentProperties,
      componentPropertyDefinitions: component.componentPropertyDefinitions,
      optional: component.optional === true,
      external: component.external === true
    });
  }
  const instances = [];
  for (const [index, node] of rawNodes.entries()) {
    const componentRef = node.componentRef || (node.componentId ? { componentId: node.componentId, variant: node.variant } : undefined);
    const componentId = componentRef?.componentId || componentRef?.mainComponentNodeId || componentRef?.id;
    const componentSetId = componentRef?.componentSetId || node.componentSetId || (componentId && setIds.has(componentId) ? componentId : undefined);
    if (!componentId && !componentSetId) continue;
    const figmaNodeId = figmaIdForNode(node, index);
    const normalizedId = figmaToNormalized.get(figmaNodeId) || normalizeNodeId(node.normalizedNodeId || node.normalizedId || figmaNodeId, `component-instance-${index + 1}`);
    instances.push({
      nodeId: normalizedId,
      pixelNodeId: normalizedId,
      layerRef: normalizedId,
      figmaNodeId,
      name: node.name || componentRef.name || componentId || componentSetId,
      componentId,
      mainComponentNodeId: componentRef.mainComponentNodeId || componentRef.mainNodeId || componentRef.nodeId || componentId,
      componentSetId,
      variant: componentRef.variant && typeof componentRef.variant === "object" ? componentRef.variant : (componentRef.variant ? { name: componentRef.variant } : undefined),
      variantProperties: node.variantProperties || componentRef.variantProperties,
      componentProperties: node.componentProperties || componentRef.componentProperties,
      availableStates: normalizeAvailableStates(node),
      visible: node.visible,
      hidden: node.hidden === true,
      optional: componentRef.optional === true,
      external: componentRef.external === true,
      definitionSource: componentRef.definitionSource
    });
    if (componentSetId && !setIds.has(componentSetId)) {
      componentSets.push({
        id: componentSetId,
        name: componentRef.componentSetName || node.componentSetName || componentSetId,
        type: "COMPONENT_SET",
        source: "page-instance",
        variants: componentRef.variant ? [{ name: componentRef.variant }] : [],
        componentIds: componentId ? [componentId] : [],
        states: normalizeAvailableStates(node),
        optional: componentRef.optional === true,
        external: componentRef.external === true
      });
      setIds.add(componentSetId);
    }
    if (componentId && componentId !== componentSetId && !componentIds.has(componentId)) {
      components.push({
        id: componentId,
        name: componentRef.mainComponentName || componentRef.name || node.componentName || componentId,
        type: componentRef.mainComponentType || "COMPONENT",
        source: "page-instance",
        nodeId: componentRef.mainComponentNodeId || componentId,
        componentSetId,
        states: normalizeAvailableStates(node),
        variantProperties: node.variantProperties || componentRef.variantProperties,
        componentProperties: node.componentProperties || componentRef.componentProperties,
        optional: componentRef.optional === true,
        external: componentRef.external === true
      });
      componentIds.add(componentId);
    }
  }
  return {
    schemaVersion: "2.0",
    kind: "pragma-components",
    instances,
    components,
    componentSets,
    visualStateSources: asArray(componentsSource?.visualStateSources),
    stateFrames: asArray(componentsSource?.stateFrames),
    metadataCompleteness: componentsSource?.metadataCompleteness,
    codeConnect: asArray(componentsSource?.codeConnect)
  };
}

export function buildVisualBaseline(pixelSpec, screenshots) {
  const firstScreenshot = screenshots[0];
  return {
    schemaVersion: "2.0",
    kind: "pragma-visual-baseline",
    viewports: firstScreenshot ? [{
      id: `desktop-${pixelSpec.viewport.width || 0}`,
      width: pixelSpec.viewport.width || 0,
      height: pixelSpec.viewport.height || 0,
      deviceScale: pixelSpec.viewport.deviceScale || 1,
      baselineScreenshot: firstScreenshot,
      diffThreshold: {
        pixelRatio: 0.02,
        ignoreRegions: pixelSpec.dynamicRegions.filter((region) => region.pixelMatchRequired === false).map((region) => region.id),
        warnOnlyRegions: []
      }
    }] : [],
    strategy: "screenshot-diff-for-reference",
    humanReviewRequired: true
  };
}

export function buildRenderInstructions({ pixelSpec, assets, dynamicRegionNotes }) {
  const requiredAssetIds = assets.filter((asset) => asset.required !== false).map((asset) => asset.id);
  const dynamicLines = pixelSpec.dynamicRegions.length
    ? pixelSpec.dynamicRegions.map((region) => `- ${region.id}: ${region.rendering}; ${region.notes || "implementation-defined"}`).join("\n")
    : "- None declared.";
  const assetLines = requiredAssetIds.length ? requiredAssetIds.map((id) => `- ${id}`).join("\n") : "- None declared.";
  return `# Render Instructions\n\n` +
    `## Pixel Contract\n` +
    `- Use normalized/pixel-spec/index.json as the primary pixel implementation entrypoint, then read only the frame or Page Region shards needed for the task.\n` +
    `- Preserve bounds, z-index order, text styles, fills, strokes, radii, shadows, opacity, and asset bindings from the shard unless the target product design system requires a documented equivalent.\n\n` +
    `## Required Assets\n${assetLines}\n\n` +
    `## Dynamic / Non-pixel Regions\n${dynamicLines}\n\n` +
    `## Notes\n${String(dynamicRegionNotes || "No additional render notes.").trim()}\n`;
}

export function basenameWithoutExt(filePath) {
  return path.basename(filePath, path.extname(filePath));
}
