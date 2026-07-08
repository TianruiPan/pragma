const EDITOR_TYPES = /* @__PURE__ */ new Set(["design", "file", "proto", "board", "slides", "make"]);
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
export {
  buildFigmaUrl,
  figmaNodeIdForUrl,
  normalizeFigmaNodeId,
  parseFigmaUrl,
  resolveRequiredFigmaFileKey
};
