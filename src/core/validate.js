import path from "node:path";
import { CliError } from "./errors.js";
import { pathExists, readJson } from "./fs.js";
import { sha256File } from "./checksum.js";

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

function hasSecretKey(value, trail = []) {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    const keyText = key.toLowerCase();
    if (["token", "access_token", "figma_token", "password", "secret", "credential", "credentials"].includes(keyText)) {
      return [...trail, key].join(".");
    }
    const found = hasSecretKey(child, [...trail, key]);
    if (found) return found;
  }
  return undefined;
}

export async function validateDesignContext(options) {
  const contextDir = path.resolve(String(options.context));
  const errors = [];
  const warnings = [];

  assert(await pathExists(contextDir), `Context directory does not exist: ${contextDir}`, errors);
  if (errors.length) return { ok: false, errors, warnings, contextDir };

  const manifestPath = path.join(contextDir, "manifest.json");
  assert(await pathExists(manifestPath), "manifest.json is missing", errors);
  if (errors.length) return { ok: false, errors, warnings, contextDir };

  let manifest;
  try {
    manifest = await readJson(manifestPath);
  } catch (error) {
    errors.push(`manifest.json is not valid JSON: ${error.message}`);
    return { ok: false, errors, warnings, contextDir };
  }

  assert(manifest.schemaVersion === "2.0", "manifest.schemaVersion must be 2.0", errors);
  assert(manifest.kind === "pragma-design-context-package", "manifest.kind must be pragma-design-context-package", errors);
  assert(Boolean(manifest.id), "manifest.id is required", errors);
  assert(manifest.issue?.provider === "gitea", "manifest.issue.provider must be gitea", errors);
  assert(Number.isInteger(manifest.issue?.number) && manifest.issue.number > 0, "manifest.issue.number must be a positive integer", errors);
  assert(Boolean(manifest.issue?.repo), "manifest.issue.repo is required", errors);
  assert(Boolean(manifest.source?.provider), "manifest.source.provider is required", errors);
  assert(Boolean(manifest.source?.adapter), "manifest.source.adapter is required", errors);
  assert(Boolean(manifest.source?.capturedAt), "manifest.source.capturedAt is required", errors);

  const entrypoints = manifest.entrypoints || {};
  for (const key of ["humanHandoff", "agentContext", "designContext", "assetsManifest", "assetsDir", "screenshots"]) {
    assert(Boolean(entrypoints[key]), `manifest.entrypoints.${key} is required`, errors);
  }

  for (const key of ["humanHandoff", "agentContext", "designContext", "assetsManifest"]) {
    if (entrypoints[key]) {
      assert(await pathExists(path.join(contextDir, entrypoints[key])), `${entrypoints[key]} is missing`, errors);
    }
  }

  let designContext;
  if (entrypoints.designContext && await pathExists(path.join(contextDir, entrypoints.designContext))) {
    designContext = await readJson(path.join(contextDir, entrypoints.designContext));
    assert(designContext.schemaVersion === "2.0", "design-context.schemaVersion must be 2.0", errors);
    assert(designContext.kind === "pragma-design-context", "design-context.kind must be pragma-design-context", errors);
    assert(Boolean(designContext.agentContext), "design-context.agentContext is required", errors);
    assert(Boolean(designContext.assetsManifest), "design-context.assetsManifest is required", errors);
  }

  const assetsMayBeExternal = manifest.artifact?.storage === "gitea-generic-package";
  let assetsManifest;
  if (entrypoints.assetsManifest && await pathExists(path.join(contextDir, entrypoints.assetsManifest))) {
    assetsManifest = await readJson(path.join(contextDir, entrypoints.assetsManifest));
    assert(assetsManifest.schemaVersion === "2.0", "assets.schemaVersion must be 2.0", errors);
    assert(assetsManifest.kind === "pragma-design-assets", "assets.kind must be pragma-design-assets", errors);
    assert(Array.isArray(assetsManifest.assets), "assets.assets must be an array", errors);
    for (const asset of assetsManifest.assets || []) {
      assert(Boolean(asset.id), "asset.id is required", errors);
      assert(Boolean(asset.path), `asset ${asset.id || "<unknown>"} path is required`, errors);
      if (asset.path) {
        const assetPath = path.join(contextDir, asset.path);
        const exists = await pathExists(assetPath);
        if (!exists && assetsMayBeExternal) {
          warnings.push(`asset ${asset.id} is not present in the lightweight repo context: ${asset.path}`);
        } else {
          assert(exists, `asset ${asset.id} file is missing: ${asset.path}`, errors);
        }
        if (asset.checksum && exists) {
          const actual = await sha256File(assetPath);
          assert(actual === asset.checksum, `asset ${asset.id} checksum mismatch`, errors);
        }
      }
    }
  }

  const checksumsPath = path.join(contextDir, "checksums.json");
  if (await pathExists(checksumsPath)) {
    const checksums = await readJson(checksumsPath);
    for (const entry of checksums.files || []) {
      const file = path.join(contextDir, entry.path);
      assert(await pathExists(file), `checksums entry is missing: ${entry.path}`, errors);
      if (await pathExists(file)) {
        const actual = await sha256File(file);
        assert(actual === entry.checksum, `checksum mismatch: ${entry.path}`, errors);
      }
    }
  } else {
    warnings.push("checksums.json is missing");
  }

  const secretPath = hasSecretKey(manifest) || hasSecretKey(designContext) || hasSecretKey(assetsManifest);
  assert(!secretPath, `package metadata contains a forbidden secret-like key: ${secretPath}`, errors);

  if (manifest.artifact?.storage === "gitea-generic-package") {
    assert(Boolean(manifest.artifact.downloadUrl), "manifest.artifact.downloadUrl is required for gitea-generic-package", errors);
    assert(Boolean(manifest.artifact.checksum), "manifest.artifact.checksum is required for gitea-generic-package", errors);
    const localZip = path.join(contextDir, manifest.artifact.fileName || "context.zip");
    if (await pathExists(localZip) && manifest.artifact.checksum) {
      const actual = await sha256File(localZip);
      assert(actual === manifest.artifact.checksum, "context.zip checksum does not match manifest.artifact.checksum", errors);
    }
    if (options.checkRemote && manifest.artifact.downloadUrl) {
      try {
        const response = await fetch(manifest.artifact.downloadUrl, { method: "HEAD" });
        assert(response.ok, `Gitea Package Registry URL is not reachable: HTTP ${response.status}`, errors);
      } catch (error) {
        errors.push(`Gitea Package Registry URL check failed: ${error.message}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, contextDir, manifest };
}

export async function assertValidDesignContext(options) {
  const result = await validateDesignContext(options);
  if (!result.ok) {
    throw new CliError(`Design context validation failed:\n- ${result.errors.join("\n- ")}`);
  }
  return result;
}
