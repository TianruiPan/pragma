import fs from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";
import { ensureDir, pathExists, readJson } from "./fs.js";
import { assertValidDesignContext } from "./validate.js";

export async function resolveDesignAsset(options) {
  const contextDir = path.resolve(String(options.context));
  const id = String(options.id || "");
  if (!id) throw new CliError("--id is required for design asset lookup.");
  await assertValidDesignContext({ context: contextDir });
  const manifest = await readJson(path.join(contextDir, "manifest.json"));
  const assetsManifest = await readJson(path.join(contextDir, manifest.entrypoints.assetsManifest));
  const asset = (assetsManifest.assets || []).find((candidate) => candidate.id === id);
  if (!asset) throw new CliError(`Asset not found: ${id}`);
  const assetPath = path.join(contextDir, asset.path);
  if (!(await pathExists(assetPath))) throw new CliError(`Asset file is missing: ${asset.path}`);
  if (options["copy-to"] || options.copyTo) {
    const target = path.resolve(String(options["copy-to"] || options.copyTo));
    await ensureDir(path.dirname(target));
    await fs.copyFile(assetPath, target);
    return { asset, assetPath, copiedTo: target };
  }
  return { asset, assetPath };
}
