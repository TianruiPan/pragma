export function normalizeFigmaNodeId(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const decoded = decodeURIComponent(String(value).trim());
  return decoded.replace(/-/g, ":");
}

export function figmaNodeIdForPath(value) {
  const normalized = normalizeFigmaNodeId(value) || "unknown";
  return normalized.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function segmentAfter(segments, marker) {
  const index = segments.indexOf(marker);
  return index >= 0 ? segments[index + 1] : undefined;
}

export function parseFigmaUrl(value) {
  if (!value) return {};
  let url;
  try {
    url = new URL(String(value));
  } catch (error) {
    throw new Error(`Invalid Figma URL: ${value}`);
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith("figma.com")) {
    throw new Error(`Not a figma.com URL: ${value}`);
  }
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const fileType = segments[0];
  const branchIndex = segments.indexOf("branch");
  const branchKey = branchIndex >= 0 ? segments[branchIndex + 1] : undefined;
  let fileKey;
  if (["design", "file", "board", "slides", "make"].includes(fileType)) {
    fileKey = segments[1];
  } else {
    fileKey = segmentAfter(segments, "design") || segmentAfter(segments, "file") || segmentAfter(segments, "board") || segmentAfter(segments, "slides") || segmentAfter(segments, "make");
  }
  const rawNodeId = url.searchParams.get("node-id") || url.searchParams.get("node_id") || url.searchParams.get("nodeId");
  return {
    url: String(value),
    fileType,
    fileKey,
    branchKey,
    nodeId: normalizeFigmaNodeId(rawNodeId),
    rawNodeId: rawNodeId || undefined
  };
}
