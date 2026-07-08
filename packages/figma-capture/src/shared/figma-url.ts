export interface ParsedFigmaUrl {
  fileKey?: string;
  branchKey?: string;
  nodeId?: string;
  editorType?: "design" | "figjam" | "slides" | "make" | "proto" | "file";
  url?: string;
}

const EDITOR_TYPES = new Set(["design", "file", "proto", "board", "slides", "make"]);

export function normalizeFigmaNodeId(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  let text = String(value).trim();
  if (!text) return undefined;
  text = text.replace(/^node-id=/i, "");
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep the original value if it was not URI encoded.
  }
  text = text.replace(/^#/, "");
  if (text.includes("?")) text = text.split("?")[0] ?? text;
  if (text.includes("&")) text = text.split("&")[0] ?? text;
  return text.replace(/-/g, ":");
}

export function figmaNodeIdForUrl(value: string): string {
  return String(value).replace(/:/g, "-");
}

export function parseFigmaUrl(value: string | undefined | null): ParsedFigmaUrl {
  if (!value || !String(value).trim()) return {};
  let url: URL;
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
  const fileKey = editorIndex >= 0 ? segments[editorIndex + 1] : undefined;
  const branchIndex = segments.indexOf("branch");
  const branchKey = branchIndex >= 0 ? segments[branchIndex + 1] : undefined;
  const nodeId = normalizeFigmaNodeId(url.searchParams.get("node-id") || url.searchParams.get("node_id"));
  const editorType = editorSegment === "board" ? "figjam" : editorSegment as ParsedFigmaUrl["editorType"];

  return {
    fileKey: branchKey || fileKey,
    branchKey,
    nodeId,
    editorType,
    url: url.toString()
  };
}

export function buildFigmaUrl(fileKey: string, nodeId?: string): string {
  const base = `https://www.figma.com/design/${encodeURIComponent(fileKey)}/Pragma-Capture`;
  if (!nodeId) return base;
  return `${base}?node-id=${figmaNodeIdForUrl(nodeId)}`;
}

export function resolveRequiredFigmaFileKey(input: { override?: string; figmaUrl?: string; pluginFileKey?: string }): string {
  const fileKey = String(input.override || "").trim() || parseFigmaUrl(input.figmaUrl).fileKey || String(input.pluginFileKey || "").trim();
  if (!fileKey) throw new Error("Figma fileKey is required. Paste the Figma file URL or fill File key override.");
  return fileKey;
}
