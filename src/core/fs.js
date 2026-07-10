import fs from "node:fs/promises";
import path from "node:path";

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readText(filePath, fallback = undefined) {
  if (!(await pathExists(filePath))) {
    if (fallback !== undefined) return fallback;
    throw new Error(`File not found: ${filePath}`);
  }
  return fs.readFile(filePath, "utf8");
}

export async function readJson(filePath, fallback = undefined) {
  if (!(await pathExists(filePath))) {
    if (fallback !== undefined) return fallback;
    throw new Error(`File not found: ${filePath}`);
  }
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

export async function writeText(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
}

export async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function copyFileIfExists(from, to) {
  if (!(await pathExists(from))) return false;
  await ensureDir(path.dirname(to));
  await fs.copyFile(from, to);
  return true;
}

export async function copyDirIfExists(from, to) {
  if (!(await pathExists(from))) return false;
  await ensureDir(to);
  await fs.cp(from, to, { recursive: true, force: true });
  return true;
}

export async function listFilesRecursive(rootDir) {
  if (!(await pathExists(rootDir))) return [];
  const results = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        results.push(absolute);
      }
    }
  }
  await walk(rootDir);
  return results.sort((a, b) => a.localeCompare(b));
}

export async function directorySizeBytes(rootDir, options = {}) {
  const files = await listFilesRecursive(rootDir);
  let total = 0;
  for (const file of files) {
    if (options.exclude?.some((predicate) => predicate(file))) continue;
    const stat = await fs.stat(file);
    total += stat.size;
  }
  return total;
}

export function toPosixPath(value) {
  return String(value).replace(/\\/g, "/").split(path.sep).join("/");
}

export function relativePosix(from, to) {
  return toPosixPath(path.relative(from, to));
}

export function normalizeRelativePosix(value) {
  const normalized = toPosixPath(String(value || "")).replace(/^\.\/+/, "");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error(`Unsafe relative path: ${value}`);
  }
  return parts.join("/");
}

export function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function safeJoin(root, ...parts) {
  const target = path.resolve(root, ...parts);
  if (!isPathInside(root, target)) {
    throw new Error(`Refusing to access path outside root: ${target}`);
  }
  return target;
}

export function resolveRepoRootFromContext(contextDir) {
  const resolved = path.resolve(contextDir);
  const parts = resolved.split(path.sep);
  const pragmaIndex = parts.map((part) => part.toLowerCase()).lastIndexOf(".pragma");
  if (pragmaIndex <= 0) return undefined;
  return parts.slice(0, pragmaIndex).join(path.sep) || path.parse(resolved).root;
}

export async function resetDirIfSafe(dir) {
  const normalized = path.resolve(dir);
  const parts = normalized.split(path.sep).map((part) => part.toLowerCase());
  const insidePragmaDesignContexts = parts.includes(".pragma") && parts.includes("design-contexts");
  const issueLike = path.basename(normalized).startsWith("issue-");
  const versionLike = /^v\d+$/i.test(path.basename(normalized)) && path.basename(path.dirname(normalized)).toLowerCase() === "versions";
  if (!insidePragmaDesignContexts || (!issueLike && !versionLike)) {
    throw new Error(`Refusing to reset unsafe context directory: ${dir}`);
  }
  await fs.rm(normalized, { recursive: true, force: true });
  await ensureDir(normalized);
}
