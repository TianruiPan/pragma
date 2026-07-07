import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "src", "cli.js");

async function run(args, options = {}) {
  return execFileAsync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    maxBuffer: 1024 * 1024 * 10,
    ...options
  });
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createInputFixture(root) {
  const input = path.join(root, "input");
  const repo = path.join(root, "repo");
  await writeJson(path.join(input, "capture.json"), {
    repo: { owner: "example-org", name: "demo-repo", localPath: repo },
    designIssue: { number: 102, title: "Design context" },
    targetDevIssues: [{ number: 101, title: "Implement UI" }],
    figma: { fileKey: "file-key", nodeIds: ["1:23"], selectionMode: "explicit-node-ids" },
    capturedAt: "2026-07-06T10:00:00+08:00"
  });
  await writeJson(path.join(input, "figma", "metadata.json"), { fileName: "Demo" });
  await writeJson(path.join(input, "figma", "selection.json"), { nodes: [{ id: "1:23", name: "Main", width: 1440, height: 900 }] });
  await fs.mkdir(path.join(input, "figma"), { recursive: true });
  await fs.writeFile(path.join(input, "figma", "get-design-context.md"), "# Raw context\n", "utf8");
  await fs.mkdir(path.join(input, "assets", "icons"), { recursive: true });
  await fs.writeFile(path.join(input, "assets", "icons", "drone.svg"), "<svg></svg>\n", "utf8");
  await writeJson(path.join(input, "assets-manifest.json"), { assets: [{ id: "asset-drone-icon", name: "Drone", type: "svg", path: "icons/drone.svg", required: true }] });
  await fs.mkdir(path.join(input, "screenshots"), { recursive: true });
  await fs.writeFile(path.join(input, "screenshots", "main-frame.webp"), "webp\n", "utf8");
  await fs.writeFile(path.join(input, "designer-notes.md"), "Design intent note.\n", "utf8");
  await fs.writeFile(path.join(input, "dynamic-regions.md"), "Map is implementation-defined.\n", "utf8");
  return { input, repo };
}

test("ingest, validate, issue-fragment, read, and asset lookup work", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-test-"));
  const { input, repo } = await createInputFixture(tmp);
  const ingest = await run(["design", "ingest", "--input", input, "--repo", repo]);
  const ingestResult = JSON.parse(ingest.stdout);
  assert.equal(ingestResult.ok, true);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102");

  const validate = await run(["design", "validate", "--context", contextDir]);
  assert.match(validate.stdout, /OK:/);

  const fragment = await run(["design", "issue-fragment", "--context", contextDir]);
  assert.match(fragment.stdout, /Manifest/);
  assert.match(fragment.stdout, /issue-102-v1/);

  const read = await run(["design", "read", "--repo", repo, "--issue", "102", "--summary-only"]);
  const readResult = JSON.parse(read.stdout);
  assert.equal(readResult.ok, true);
  assert.match(readResult.agentContextPath, /agent-context\.md$/);

  const asset = await run(["design", "asset", "--context", contextDir, "--id", "asset-drone-icon"]);
  const assetResult = JSON.parse(asset.stdout);
  assert.equal(assetResult.asset.id, "asset-drone-icon");
});

test("read blocks design/context development issue when dependent context is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-block-"));
  const repo = path.join(tmp, "repo");
  await fs.mkdir(path.join(repo, "issues"), { recursive: true });
  const devIssue = path.join(repo, "issues", "issue-101.md");
  await fs.writeFile(devIssue, "设计分类：design/context\n\n设计依赖：\n- Depends on #102\n", "utf8");
  await assert.rejects(
    run(["design", "read", "--repo", repo, "--dev-issue-file", devIssue]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /尚未交付 Pragma Context/);
      return true;
    }
  );
});

test("pack creates context.zip and publish supports repo mode", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-pack-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102");
  const pack = await run(["design", "pack", "--context", contextDir]);
  const packResult = JSON.parse(pack.stdout);
  assert.equal(packResult.ok, true);
  assert.match(packResult.checksum, /^sha256:/);

  const publish = await run(["design", "publish", "--context", contextDir, "--threshold-mb", "20"]);
  const publishResult = JSON.parse(publish.stdout);
  assert.equal(publishResult.mode, "repo");
});

test("publish supports Gitea Generic Package Registry dry run", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-publish-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102");
  const publish = await run([
    "design",
    "publish",
    "--context",
    contextDir,
    "--threshold-mb",
    "0",
    "--gitea-base-url",
    "https://gitea.example.com",
    "--owner",
    "example-org",
    "--dry-run"
  ]);
  const publishResult = JSON.parse(publish.stdout);
  assert.equal(publishResult.mode, "gitea-generic-package");
  assert.equal(publishResult.artifact.packageVersion, "issue-102-v1");
  assert.match(publishResult.artifact.downloadUrl, /api\/packages\/example-org\/generic\/pragma-design-context\/issue-102-v1\/context\.zip/);
  assert.match(publishResult.artifact.checksum, /^sha256:/);

  const validate = await run(["design", "validate", "--context", contextDir]);
  assert.match(validate.stdout, /OK:/);
});
