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

function plain(value: unknown, depth = 0): unknown {
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
  const componentProperties = plain(node.componentProperties) as Record<string, unknown> | undefined;
  return {
    componentId: String((mainComponent?.id || node.componentId || node.mainComponentId || "") as string) || undefined,
    mainComponentNodeId: String((mainComponent?.id || node.mainComponentId || "") as string) || undefined,
    mainComponentName: String((mainComponent?.name || node.mainComponentName || "") as string) || undefined,
    componentSetId: String((mainComponent?.parent as Record<string, unknown> | undefined)?.id || node.componentSetId || "") || undefined,
    variant: componentProperties || (plain(node.variantProperties) as Record<string, unknown> | undefined),
    componentProperties
  };
}

export interface SerializedLayerNode {
  nodeId: string;
  figmaNodeId: string;
  name: string;
  type: string;
  role?: string;
  bounds: RectLike;
  zIndex: number;
  visible?: boolean;
  locked?: boolean;
  layoutMode?: string;
  constraints?: unknown;
  padding?: ReturnType<typeof paddingOf>;
  gap?: number;
  fills?: unknown[];
  strokes?: unknown[];
  strokeWeight?: unknown;
  cornerRadius?: unknown;
  effects?: unknown[];
  opacity?: number;
  blendMode?: string;
  text?: Record<string, unknown> | null;
  componentRef?: ReturnType<typeof componentRefFromNode>;
  imageFillRefs?: Array<{ imageHash: string; scaleMode?: string; filters?: unknown }>;
  boundVariables?: unknown;
  children: SerializedLayerNode[];
}

export function serializeLayerNode(input: Record<string, unknown>, options: { zIndex?: number; role?: string; mainComponent?: Record<string, unknown> | null } = {}): SerializedLayerNode {
  const children = asArray(input.children as Array<Record<string, unknown>>).map((child, index) => serializeLayerNode(child, { zIndex: index }));
  const fills = asArray(input.fills as unknown[]).map((fill) => plain(fill)).filter(Boolean);
  const imageFillRefs = fills
    .filter((fill): fill is Record<string, unknown> => Boolean(fill && typeof fill === "object" && (fill as Record<string, unknown>).type === "IMAGE" && (fill as Record<string, unknown>).imageHash))
    .map((fill) => ({
      imageHash: String(fill.imageHash),
      scaleMode: fill.scaleMode ? String(fill.scaleMode) : undefined,
      filters: fill.filters
    }));
  const text = input.type === "TEXT" ? {
    content: String(input.characters ?? ""),
    fontFamily: typeof input.fontName === "object" ? (input.fontName as Record<string, unknown>).family : input.fontFamily,
    fontStyle: typeof input.fontName === "object" ? (input.fontName as Record<string, unknown>).style : undefined,
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
    visible: input.visible === undefined ? true : Boolean(input.visible),
    locked: Boolean(input.locked),
    layoutMode: input.layoutMode ? String(input.layoutMode) : undefined,
    constraints: plain(input.constraints),
    padding: paddingOf(input),
    gap: input.itemSpacing === undefined ? undefined : numberOr(input.itemSpacing, 0),
    fills,
    strokes: asArray(input.strokes as unknown[]).map((stroke) => plain(stroke)).filter(Boolean),
    strokeWeight: plain(input.strokeWeight),
    cornerRadius: plain(input.cornerRadius ?? input.rectangleCornerRadii),
    effects: asArray(input.effects as unknown[]).map((effect) => plain(effect)).filter(Boolean),
    opacity: input.opacity === undefined ? 1 : numberOr(input.opacity, 1),
    blendMode: input.blendMode ? String(input.blendMode) : "NORMAL",
    text,
    componentRef: componentRefFromNode(input, options.mainComponent),
    imageFillRefs,
    boundVariables: plain(input.boundVariables),
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
      mainComponentNodeId: node.componentRef?.mainComponentNodeId || node.componentRef?.componentId,
      componentSetId: node.componentRef?.componentSetId,
      variant: node.componentRef?.variant || {},
      bounds: node.bounds
    }));
}
