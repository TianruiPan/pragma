import fs from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";
import { directorySizeBytes, readJson, readText, writeJson } from "./fs.js";
import { canonicalPackageChecksum, generateChecksums, sha256File } from "./checksum.js";
import { packDesignContext } from "./pack.js";
import { assertValidDesignContext } from "./validate.js";
import { currentPathForIssueRoot, issueRootDir, normalizeVersion, resolveVersionContext, versionRelative, writeCurrentPointer } from "./versioning.js";
import { pragmaContextObjectKey, resolveMinioPublishConfig, uploadImmutableMinioObject } from "./minio.js";

function mbToBytes(value) {
  return Number(value) * 1024 * 1024;
}

async function pruneRepoPayload(contextDir, fileName) {
  await fs.rm(path.join(contextDir, "assets"), { recursive: true, force: true });
  await fs.rm(path.join(contextDir, "source"), { recursive: true, force: true });
  await fs.rm(path.join(contextDir, fileName), { force: true });
  await generateChecksums(contextDir);
}

export async function publishDesignContext(options) {
  const resolved = options.context
    ? await resolveVersionContext({ context: options.context, version: options.version })
    : await resolveVersionContext({ repo: options.repo || process.cwd(), issue: options.issue, version: options.version || (options.bump ? await inferVersionFromBump(options) : "v1") });
  const contextDir = resolved.contextDir;
  await fs.rm(path.join(contextDir, "context.zip"), { force: true });
  await assertValidDesignContext({ context: contextDir });
  const thresholdMb = Number(options["threshold-mb"] || options.thresholdMb || 20);
  const maxMb = Number(options["max-mb"] || options.maxMb || 100);
  const dryRun = Boolean(options["dry-run"] || options.dryRun);
  const thresholdBytes = mbToBytes(thresholdMb);
  const maxBytes = mbToBytes(maxMb);
  const sizeBytes = await directorySizeBytes(contextDir, {
    exclude: [(file) => path.basename(file) === "context.zip"]
  });
  const manifestPath = path.join(contextDir, "manifest.json");
  const manifest = await readJson(manifestPath);
  const changeSummaryText = options.changeSummaryText
    || (options["change-summary"] ? await readText(path.resolve(String(options["change-summary"]))) : undefined)
    || (options.changeSummary ? await readText(path.resolve(String(options.changeSummary))).catch(() => String(options.changeSummary)) : undefined);
  const manifestIssueNumber = Number(manifest.issue?.number);
  const requestedIssueNumber = options.issue === undefined ? undefined : Number(options.issue);
  if (requestedIssueNumber !== undefined && requestedIssueNumber !== manifestIssueNumber) {
    throw new CliError(`Requested Design Issue #${requestedIssueNumber} does not match manifest.issue.number #${manifestIssueNumber}.`);
  }
  const issueNumber = Number(requestedIssueNumber || manifestIssueNumber);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new CliError("--issue or manifest.issue.number is required for design publish.");
  const repoRoot = options.repo ? path.resolve(String(options.repo)) : path.resolve(contextDir.split(`${path.sep}.pragma${path.sep}`)[0] || process.cwd());
  const issueRoot = resolved.issueRoot && path.basename(resolved.issueRoot).startsWith("issue-")
    ? resolved.issueRoot
    : issueRootDir(repoRoot, issueNumber);
  const versionInfo = normalizeVersion(manifest.version || resolved.version || path.basename(contextDir));
  if (options.version && normalizeVersion(options.version).version !== versionInfo.version) {
    throw new CliError(`Requested version ${normalizeVersion(options.version).version} does not match context manifest version ${versionInfo.version}.`);
  }
  if (resolved.version && normalizeVersion(resolved.version).version !== versionInfo.version) {
    throw new CliError(`Context directory version ${resolved.version} does not match manifest version ${versionInfo.version}.`);
  }
  const supersedes = options.supersedes ? normalizeVersion(options.supersedes) : (manifest.supersedes ? normalizeVersion(manifest.supersedes) : undefined);
  if (supersedes && supersedes.versionNumber >= versionInfo.versionNumber) {
    throw new CliError(`manifest.supersedes must be older than ${versionInfo.version}.`);
  }
  manifest.version = versionInfo.version;
  manifest.integrationContractVersion = "pragma-integration/v2";
  manifest.versionNumber = versionInfo.versionNumber;
  manifest.supersedes = supersedes?.version || null;
  if (changeSummaryText) manifest.changeSummary = changeSummaryText;
  manifest.changeSummary = manifest.changeSummary || (manifest.supersedes ? `Design context update ${manifest.version}.` : `Initial design context for issue #${issueNumber}.`);
  manifest.issue = { ...(manifest.issue || {}), provider: "gitea", number: issueNumber, type: "design" };
  manifest.linkedDevelopmentIssues = manifest.linkedDevelopmentIssues || (manifest.issue.targetDevIssues || []).map((issue) => Number(issue.number ?? issue)).filter((issue) => Number.isInteger(issue) && issue > 0);
  manifest.compatibility = {
    breakingChange: false,
    requiresDevIssueReview: false,
    reason: manifest.supersedes ? "new design context version" : "initial version",
    ...(manifest.compatibility || {})
  };
  manifest.packageChecksum = await canonicalPackageChecksum(contextDir);

  if (sizeBytes > maxBytes) {
    throw new CliError(`Context is ${(sizeBytes / 1024 / 1024).toFixed(2)}MB, over the MVP max of ${maxMb}MB.`);
  }

  if (sizeBytes <= thresholdBytes) {
    const checksum = manifest.packageChecksum;
    manifest.artifact = {
      storage: "repo",
      owner: manifest.issue.repo?.split("/")?.[0],
      fileName: null,
      checksum,
      path: versionRelative(issueNumber, manifest.version)
    };
    await writeJson(manifestPath, manifest);
    await generateChecksums(contextDir);
    const current = dryRun ? undefined : await writeCurrentPointer({
      issueRoot,
      designIssue: {
        provider: "gitea",
        repo: manifest.issue.repo,
        number: issueNumber
      },
      version: manifest.version,
      reason: options.reason || "designer-published-new-context"
    });
    return {
      mode: "repo",
      contextDir,
      sizeBytes,
      manifest,
      current,
      currentPath: current ? currentPathForIssueRoot(issueRoot) : undefined
    };
  }

  const fileName = options["file-name"] || options.fileName || "context.zip";
  const minio = resolveMinioPublishConfig(options, { credentialsRequired: !dryRun });
  const objectKey = pragmaContextObjectKey({
    objectPrefix: minio.objectPrefix,
    repo: manifest.issue.repo,
    designIssue: issueNumber,
    version: manifest.version,
    fileName
  });

  const packed = await packDesignContext({
    context: contextDir,
    ...(options.zip ? { zip: path.resolve(String(options.zip)) } : {}),
    excludeControlFiles: true,
  });
  const zipPath = packed.zipPath;
  const checksum = await sha256File(zipPath);
  const archiveSizeBytes = (await fs.stat(zipPath)).size;

  manifest.artifact = {
    storage: "minio-s3",
    bucket: minio.bucket,
    objectKey,
    uri: `s3://${minio.bucket}/${objectKey}`,
    fileName,
    checksum,
    archiveSizeBytes,
    publishedAt: new Date().toISOString(),
    dryRun
  };
  await writeJson(manifestPath, manifest);
  await generateChecksums(contextDir);

  const pruneRepo = options["prune-repo"] || options.pruneRepo;
  if (!dryRun) {
    await uploadImmutableMinioObject({
      config: minio,
      bucket: minio.bucket,
      objectKey,
      zipPath,
      checksum,
      sizeBytes: archiveSizeBytes,
      client: options.minioClient
    });
  }
  if (pruneRepo) {
    if (dryRun) throw new CliError("--prune-repo requires a real upload; omit --dry-run first.");
    await pruneRepoPayload(contextDir, fileName);
  }
  const current = dryRun ? undefined : await writeCurrentPointer({
    issueRoot,
    designIssue: {
      provider: "gitea",
      repo: manifest.issue.repo,
      number: issueNumber
    },
    version: manifest.version,
    reason: options.reason || "designer-published-new-context"
  });

  return {
    mode: "minio-s3",
    contextDir,
    zipPath: pruneRepo ? undefined : zipPath,
    sizeBytes,
    checksum,
    packageChecksum: manifest.packageChecksum,
    pruned: Boolean(pruneRepo),
    manifest,
    current,
    currentPath: current ? currentPathForIssueRoot(issueRoot) : undefined
  };
}

async function inferVersionFromBump(options) {
  const repoPath = path.resolve(String(options.repo || process.cwd()));
  const issueNumber = Number(options.issue);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return "v1";
  const { nextVersionForIssueRoot } = await import("./versioning.js");
  return (await nextVersionForIssueRoot(issueRootDir(repoPath, issueNumber))).version;
}
