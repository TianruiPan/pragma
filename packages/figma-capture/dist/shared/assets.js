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
    bindings: (input.bindings || []).map(createAssetBinding),
    required: input.required !== false
  };
  if (/^sha256:[0-9a-f]{64}$/i.test(input.checksum || "")) record.checksum = input.checksum;
  else record.checksumStatus = input.checksumStatus || "unavailable";
  return record;
}
function createAssetBinding(input) {
  return {
    assetId: input.assetId,
    nodeId: input.nodeId,
    figmaNodeId: input.figmaNodeId,
    fit: input.fit || "contain",
    crop: input.crop ?? null,
    placement: input.placement ?? void 0
  };
}
export {
  assetTypeForMime,
  createAssetBinding,
  createAssetRecord,
  extensionForMime,
  safeNodeIdSegment,
  slugify,
  sniffAssetBytes,
  sniffMime
};
