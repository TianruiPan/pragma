import { CliError } from "./errors.js";
import { readJson } from "./fs.js";
import { manifestChecksum, resolveVersionContext } from "./versioning.js";

async function readVersion(options, version) {
  const resolved = await resolveVersionContext({ repo: options.repo || process.cwd(), issue: options.issue, context: options.context, version });
  const manifest = await readJson(resolved.manifestPath);
  const manifestDigest = await manifestChecksum(resolved.manifestPath);
  return {
    version,
    contextDir: resolved.contextDir,
    manifestPath: resolved.manifestPath,
    checksum: manifest.packageChecksum || manifestDigest,
    packageChecksum: manifest.packageChecksum,
    manifestChecksum: manifestDigest,
    manifest
  };
}

function countChanged(left = [], right = []) {
  const l = new Set(left);
  const r = new Set(right);
  return {
    added: [...r].filter((item) => !l.has(item)),
    removed: [...l].filter((item) => !r.has(item))
  };
}

export async function diffDesignContext(options) {
  if (!options.issue && !options.context) throw new CliError("--issue is required for design diff unless --context points to an issue root.");
  if (!options.from || !options.to) throw new CliError("--from and --to are required for design diff.");
  const from = await readVersion(options, options.from);
  const to = await readVersion(options, options.to);
  const sourceNodes = countChanged(from.manifest.source?.nodes || [], to.manifest.source?.nodes || []);
  const linkedDevelopmentIssues = countChanged(from.manifest.linkedDevelopmentIssues || [], to.manifest.linkedDevelopmentIssues || []);
  return {
    ok: true,
    command: "design diff",
    issue: Number(options.issue || from.manifest.issue?.number || to.manifest.issue?.number),
    from: {
      version: from.manifest.version,
      manifestPath: from.manifestPath,
      checksum: from.checksum,
      packageChecksum: from.packageChecksum,
      manifestChecksum: from.manifestChecksum
    },
    to: {
      version: to.manifest.version,
      manifestPath: to.manifestPath,
      checksum: to.checksum,
      packageChecksum: to.packageChecksum,
      manifestChecksum: to.manifestChecksum
    },
    changed: from.manifestChecksum !== to.manifestChecksum,
    summary: {
      changeSummary: to.manifest.changeSummary,
      compatibility: to.manifest.compatibility,
      sourceNodes,
      linkedDevelopmentIssues,
      packageChanged: from.packageChecksum !== to.packageChecksum,
      manifestChanged: from.manifestChecksum !== to.manifestChecksum,
      entrypointsChanged: JSON.stringify(from.manifest.entrypoints || {}) !== JSON.stringify(to.manifest.entrypoints || {}),
      artifactChanged: JSON.stringify(from.manifest.artifact || {}) !== JSON.stringify(to.manifest.artifact || {})
    },
    note: "MVP diff is a structured summary for human review; Pragma does not decide whether design changes can be ignored."
  };
}
