import type { BundleFile, PragmaInputBundle } from "./types.js";

export function jsonFile(path: string, content: unknown): BundleFile {
  return { path, kind: "json", content };
}

export function textFile(path: string, content: string): BundleFile {
  return { path, kind: "text", content };
}

export function binaryFile(path: string, base64: string, mime: string, checksum?: string): BundleFile {
  return { path, kind: "binary", base64, mime, checksum };
}

export function createPragmaInputBundle(files: BundleFile[], createdAt = new Date().toISOString(), summary: Record<string, unknown> = {}): PragmaInputBundle {
  return {
    schemaVersion: "2.0",
    kind: "pragma-figma-capture-bundle",
    createdAt,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    summary
  };
}

export function bundleFilePaths(bundle: PragmaInputBundle): string[] {
  return bundle.files.map((file) => file.path).sort();
}
