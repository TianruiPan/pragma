function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === void 0 || value === null) return [];
  return [value];
}
function numberOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}
function plain(value, depth = 0) {
  if (depth > 8) return void 0;
  if (value === null || value === void 0) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1)).filter((item) => item !== void 0);
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "function" || typeof item === "symbol") continue;
      const normalized = plain(item, depth + 1);
      if (normalized !== void 0) output[key] = normalized;
    }
    return output;
  }
  return void 0;
}
function boundsOf(node) {
  const raw = node.absoluteBoundingBox || node.bounds || node.rect || node;
  return {
    x: numberOr(raw.x, 0),
    y: numberOr(raw.y, 0),
    width: numberOr(raw.width ?? node.width, 0),
    height: numberOr(raw.height ?? node.height, 0)
  };
}
function paddingOf(node) {
  const hasPadding = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].some((key) => node[key] !== void 0);
  if (!hasPadding) return void 0;
  return {
    top: numberOr(node.paddingTop, 0),
    right: numberOr(node.paddingRight, 0),
    bottom: numberOr(node.paddingBottom, 0),
    left: numberOr(node.paddingLeft, 0)
  };
}
function componentRefFromNode(node, mainComponent) {
  if (node.type !== "INSTANCE" && !mainComponent && !node.componentRef) return null;
  const componentProperties = plain(node.componentProperties);
  return {
    componentId: String(mainComponent?.id || node.componentId || node.mainComponentId || "") || void 0,
    mainComponentNodeId: String(mainComponent?.id || node.mainComponentId || "") || void 0,
    mainComponentName: String(mainComponent?.name || node.mainComponentName || "") || void 0,
    componentSetId: String(mainComponent?.parent?.id || node.componentSetId || "") || void 0,
    variant: componentProperties || plain(node.variantProperties),
    componentProperties
  };
}
function serializeLayerNode(input, options = {}) {
  const children = asArray(input.children).map((child, index) => serializeLayerNode(child, { zIndex: index }));
  const fills = asArray(input.fills).map((fill) => plain(fill)).filter(Boolean);
  const imageFillRefs = fills.filter((fill) => Boolean(fill && typeof fill === "object" && fill.type === "IMAGE" && fill.imageHash)).map((fill) => ({
    imageHash: String(fill.imageHash),
    scaleMode: fill.scaleMode ? String(fill.scaleMode) : void 0,
    filters: fill.filters
  }));
  const text = input.type === "TEXT" ? {
    content: String(input.characters ?? ""),
    fontFamily: typeof input.fontName === "object" ? input.fontName.family : input.fontFamily,
    fontStyle: typeof input.fontName === "object" ? input.fontName.style : void 0,
    fontSize: input.fontSize,
    fontWeight: input.fontWeight,
    lineHeight: plain(input.lineHeight),
    letterSpacing: plain(input.letterSpacing),
    alignHorizontal: input.textAlignHorizontal,
    alignVertical: input.textAlignVertical
  } : null;
  return {
    nodeId: String(input.id || "unknown-node"),
    figmaNodeId: String(input.id || "unknown-node"),
    name: String(input.name || input.id || "Unnamed"),
    type: String(input.type || "UNKNOWN"),
    role: options.role,
    bounds: boundsOf(input),
    zIndex: options.zIndex ?? 0,
    visible: input.visible === void 0 ? true : Boolean(input.visible),
    locked: Boolean(input.locked),
    layoutMode: input.layoutMode ? String(input.layoutMode) : void 0,
    constraints: plain(input.constraints),
    padding: paddingOf(input),
    gap: input.itemSpacing === void 0 ? void 0 : numberOr(input.itemSpacing, 0),
    fills,
    strokes: asArray(input.strokes).map((stroke) => plain(stroke)).filter(Boolean),
    strokeWeight: plain(input.strokeWeight),
    cornerRadius: plain(input.cornerRadius ?? input.rectangleCornerRadii),
    effects: asArray(input.effects).map((effect) => plain(effect)).filter(Boolean),
    opacity: input.opacity === void 0 ? 1 : numberOr(input.opacity, 1),
    blendMode: input.blendMode ? String(input.blendMode) : "NORMAL",
    text,
    componentRef: componentRefFromNode(input, options.mainComponent),
    imageFillRefs,
    boundVariables: plain(input.boundVariables),
    children
  };
}
function serializeLayerTree(roots) {
  return {
    schemaVersion: "2.0",
    kind: "pragma-layer-tree",
    rootNodeIds: roots.map((root) => String(root.id)),
    nodes: roots.map((root, index) => serializeLayerNode(root, { zIndex: index, role: root.role }))
  };
}
function flattenSerializedLayers(nodes) {
  const output = [];
  const walk = (node) => {
    output.push(node);
    for (const child of node.children || []) walk(child);
  };
  for (const node of nodes) walk(node);
  return output;
}
function collectComponentInstances(nodes) {
  return flattenSerializedLayers(nodes).filter((node) => node.type === "INSTANCE" || node.componentRef).map((node) => ({
    nodeId: node.nodeId,
    figmaNodeId: node.figmaNodeId,
    name: node.name,
    mainComponentNodeId: node.componentRef?.mainComponentNodeId || node.componentRef?.componentId,
    componentSetId: node.componentRef?.componentSetId,
    variant: node.componentRef?.variant || {},
    bounds: node.bounds
  }));
}
export {
  boundsOf,
  collectComponentInstances,
  componentRefFromNode,
  flattenSerializedLayers,
  paddingOf,
  serializeLayerNode,
  serializeLayerTree
};
