import { sha256Text } from "./checksum.js";
import { figmaNodeIdForPath, normalizeFigmaNodeId } from "./figma-url.js";
import { asArray } from "./normalize.js";

const STATUSES = new Set(["selected", "reused", "missing", "none"]);

function shortSha(value) {
  return sha256Text(value).replace(/^sha256:/, "").slice(0, 12);
}

function defaultRules(lock = {}) {
  return {
    lockDependencies: true,
    neverDependOnFloatingLatest: true,
    ifMissingComponentsAndPageHasInstances: "block",
    ifMissingAssetsAndPageHasUnresolvedRefs: "block",
    ...(lock.rules || {})
  };
}

function normalizePageFrame(frame, capturedAt, index) {
  const nodeId = normalizeFigmaNodeId(frame.nodeId || frame.figmaNodeId || frame.id || frame) || `page:${index + 1}`;
  const bounds = typeof frame === "object" ? (frame.bounds || frame.absoluteBoundingBox) : undefined;
  const viewport = typeof frame === "object"
    ? (frame.viewport || (bounds || frame.width || frame.height ? {
      width: frame.width ?? bounds?.width,
      height: frame.height ?? bounds?.height
    } : undefined))
    : undefined;
  const normalized = {
    nodeId,
    name: typeof frame === "object" ? frame.name : undefined,
    snapshotId: typeof frame === "object" && frame.snapshotId ? frame.snapshotId : `page-${figmaNodeIdForPath(nodeId)}-${shortSha(`${nodeId}:${capturedAt}`)}`
  };
  if (typeof frame === "object") {
    if (frame.role) normalized.role = frame.role;
    if (frame.type || frame.nodeType) normalized.type = frame.type || frame.nodeType;
    if (frame.url) normalized.url = frame.url;
    if (bounds) normalized.bounds = bounds;
    if (viewport) normalized.viewport = viewport;
    const width = frame.width ?? bounds?.width ?? viewport?.width;
    const height = frame.height ?? bounds?.height ?? viewport?.height;
    if (width !== undefined || height !== undefined) {
      normalized.width = width;
      normalized.height = height;
    }
  }
  return normalized;
}

function normalizeStatus(value, fallback = "none") {
  const status = String(value || fallback).toLowerCase();
  return STATUSES.has(status) ? status : fallback;
}

function normalizeRole(role, input = undefined) {
  const status = normalizeStatus(input?.status, "none");
  const entry = { status };
  if (input?.frameNodeId || input?.nodeId || input?.figmaNodeId) entry.frameNodeId = normalizeFigmaNodeId(input.frameNodeId || input.nodeId || input.figmaNodeId);
  const frameNodeIds = asArray(input?.frameNodeIds)
    .map((nodeId) => normalizeFigmaNodeId(nodeId))
    .filter(Boolean);
  if (frameNodeIds.length) entry.frameNodeIds = frameNodeIds;
  else if (entry.frameNodeId) entry.frameNodeIds = [entry.frameNodeId];
  if (input?.snapshotId) entry.snapshotId = String(input.snapshotId);
  if (input?.path) entry.path = String(input.path).replace(/\\/g, "/");
  if (input?.checksum) entry.checksum = String(input.checksum);
  if (input?.name) entry.name = input.name;
  if (input?.optional !== undefined) entry.optional = Boolean(input.optional);
  if (input?.external !== undefined) entry.external = Boolean(input.external);
  return entry;
}

export function buildDependencies({ dependencyLock = {}, capture = {}, selectionNodes = [], selectionFrames = {} }) {
  const capturedAt = dependencyLock.capturedAt || capture.capturedAt || new Date().toISOString();
  const fileKey = dependencyLock.fileKey || capture.figma?.fileKey;
  const pageCandidates = dependencyLock.pageFrames || dependencyLock.frames?.page || capture.figma?.frames?.page || selectionFrames.page || selectionNodes;
  return {
    schemaVersion: "2.0",
    kind: "pragma-design-dependencies",
    fileKey,
    capturedAt,
    pageFrames: asArray(pageCandidates).map((frame, index) => normalizePageFrame(frame, capturedAt, index)),
    components: normalizeRole("components", dependencyLock.components),
    assets: normalizeRole("assets", dependencyLock.assets),
    rules: defaultRules(dependencyLock)
  };
}

export function isConcreteSnapshotId(snapshotId, role) {
  const value = String(snapshotId || "");
  return value.startsWith(`${role}-`) && !/latest/i.test(value);
}

export function isValidDependencyStatus(status) {
  return STATUSES.has(String(status || ""));
}
