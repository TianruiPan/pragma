import fs from "node:fs/promises";
import path from "node:path";

const MIME_BY_TYPE = {
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  jpeg: "image/jpeg",
  jpg: "image/jpeg"
};

export function mimeForType(type) {
  return MIME_BY_TYPE[String(type || "").toLowerCase()] || "application/octet-stream";
}

export function typeFromExtension(filePath) {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return ext === "jpg" ? "jpeg" : ext;
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16);
}

function sniffPng(buffer) {
  if (buffer.length < 24) return undefined;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => buffer[index] === byte)) return undefined;
  return { type: "png", mime: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function sniffJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { type: "jpeg", mime: "image/jpeg", height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { type: "jpeg", mime: "image/jpeg" };
}

function sniffWebp(buffer) {
  if (buffer.length < 16) return undefined;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return { type: "webp", mime: "image/webp", width: readUInt24LE(buffer, 24) + 1, height: readUInt24LE(buffer, 27) + 1 };
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    return { type: "webp", mime: "image/webp", width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && buffer.length >= 25) {
    const b0 = buffer[21];
    const b1 = buffer[22];
    const b2 = buffer[23];
    const b3 = buffer[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { type: "webp", mime: "image/webp", width, height };
  }
  return { type: "webp", mime: "image/webp" };
}

function parseSvgDimension(value) {
  if (!value) return undefined;
  const numeric = String(value).match(/^\s*([0-9.]+)/);
  return numeric ? Number(numeric[1]) : undefined;
}

function sniffSvg(buffer) {
  const text = buffer.toString("utf8", 0, Math.min(buffer.length, 4096)).replace(/^\uFEFF/, "").trimStart();
  if (!text.startsWith("<svg") && !/^<\?xml[\s\S]*?<svg/i.test(text)) return undefined;
  const openTag = text.match(/<svg\b[^>]*>/i)?.[0] || "";
  const width = parseSvgDimension(openTag.match(/\bwidth=["']([^"']+)["']/i)?.[1]);
  const height = parseSvgDimension(openTag.match(/\bheight=["']([^"']+)["']/i)?.[1]);
  const viewBox = openTag.match(/\bviewBox=["']([^"']+)["']/i)?.[1]?.trim().split(/[\s,]+/).map(Number);
  return {
    type: "svg",
    mime: "image/svg+xml",
    width: width ?? (viewBox && viewBox.length === 4 ? viewBox[2] : undefined),
    height: height ?? (viewBox && viewBox.length === 4 ? viewBox[3] : undefined)
  };
}

export function sniffAssetBuffer(buffer) {
  return sniffPng(buffer) || sniffJpeg(buffer) || sniffWebp(buffer) || sniffSvg(buffer) || {
    type: "binary",
    mime: "application/octet-stream"
  };
}

export async function sniffAssetFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return sniffAssetBuffer(buffer);
}

export function isSupportedAssetType(type) {
  return ["svg", "png", "webp", "jpeg", "jpg"].includes(String(type || "").toLowerCase());
}
