import fs from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";
import { directorySizeBytes, pathExists, readJson, readText, writeJson } from "./fs.js";
import { generateChecksums, sha256File } from "./checksum.js";
import { packDesignContext } from "./pack.js";
import { assertValidDesignContext } from "./validate.js";
import { currentPathForIssueRoot, issueRootDir, manifestChecksum, normalizeVersion, resolveVersionContext, versionRelative, writeCurrentPointer } from "./versioning.js";

function mbToBytes(value) {
  return Number(value) * 1024 * 1024;
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}


async function pruneRepoPayload(contextDir, fileName) {
  await fs.rm(path.join(contextDir, "assets"), { recursive: true, force: true });
  await fs.rm(path.join(contextDir, "source"), { recursive: true, force: true });
  await fs.rm(path.join(contextDir, fileName), { force: true });
  await generateChecksums(contextDir);
}

async function uploadToGitea({ zipPath, downloadUrl, token }) {
  const body = await fs.readFile(zipPath);
  const response = await fetch(downloadUrl, {
    method: "PUT",
    headers: {
      Authorization: `token ${token}`,
      "Content-Type": "application/zip"
    },
    body
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new CliError(`Gitea package upload failed: HTTP ${response.status} ${text}`);
  }
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

  if (sizeBytes > maxBytes) {
    throw new CliError(`Context is ${(sizeBytes / 1024 / 1024).toFixed(2)}MB, over the MVP max of ${maxMb}MB.`);
  }

  if (sizeBytes <= thresholdBytes) {
    const checksum = options.zip && await pathExists(path.resolve(String(options.zip)))
      ? await sha256File(path.resolve(String(options.zip)))
      : (manifest.packageChecksum || await manifestChecksum(manifestPath));
    manifest.packageChecksum = checksum;
    manifest.artifact = {
      storage: "repo",
      owner: manifest.issue.repo?.split("/")?.[0],
      packageName: "pragma-design-context",
      packageVersion: `issue-${issueNumber}-${manifest.version}`,
      fileName: null,
      downloadUrl: null,
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

  const baseUrl = normalizeBaseUrl(options["gitea-base-url"] || options.giteaBaseUrl);
  const owner = options.owner || manifest.issue.repo.split("/")[0];
  const packageName = options["package-name"] || options.packageName || "pragma-design-context";
  const packageVersion = `issue-${issueNumber}-${manifest.version}`;
  const fileName = options["file-name"] || options.fileName || "context.zip";
  if (!baseUrl) throw new CliError("--gitea-base-url is required when publishing packages over the threshold.");
  if (!owner) throw new CliError("--owner is required when publishing packages over the threshold.");
  const downloadUrl = `${baseUrl}/api/packages/${encodeURIComponent(owner)}/generic/${encodeURIComponent(packageName)}/${encodeURIComponent(packageVersion)}/${encodeURIComponent(fileName)}`;

  const zipPath = path.resolve(String(options.zip || path.join(contextDir, fileName)));
  await packDesignContext({ context: contextDir, zip: zipPath });
  const checksum = await sha256File(zipPath);
  manifest.packageChecksum = checksum;

  manifest.artifact = {
    storage: "gitea-generic-package",
    owner,
    packageName,
    packageVersion,
    fileName,
    downloadUrl,
    checksum,
    publishedAt: new Date().toISOString(),
    dryRun
  };
  await writeJson(manifestPath, manifest);
  await generateChecksums(contextDir);

  const pruneRepo = options["prune-repo"] || options.pruneRepo;
  if (!dryRun) {
    const tokenEnv = options["token-env"] || options.tokenEnv;
    const token = options.token || (tokenEnv ? process.env[tokenEnv] : undefined);
    if (!token) throw new CliError("A Gitea token is required. Use --token or --token-env.");
    await uploadToGitea({ zipPath, downloadUrl, token });
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
    mode: "gitea-generic-package",
    contextDir,
    zipPath: pruneRepo ? undefined : zipPath,
    sizeBytes,
    checksum,
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
