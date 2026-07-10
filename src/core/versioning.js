import path from "node:path";
import fs from "node:fs/promises";
import { CliError } from "./errors.js";
import { isPathInside, pathExists, readJson, relativePosix, safeJoin, writeJson } from "./fs.js";
import { sha256File } from "./checksum.js";

const VERSION_RE = /^v(\d+)$/i;

export function normalizeVersion(value, fallback = "v1") {
  const raw = String(value || fallback).trim();
  const fromIssueVersion = raw.match(/(?:^|-)v(\d+)$/i);
  const match = raw.match(VERSION_RE) || fromIssueVersion;
  if (!match) throw new CliError(`Invalid Pragma context version: ${raw}. Use vN, for example v1.`);
  const versionNumber = Number(match[1]);
  if (!Number.isInteger(versionNumber) || versionNumber <= 0) {
    throw new CliError(`Invalid Pragma context version: ${raw}. Version number must be positive.`);
  }
  return { version: `v${versionNumber}`, versionNumber };
}

export function issueRootDir(repoPath, issueNumber) {
  return safeJoin(repoPath, ".pragma", "design-contexts", `issue-${Number(issueNumber)}`);
}

export function versionDirForIssue(repoPath, issueNumber, version) {
  return safeJoin(issueRootDir(repoPath, issueNumber), "versions", normalizeVersion(version).version);
}

export function issueRootRelative(issueNumber) {
  return `.pragma/design-contexts/issue-${Number(issueNumber)}`;
}

export function versionRelative(issueNumber, version) {
  return `${issueRootRelative(issueNumber)}/versions/${normalizeVersion(version).version}`;
}

export function isVersionDir(contextDir) {
  const versionName = path.basename(contextDir);
  const versionsName = path.basename(path.dirname(contextDir)).toLowerCase();
  return VERSION_RE.test(versionName) && versionsName === "versions";
}

export function issueRootFromVersionDir(versionDir) {
  return path.dirname(path.dirname(path.resolve(versionDir)));
}

export function versionFromContextDir(contextDir) {
  if (!isVersionDir(contextDir)) return undefined;
  return normalizeVersion(path.basename(contextDir));
}

export function currentPathForIssueRoot(issueRoot) {
  return path.join(issueRoot, "current.json");
}

export async function readCurrentPointer(issueRoot) {
  const currentPath = currentPathForIssueRoot(issueRoot);
  if (!(await pathExists(currentPath))) return undefined;
  return readJson(currentPath);
}

export async function writeCurrentPointer({ issueRoot, designIssue, version, reason = "designer-published-new-context", updatedBy = "pragma design publish" }) {
  const normalized = normalizeVersion(version);
  const current = {
    schemaVersion: "2.0",
    kind: "pragma-design-context-current",
    designIssue,
    currentVersion: normalized.version,
    currentManifest: `versions/${normalized.version}/manifest.json`,
    updatedAt: new Date().toISOString(),
    updatedBy,
    reason
  };
  await writeJson(currentPathForIssueRoot(issueRoot), current);
  return current;
}

export async function nextVersionForIssueRoot(issueRoot) {
  const current = await readCurrentPointer(issueRoot).catch(() => undefined);
  if (current?.currentVersion) {
    const parsed = normalizeVersion(current.currentVersion);
    return normalizeVersion(`v${parsed.versionNumber + 1}`);
  }
  const versionsDir = path.join(issueRoot, "versions");
  if (!(await pathExists(versionsDir))) return normalizeVersion("v1");
  const entries = await fs.readdir(versionsDir, { withFileTypes: true }).catch(() => []);
  const max = entries
    .filter((entry) => entry.isDirectory() && VERSION_RE.test(entry.name))
    .map((entry) => normalizeVersion(entry.name).versionNumber)
    .reduce((acc, value) => Math.max(acc, value), 0);
  return normalizeVersion(`v${max + 1}`);
}

export async function chooseVersion({ issueRoot, requestedVersion, bump }) {
  if (String(bump || "").toLowerCase() === "auto") return nextVersionForIssueRoot(issueRoot);
  return normalizeVersion(requestedVersion || "v1");
}

export async function resolveVersionContext(options) {
  if (options.context) {
    const input = path.resolve(String(options.context));
    const requestedVersion = options.version && options.version !== "current" ? normalizeVersion(options.version) : undefined;
    const inputVersion = versionFromContextDir(input);
    if (inputVersion && requestedVersion && inputVersion.version !== requestedVersion.version) {
      throw new CliError(`Requested version ${requestedVersion.version} does not match context directory version ${inputVersion.version}.`);
    }
    if (!inputVersion && requestedVersion) {
      const versionContextDir = path.join(input, "versions", requestedVersion.version);
      const versionManifestPath = path.join(versionContextDir, "manifest.json");
      if (await pathExists(versionManifestPath)) {
        return {
          contextDir: versionContextDir,
          manifestPath: versionManifestPath,
          issueRoot: input,
          version: requestedVersion.version
        };
      }
    }
    const current = await readCurrentPointer(input).catch(() => undefined);
    if (current?.currentManifest && !isVersionDir(input)) {
      const version = requestedVersion || normalizeVersion(current.currentVersion);
      const contextDir = path.join(input, "versions", version.version);
      return {
        contextDir,
        manifestPath: path.join(contextDir, "manifest.json"),
        issueRoot: input,
        current,
        version: version.version
      };
    }
    const manifestPath = path.join(input, "manifest.json");
    if (await pathExists(manifestPath)) {
      return {
        contextDir: input,
        manifestPath,
        issueRoot: isVersionDir(input) ? issueRootFromVersionDir(input) : input,
        version: versionFromContextDir(input)?.version
      };
    }
    if (!current?.currentManifest) throw new CliError(`No manifest.json or current.json found under context: ${input}`);
    const version = requestedVersion || normalizeVersion(current.currentVersion);
    const contextDir = path.join(input, "versions", version.version);
    return {
      contextDir,
      manifestPath: path.join(contextDir, "manifest.json"),
      issueRoot: input,
      current,
      version: version.version
    };
  }

  if (options.manifest) {
    const manifestPath = path.resolve(String(options.manifest));
    const contextDir = path.dirname(manifestPath);
    const contextVersion = versionFromContextDir(contextDir);
    if (contextVersion && options.version && options.version !== "current" && normalizeVersion(options.version).version !== contextVersion.version) {
      throw new CliError(`Requested version ${normalizeVersion(options.version).version} does not match manifest directory version ${contextVersion.version}.`);
    }
    return {
      contextDir,
      manifestPath,
      issueRoot: isVersionDir(contextDir) ? issueRootFromVersionDir(contextDir) : contextDir,
      version: contextVersion?.version
    };
  }

  if (options.repo && options.issue) {
    const repoPath = path.resolve(String(options.repo));
    const issueNumber = Number(options.issue);
    const issueRoot = issueRootDir(repoPath, issueNumber);
    let version;
    let current;
    if (options.version && options.version !== "current") {
      version = normalizeVersion(options.version);
    } else {
      current = await readCurrentPointer(issueRoot);
      if (!current?.currentVersion) {
        throw new CliError(`Design Issue #${issueNumber} has no current pointer at ${currentPathForIssueRoot(issueRoot)}. The design context is not ready or has not been merged into this branch.`, 2, "PRAGMA_DESIGN_CONTEXT_BLOCKED", { issue: issueNumber, currentPath: currentPathForIssueRoot(issueRoot) });
      }
      version = normalizeVersion(current.currentVersion);
    }
    const contextDir = versionDirForIssue(repoPath, issueNumber, version.version);
    return {
      contextDir,
      manifestPath: path.join(contextDir, "manifest.json"),
      issueRoot,
      current,
      version: version.version
    };
  }

  throw new CliError("Use --context, --manifest, or --repo --issue.");
}

export async function manifestChecksum(manifestPath) {
  return sha256File(manifestPath);
}

export function repoRelativeManifest(repoRoot, manifestPath) {
  return relativePosix(repoRoot, manifestPath);
}

export function ensureContextInsideIssueRoot(issueRoot, contextDir) {
  if (!isPathInside(path.join(issueRoot, "versions"), contextDir)) {
    throw new CliError("Resolved context version path is outside the Design Issue versions directory.", 1, "PRAGMA_UNSAFE_CONTEXT_PATH", { contextDir, issueRoot });
  }
}
