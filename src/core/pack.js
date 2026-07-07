import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CliError } from "./errors.js";
import { assertValidDesignContext } from "./validate.js";
import { ensureDir, listFilesRecursive, pathExists } from "./fs.js";
import { generateChecksums, sha256File } from "./checksum.js";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new CliError(`${command} exited with ${code}: ${stderr || stdout}`));
    });
  });
}

async function copyContextForZip(contextDir, stagingDir, zipPath) {
  await ensureDir(stagingDir);
  const files = await listFilesRecursive(contextDir);
  for (const file of files) {
    if (path.resolve(file) === path.resolve(zipPath)) continue;
    const rel = path.relative(contextDir, file);
    const target = path.join(stagingDir, rel);
    await ensureDir(path.dirname(target));
    await fs.copyFile(file, target);
  }
}

async function createZipFromStaging(stagingDir, zipPath) {
  await ensureDir(path.dirname(zipPath));
  await fs.rm(zipPath, { force: true });
  if (process.platform === "win32") {
    const escapedStaging = stagingDir.replace(/'/g, "''");
    const escapedZip = zipPath.replace(/'/g, "''");
    const script = `$ErrorActionPreference = 'Stop'; $items = Get-ChildItem -LiteralPath '${escapedStaging}' -Force; Compress-Archive -LiteralPath $items.FullName -DestinationPath '${escapedZip}' -Force`;
    await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
    return;
  }
  await run("zip", ["-r", zipPath, "."], { cwd: stagingDir });
}

export async function packDesignContext(options) {
  const contextDir = path.resolve(String(options.context));
  await assertValidDesignContext({ context: contextDir });
  const zipPath = path.resolve(String(options.zip || path.join(contextDir, "context.zip")));
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "pragma-pack-"));
  try {
    await copyContextForZip(contextDir, stagingDir, zipPath);
    await createZipFromStaging(stagingDir, zipPath);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
  if (!(await pathExists(zipPath))) throw new CliError(`Failed to create zip: ${zipPath}`);
  await generateChecksums(contextDir);
  return {
    contextDir,
    zipPath,
    checksum: await sha256File(zipPath)
  };
}
