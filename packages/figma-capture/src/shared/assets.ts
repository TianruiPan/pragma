import type { RectLike } from "./types.js";

export interface AssetBindingInput {
  assetId: string;
  nodeId?: string;
  figmaNodeId?: string;
  fit?: string;
  crop?: object | null;
  placement?: RectLike | null;
}

export function slugify(value: string | undefined | null, fallback = "item"): string {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function safeNodeIdSegment(value: string): string {
  return slugify(String(value).replace(/:/g, "-"), "node");
}

export function sniffMime(bytes: Uint8Array, fallback = "application/octet-stream"): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 6) {
    const head = String.fromCharCode(...bytes.slice(0, 6)).toLowerCase();
    if (head.startsWith("gif")) return "image/gif";
  }
  const textHead = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 256))).trimStart().toLowerCase();
  if (textHead.startsWith("<svg") || textHead.startsWith("<?xml")) return "image/svg+xml";
  return fallback;
}

function dataView(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readUInt24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
}

function parseSvgDimension(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^\s*([0-9.]+)/);
  return match ? Number(match[1]) : undefined;
}

export function sniffAssetBytes(bytes: Uint8Array, fallback = "application/octet-stream"): { mime: string; width?: number; height?: number } {
  const mime = sniffMime(bytes, fallback);
  const view = dataView(bytes);
  if (mime === "image/png" && bytes.length >= 24) {
    return { mime, width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === "image/jpeg" && bytes.length >= 4) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      const length = view.getUint16(offset + 2);
      if (length < 2) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { mime, height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  if (mime === "image/webp" && bytes.length >= 30) {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8X") return { mime, width: readUInt24LE(bytes, 24) + 1, height: readUInt24LE(bytes, 27) + 1 };
    if (chunk === "VP8 ") return { mime, width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L" && bytes.length >= 25) {
      const b0 = bytes[21];
      const b1 = bytes[22];
      const b2 = bytes[23];
      const b3 = bytes[24];
      return {
        mime,
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      };
    }
  }
  if (mime === "image/svg+xml") {
    const text = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 4096))).replace(/^\uFEFF/, "");
    const openTag = text.match(/<svg\b[^>]*>/i)?.[0] || "";
    const viewBox = openTag.match(/\bviewBox=["']([^"']+)["']/i)?.[1]?.trim().split(/[\s,]+/).map(Number);
    return {
      mime,
      width: parseSvgDimension(openTag.match(/\bwidth=["']([^"']+)["']/i)?.[1]) ?? (viewBox && viewBox.length === 4 ? viewBox[2] : undefined),
      height: parseSvgDimension(openTag.match(/\bheight=["']([^"']+)["']/i)?.[1]) ?? (viewBox && viewBox.length === 4 ? viewBox[3] : undefined)
    };
  }
  return { mime };
}

export function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    case "image/svg+xml": return "svg";
    default: return "bin";
  }
}

export function assetTypeForMime(mime: string): string {
  return extensionForMime(mime);
}

export function createAssetRecord(input: {
  id: string;
  name: string;
  role?: string;
  mime: string;
  path: string;
  width?: number;
  height?: number;
  checksum?: string;
  checksumStatus?: "unavailable";
  sourceNodeIds?: string[];
  bindings?: AssetBindingInput[];
  required?: boolean;
}) {
  const record: Record<string, unknown> = {
    id: input.id,
    name: input.name,
    role: input.role || "implementation-asset",
    type: assetTypeForMime(input.mime),
    path: input.path,
    mime: input.mime,
    width: input.width,
    height: input.height,
    sourceNodeIds: input.sourceNodeIds || [],
    bindings: (input.bindings || []).map(createAssetBinding),
    required: input.required !== false
  };
  if (/^sha256:[0-9a-f]{64}$/i.test(input.checksum || "")) record.checksum = input.checksum;
  else record.checksumStatus = input.checksumStatus || "unavailable";
  return record;
}

export function createAssetBinding(input: AssetBindingInput) {
  return {
    assetId: input.assetId,
    nodeId: input.nodeId,
    figmaNodeId: input.figmaNodeId,
    fit: input.fit || "contain",
    crop: input.crop ?? null,
    placement: input.placement ?? undefined
  };
}
