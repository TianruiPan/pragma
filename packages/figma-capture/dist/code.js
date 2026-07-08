"use strict";
(() => {
  // src/shared/assets.ts
  function slugify(value, fallback = "item") {
    const normalized = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return normalized || fallback;
  }
  function safeNodeIdSegment(value) {
    return slugify(String(value).replace(/:/g, "-"), "node");
  }
  function sniffMime(bytes, fallback = "application/octet-stream") {
    if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
    if (bytes.length >= 6) {
      const head = String.fromCharCode(...bytes.slice(0, 6)).toLowerCase();
      if (head.startsWith("gif")) return "image/gif";
    }
    const textHead = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 256))).trimStart().toLowerCase();
    if (textHead.startsWith("<svg") || textHead.startsWith("<?xml")) return "image/svg+xml";
    return fallback;
  }
  function dataView(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  function readUInt24LE(bytes, offset) {
    return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
  }
  function parseSvgDimension(value) {
    if (!value) return void 0;
    const match = value.match(/^\s*([0-9.]+)/);
    return match ? Number(match[1]) : void 0;
  }
  function sniffAssetBytes(bytes, fallback = "application/octet-stream") {
    const mime = sniffMime(bytes, fallback);
    const view = dataView(bytes);
    if (mime === "image/png" && bytes.length >= 24) {
      return { mime, width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (mime === "image/jpeg" && bytes.length >= 4) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 255) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1];
        const length = view.getUint16(offset + 2);
        if (length < 2) break;
        if (marker >= 192 && marker <= 195 || marker >= 197 && marker <= 199 || marker >= 201 && marker <= 203 || marker >= 205 && marker <= 207) {
          return { mime, height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
        }
        offset += 2 + length;
      }
    }
    if (mime === "image/webp" && bytes.length >= 30) {
      const chunk = String.fromCharCode(...bytes.slice(12, 16));
      if (chunk === "VP8X") return { mime, width: readUInt24LE(bytes, 24) + 1, height: readUInt24LE(bytes, 27) + 1 };
      if (chunk === "VP8 ") return { mime, width: view.getUint16(26, true) & 16383, height: view.getUint16(28, true) & 16383 };
      if (chunk === "VP8L" && bytes.length >= 25) {
        const b0 = bytes[21];
        const b1 = bytes[22];
        const b2 = bytes[23];
        const b3 = bytes[24];
        return {
          mime,
          width: 1 + ((b1 & 63) << 8 | b0),
          height: 1 + ((b3 & 15) << 10 | b2 << 2 | (b1 & 192) >> 6)
        };
      }
    }
    if (mime === "image/svg+xml") {
      const text = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 4096))).replace(/^\uFEFF/, "");
      const openTag = text.match(/<svg\b[^>]*>/i)?.[0] || "";
      const viewBox = openTag.match(/\bviewBox=["']([^"']+)["']/i)?.[1]?.trim().split(/[\s,]+/).map(Number);
      return {
        mime,
        width: parseSvgDimension(openTag.match(/\bwidth=["']([^"']+)["']/i)?.[1]) ?? (viewBox && viewBox.length === 4 ? viewBox[2] : void 0),
        height: parseSvgDimension(openTag.match(/\bheight=["']([^"']+)["']/i)?.[1]) ?? (viewBox && viewBox.length === 4 ? viewBox[3] : void 0)
      };
    }
    return { mime };
  }
  function extensionForMime(mime) {
    switch (mime) {
      case "image/png":
        return "png";
      case "image/jpeg":
        return "jpg";
      case "image/webp":
        return "webp";
      case "image/gif":
        return "gif";
      case "image/svg+xml":
        return "svg";
      default:
        return "bin";
    }
  }
  function assetTypeForMime(mime) {
    return extensionForMime(mime);
  }
  function createAssetRecord(input) {
    const record = {
      id: input.id,
      name: input.name,
      role: input.role || "implementation-asset",
      type: assetTypeForMime(input.mime),
      path: input.path,
      mime: input.mime,
      width: input.width,
      height: input.height,
      sourceNodeIds: input.sourceNodeIds || [],
      usedByNodeIds: input.usedByNodeIds || input.sourceNodeIds || [],
      required: input.required !== false
    };
    if (/^sha256:[0-9a-f]{64}$/i.test(input.checksum || "")) record.checksum = input.checksum;
    else record.checksumStatus = input.checksumStatus || "unavailable";
    return record;
  }

  // src/shared/bundle.ts
  function jsonFile(path, content) {
    return { path, kind: "json", content };
  }
  function textFile(path, content) {
    return { path, kind: "text", content };
  }
  function binaryFile(path, base64, mime, checksum) {
    return { path, kind: "binary", base64, mime, checksum };
  }
  function createPragmaInputBundle(files, createdAt = (/* @__PURE__ */ new Date()).toISOString(), summary = {}) {
    return {
      schemaVersion: "2.0",
      kind: "pragma-figma-capture-bundle",
      createdAt,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      summary
    };
  }

  // src/shared/figma-url.ts
  var EDITOR_TYPES = /* @__PURE__ */ new Set(["design", "file", "proto", "board", "slides", "make"]);
  function normalizeFigmaNodeId(value) {
    if (!value) return void 0;
    let text = String(value).trim();
    if (!text) return void 0;
    text = text.replace(/^node-id=/i, "");
    try {
      text = decodeURIComponent(text);
    } catch {
    }
    text = text.replace(/^#/, "");
    if (text.includes("?")) text = text.split("?")[0] ?? text;
    if (text.includes("&")) text = text.split("&")[0] ?? text;
    return text.replace(/-/g, ":");
  }
  function figmaNodeIdForUrl(value) {
    return String(value).replace(/:/g, "-");
  }
  function parseFigmaUrl(value) {
    if (!value || !String(value).trim()) return {};
    let url;
    try {
      url = new URL(String(value).trim());
    } catch {
      return { nodeId: normalizeFigmaNodeId(String(value)) };
    }
    if (!/figma\.com$/i.test(url.hostname) && !url.hostname.endsWith(".figma.com")) {
      return { url: url.toString() };
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const editorSegment = segments.find((segment) => EDITOR_TYPES.has(segment));
    const editorIndex = editorSegment ? segments.indexOf(editorSegment) : -1;
    const fileKey = editorIndex >= 0 ? segments[editorIndex + 1] : void 0;
    const branchIndex = segments.indexOf("branch");
    const branchKey = branchIndex >= 0 ? segments[branchIndex + 1] : void 0;
    const nodeId = normalizeFigmaNodeId(url.searchParams.get("node-id") || url.searchParams.get("node_id"));
    const editorType = editorSegment === "board" ? "figjam" : editorSegment;
    return {
      fileKey: branchKey || fileKey,
      branchKey,
      nodeId,
      editorType,
      url: url.toString()
    };
  }
  function buildFigmaUrl(fileKey, nodeId) {
    const base = `https://www.figma.com/design/${encodeURIComponent(fileKey)}/Pragma-Capture`;
    if (!nodeId) return base;
    return `${base}?node-id=${figmaNodeIdForUrl(nodeId)}`;
  }
  function resolveRequiredFigmaFileKey(input) {
    const fileKey = String(input.override || "").trim() || parseFigmaUrl(input.figmaUrl).fileKey || String(input.pluginFileKey || "").trim();
    if (!fileKey) throw new Error("Figma fileKey is required. Paste the Figma file URL or fill File key override.");
    return fileKey;
  }

  // src/shared/layer.ts
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

  // src/shared/roles.ts
  function asFrameArray(value) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    return [value];
  }
  function frameList(frames) {
    return [
      ...frames.page || [],
      ...asFrameArray(frames.components),
      ...asFrameArray(frames.assets)
    ];
  }
  function assertFrameRoles(frames) {
    if (!frames.page || frames.page.length === 0) throw new Error("At least one page frame is required.");
    const ids = /* @__PURE__ */ new Set();
    for (const frame of frameList(frames)) {
      if (!frame.nodeId) throw new Error(`Frame ${frame.name || "(unnamed)"} is missing nodeId.`);
      if (ids.has(frame.nodeId)) throw new Error(`Frame ${frame.nodeId} is assigned to more than one role.`);
      ids.add(frame.nodeId);
    }
  }
  function buildSelectionJson(input) {
    assertFrameRoles(input.frames);
    return {
      schemaVersion: "2.0",
      kind: "pragma-figma-selection",
      fileKey: input.fileKey,
      fileName: input.fileName,
      page: input.page || null,
      frames: {
        page: input.frames.page.map((frame) => ({ ...frame, role: "page" })),
        components: asFrameArray(input.frames.components).map((frame) => ({ ...frame, role: "components", optional: true })),
        assets: asFrameArray(input.frames.assets).map((frame) => ({ ...frame, role: "assets", optional: true }))
      },
      nodes: frameList(input.frames).map((frame) => ({
        id: frame.nodeId,
        nodeId: frame.nodeId,
        name: frame.name,
        type: frame.type,
        width: frame.width,
        height: frame.height,
        bounds: frame.bounds,
        viewport: frame.viewport,
        role: frame.role,
        url: frame.url
      }))
    };
  }
  function buildCaptureJson(request, capturedAt = (/* @__PURE__ */ new Date()).toISOString()) {
    assertFrameRoles(request.figma.frames);
    const nodeIds = frameList(request.figma.frames).map((frame) => frame.nodeId);
    return {
      repo: request.repo,
      designIssue: request.designIssue,
      targetDevIssues: request.targetDevIssues || [],
      figma: {
        fileKey: request.figma.fileKey,
        fileName: request.figma.fileName,
        nodeIds,
        frames: request.figma.frames,
        selectionMode: request.figma.selectionMode || "figma-plugin-explicit-frame-roles",
        url: request.figma.url
      },
      source: {
        provider: "figma",
        adapter: "figma-plugin-capture-bridge"
      },
      blueLakeUrl: request.blueLakeUrl,
      designerNotes: request.designerNotes,
      dynamicRegionNotes: request.dynamicRegionNotes,
      capturedAt,
      skillVersion: "pragma-figma-capture@0.1.0"
    };
  }
  function buildPluginOnlyDependencyLock(input) {
    return {
      schemaVersion: "2.0",
      kind: "pragma-capture-dependency-lock",
      mode: "plugin-only-candidate",
      fileKey: input.fileKey,
      capturedAt: input.capturedAt,
      pageFrames: input.frames.page.map((frame) => ({ nodeId: frame.nodeId, name: frame.name, snapshotId: null })),
      components: asFrameArray(input.frames.components).length ? {
        status: "selected",
        frameNodeId: asFrameArray(input.frames.components)[0]?.nodeId,
        frameNodeIds: asFrameArray(input.frames.components).map((frame) => frame.nodeId),
        snapshotId: null,
        path: null,
        checksum: null,
        reason: "selected-in-plugin-core-must-materialize-snapshot"
      } : {
        status: input.hasComponentInstances ? "missing" : "none",
        frameNodeId: null,
        snapshotId: null,
        path: null,
        checksum: null,
        reason: "plugin-cannot-read-repo-registry"
      },
      assets: asFrameArray(input.frames.assets).length ? {
        status: "selected",
        frameNodeId: asFrameArray(input.frames.assets)[0]?.nodeId,
        frameNodeIds: asFrameArray(input.frames.assets).map((frame) => frame.nodeId),
        snapshotId: null,
        path: null,
        checksum: null,
        reason: "selected-in-plugin-core-must-materialize-snapshot"
      } : {
        status: input.hasUnresolvedSharedAssetRefs ? "missing" : "none",
        frameNodeId: null,
        snapshotId: null,
        path: null,
        checksum: null,
        reason: "plugin-cannot-read-repo-registry"
      },
      rules: {
        lockDependencies: true,
        neverDependOnFloatingLatest: true,
        ifMissingComponentsAndPageHasInstances: "block",
        ifMissingAssetsAndPageHasUnresolvedRefs: "block"
      }
    };
  }

  // src/plugin/serializer.ts
  var CAPTURABLE_TYPES = /* @__PURE__ */ new Set(["FRAME", "COMPONENT", "INSTANCE", "COMPONENT_SET", "SECTION"]);
  function nowMs() {
    return Date.now();
  }
  function elapsedMs(start) {
    return Math.max(0, Date.now() - start);
  }
  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 32768;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.slice(index, index + chunk));
    }
    return btoa(binary);
  }
  async function sha256(bytes) {
    if (globalThis.crypto?.subtle) {
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
      return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    }
    return void 0;
  }
  function requirePositiveInteger(value, fallback) {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
  }
  async function nodeById(nodeId) {
    if (typeof figma.getNodeByIdAsync === "function") return await figma.getNodeByIdAsync(nodeId);
    return figma.getNodeById(nodeId);
  }
  function normalizeFrameSlots(rawRequest) {
    const slots = { page: [], components: [], assets: [] };
    const rawSlots = rawRequest.frameSlots || rawRequest.framesByRole;
    if (rawSlots && typeof rawSlots === "object") {
      for (const role of ["page", "components", "assets"]) {
        const rawIds = Array.isArray(rawSlots[role]) ? rawSlots[role] : [];
        slots[role] = rawIds.map((item) => String(item?.nodeId || item?.id || item)).filter(Boolean);
      }
      return slots;
    }
    const assignments = rawRequest.roleAssignments || {};
    for (const [nodeId, role] of Object.entries(assignments)) {
      if (!role || role === "none") continue;
      slots[role].push(nodeId);
    }
    return slots;
  }
  async function resolveAssignedFrames(rawRequest) {
    const slots = normalizeFrameSlots(rawRequest);
    const roles = { page: [], components: [], assets: [] };
    for (const role of ["page", "components", "assets"]) {
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
  function frameFromNode(node, role, fileKey) {
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
  function framesFromRoles(roles, fileKey) {
    return {
      page: roles.page.map((node) => frameFromNode(node, "page", fileKey)),
      components: roles.components.map((node) => frameFromNode(node, "components", fileKey)),
      assets: roles.assets.map((node) => frameFromNode(node, "assets", fileKey))
    };
  }
  async function mainComponentOf(node) {
    if (node.type !== "INSTANCE") return null;
    try {
      if (typeof node.getMainComponentAsync === "function") return await node.getMainComponentAsync();
      return node.mainComponent || null;
    } catch {
      return null;
    }
  }
  function plainFigmaNode(node) {
    const keys = [
      "id",
      "name",
      "type",
      "visible",
      "locked",
      "opacity",
      "blendMode",
      "absoluteBoundingBox",
      "relativeTransform",
      "width",
      "height",
      "constraints",
      "layoutMode",
      "primaryAxisSizingMode",
      "counterAxisSizingMode",
      "primaryAxisAlignItems",
      "counterAxisAlignItems",
      "layoutWrap",
      "itemSpacing",
      "layoutGrow",
      "layoutAlign",
      "layoutPositioning",
      "layoutSizingHorizontal",
      "layoutSizingVertical",
      "itemReverseZIndex",
      "strokesIncludedInLayout",
      "clipsContent",
      "overflowDirection",
      "minWidth",
      "maxWidth",
      "minHeight",
      "maxHeight",
      "inferredAutoLayout",
      "explicitVariableModes",
      "resolvedVariableModes",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "fills",
      "strokes",
      "strokeWeight",
      "cornerRadius",
      "rectangleCornerRadii",
      "effects",
      "characters",
      "fontName",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "letterSpacing",
      "textAlignHorizontal",
      "textAlignVertical",
      "componentProperties",
      "variantProperties",
      "boundVariables",
      "fillStyleId",
      "strokeStyleId",
      "textStyleId",
      "effectStyleId",
      "gridStyleId",
      "key",
      "description",
      "componentPropertyDefinitions",
      "exportSettings"
    ];
    const output = {};
    for (const key of keys) {
      try {
        if (node[key] !== void 0) output[key] = node[key];
      } catch {
      }
    }
    output.parentId = node.parent?.id;
    output.parentName = node.parent?.name;
    output.pageId = figma.currentPage?.id;
    output.pageName = figma.currentPage?.name;
    output.children = [];
    return output;
  }
  async function serializeFigmaNode(node, role, zIndex = 0, parentNodeId) {
    const mainComponent = await mainComponentOf(node);
    const childNodes = Array.isArray(node.children) ? node.children : [];
    const serialized = serializeLayerNode(plainFigmaNode(node), { role, zIndex, mainComponent, parentNodeId });
    serialized.children = [];
    for (let index = 0; index < childNodes.length; index += 1) {
      serialized.children.push(await serializeFigmaNode(childNodes[index], role, index, node.id));
    }
    return serialized;
  }
  async function serializeLayerRoots(roles) {
    const roots = [];
    for (const role of ["page", "components", "assets"]) {
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
  function componentSource(node) {
    return node.role === "components" ? "selected-components-frame" : "page-inline";
  }
  function componentMetadataFromLayer(node) {
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
      availableStates: node.availableStates?.length ? node.availableStates : availableStatesFromProperties({
        variantProperties: node.variantProperties,
        componentProperties: node.componentProperties,
        componentPropertyDefinitions: node.componentPropertyDefinitions,
        visible: node.visible
      })
    };
  }
  function countVisibilityFacts(nodes) {
    return nodes.filter((node) => typeof node.visible === "boolean" || typeof node.hidden === "boolean").length;
  }
  function styleRecord(style) {
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
  function buildComponentsJson(layerTree) {
    const allLayers = flattenSerializedLayers(layerTree.nodes || []);
    const instances = collectComponentInstances(layerTree.nodes || []);
    const visualStateSources = collectVisualStateSources(layerTree.nodes || []);
    const stateFrames = visualStateSources.filter((state) => state.type === "FRAME" || state.type === "SECTION");
    const componentSets = allLayers.filter((node) => node.type === "COMPONENT_SET").map((node) => ({
      ...componentMetadataFromLayer(node),
      components: allLayers.filter((candidate) => candidate.type === "COMPONENT" && candidate.parentNodeId === node.figmaNodeId).map(componentMetadataFromLayer)
    }));
    const components = allLayers.filter((node) => node.type === "COMPONENT").map(componentMetadataFromLayer);
    const componentMetadataMissingCount = instances.filter((instance) => !instance.mainComponentNodeId).length;
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
    const result = {
      schemaVersion: "2.0",
      kind: "pragma-figma-variables",
      variables: [],
      styles: []
    };
    try {
      if (figma.variables?.getLocalVariablesAsync) {
        result.variables = (await figma.variables.getLocalVariablesAsync()).map((variable) => ({
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
  function buildMetadataJson(input) {
    const allLayers = flattenSerializedLayers(input.layerTree.nodes || []);
    const capturedFrames = ["page", "components", "assets"].flatMap((role) => (input.frames[role] || []).map((frame) => ({
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
        updatedAt: figma.root?.lastModified || figma.root?.updatedAt || null,
        updatedAtStatus: figma.root?.lastModified || figma.root?.updatedAt ? "captured" : "unavailable-in-plugin-api"
      },
      currentPage: {
        id: figma.currentPage.id,
        name: figma.currentPage.name,
        type: figma.currentPage.type,
        childCount: Array.isArray(figma.currentPage.children) ? figma.currentPage.children.length : void 0
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
  async function exportNodePng(node) {
    return await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
  }
  async function addScreenshotFiles(files, roles) {
    let index = 0;
    for (const node of [...roles.page, ...roles.components, ...roles.assets]) {
      const bytes = await exportNodePng(node);
      const checksum = await sha256(bytes);
      const role = roles.page.includes(node) ? "page" : roles.components.includes(node) ? "components" : "assets";
      files.push(binaryFile(`screenshots/${String(index).padStart(2, "0")}-${role}-${slugify(node.name, "frame")}.png`, bytesToBase64(bytes), "image/png", checksum));
      index += 1;
    }
  }
  function placementOf(node) {
    const box = node.absoluteBoundingBox || { x: 0, y: 0, width: node.width || 0, height: node.height || 0 };
    return { x: box.x || 0, y: box.y || 0, width: box.width || 0, height: box.height || 0 };
  }
  function imagePaints(node) {
    return Array.isArray(node.fills) ? node.fills.filter((fill) => fill && fill.type === "IMAGE" && fill.imageHash) : [];
  }
  function fitForImagePaint(fill) {
    if (fill.scaleMode === "FILL") return "cover";
    if (fill.scaleMode === "STRETCH") return "stretch";
    if (fill.scaleMode === "TILE") return "tile";
    return "contain";
  }
  function cropForImagePaint(fill) {
    if (fill.scaleMode !== "CROP") return null;
    return {
      scaleMode: fill.scaleMode,
      imageTransform: plain(fill.imageTransform) ?? null
    };
  }
  function walkNodes(nodes, visit) {
    for (const node of nodes) {
      visit(node);
      if (Array.isArray(node.children)) walkNodes(node.children, visit);
    }
  }
  async function addImageFillAssets(files, assetRecords, bindings, pageNodes) {
    const seen = /* @__PURE__ */ new Set();
    const candidates = [];
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
        scope: "page",
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
        checksumStatus: checksum ? void 0 : "unavailable",
        sourceNodeIds: [node.id],
        usedByNodeIds: [node.id],
        bindings: [binding],
        required: true
      }));
      files.push(binaryFile(assetPath, bytesToBase64(bytes), mime, checksum));
    }
  }
  async function addAssetsFrameExports(files, assetRecords, bindings, assetsFrames) {
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
          scope: "shared",
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
          checksumStatus: checksum ? void 0 : "unavailable",
          sourceNodeIds: [node.id],
          usedByNodeIds: [node.id],
          bindings: [binding],
          required: false
        }));
        files.push(binaryFile(assetPath, bytesToBase64(bytes), "image/png", checksum));
      }
    }
  }
  function getDesignContextFallback(request, frames) {
    const pageNames = frames.page.map((frame) => `${frame.name} (${frame.nodeId})`).join(", ");
    const componentNames = frames.components?.length ? frames.components.map((frame) => `${frame.name} (${frame.nodeId})`).join(", ") : "not selected";
    const assetNames = frames.assets?.length ? frames.assets.map((frame) => `${frame.name} (${frame.nodeId})`).join(", ") : "not selected";
    return `# Figma Plugin Capture Summary

This file was captured by the Pragma Figma Plugin. Figma MCP get_design_context text was not available in-plugin, so this is a provider/plugin summary only. Do not treat it as MCP output or generated implementation code.

- File key: ${request.figma.fileKey}
- Page frame(s): ${pageNames}
- Components frame(s): ${componentNames}
- Assets frame(s): ${assetNames}
`;
  }
  function parseRequest(raw, frames, fileKey, fileName) {
    const issueNumber = requirePositiveInteger(raw.designIssueNumber, raw.designIssue?.number || 1);
    const repoName = String(raw.repoName || raw.repo?.name || "product-repo");
    const repoOwner = String(raw.repoOwner || raw.repo?.owner || "local");
    const parsedUrl = parseFigmaUrl(raw.figmaUrl);
    return {
      repo: {
        owner: repoOwner,
        name: repoName,
        localPath: raw.repoLocalPath || raw.repo?.localPath || void 0
      },
      designIssue: {
        number: issueNumber,
        title: raw.designIssueTitle || raw.designIssue?.title || void 0
      },
      targetDevIssues: raw.targetDevIssueNumber ? [{ number: requirePositiveInteger(raw.targetDevIssueNumber, 1), title: raw.targetDevIssueTitle || void 0 }] : raw.targetDevIssues || [],
      figma: {
        fileKey: raw.fileKey || parsedUrl.fileKey || fileKey,
        fileName: raw.fileName || fileName,
        url: raw.figmaUrl || parsedUrl.url,
        selectionMode: "figma-plugin-explicit-frame-roles",
        frames
      },
      blueLakeUrl: raw.blueLakeUrl || void 0,
      designerNotes: raw.designerNotes || "",
      dynamicRegionNotes: raw.dynamicRegionNotes || ""
    };
  }
  async function buildCaptureBundle(rawRequest) {
    const totalStart = nowMs();
    const serializeStart = nowMs();
    const fileKey = resolveRequiredFigmaFileKey({ override: rawRequest.fileKey, figmaUrl: rawRequest.figmaUrl, pluginFileKey: figma.fileKey });
    const roles = await resolveAssignedFrames(rawRequest || {});
    const frames = framesFromRoles(roles, fileKey);
    const request = parseRequest(rawRequest, frames, fileKey, figma.root?.name);
    const capturedAt = (/* @__PURE__ */ new Date()).toISOString();
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
    const files = [];
    const assets = [];
    const bindings = [];
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

  // src/shared/bridge-url.ts
  function normalizeLocalhostCaptureUrl(value) {
    const input = String(value || "http://localhost:48732/capture").trim();
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`;
    const withoutHash = withProtocol.split("#")[0];
    const withoutQuery = withoutHash.split("?")[0];
    const withoutTrailingSlash = withoutQuery.endsWith("/") ? withoutQuery.slice(0, -1) : withoutQuery;
    if (withoutTrailingSlash === "http://localhost:48732") return "http://localhost:48732/capture";
    if (withoutTrailingSlash === "http://localhost:48732/capture") return "http://localhost:48732/capture";
    return "";
  }
  function normalizeBridgeEndpoint(value) {
    const captureUrl = normalizeLocalhostCaptureUrl(value);
    if (!captureUrl) {
      throw new Error("Bridge URL must be http://localhost:48732/capture.");
    }
    return {
      captureUrl,
      healthUrl: "http://localhost:48732/health"
    };
  }

  // src/plugin/code.ts
  figma.showUI('<!doctype html>\r\n<html lang="en">\r\n<head>\r\n  <meta charset="utf-8" />\r\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\r\n  <style>\r\n    :root {\r\n      --background: #09090b;\r\n      --card: #18181b;\r\n      --popover: #111113;\r\n      --border: #27272a;\r\n      --input: #27272a;\r\n      --foreground: #fafafa;\r\n      --muted: #a1a1aa;\r\n      --muted-2: #71717a;\r\n      --primary: #fafafa;\r\n      --primary-foreground: #09090b;\r\n      --destructive: #ef4444;\r\n      --radius: 10px;\r\n    }\r\n    * { box-sizing: border-box; }\r\n    body {\r\n      margin: 0;\r\n      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;\r\n      color: var(--foreground);\r\n      background: var(--background);\r\n      font-size: 12px;\r\n    }\r\n    header { padding: 18px 18px 8px; border-bottom: 1px solid var(--border); }\r\n    h1 { margin: 0; font-size: 18px; font-weight: 500; letter-spacing: -0.02em; }\r\n    .sub { margin-top: 6px; color: var(--muted); line-height: 1.5; }\r\n    main { padding: 12px 18px 18px; }\r\n    section { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; margin: 10px 0; }\r\n    h2 { margin: 0 0 8px; font-size: 13px; font-weight: 500; letter-spacing: -0.01em; }\r\n    label { display: block; color: var(--muted); margin: 10px 0 5px; font-size: 12px; }\r\n    input, textarea {\r\n      width: 100%; border: 1px solid var(--input); border-radius: 8px; padding: 8px 9px;\r\n      background: var(--background); color: var(--foreground); font: inherit; outline: none;\r\n    }\r\n    input:focus, textarea:focus { border-color: #52525b; }\r\n    textarea { min-height: 54px; resize: vertical; }\r\n    button {\r\n      border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font: inherit;\r\n      cursor: pointer; background: var(--primary); color: var(--primary-foreground);\r\n    }\r\n    button.secondary { background: var(--popover); color: var(--foreground); }\r\n    button.ghost { background: transparent; color: var(--muted); }\r\n    button.danger { color: var(--destructive); background: transparent; }\r\n    button:disabled { opacity: .45; cursor: not-allowed; }\r\n    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }\r\n    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }\r\n    .muted { color: var(--muted); }\r\n    .tiny { color: var(--muted-2); font-size: 11px; line-height: 1.45; }\n    .hint { border: 1px solid var(--border); border-radius: 8px; padding: 8px; color: var(--muted); background: var(--popover); line-height: 1.5; margin-bottom: 10px; }\n    .selection-list, .slot-list { display: grid; gap: 8px; }\r\n    .node-card {\r\n      border: 1px solid var(--border); border-radius: 8px; padding: 8px;\r\n      background: var(--popover); min-width: 0;\r\n    }\r\n    .node-top { display: flex; justify-content: space-between; gap: 8px; align-items: start; }\r\n    .node-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }\r\n    .node-meta { color: var(--muted-2); margin-top: 3px; }\r\n    .url { color: var(--muted); margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\r\n    .slot-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }\r\n    .count { color: var(--muted-2); font-size: 11px; }\r\n    .actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 10px; }\r\n    .status { color: var(--muted); line-height: 1.5; white-space: pre-wrap; }\r\n    .error { color: var(--destructive); }\r\n  </style>\r\n</head>\r\n<body>\r\n  <header>\r\n    <h1>Pragma Capture</h1>\r\n    <div class="sub">Add the current Figma selection into persistent frame slots. Switching selection will not clear slots.</div>\r\n  </header>\r\n  <main>\r\n    <section>\r\n      <div class="slot-header">\r\n        <h2>Current selection</h2>\r\n        <button class="secondary" id="refresh">Refresh</button>\r\n      </div>\r\n      <div id="selection" class="selection-list"></div>\r\n      <div class="actions">\r\n        <button id="addPage">Add to page</button>\r\n        <button class="secondary" id="addComponents">Add to components</button>\r\n        <button class="secondary" id="addAssets">Add to assets</button>\r\n      </div>\r\n    </section>\r\n\r\n    <section>\n      <div class="hint">\n        Required: at least one page frame, a design issue number, and a file key from the Figma URL or override. Send to local bridge also requires <span class="muted">http://localhost:48732/capture</span> and a running bridge process.\n      </div>\n      <div class="grid">\n        <div><label>Repo owner</label><input id="repoOwner" value="local" /></div>\r\n        <div><label>Repo name</label><input id="repoName" value="product-repo" /></div>\r\n      </div>\r\n      <label>Repo local path</label><input id="repoLocalPath" placeholder="D:/path/to/repo" />\r\n      <div class="grid">\r\n        <div><label>Design issue number</label><input id="designIssueNumber" type="number" min="1" value="1" /></div>\r\n        <div><label>Target dev issue number</label><input id="targetDevIssueNumber" type="number" min="1" /></div>\r\n      </div>\r\n      <label>Figma URL or file URL</label><input id="figmaUrl" placeholder="https://www.figma.com/design/...?...node-id=..." />\r\n      <label>File key override</label><input id="fileKey" placeholder="Auto-filled when Figma exposes fileKey" />\r\n      <label>Designer notes</label><textarea id="designerNotes" placeholder="Intent, priorities, implementation boundaries"></textarea>\r\n      <label>Dynamic region notes</label><textarea id="dynamicRegionNotes" placeholder="Maps, charts, video, 3D, realtime data"></textarea>\r\n      <label>Bridge URL</label><input id="bridgeUrl" value="http://localhost:48732/capture" />\r\n    </section>\r\n\r\n    <section id="slots"></section>\r\n\r\n    <section>\r\n      <div class="row">\r\n        <button id="export">Export capture</button>\r\n        <button class="secondary" id="send">Send to local bridge</button>\r\n        <button class="ghost" id="clearAll">Clear slots</button>\r\n      </div>\r\n    </section>\r\n\r\n    <section><div id="status" class="status">Waiting for selection...</div></section>\r\n  </main>\r\n  <script>\r\n    const state = {\r\n      selection: [],\r\n      slots: { page: [], components: [], assets: [] },\r\n      fileKeyFromFigma: ""\r\n    };\r\n    const $ = (id) => document.getElementById(id);\r\n    const fields = ["repoOwner", "repoName", "repoLocalPath", "designIssueNumber", "targetDevIssueNumber", "figmaUrl", "fileKey", "designerNotes", "dynamicRegionNotes"];\r\n\r\n    function escapeHtml(value) {\r\n      return String(value ?? "").replace(/[&<>"\']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;", "\'": "&#039;" }[char]));\r\n    }\r\n\r\n    function setStatus(text, isError = false) {\n      const node = $("status");\n      node.textContent = typeof text === "string" ? text : JSON.stringify(text, null, 2);\n      node.className = isError ? "status error" : "status";\n    }\n\r\n    function parseFileKeyFromUrl(value) {\r\n      try {\r\n        const url = new URL(value);\r\n        const parts = url.pathname.split("/").filter(Boolean);\r\n        const known = ["design", "file", "proto", "board", "slides", "make"];\r\n        const index = parts.findIndex((part) => known.includes(part));\r\n        const branch = parts.indexOf("branch");\r\n        if (branch >= 0 && parts[branch + 1]) return parts[branch + 1];\r\n        if (index >= 0 && parts[index + 1]) return parts[index + 1];\r\n      } catch {}\r\n      return "";\r\n    }\r\n\r\n    function currentFileKey() {\n      return $("fileKey").value.trim() || parseFileKeyFromUrl($("figmaUrl").value.trim()) || state.fileKeyFromFigma || "";\n    }\n\n    function normalizeBridgeUrl(value) {\n      const input = String(value || "http://localhost:48732/capture").trim();\n      const withProtocol = /^[a-z][a-z0-9+.-]*:\\/\\//i.test(input) ? input : `http://${input}`;\n      const withoutHash = withProtocol.split("#")[0];\n      const withoutQuery = withoutHash.split("?")[0];\n      const normalized = withoutQuery.endsWith("/") ? withoutQuery.slice(0, -1) : withoutQuery;\n      if (normalized === "http://localhost:48732") return "http://localhost:48732/capture";\n      if (normalized === "http://localhost:48732/capture") return "http://localhost:48732/capture";\n      return "";\n    }\n\r\n    function frameUrl(node) {\r\n      const key = currentFileKey();\r\n      if (!key) return "";\r\n      return `https://www.figma.com/design/${encodeURIComponent(key)}/Pragma-Capture?node-id=${String(node.id).replace(/:/g, "-")}`;\r\n    }\r\n\r\n    function nodeCard(node, role) {\r\n      const url = frameUrl(node);\r\n      const size = node.width ? `${Math.round(node.width)}x${Math.round(node.height)}` : "size unknown";\r\n      return `\r\n        <div class="node-card" data-node-id="${escapeHtml(node.id)}">\r\n          <div class="node-top">\r\n            <div style="min-width:0">\r\n              <div class="node-title" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</div>\r\n              <div class="node-meta">${escapeHtml(node.type)} - ${escapeHtml(node.id)} - ${size}</div>\r\n            </div>\r\n            ${role ? `<button class="danger" data-remove-role="${role}" data-remove-id="${escapeHtml(node.id)}">Remove</button>` : ""}\r\n          </div>\r\n          <div class="url">${url ? escapeHtml(url) : "Enter a file key or Figma URL to generate this frame URL."}</div>\r\n        </div>`;\r\n    }\r\n\r\n    function renderSelection() {\r\n      const mount = $("selection");\r\n      if (!state.selection.length) {\r\n        mount.innerHTML = \'<div class="tiny">Select one or more frames in Figma, then click Refresh or change selection.</div>\';\r\n        return;\r\n      }\r\n      mount.innerHTML = state.selection.map((node) => nodeCard(node)).join("");\r\n    }\r\n\r\n    function renderSlots() {\r\n      const labels = { page: "Page frames", components: "Component frames", assets: "Asset frames" };\r\n      $("slots").innerHTML = ["page", "components", "assets"].map((role) => `\r\n        <div class="slot-block" style="margin-bottom:12px">\r\n          <div class="slot-header">\r\n            <h2>${labels[role]}</h2>\r\n            <span class="count">${state.slots[role].length} selected</span>\r\n          </div>\r\n          <div class="slot-list">${state.slots[role].length ? state.slots[role].map((node) => nodeCard(node, role)).join("") : \'<div class="tiny">No frames in this slot.</div>\'}</div>\r\n        </div>`).join("");\r\n      for (const button of document.querySelectorAll("[data-remove-role]")) {\r\n        button.addEventListener("click", () => {\r\n          const role = button.getAttribute("data-remove-role");\r\n          const id = button.getAttribute("data-remove-id");\r\n          state.slots[role] = state.slots[role].filter((node) => node.id !== id);\r\n          renderSlots();\r\n        });\r\n      }\r\n    }\r\n\r\n    function addSelection(role) {\r\n      if (!state.selection.length) {\n        setStatus("Select at least one frame in Figma first.", true);\n        return;\n      }\n      const selectedIds = new Set(state.selection.map((node) => node.id));\n      for (const otherRole of ["page", "components", "assets"]) {\n        if (otherRole !== role) state.slots[otherRole] = state.slots[otherRole].filter((node) => !selectedIds.has(node.id));\n      }\n      const existing = new Set(state.slots[role].map((node) => node.id));\n      for (const node of state.selection) {\r\n        if (!existing.has(node.id)) state.slots[role].push(node);\r\n      }\r\n      renderSlots();\r\n      setStatus(`Added ${state.selection.length} current selection item(s) to ${role}.`);\r\n    }\r\n\r\n    function collectRequest() {\r\n      if (!state.slots.page.length) throw new Error("Add at least one frame to the page slot before exporting.");\r\n      const request = {\r\n        frameSlots: {\r\n          page: state.slots.page.map((node) => node.id),\r\n          components: state.slots.components.map((node) => node.id),\r\n          assets: state.slots.assets.map((node) => node.id)\r\n        }\r\n      };\n      for (const field of fields) request[field] = $(field).value.trim();\n      if (!request.fileKey) request.fileKey = currentFileKey();\n      if (!request.fileKey) throw new Error("Figma fileKey is required. Paste the Figma file URL or fill File key override.");\n      request.designIssueNumber = Number(request.designIssueNumber || 1);\n      if (!Number.isInteger(request.designIssueNumber) || request.designIssueNumber <= 0) throw new Error("Design issue number must be a positive integer.");\n      request.targetDevIssueNumber = request.targetDevIssueNumber ? Number(request.targetDevIssueNumber) : undefined;\n      return request;\n    }\r\n\r\n    function post(type, extra = {}) {\r\n      parent.postMessage({ pluginMessage: { type, ...extra } }, "*");\r\n    }\r\n\r\n    $("refresh").onclick = () => post("refresh-selection");\r\n    $("addPage").onclick = () => addSelection("page");\r\n    $("addComponents").onclick = () => addSelection("components");\r\n    $("addAssets").onclick = () => addSelection("assets");\r\n    $("clearAll").onclick = () => { state.slots = { page: [], components: [], assets: [] }; renderSlots(); setStatus("Cleared all slots."); };\r\n    $("figmaUrl").addEventListener("input", () => renderSlots());\r\n    $("fileKey").addEventListener("input", () => renderSlots());\r\n\r\n    $("export").onclick = () => {\r\n      try {\r\n        setStatus("Building capture bundle...");\r\n        post("export-capture", { request: collectRequest() });\r\n      } catch (error) { setStatus(error.message, true); }\r\n    };\r\n    $("send").onclick = () => {\n      try {\n        const bridgeUrl = normalizeBridgeUrl($("bridgeUrl").value);\n        if (!bridgeUrl) throw new Error("Bridge URL must be exactly http://localhost:48732/capture.");\n        $("bridgeUrl").value = bridgeUrl;\n        setStatus("Sending capture bundle to local bridge...");\n        post("send-to-bridge", { request: collectRequest(), bridgeUrl });\n      } catch (error) { setStatus(error.message, true); }\n    };\n\r\n    onmessage = (event) => {\r\n      const message = event.data.pluginMessage;\r\n      if (!message) return;\r\n      if (message.type === "selection") {\r\n        state.selection = message.selection || [];\r\n        state.fileKeyFromFigma = message.fileKey || state.fileKeyFromFigma || "";\r\n        if (state.fileKeyFromFigma && !$("fileKey").value.trim()) $("fileKey").value = state.fileKeyFromFigma;\r\n        renderSelection();\r\n        renderSlots();\r\n        setStatus(`${state.selection.length} selected node(s). Add them into a slot when ready.`);\r\n      }\r\n      if (message.type === "export-ready") {\r\n        const blob = new Blob([JSON.stringify(message.bundle, null, 2)], { type: "application/json" });\r\n        const url = URL.createObjectURL(blob);\r\n        const a = document.createElement("a");\r\n        a.href = url;\r\n        a.download = `pragma-input-bundle-${Date.now()}.json`;\r\n        a.click();\r\n        URL.revokeObjectURL(url);\r\n        setStatus(`Capture bundle downloaded. Files: ${message.bundle.files.length}`);\r\n      }\r\n      if (message.type === "bridge-result") setStatus(JSON.stringify(message.bridgeResult, null, 2));\r\n      if (message.type === "error") setStatus(message.message, true);\r\n    };\r\n\r\n    renderSelection();\r\n    renderSlots();\r\n  <\/script>\r\n</body>\r\n</html>\r\n', { width: 520, height: 760, themeColors: true });
  function selectionSummary() {
    return figma.currentPage.selection.map((node) => ({
      id: node.id,
      nodeId: node.id,
      name: node.name,
      type: node.type,
      width: node.width,
      height: node.height
    }));
  }
  function postSelection() {
    figma.ui.postMessage({
      type: "selection",
      selection: selectionSummary(),
      page: {
        id: figma.currentPage.id,
        name: figma.currentPage.name,
        type: figma.currentPage.type
      },
      fileName: figma.root?.name,
      fileKey: figma.fileKey
    });
  }
  figma.on("selectionchange", postSelection);
  postSelection();
  function readableError(error) {
    if (error instanceof Error) return error.message || error.name;
    if (typeof error === "string") return error;
    try {
      return JSON.stringify(error, null, 2);
    } catch {
      return String(error);
    }
  }
  async function sendToBridge(bridgeUrl, bundle) {
    const endpoint = normalizeBridgeEndpoint(bridgeUrl);
    let healthResponse;
    try {
      healthResponse = await fetch(endpoint.healthUrl);
    } catch {
      throw new Error('Local bridge is not reachable. Start it with: npm run bridge -- serve --host localhost --port 48732 --repo "D:/path/to/repo".');
    }
    if (!healthResponse.ok) {
      throw new Error(`Local bridge health check failed with HTTP ${healthResponse.status}. Check that the bridge is running on localhost:48732.`);
    }
    const response = await fetch(endpoint.captureUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle })
    });
    const text = await response.text();
    let payload = text;
    try {
      payload = JSON.parse(text);
    } catch {
    }
    if (!response.ok) throw new Error(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
    return payload;
  }
  figma.ui.onmessage = async (message) => {
    try {
      if (message.type === "refresh-selection") {
        postSelection();
        return;
      }
      if (message.type === "close") {
        figma.closePlugin();
        return;
      }
      if (message.type === "export-capture" || message.type === "send-to-bridge") {
        const bundle = await buildCaptureBundle(message.request || {});
        if (message.type === "export-capture") {
          figma.ui.postMessage({ type: "export-ready", bundle });
          return;
        }
        const bridgeUrl = message.bridgeUrl || "http://localhost:48732/capture";
        const bridgeResult = await sendToBridge(bridgeUrl, bundle);
        figma.ui.postMessage({ type: "bridge-result", bridgeResult });
        return;
      }
    } catch (error) {
      figma.ui.postMessage({
        type: "error",
        message: readableError(error)
      });
    }
  };
})();
