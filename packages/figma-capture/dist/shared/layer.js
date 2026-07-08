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
function plainRecord(value) {
  const normalized = plain(value);
  return normalized && typeof normalized === "object" && !Array.isArray(normalized) ? normalized : void 0;
}
function stringOrUndefined(value) {
  const text = String(value || "");
  return text ? text : void 0;
}
function visibleOf(node) {
  return node.visible === void 0 ? true : Boolean(node.visible);
}
function colorByte(value) {
  return Math.max(0, Math.min(255, Math.round(numberOr(value, 0) * 255)));
}
function colorHex(color) {
  return `#${["r", "g", "b"].map((key) => colorByte(color[key]).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
function firstSolidTextColor(fills) {
  const paint = fills.find((fill) => Boolean(fill && typeof fill === "object" && fill.type === "SOLID"));
  const color = paint?.color;
  if (!color || typeof color !== "object") return void 0;
  return {
    resolvedValue: colorHex(color),
    opacity: paint.opacity === void 0 ? 1 : numberOr(paint.opacity, 1),
    paint: plain(paint)
  };
}
function valueFromComponentProperty(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value;
    return {
      value: record.value ?? record.defaultValue ?? record.variantValue ?? value,
      type: record.type,
      preferredValues: record.preferredValues ?? record.variantOptions ?? record.options
    };
  }
  return { value };
}
function availableStatesFromProperties(input) {
  const states = [];
  const variantProperties = plainRecord(input.variantProperties);
  if (variantProperties) {
    for (const [name, value] of Object.entries(variantProperties)) {
      states.push({ name, value, source: "figma-variant-property" });
    }
  }
  const componentProperties = plainRecord(input.componentProperties);
  if (componentProperties) {
    for (const [name, rawValue] of Object.entries(componentProperties)) {
      const parsed = valueFromComponentProperty(rawValue);
      states.push({
        name,
        value: plain(parsed.value),
        type: parsed.type,
        preferredValues: plain(parsed.preferredValues),
        source: "figma-component-property"
      });
    }
  }
  const componentPropertyDefinitions = plainRecord(input.componentPropertyDefinitions);
  if (componentPropertyDefinitions) {
    for (const [name, rawValue] of Object.entries(componentPropertyDefinitions)) {
      const parsed = valueFromComponentProperty(rawValue);
      const record = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? rawValue : {};
      states.push({
        name,
        value: plain(parsed.value),
        type: parsed.type,
        preferredValues: plain(parsed.preferredValues ?? record.options ?? record.variantOptions),
        source: "figma-component-property-definition"
      });
    }
  }
  if (input.visible === false) {
    states.push({ name: "visibility", value: "hidden", source: "figma-node-visibility" });
  }
  return states.filter((state) => state.value !== void 0);
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
  const componentProperties = plainRecord(node.componentProperties);
  const variantProperties = plainRecord(node.variantProperties);
  const componentSet = mainComponent?.parent || node.componentSet;
  return {
    source: "figma",
    instanceNodeId: node.type === "INSTANCE" ? stringOrUndefined(node.id) : void 0,
    componentId: stringOrUndefined(mainComponent?.id || node.componentId || node.mainComponentId),
    mainComponentNodeId: stringOrUndefined(mainComponent?.id || node.mainComponentId),
    mainComponentKey: stringOrUndefined(mainComponent?.key || node.mainComponentKey),
    mainComponentName: stringOrUndefined(mainComponent?.name || node.mainComponentName),
    mainComponentType: stringOrUndefined(mainComponent?.type || node.mainComponentType),
    componentSetId: stringOrUndefined(componentSet?.id || node.componentSetId),
    componentSetName: stringOrUndefined(componentSet?.name || node.componentSetName),
    variantProperties,
    componentProperties,
    variant: variantProperties || componentProperties || void 0,
    availableStates: availableStatesFromProperties({ variantProperties, componentProperties, visible: visibleOf(node) })
  };
}
function compactRecord(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== void 0));
}
function serializeLayerNode(input, options = {}) {
  const children = asArray(input.children).map((child, index) => serializeLayerNode(child, { zIndex: index, parentNodeId: String(input.id || "") || void 0 }));
  const fills = asArray(input.fills).map((fill) => plain(fill)).filter(Boolean);
  const imageFillRefs = fills.filter((fill) => Boolean(fill && typeof fill === "object" && fill.type === "IMAGE" && fill.imageHash)).map((fill) => ({
    imageHash: String(fill.imageHash),
    scaleMode: fill.scaleMode ? String(fill.scaleMode) : void 0,
    filters: fill.filters
  }));
  const visible = visibleOf(input);
  const componentProperties = plainRecord(input.componentProperties);
  const variantProperties = plainRecord(input.variantProperties);
  const componentPropertyDefinitions = plainRecord(input.componentPropertyDefinitions);
  const availableStates = availableStatesFromProperties({ variantProperties, componentProperties, componentPropertyDefinitions, visible });
  const bounds = boundsOf(input);
  const layout = {
    layoutMode: input.layoutMode ? String(input.layoutMode) : void 0,
    primaryAxisSizingMode: input.primaryAxisSizingMode,
    counterAxisSizingMode: input.counterAxisSizingMode,
    primaryAxisAlignItems: input.primaryAxisAlignItems,
    counterAxisAlignItems: input.counterAxisAlignItems,
    layoutWrap: input.layoutWrap,
    layoutGrow: input.layoutGrow,
    layoutAlign: input.layoutAlign,
    layoutPositioning: input.layoutPositioning,
    layoutSizingHorizontal: input.layoutSizingHorizontal,
    layoutSizingVertical: input.layoutSizingVertical,
    itemReverseZIndex: input.itemReverseZIndex,
    strokesIncludedInLayout: input.strokesIncludedInLayout,
    clipsContent: input.clipsContent,
    overflowDirection: input.overflowDirection,
    minWidth: input.minWidth,
    maxWidth: input.maxWidth,
    minHeight: input.minHeight,
    maxHeight: input.maxHeight
  };
  const text = input.type === "TEXT" ? {
    content: String(input.characters ?? ""),
    fontName: plain(input.fontName),
    fontFamily: typeof input.fontName === "object" ? input.fontName.family : input.fontFamily,
    fontStyle: typeof input.fontName === "object" ? input.fontName.style : void 0,
    fontSize: input.fontSize,
    fontWeight: input.fontWeight,
    lineHeight: plain(input.lineHeight),
    letterSpacing: plain(input.letterSpacing),
    alignHorizontal: input.textAlignHorizontal,
    alignVertical: input.textAlignVertical,
    color: firstSolidTextColor(fills),
    textStyleId: input.textStyleId
  } : null;
  const styleIds = compactRecord({
    fillStyleId: input.fillStyleId,
    strokeStyleId: input.strokeStyleId,
    textStyleId: input.textStyleId,
    effectStyleId: input.effectStyleId,
    gridStyleId: input.gridStyleId
  });
  const boundVariables = plain(input.boundVariables);
  const explicitVariableModes = plain(input.explicitVariableModes);
  const resolvedVariableModes = plain(input.resolvedVariableModes);
  return {
    nodeId: String(input.id || "unknown-node"),
    figmaNodeId: String(input.id || "unknown-node"),
    parentNodeId: options.parentNodeId || stringOrUndefined(input.parentId),
    name: String(input.name || input.id || "Unnamed"),
    type: String(input.type || "UNKNOWN"),
    key: stringOrUndefined(input.key),
    description: stringOrUndefined(input.description),
    role: options.role,
    bounds,
    size: { width: numberOr(input.width, bounds.width), height: numberOr(input.height, bounds.height) },
    zIndex: options.zIndex ?? 0,
    sourceOrder: options.zIndex ?? 0,
    visible,
    hidden: !visible,
    locked: Boolean(input.locked),
    relativeTransform: plain(input.relativeTransform),
    layoutMode: input.layoutMode ? String(input.layoutMode) : void 0,
    constraints: plain(input.constraints),
    padding: paddingOf(input),
    gap: input.itemSpacing === void 0 ? void 0 : numberOr(input.itemSpacing, 0),
    layout: Object.fromEntries(Object.entries(layout).filter(([, value]) => value !== void 0)),
    fills,
    strokes: asArray(input.strokes).map((stroke) => plain(stroke)).filter(Boolean),
    strokeWeight: plain(input.strokeWeight),
    cornerRadius: plain(input.cornerRadius ?? input.rectangleCornerRadii),
    effects: asArray(input.effects).map((effect) => plain(effect)).filter(Boolean),
    opacity: input.opacity === void 0 ? 1 : numberOr(input.opacity, 1),
    blendMode: input.blendMode ? String(input.blendMode) : "NORMAL",
    text,
    componentRef: componentRefFromNode(input, options.mainComponent),
    componentProperties,
    variantProperties,
    componentPropertyDefinitions,
    availableStates,
    imageFillRefs,
    boundVariables,
    explicitVariableModes,
    resolvedVariableModes,
    styleIds,
    tokenRefs: compactRecord({
      styleIds,
      boundVariables,
      explicitVariableModes,
      resolvedVariableModes,
      textStyleId: input.textStyleId,
      fillStyleId: input.fillStyleId,
      strokeStyleId: input.strokeStyleId,
      effectStyleId: input.effectStyleId
    }),
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
    type: node.type,
    role: node.role,
    visible: node.visible,
    hidden: node.hidden,
    locked: node.locked,
    mainComponentNodeId: node.componentRef?.mainComponentNodeId || node.componentRef?.componentId,
    mainComponentName: node.componentRef?.mainComponentName,
    componentSetId: node.componentRef?.componentSetId,
    componentSetName: node.componentRef?.componentSetName,
    componentRef: node.componentRef,
    variantProperties: node.variantProperties || node.componentRef?.variantProperties || {},
    componentProperties: node.componentProperties || node.componentRef?.componentProperties || {},
    availableStates: node.availableStates || node.componentRef?.availableStates || [],
    variant: node.componentRef?.variant || {},
    bounds: node.bounds
  }));
}
function collectVisualStateSources(nodes) {
  return flattenSerializedLayers(nodes).filter((node) => ["FRAME", "SECTION", "COMPONENT_SET", "COMPONENT", "INSTANCE"].includes(node.type)).filter((node) => node.type !== "INSTANCE" || node.hidden || node.availableStates && node.availableStates.length > 0).map((node) => ({
    nodeId: node.nodeId,
    figmaNodeId: node.figmaNodeId,
    parentNodeId: node.parentNodeId,
    name: node.name,
    type: node.type,
    role: node.role,
    source: "figma-native-node",
    sourceKind: node.type === "COMPONENT" ? "component-variant-node" : node.type === "COMPONENT_SET" ? "component-set" : node.type === "INSTANCE" ? "component-instance" : "state-capable-frame",
    bounds: node.bounds,
    size: node.size,
    sourceOrder: node.sourceOrder,
    visible: node.visible,
    hidden: node.hidden,
    componentRef: node.componentRef,
    componentProperties: node.componentProperties || {},
    variantProperties: node.variantProperties || {},
    availableStates: node.availableStates || []
  }));
}
export {
  availableStatesFromProperties,
  boundsOf,
  collectComponentInstances,
  collectVisualStateSources,
  componentRefFromNode,
  flattenSerializedLayers,
  paddingOf,
  plain,
  serializeLayerNode,
  serializeLayerTree
};
