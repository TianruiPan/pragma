import fs from "node:fs";

const packageMetadata = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const PRAGMA_SCHEMA_VERSION = "2.0";
export const PRAGMA_INTEGRATION_CONTRACT_VERSION = "pragma-integration/v1";

export function pragmaVersionPayload(env = process.env) {
  return {
    ok: true,
    product: packageMetadata.name,
    cliVersion: packageMetadata.version,
    schemaVersion: PRAGMA_SCHEMA_VERSION,
    integrationContractVersion: PRAGMA_INTEGRATION_CONTRACT_VERSION,
    buildCommit: normalizeBuildCommit(env.PRAGMA_BUILD_COMMIT)
  };
}

function normalizeBuildCommit(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}
