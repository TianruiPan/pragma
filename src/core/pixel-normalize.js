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
    const figmaNodeId = node.figmaNodeId || node.nodeId || node.id || `generated:${index}`;
    const normalizedId = normalizeNodeId(node.normalizedNodeId || node.normalizedId || figmaNodeId, `node-${index + 1}`);
    figmaToNormalized.set(String(figmaNodeId), normalizedId);
    normalizedToFigma.set(normalizedId, String(figmaNodeId));
  });

  const layers = fallbackNodes.map((node, index) => {
    const figmaNodeId = String(node.figmaNodeId || node.nodeId || node.id || `generated:${index}`);
    const childRefs = asArray(node.children).map((child) => {
      if (typeof child === "string") return child;
      return String(child.figmaNodeId || child.nodeId || child.id || "");
    }).filter(Boolean);
    return {
      figmaNodeId,
      normalizedNodeId: figmaToNormalized.get(figmaNodeId),
      name: node.name || figmaNodeId,
      type: node.type || "FRAME",
      bounds: normalizeBounds(node),
      componentRef: node.componentRef || (node.componentId ? { componentId: node.componentId } : null),
      children: childRefs
    };
  });

  const explicitRoots = asArray(layerSource?.rootNodeIds).map(String);
  const allChildren = new Set(layers.flatMap((node) => node.children || []));
  const roots = explicitRoots.length ? explicitRoots : layers.map((node) => node.figmaNodeId).filter((id) => !allChildren.has(id));

  return {
    layers: {
      schemaVersion: "2.0",
      kind: "pragma-layer-tree",
      rootNodeIds: roots.length ? roots : layers.slice(0, 1).map((node) => node.figmaNodeId),
      nodes: layers
    },
    rawNodes: fallbackNodes,
    figmaToNormalized,
    normalizedToFigma
  };
}

function normalizeBinding(binding, figmaToNormalized) {
  const figmaNodeId = binding.figmaNodeId || binding.sourceNodeId;
  const nodeId = binding.nodeId || (figmaNodeId ? figmaToNormalized.get(String(figmaNodeId)) : undefined);
  return {
    nodeId,
    figmaNodeId,
    assetId: binding.assetId,
    fit: binding.fit || "contain",
    crop: binding.crop ?? null,
    placement: binding.placement || binding.bounds || undefined
  };
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

export function buildPixelSpec({ contextId, rawNodes, layers, figmaToNormalized, assetBindings, dynamicRegionNotes }) {
  const pixelNodes = rawNodes.map((node, index) => {
    const figmaNodeId = String(node.figmaNodeId || node.nodeId || node.id || `generated:${index}`);
    const normalizedId = figmaToNormalized.get(figmaNodeId) || normalizeNodeId(figmaNodeId, `node-${index + 1}`);
    const childRefs = asArray(node.children).map((child) => {
      const childFigmaId = typeof child === "string" ? child : String(child.figmaNodeId || child.nodeId || child.id || "");
      return figmaToNormalized.get(childFigmaId);
    }).filter(Boolean);
    const pixelNode = {
      id: normalizedId,
      figmaNodeId,
      name: node.name || figmaNodeId,
      type: normalizeNodeType(node.type),
      zIndex: Number.isFinite(Number(node.zIndex)) ? Number(node.zIndex) : index,
      bounds: normalizeBounds(node),
      layout: normalizeLayout(node),
      fills: asArray(node.fills || node.fill).filter(Boolean),
      strokes: asArray(node.strokes || node.stroke).filter(Boolean),
      radius: normalizeRadius(node),
      shadow: asArray(node.shadow || node.shadows || node.effects).filter(Boolean),
      opacity: node.opacity ?? 1,
      blendMode: node.blendMode || "normal",
      text: normalizeText(node),
      assetBinding: null,
      componentRef: node.componentRef || (node.componentId ? { componentId: node.componentId, variant: node.variant } : null),
      state: node.state || "default",
      children: childRefs
    };
    pixelNode.assetBinding = bindingForNode(assetBindings, pixelNode);
    return pixelNode;
  });

  const rootLayer = layers.nodes.find((node) => layers.rootNodeIds.includes(node.figmaNodeId)) || layers.nodes[0];
  const viewportBounds = rootLayer?.bounds || pixelNodes[0]?.bounds || { width: 0, height: 0 };
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
    assetBindings,
    states: [
      { name: "default", nodeIds: pixelNodes.filter((node) => node.state === "default").map((node) => node.id) },
      { name: "loading", nodeIds: pixelNodes.filter((node) => node.state === "loading").map((node) => node.id) },
      { name: "error", nodeIds: pixelNodes.filter((node) => node.state === "error").map((node) => node.id) },
      { name: "empty", nodeIds: pixelNodes.filter((node) => node.state === "empty").map((node) => node.id) },
      { name: "disabled", nodeIds: pixelNodes.filter((node) => node.state === "disabled").map((node) => node.id) }
    ],
    dynamicRegions
  };
}

export function buildTokens(variablesSource) {
  const tokens = [];
  const pushGroup = (group, type) => {
    if (!group || typeof group !== "object") return;
    for (const [name, value] of Object.entries(group)) {
      const source = value && typeof value === "object" ? value : { value };
      tokens.push({
        id: `${type}-${slugify(name)}`,
        type,
        name,
        value: source.value ?? source.color ?? source,
        source: source.id || source.variableId || source.styleId ? {
          provider: "figma",
          variableId: source.variableId || source.id,
          styleId: source.styleId
        } : undefined
      });
    }
  };
  pushGroup(variablesSource?.colors || variablesSource?.color, "color");
  pushGroup(variablesSource?.typography || variablesSource?.fonts, "typography");
  pushGroup(variablesSource?.spacing || variablesSource?.space, "spacing");
  pushGroup(variablesSource?.radius || variablesSource?.radii, "radius");
  pushGroup(variablesSource?.shadow || variablesSource?.shadows, "shadow");
  return {
    schemaVersion: "2.0",
    kind: "pragma-design-tokens",
    tokens
  };
}

export function buildComponents(componentsSource, rawNodes = []) {
  const rawComponentSets = asArray(componentsSource?.componentSets || componentsSource?.components || componentsSource);
  const componentSets = rawComponentSets.filter((component) => component && typeof component === "object").map((component) => {
    const id = component.id || component.componentSetId || component.componentId || `component-${slugify(component.name || component.key || "component")}`;
    return {
      id,
      name: component.name || id,
      source: component.source || "capture",
      snapshotId: component.snapshotId,
      nodeId: component.nodeId || component.figmaNodeId,
      variants: asArray(component.variants || component.variant).map((variant) => {
        if (typeof variant === "string") return { name: variant };
        return variant;
      }),
      states: asArray(component.states),
      optional: component.optional === true,
      external: component.external === true
    };
  });
  const setIds = new Set(componentSets.map((component) => component.id));
  const instances = [];
  for (const [index, node] of rawNodes.entries()) {
    const componentRef = node.componentRef || (node.componentId ? { componentId: node.componentId, variant: node.variant } : undefined);
    const componentId = componentRef?.componentId || componentRef?.id || componentRef?.componentSetId;
    if (!componentId) continue;
    const figmaNodeId = String(node.figmaNodeId || node.nodeId || node.id || `generated:${index}`);
    instances.push({
      nodeId: normalizeNodeId(node.normalizedNodeId || node.normalizedId || figmaNodeId, `component-instance-${index + 1}`),
      figmaNodeId,
      name: node.name || componentRef.name || componentId,
      mainComponentNodeId: componentRef.mainComponentNodeId || componentRef.mainNodeId || componentRef.nodeId,
      componentSetId: componentId,
      variant: componentRef.variant && typeof componentRef.variant === "object" ? componentRef.variant : (componentRef.variant ? { name: componentRef.variant } : undefined),
      bounds: normalizeBounds(node),
      optional: componentRef.optional === true,
      external: componentRef.external === true,
      definitionSource: componentRef.definitionSource
    });
    if (!setIds.has(componentId)) {
      componentSets.push({
        id: componentId,
        name: componentRef.name || node.componentName || componentId,
        source: "page-instance",
        variants: componentRef.variant ? [{ name: componentRef.variant }] : [],
        states: node.state ? [node.state] : [],
        optional: componentRef.optional === true,
        external: componentRef.external === true
      });
      setIds.add(componentId);
    }
  }
  return {
    schemaVersion: "2.0",
    kind: "pragma-components",
    instances,
    componentSets,
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
    `- Use normalized/pixel-spec.json as the primary pixel implementation contract.\n` +
    `- Preserve bounds, z-index order, text styles, fills, strokes, radii, shadows, opacity, and asset bindings unless the target product design system requires a documented equivalent.\n\n` +
    `## Required Assets\n${assetLines}\n\n` +
    `## Dynamic / Non-pixel Regions\n${dynamicLines}\n\n` +
    `## Notes\n${String(dynamicRegionNotes || "No additional render notes.").trim()}\n`;
}

export function basenameWithoutExt(filePath) {
  return path.basename(filePath, path.extname(filePath));
}
