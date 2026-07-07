import fs from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";
import { directorySizeBytes, readJson, writeJson } from "./fs.js";
import { generateChecksums, sha256File } from "./checksum.js";
import { packDesignContext } from "./pack.js";
import { assertValidDesignContext } from "./validate.js";

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
  const contextDir = path.resolve(String(options.context));
  await assertValidDesignContext({ context: contextDir });
  const thresholdMb = Number(options["threshold-mb"] || options.thresholdMb || 20);
  const maxMb = Number(options["max-mb"] || options.maxMb || 100);
  const thresholdBytes = mbToBytes(thresholdMb);
  const maxBytes = mbToBytes(maxMb);
  const sizeBytes = await directorySizeBytes(contextDir, {
    exclude: [(file) => path.basename(file) === "context.zip"]
  });
  const manifestPath = path.join(contextDir, "manifest.json");
  const manifest = await readJson(manifestPath);

  if (sizeBytes > maxBytes) {
    throw new CliError(`Context is ${(sizeBytes / 1024 / 1024).toFixed(2)}MB, over the MVP max of ${maxMb}MB.`);
  }

  if (sizeBytes <= thresholdBytes) {
    manifest.artifact = {
      storage: "repo",
      path: manifest.artifact?.path || `.pragma/design-contexts/issue-${manifest.issue.number}`
    };
    await writeJson(manifestPath, manifest);
    await generateChecksums(contextDir);
    return {
      mode: "repo",
      contextDir,
      sizeBytes,
      manifest
    };
  }

  const baseUrl = normalizeBaseUrl(options["gitea-base-url"] || options.giteaBaseUrl);
  const owner = options.owner || manifest.issue.repo.split("/")[0];
  const packageName = options["package-name"] || options.packageName || "pragma-design-context";
  const packageVersion = options.version || manifest.version || `issue-${manifest.issue.number}-v1`;
  const fileName = options["file-name"] || options.fileName || "context.zip";
  if (!baseUrl) throw new CliError("--gitea-base-url is required when publishing packages over the threshold.");
  if (!owner) throw new CliError("--owner is required when publishing packages over the threshold.");
  const downloadUrl = `${baseUrl}/api/packages/${encodeURIComponent(owner)}/generic/${encodeURIComponent(packageName)}/${encodeURIComponent(packageVersion)}/${encodeURIComponent(fileName)}`;

  const zipPath = path.resolve(String(options.zip || path.join(contextDir, fileName)));
  await packDesignContext({ context: contextDir, zip: zipPath });
  const checksum = await sha256File(zipPath);

  manifest.artifact = {
    storage: "gitea-generic-package",
    owner,
    packageName,
    packageVersion,
    fileName,
    downloadUrl,
    checksum,
    publishedAt: new Date().toISOString(),
    dryRun: Boolean(options["dry-run"] || options.dryRun)
  };
  await writeJson(manifestPath, manifest);
  await generateChecksums(contextDir);

  const dryRun = options["dry-run"] || options.dryRun;
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

  return {
    mode: "gitea-generic-package",
    contextDir,
    zipPath: pruneRepo ? undefined : zipPath,
    sizeBytes,
    checksum,
    pruned: Boolean(pruneRepo),
    manifest
  };
}
