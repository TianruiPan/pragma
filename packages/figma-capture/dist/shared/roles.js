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
      role: frame.role
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
export {
  assertFrameRoles,
  buildCaptureJson,
  buildPluginOnlyDependencyLock,
  buildSelectionJson,
  frameList
};
