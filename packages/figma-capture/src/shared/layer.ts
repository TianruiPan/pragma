import type { RectLike } from "./types.js";

function asArray<T>(value: T[] | T | undefined | null): T[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function numberOr(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function plain(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1)).filter((item) => item !== undefined);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === "function" || typeof item === "symbol") continue;
      const normalized = plain(item, depth + 1);
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  }
  return undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  const normalized = plain(value);
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = String(value || "");
  return text ? text : undefined;
}

function visibleOf(node: Record<string, unknown>): boolean {
  return node.visible === undefined ? true : Boolean(node.visible);
}

function colorByte(value: unknown): number {
  return Math.max(0, Math.min(255, Math.round(numberOr(value, 0) * 255)));
}

function colorHex(color: Record<string, unknown>): string {
  return `#${["r", "g", "b"].map((key) => colorByte(color[key]).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function firstSolidTextColor(fills: unknown[]): Record<string, unknown> | undefined {
  const paint = fills.find((fill): fill is Record<string, unknown> => Boolean(fill && typeof fill === "object" && (fill as Record<string, unknown>).type === "SOLID"));
  const color = paint?.color;
  if (!color || typeof color !== "object") return undefined;
  return {
    resolvedValue: colorHex(color as Record<string, unknown>),
    opacity: paint.opacity === undefined ? 1 : numberOr(paint.opacity, 1),
    paint: plain(paint)
  };
}

function valueFromComponentProperty(value: unknown): { value: unknown; type?: unknown; preferredValues?: unknown } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      value: record.value ?? record.defaultValue ?? record.variantValue ?? value,
      type: record.type,
      preferredValues: record.preferredValues ?? record.variantOptions ?? record.options
    };
  }
  return { value };
}

export function availableStatesFromProperties(input: {
  variantProperties?: unknown;
  componentProperties?: unknown;
  componentPropertyDefinitions?: unknown;
  visible?: boolean;
}) {
  const states: Array<Record<string, unknown>> = [];
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
      const record = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? rawValue as Record<string, unknown> : {};
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
  return states.filter((state) => state.value !== undefined);
}

export function boundsOf(node: Record<string, unknown>): RectLike {
  const raw = (node.absoluteBoundingBox || node.bounds || node.rect || node) as Record<string, unknown>;
  return {
    x: numberOr(raw.x, 0),
    y: numberOr(raw.y, 0),
    width: numberOr(raw.width ?? node.width, 0),
    height: numberOr(raw.height ?? node.height, 0)
  };
}

export function paddingOf(node: Record<string, unknown>) {
  const hasPadding = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].some((key) => node[key] !== undefined);
  if (!hasPadding) return undefined;
  return {
    top: numberOr(node.paddingTop, 0),
    right: numberOr(node.paddingRight, 0),
    bottom: numberOr(node.paddingBottom, 0),
    left: numberOr(node.paddingLeft, 0)
  };
}

export function componentRefFromNode(node: Record<string, unknown>, mainComponent?: Record<string, unknown> | null) {
  if (node.type !== "INSTANCE" && !mainComponent && !node.componentRef) return null;
  const componentProperties = plainRecord(node.componentProperties);
  const variantProperties = plainRecord(node.variantProperties);
  const componentSet = (mainComponent?.parent || node.componentSet) as Record<string, unknown> | undefined;
  return {
    source: "figma",
    instanceNodeId: node.type === "INSTANCE" ? stringOrUndefined(node.id) : undefined,
    componentId: stringOrUndefined(mainComponent?.id || node.componentId || node.mainComponentId),
    mainComponentNodeId: stringOrUndefined(mainComponent?.id || node.mainComponentId),
    mainComponentKey: stringOrUndefined(mainComponent?.key || node.mainComponentKey),
    mainComponentName: stringOrUndefined(mainComponent?.name || node.mainComponentName),
    mainComponentType: stringOrUndefined(mainComponent?.type || node.mainComponentType),
    componentSetId: stringOrUndefined(componentSet?.id || node.componentSetId),
    componentSetName: stringOrUndefined(componentSet?.name || node.componentSetName),
    variantProperties,
    componentProperties,
    variant: variantProperties || componentProperties || undefined,
    availableStates: availableStatesFromProperties({ variantProperties, componentProperties, visible: visibleOf(node) })
  };
}

export interface SerializedLayerNode {
  nodeId: string;
  figmaNodeId: string;
  parentNodeId?: string;
  name: string;
  type: string;
  key?: string;
  description?: string;
  role?: string;
  bounds: RectLike;
  size: { width: number; height: number };
  zIndex: number;
  sourceOrder: number;
  visible?: boolean;
  hidden?: boolean;
  locked?: boolean;
  relativeTransform?: unknown;
  layoutMode?: string;
  constraints?: unknown;
  padding?: ReturnType<typeof paddingOf>;
  gap?: number;
  layout?: Record<string, unknown>;
  fills?: unknown[];
  strokes?: unknown[];
  strokeWeight?: unknown;
  cornerRadius?: unknown;
  effects?: unknown[];
  opacity?: number;
  blendMode?: string;
  text?: Record<string, unknown> | null;
  componentRef?: ReturnType<typeof componentRefFromNode>;
  componentProperties?: Record<string, unknown>;
  variantProperties?: Record<string, unknown>;
  componentPropertyDefinitions?: Record<string, unknown>;
  availableStates?: Array<Record<string, unknown>>;
  imageFillRefs?: Array<{ imageHash: string; scaleMode?: string; filters?: unknown }>; 
  boundVariables?: unknown;
  explicitVariableModes?: unknown;
  resolvedVariableModes?: unknown;
  styleIds?: Record<string, unknown>;
  tokenRefs?: Record<string, unknown>;
  children: SerializedLayerNode[];
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function serializeLayerNode(
  input: Record<string, unknown>,
  options: { zIndex?: number; role?: string; mainComponent?: Record<string, unknown> | null; parentNodeId?: string } = {}
): SerializedLayerNode {
  const children = asArray(input.children as Array<Record<string, unknown>>).map((child, index) => serializeLayerNode(child, { zIndex: index, parentNodeId: String(input.id || "") || undefined }));
  const fills = asArray(input.fills as unknown[]).map((fill) => plain(fill)).filter(Boolean);
  const imageFillRefs = fills
    .filter((fill): fill is Record<string, unknown> => Boolean(fill && typeof fill === "object" && (fill as Record<string, unknown>).type === "IMAGE" && (fill as Record<string, unknown>).imageHash))
    .map((fill) => ({
      imageHash: String(fill.imageHash),
      scaleMode: fill.scaleMode ? String(fill.scaleMode) : undefined,
      filters: fill.filters
    }));
  const visible = visibleOf(input);
  const componentProperties = plainRecord(input.componentProperties);
  const variantProperties = plainRecord(input.variantProperties);
  const componentPropertyDefinitions = plainRecord(input.componentPropertyDefinitions);
  const availableStates = availableStatesFromProperties({ variantProperties, componentProperties, componentPropertyDefinitions, visible });
  const bounds = boundsOf(input);
  const layout = {
    layoutMode: input.layoutMode ? String(input.layoutMode) : undefined,
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
    fontFamily: typeof input.fontName === "object" ? (input.fontName as Record<string, unknown>).family : input.fontFamily,
    fontStyle: typeof input.fontName === "object" ? (input.fontName as Record<string, unknown>).style : undefined,
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
    layoutMode: input.layoutMode ? String(input.layoutMode) : undefined,
    constraints: plain(input.constraints),
    padding: paddingOf(input),
    gap: input.itemSpacing === undefined ? undefined : numberOr(input.itemSpacing, 0),
    layout: Object.fromEntries(Object.entries(layout).filter(([, value]) => value !== undefined)),
    fills,
    strokes: asArray(input.strokes as unknown[]).map((stroke) => plain(stroke)).filter(Boolean),
    strokeWeight: plain(input.strokeWeight),
    cornerRadius: plain(input.cornerRadius ?? input.rectangleCornerRadii),
    effects: asArray(input.effects as unknown[]).map((effect) => plain(effect)).filter(Boolean),
    opacity: input.opacity === undefined ? 1 : numberOr(input.opacity, 1),
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

export function serializeLayerTree(roots: Array<Record<string, unknown> & { role?: string }>) {
  return {
    schemaVersion: "2.0",
    kind: "pragma-layer-tree",
    rootNodeIds: roots.map((root) => String(root.id)),
    nodes: roots.map((root, index) => serializeLayerNode(root, { zIndex: index, role: root.role }))
  };
}

export function flattenSerializedLayers(nodes: SerializedLayerNode[]): SerializedLayerNode[] {
  const output: SerializedLayerNode[] = [];
  const walk = (node: SerializedLayerNode) => {
    output.push(node);
    for (const child of node.children || []) walk(child);
  };
  for (const node of nodes) walk(node);
  return output;
}

export function collectComponentInstances(nodes: SerializedLayerNode[]) {
  return flattenSerializedLayers(nodes)
    .filter((node) => node.type === "INSTANCE" || node.componentRef)
    .map((node) => ({
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

export function collectVisualStateSources(nodes: SerializedLayerNode[]) {
  return flattenSerializedLayers(nodes)
    .filter((node) => ["FRAME", "SECTION", "COMPONENT_SET", "COMPONENT", "INSTANCE"].includes(node.type))
    .filter((node) => node.type !== "INSTANCE" || node.hidden || (node.availableStates && node.availableStates.length > 0))
    .map((node) => ({
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
