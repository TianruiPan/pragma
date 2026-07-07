import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseFigmaUrl } from "../src/core/figma-url.js";

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

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
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

  await writeJson(path.join(input, "figma", "layers.json"), {
    rootNodeIds: ["1:23"],
    nodes: [
      { figmaNodeId: "1:23", name: "Main", type: "FRAME", bounds: { x: 0, y: 0, width: 1440, height: 900 }, children: ["1:24", "1:30"] },
      { figmaNodeId: "1:24", name: "Title", type: "TEXT", bounds: { x: 24, y: 24, width: 160, height: 32 }, text: { content: "Dashboard", fontSize: 24, lineHeight: 32, color: "#ffffff" } },
      { figmaNodeId: "1:30", name: "Drone icon", type: "IMAGE", bounds: { x: 200, y: 200, width: 32, height: 32 } }
    ]
  });
  await writeJson(path.join(input, "asset-bindings.json"), {
    bindings: [{ assetId: "asset-drone-icon", figmaNodeId: "1:30", fit: "contain", placement: { x: 200, y: 200, width: 32, height: 32 } }]
  });
  await writeJson(path.join(input, "figma", "variables.json"), { colors: { "text.primary": "#ffffff" } });
  await writeJson(path.join(input, "figma", "components.json"), { components: [] });
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
  assert.match(readResult.pixelSpecPath, /pixel-spec\.json$/);
  const pixelSpec = JSON.parse(await fs.readFile(path.join(contextDir, "normalized", "pixel-spec.json"), "utf8"));
  assert.equal(pixelSpec.kind, "pragma-pixel-spec");
  assert.equal(pixelSpec.nodes.some((node) => node.assetBinding?.assetId === "asset-drone-icon"), true);
  const visualBaseline = JSON.parse(await fs.readFile(path.join(contextDir, "validation", "visual-baseline.json"), "utf8"));
  assert.equal(visualBaseline.kind, "pragma-visual-baseline");

  const asset = await run(["design", "asset", "--context", contextDir, "--id", "asset-drone-icon"]);
  const assetResult = JSON.parse(asset.stdout);
  assert.equal(assetResult.asset.id, "asset-drone-icon");
});

test("Figma URL parser normalizes node-id hyphens to colons", () => {
  const parsed = parseFigmaUrl("https://www.figma.com/design/fileKey/Demo?node-id=1239-6203");
  assert.equal(parsed.fileKey, "fileKey");
  assert.equal(parsed.nodeId, "1239:6203");
});

test("prepare-figma-capture reports selected, reused, missing, and none dependency states", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-prepare-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "source", "add", "--role", "components", "--input", input, "--repo", repo, "--file-key", "file-key", "--frame-node-id", "5:100"]);

  const selected = JSON.parse((await run(["design", "prepare-figma-capture", "--url", "https://www.figma.com/design/file-key/Demo?node-id=1-23", "--repo", repo, "--components", "5:100", "--assets", "none", "--json"])).stdout);
  assert.equal(selected.dependencies.components.status, "selected");
  assert.equal(selected.dependencies.assets.status, "none");

  const reused = JSON.parse((await run(["design", "prepare-figma-capture", "--url", "https://www.figma.com/design/file-key/Demo?node-id=1-23", "--repo", repo, "--json"])).stdout);
  assert.equal(reused.dependencies.components.status, "reused");
  assert.match(reused.dependencies.components.snapshotId, /^components-5-100-/);

  const emptyRepo = path.join(tmp, "empty-repo");
  await fs.mkdir(emptyRepo, { recursive: true });
  await assert.rejects(
    run(["design", "prepare-figma-capture", "--url", "https://www.figma.com/design/file-key/Demo?node-id=1-23", "--repo", emptyRepo, "--page-has-instances", "--json"]),
    (error) => {
      assert.equal(error.code, 2);
      const result = JSON.parse(error.stdout);
      assert.equal(result.dependencies.components.status, "missing");
      assert.equal(result.blockers[0].code, "MISSING_COMPONENTS_SNAPSHOT");
      return true;
    }
  );
});

test("source snapshots are content-addressed and reused for identical content", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-source-"));
  const { input, repo } = await createInputFixture(tmp);
  const first = JSON.parse((await run(["design", "source", "add", "--role", "components", "--input", input, "--repo", repo, "--file-key", "file-key", "--frame-node-id", "5:100"])).stdout);
  assert.equal(first.created, true);
  assert.equal(first.reused, false);

  const second = JSON.parse((await run(["design", "source", "add", "--role", "components", "--input", input, "--repo", repo, "--file-key", "file-key", "--frame-node-id", "5:100"])).stdout);
  assert.equal(second.snapshotId, first.snapshotId);
  assert.equal(second.reused, true);

  const componentsPath = path.join(input, "figma", "components.json");
  const components = await readJson(componentsPath);
  components.components.push({ id: "component-new-card", name: "New/Card", nodeId: "5:200" });
  await writeJson(componentsPath, components);
  const third = JSON.parse((await run(["design", "source", "add", "--role", "components", "--input", input, "--repo", repo, "--file-key", "file-key", "--frame-node-id", "5:100"])).stdout);
  assert.notEqual(third.snapshotId, first.snapshotId);
  const registry = await readJson(path.join(repo, ".pragma", "design-sources", "figma", "file-key", "registry.json"));
  assert.equal(registry.latest.components, third.snapshotId);
  assert.equal(registry.roles.components.length, 2);

  const assetFirst = JSON.parse((await run(["design", "source", "add", "--role", "assets", "--input", input, "--repo", repo, "--file-key", "file-key", "--frame-node-id", "6:200"])).stdout);
  const assetSecond = JSON.parse((await run(["design", "source", "add", "--role", "assets", "--input", input, "--repo", repo, "--file-key", "file-key", "--frame-node-id", "6:200"])).stdout);
  assert.equal(assetSecond.snapshotId, assetFirst.snapshotId);
  assert.equal(assetSecond.reused, true);
  await fs.writeFile(path.join(input, "assets", "icons", "drone.svg"), "<svg viewBox=\"0 0 2 2\"></svg>\n", "utf8");
  const assetThird = JSON.parse((await run(["design", "source", "add", "--role", "assets", "--input", input, "--repo", repo, "--file-key", "file-key", "--frame-node-id", "6:200"])).stdout);
  assert.notEqual(assetThird.snapshotId, assetFirst.snapshotId);
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

test("pack-from-figma-capture runs the full deterministic pipeline", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-combo-"));
  const { input, repo } = await createInputFixture(tmp);
  const packed = await run(["design", "pack-from-figma-capture", "--input", input, "--repo", repo, "--threshold-mb", "20"]);
  const packedResult = JSON.parse(packed.stdout);
  assert.equal(packedResult.ok, true);
  assert.equal(packedResult.publishMode, "repo");
  assert.match(packedResult.issueFragmentPath, /issue-fragment\.md$/);
  await fs.access(packedResult.issueFragmentPath);
  await fs.access(path.join(packedResult.contextDir, "normalized", "pixel-spec.json"));
  await fs.access(path.join(packedResult.contextDir, "validation", "visual-baseline.json"));
});

test("ingest and pack-from-figma-capture preserve dependency-lock as normalized dependencies", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-deps-"));
  const { input, repo } = await createInputFixture(tmp);
  await writeJson(path.join(input, "dependency-lock.json"), {
    schemaVersion: "2.0",
    kind: "pragma-dependency-lock",
    fileKey: "file-key",
    capturedAt: "2026-07-06T10:00:00+08:00",
    pageFrames: [{ nodeId: "1:23", name: "Main", snapshotId: "page-1-23-fixed" }],
    components: { status: "none" },
    assets: { status: "none" },
    rules: {
      lockDependencies: true,
      neverDependOnFloatingLatest: true,
      ifMissingComponentsAndPageHasInstances: "block",
      ifMissingAssetsAndPageHasUnresolvedRefs: "block"
    }
  });
  const packed = await run(["design", "pack-from-figma-capture", "--input", input, "--repo", repo, "--threshold-mb", "20"]);
  const packedResult = JSON.parse(packed.stdout);
  const deps = await readJson(path.join(packedResult.contextDir, "normalized", "dependencies.json"));
  assert.equal(deps.kind, "pragma-design-dependencies");
  assert.equal(deps.components.status, "none");
  assert.equal(deps.pageFrames[0].snapshotId, "page-1-23-fixed");
});

test("validate rejects broken pixel spec asset references", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-invalid-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102");
  const pixelSpecPath = path.join(contextDir, "normalized", "pixel-spec.json");
  const pixelSpec = JSON.parse(await fs.readFile(pixelSpecPath, "utf8"));
  pixelSpec.assetBindings[0].assetId = "asset-missing";
  await fs.writeFile(pixelSpecPath, `${JSON.stringify(pixelSpec, null, 2)}\n`, "utf8");
  await assert.rejects(
    run(["design", "validate", "--context", contextDir]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /unknown assetId asset-missing/);
      return true;
    }
  );
});

test("validate rejects floating latest dependency locks", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-floating-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102");
  const depsPath = path.join(contextDir, "normalized", "dependencies.json");
  const deps = await readJson(depsPath);
  deps.components = {
    status: "reused",
    frameNodeId: "5:100",
    snapshotId: "latest",
    path: ".pragma/design-sources/figma/file-key/latest",
    checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  };
  await writeJson(depsPath, deps);
  await assert.rejects(
    run(["design", "validate", "--context", contextDir]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /floating latest/);
      return true;
    }
  );
});

test("validate rejects bad asset checksum or MIME facts", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-bad-asset-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102");
  await fs.writeFile(path.join(contextDir, "assets", "icons", "drone.svg"), "not an svg\n", "utf8");
  await assert.rejects(
    run(["design", "validate", "--context", contextDir]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /checksum mismatch|unknown magic bytes/);
      return true;
    }
  );
});

test("enrich writes an explicit non-fact enrichment file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-enrich-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102");
  const enriched = await run(["design", "enrich", "--context", contextDir, "--notes", "Use product tabs where available.", "--generated-by", "test", "--model", "none"]);
  const enrichedResult = JSON.parse(enriched.stdout);
  const text = await fs.readFile(enrichedResult.output, "utf8");
  assert.match(text, /## Agent Enrichment/);
  assert.match(text, /generatedBy: test/);
});
