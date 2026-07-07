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
  return {
    nodeId,
    name: typeof frame === "object" ? frame.name : undefined,
    snapshotId: typeof frame === "object" && frame.snapshotId ? frame.snapshotId : `page-${figmaNodeIdForPath(nodeId)}-${shortSha(`${nodeId}:${capturedAt}`)}`
  };
}

function normalizeStatus(value, fallback = "none") {
  const status = String(value || fallback).toLowerCase();
  return STATUSES.has(status) ? status : fallback;
}

function normalizeRole(role, input = undefined) {
  const status = normalizeStatus(input?.status, "none");
  const entry = { status };
  if (input?.frameNodeId || input?.nodeId || input?.figmaNodeId) entry.frameNodeId = normalizeFigmaNodeId(input.frameNodeId || input.nodeId || input.figmaNodeId);
  if (input?.snapshotId) entry.snapshotId = String(input.snapshotId);
  if (input?.path) entry.path = String(input.path).replace(/\\/g, "/");
  if (input?.checksum) entry.checksum = String(input.checksum);
  if (input?.name) entry.name = input.name;
  if (input?.optional !== undefined) entry.optional = Boolean(input.optional);
  if (input?.external !== undefined) entry.external = Boolean(input.external);
  return entry;
}

export function buildDependencies({ dependencyLock = {}, capture = {}, selectionNodes = [] }) {
  const capturedAt = dependencyLock.capturedAt || capture.capturedAt || new Date().toISOString();
  const fileKey = dependencyLock.fileKey || capture.figma?.fileKey;
  const pageCandidates = dependencyLock.pageFrames || dependencyLock.frames?.page || capture.figma?.frames?.page || selectionNodes;
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
