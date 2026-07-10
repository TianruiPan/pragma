import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "src", "cli.js");

test("CLI exposes a stable version and integration-contract handshake", async () => {
  const text = await run(["--version"]);
  assert.equal(text.stdout.trim(), "0.1.0");

  const json = await run(["--version", "--json"], {
    env: { ...process.env, PRAGMA_BUILD_COMMIT: "abc1234" }
  });
  assert.deepEqual(JSON.parse(json.stdout), {
    ok: true,
    product: "pragma-2-design-context-mvp",
    cliVersion: "0.1.0",
    schemaVersion: "2.0",
    integrationContractVersion: "pragma-integration/v1",
    buildCommit: "abc1234"
  });
});

function run(args, options = {}) {
  return execFileAsync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    ...options
  });
}
