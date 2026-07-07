import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listFilesRecursive, relativePosix, writeJson } from "./fs.js";

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}

export function sha256Text(text) {
  return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

export async function generateChecksums(contextDir) {
  const files = await listFilesRecursive(contextDir);
  const entries = [];
  for (const file of files) {
    const rel = relativePosix(contextDir, file);
    if (rel === "checksums.json") continue;
    entries.push({ path: rel, checksum: await sha256File(file) });
  }
  const checksums = {
    schemaVersion: "2.0",
    kind: "pragma-design-checksums",
    algorithm: "sha256",
    generatedAt: new Date().toISOString(),
    files: entries
  };
  await writeJson(path.join(contextDir, "checksums.json"), checksums);
  return checksums;
}
