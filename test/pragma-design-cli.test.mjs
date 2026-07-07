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

async function writeFakePng(file, width, height) {
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, png);
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
  await writeJson(path.join(input, "dependency-lock.json"), {
    schemaVersion: "2.0",
    kind: "pragma-design-dependencies",
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
  await writeJson(path.join(input, "figma", "metadata.json"), { fileName: "Demo" });
  await writeJson(path.join(input, "figma", "selection.json"), { nodes: [{ id: "1:23", name: "Main", width: 1440, height: 900 }] });
  await fs.mkdir(path.join(input, "figma"), { recursive: true });

  await writeJson(path.join(input, "figma", "layers.json"), {
    rootNodeIds: ["1:23"],
    nodes: [
      { figmaNodeId: "1:23", name: "Main", type: "FRAME", bounds: { x: 0, y: 0, width: 1440, height: 900 }, fills: ["#ffffff"], radius: 4, children: ["1:24", "1:30"] },
      { figmaNodeId: "1:24", name: "Title", type: "TEXT", bounds: { x: 24, y: 24, width: 160, height: 32 }, text: { content: "Dashboard", fontSize: 24, lineHeight: 32, color: "#ffffff" } },
      { figmaNodeId: "1:30", name: "Drone icon", type: "IMAGE", bounds: { x: 200, y: 200, width: 32, height: 32 } }
    ]
  });
  await writeJson(path.join(input, "asset-bindings.json"), {
    bindings: [{ assetId: "asset-drone-icon", figmaNodeId: "1:30", fit: "contain", placement: { x: 200, y: 200, width: 32, height: 32 } }]
  });
  await writeJson(path.join(input, "figma", "variables.json"), { colors: { "text.primary": "#ffffff" }, radius: { "radius.sm": 4 } });
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

async function copyIncomingCapture(input, repo, issue, timestamp) {
  const target = path.join(repo, ".pragma", "incoming", "figma-captures", `issue-${issue}-${timestamp}`, "pragma-input");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(input, target, { recursive: true });
  return target;
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
  assert.equal(pixelSpec.nodes.every((node) => node.layerRef && (!node.children || node.children.length === 0)), true);
  const titleNode = pixelSpec.nodes.find((node) => node.figmaNodeId === "1:24");
  assert.equal(titleNode.text.color.tokenId, "color-text-primary");
  assert.equal(titleNode.text.color.resolvedValue, "#ffffff");
  const mainNode = pixelSpec.nodes.find((node) => node.figmaNodeId === "1:23");
  assert.equal(mainNode.radius.tokenId, "radius-radius-sm");
  assert.deepEqual(mainNode.radius.resolvedValue, { topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 });
  assert.equal(mainNode.fills[0].color.tokenId, "color-text-primary");
  const layers = JSON.parse(await fs.readFile(path.join(contextDir, "normalized", "layers.json"), "utf8"));
  assert.equal(layers.nodes.every((node) => !("bounds" in node) && !("componentRef" in node) && !("text" in node) && !("assetBinding" in node)), true);
  const assets = JSON.parse(await fs.readFile(path.join(contextDir, "normalized", "assets.json"), "utf8"));
  assert.equal(assets.assets.every((assetItem) => !("bindings" in assetItem) && !("fit" in assetItem) && !("crop" in assetItem) && !("placement" in assetItem)), true);
  assert.deepEqual(assets.assets[0].usedByNodeIds, ["node-1-30"]);
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

test("validate enforces normalized canonical ownership and token mapping", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-canonical-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102");

  const layersPath = path.join(contextDir, "normalized", "layers.json");
  const layers = await readJson(layersPath);
  layers.nodes[0].bounds = { x: 0, y: 0, width: 1, height: 1 };
  await writeJson(layersPath, layers);

  const pixelPath = path.join(contextDir, "normalized", "pixel-spec.json");
  const pixelSpec = await readJson(pixelPath);
  pixelSpec.nodes.find((node) => node.figmaNodeId === "1:24").text.color = { tokenId: "color-text-primary" };
  await writeJson(pixelPath, pixelSpec);

  const assetsPath = path.join(contextDir, "normalized", "assets.json");
  const assets = await readJson(assetsPath);
  assets.assets[0].placement = { x: 0, y: 0, width: 32, height: 32 };
  await writeJson(assetsPath, assets);

  const componentsPath = path.join(contextDir, "normalized", "components.json");
  const components = await readJson(componentsPath);
  components.instances.push({ nodeId: "node-1-24", figmaNodeId: "1:24", bounds: { x: 0, y: 0, width: 1, height: 1 } });
  await writeJson(componentsPath, components);

  await assert.rejects(
    run(["design", "validate", "--context", contextDir, "--json"]),
    (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.issues.some((issue) => issue.code === "NORMALIZED_CANONICAL_OWNERSHIP" && issue.field === "bounds"), true);
      assert.equal(result.issues.some((issue) => issue.code === "NORMALIZED_CANONICAL_OWNERSHIP" && issue.field === "placement"), true);
      assert.equal(result.issues.some((issue) => issue.code === "TOKEN_MAPPING_MISSING_RESOLVED_VALUE"), true);
      return true;
    }
  );
});

test("ingest prunes frame render assets and validate rejects them under assets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-frame-render-"));
  const { input, repo } = await createInputFixture(tmp);
  await writeFakePng(path.join(input, "assets", "images", "homepage-render.png"), 1440, 900);
  const manifest = await readJson(path.join(input, "assets-manifest.json"));
  manifest.assets.push({
    id: "asset-homepage-render",
    name: "Homepage render",
    role: "render-reference",
    type: "png",
    path: "images/homepage-render.png",
    required: false
  });
  await writeJson(path.join(input, "assets-manifest.json"), manifest);

  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102");
  await assert.rejects(fs.access(path.join(contextDir, "assets", "images", "homepage-render.png")));
  const assets = await readJson(path.join(contextDir, "normalized", "assets.json"));
  assert.equal(assets.assets.some((asset) => asset.id === "asset-homepage-render"), false);

  await writeFakePng(path.join(contextDir, "assets", "images", "frame-render.png"), 1440, 900);
  await assert.rejects(
    run(["design", "validate", "--context", contextDir, "--json"]),
    (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.issues.some((issue) => issue.code === "ASSET_FRAME_RENDER_IN_ASSETS"), true);
      return true;
    }
  );
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

test("preflight --fix repairs placeholder asset checksums and file dimensions", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-preflight-asset-"));
  const { input, repo } = await createInputFixture(tmp);
  await writeFakePng(path.join(input, "assets", "icons", "drone.png"), 2, 3);
  await fs.rm(path.join(input, "assets", "icons", "drone.svg"), { force: true });
  await writeJson(path.join(input, "assets-manifest.json"), {
    schemaVersion: "2.0",
    kind: "pragma-design-assets",
    assets: [{
      id: "asset-drone-icon",
      name: "Drone",
      type: "png",
      mime: "image/png",
      path: "icons/drone.png",
      width: 32,
      height: 32,
      checksum: "sha256:plugin-webcrypto-unavailable-24",
      required: true
    }]
  });

  const preflight = JSON.parse((await run(["design", "preflight", "--input", input, "--repo", repo, "--fix", "--json"])).stdout);
  assert.equal(preflight.ok, true);
  assert.equal(typeof preflight.timings.resolveInputMs, "number");
  assert.equal(typeof preflight.timings.preflightMs, "number");
  assert.equal(preflight.repairs.some((repair) => repair.code === "ASSET_CHECKSUM_REPAIRED"), true);
  const manifest = await readJson(path.join(input, "assets-manifest.json"));
  assert.equal(manifest.assets[0].width, 2);
  assert.equal(manifest.assets[0].height, 3);
  assert.match(manifest.assets[0].checksum, /^sha256:[0-9a-f]{64}$/);
  const bindings = await readJson(path.join(input, "asset-bindings.json"));
  assert.equal(bindings.bindings[0].placement.width, 32);
});

test("preflight materializes selected dependency snapshots when frame data is present", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-preflight-snapshot-"));
  const { input, repo } = await createInputFixture(tmp);
  const capture = await readJson(path.join(input, "capture.json"));
  capture.figma.frames = {
    page: [{ nodeId: "1:23", name: "Main" }],
    components: [{ nodeId: "5:100", name: "Components" }],
    assets: []
  };
  await writeJson(path.join(input, "capture.json"), capture);
  const selection = await readJson(path.join(input, "figma", "selection.json"));
  selection.fileKey = "file-key";
  selection.frames = {
    page: [{ nodeId: "1:23", name: "Main" }],
    components: [{ nodeId: "5:100", name: "Components" }],
    assets: []
  };
  await writeJson(path.join(input, "figma", "selection.json"), selection);
  await writeJson(path.join(input, "dependency-lock.json"), {
    schemaVersion: "2.0",
    kind: "pragma-design-dependencies",
    fileKey: "file-key",
    capturedAt: "2026-07-06T10:00:00+08:00",
    pageFrames: [{ nodeId: "1:23", name: "Main", snapshotId: "page-1-23-fixed" }],
    components: {
      status: "selected",
      frameNodeId: "5:100",
      frameNodeIds: ["5:100"],
      snapshotId: null,
      path: null,
      checksum: null,
      materializationStatus: "pending-preflight",
      needsSourceSync: true
    },
    assets: { status: "none" },
    rules: {
      lockDependencies: true,
      neverDependOnFloatingLatest: true,
      ifMissingComponentsAndPageHasInstances: "block",
      ifMissingAssetsAndPageHasUnresolvedRefs: "block"
    }
  });

  const preflight = JSON.parse((await run(["design", "preflight", "--input", input, "--repo", repo, "--fix", "--json"])).stdout);
  assert.equal(preflight.ok, true);
  assert.equal(preflight.repairs.some((repair) => repair.code === "DEPENDENCY_SNAPSHOT_MATERIALIZED"), true);
  const lock = await readJson(path.join(input, "dependency-lock.json"));
  assert.match(lock.components.snapshotId, /^components-5-100-/);
  assert.deepEqual(lock.components.frameNodeIds, ["5:100"]);
  assert.match(lock.components.checksum, /^sha256:[0-9a-f]{64}$/);
  await fs.access(path.join(repo, lock.components.path));
});

test("preflight blocks selected snapshot repair when selected frame data is absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-preflight-missing-frame-"));
  const { input, repo } = await createInputFixture(tmp);
  await writeJson(path.join(input, "dependency-lock.json"), {
    schemaVersion: "2.0",
    kind: "pragma-design-dependencies",
    fileKey: "file-key",
    capturedAt: "2026-07-06T10:00:00+08:00",
    pageFrames: [{ nodeId: "1:23", name: "Main", snapshotId: "page-1-23-fixed" }],
    components: { status: "selected", frameNodeId: "5:100", frameNodeIds: ["5:100"] },
    assets: { status: "none" },
    rules: {
      lockDependencies: true,
      neverDependOnFloatingLatest: true,
      ifMissingComponentsAndPageHasInstances: "block",
      ifMissingAssetsAndPageHasUnresolvedRefs: "block"
    }
  });
  await assert.rejects(
    run(["design", "preflight", "--input", input, "--repo", repo, "--fix", "--json"]),
    (error) => {
      assert.equal(error.code, 2);
      const result = JSON.parse(error.stdout);
      assert.equal(result.ok, false);
      assert.equal(result.issues.some((item) => item.code === "BLOCKING_DEPENDENCY_SNAPSHOT_MISSING"), true);
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

test("validate --source-registry checks registry health and catches broken latest, missing snapshot, and checksum mismatch", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-registry-"));
  const { input, repo } = await createInputFixture(tmp);
  const component = JSON.parse((await run(["design", "source", "add", "--role", "components", "--input", input, "--repo", repo, "--file-key", "file-key", "--frame-node-id", "5:100"])).stdout);
  const asset = JSON.parse((await run(["design", "source", "add", "--role", "assets", "--input", input, "--repo", repo, "--file-key", "file-key", "--frame-node-id", "6:200"])).stdout);

  const healthy = JSON.parse((await run(["design", "validate", "--repo", repo, "--source-registry", "--file-key", "file-key", "--json"])).stdout);
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthy.fileKeys, ["file-key"]);

  const registryPath = path.join(repo, ".pragma", "design-sources", "figma", "file-key", "registry.json");
  const registry = await readJson(registryPath);
  registry.latest.components = "components-missing";
  await writeJson(registryPath, registry);
  await assert.rejects(
    run(["design", "validate", "--repo", repo, "--source-registry", "--file-key", "file-key", "--json"]),
    (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.issues.some((issue) => issue.code === "LATEST_POINTER_BROKEN"), true);
      return true;
    }
  );

  registry.latest.components = component.snapshotId;
  registry.roles.assets[0].path = ".pragma/design-sources/figma/file-key/snapshots/assets-missing";
  await writeJson(registryPath, registry);
  await assert.rejects(
    run(["design", "validate", "--repo", repo, "--source-registry", "--file-key", "file-key", "--json"]),
    (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.issues.some((issue) => issue.code === "SNAPSHOT_PATH_MISSING"), true);
      return true;
    }
  );

  registry.roles.assets[0].path = asset.path;
  await writeJson(registryPath, registry);
  const componentSnapshotFile = path.join(repo, component.path, "normalized", "components.json");
  await fs.appendFile(componentSnapshotFile, "\n");
  await assert.rejects(
    run(["design", "validate", "--repo", repo, "--source-registry", "--file-key", "file-key", "--json"]),
    (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.issues.some((issue) => issue.code === "SNAPSHOT_CHECKSUM_MISMATCH"), true);
      return true;
    }
  );
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

test("pack writes zip outside context and publish keeps repo mode zip-free", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-pack-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102");
  const pack = await run(["design", "pack", "--context", contextDir]);
  const packResult = JSON.parse(pack.stdout);
  assert.equal(packResult.ok, true);
  assert.match(packResult.checksum, /^sha256:/);
  assert.notEqual(path.dirname(packResult.zipPath), contextDir);
  await fs.access(packResult.zipPath);
  await assert.rejects(fs.access(path.join(contextDir, "context.zip")));

  const publish = await run(["design", "publish", "--context", contextDir, "--threshold-mb", "20"]);
  const publishResult = JSON.parse(publish.stdout);
  assert.equal(publishResult.mode, "repo");
  await assert.rejects(fs.access(path.join(contextDir, "context.zip")));

  await fs.writeFile(path.join(contextDir, "context.zip"), "stale zip\n", "utf8");
  await assert.rejects(
    run(["design", "validate", "--context", contextDir]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /context\.zip must not be present/);
      return true;
    }
  );
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

  await fs.writeFile(path.join(contextDir, "context.zip"), "bad zip\n", "utf8");
  await assert.rejects(
    run(["design", "validate", "--context", contextDir]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /context\.zip checksum does not match/);
      return true;
    }
  );
});

test("pack-from-figma-capture runs the full deterministic pipeline", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-combo-"));
  const { input, repo } = await createInputFixture(tmp);
  const packed = await run(["design", "pack-from-figma-capture", "--input", input, "--repo", repo, "--threshold-mb", "20"]);
  const packedResult = JSON.parse(packed.stdout);
  assert.equal(packedResult.ok, true);
  assert.equal(packedResult.preflight.ok, true);
  assert.equal(packedResult.readSmokeCheck.ok, true);
  for (const key of ["resolveInputMs", "preflightMs", "ingestMs", "packZipMs", "publishMs", "issueFragmentMs", "validateMs", "readSmokeCheckMs"]) {
    assert.equal(typeof packedResult.timings[key], "number");
  }
  assert.equal(packedResult.publishMode, "repo");
  assert.match(packedResult.issueFragmentPath, /issue-fragment\.md$/);
  assert.match(packedResult.summaryPath, /pipeline-summary\.json$/);
  await fs.access(packedResult.issueFragmentPath);
  await fs.access(packedResult.summaryPath);
  const summary = await readJson(packedResult.summaryPath);
  assert.equal(summary.kind, "pragma-pipeline-summary");
  assert.equal(summary.preflightSummary.unresolved, 0);
  assert.equal(summary.readSmokeCheck.ok, true);
  await fs.access(path.join(packedResult.contextDir, "normalized", "pixel-spec.json"));
  await fs.access(path.join(packedResult.contextDir, "validation", "visual-baseline.json"));
  await assert.rejects(fs.access(path.join(packedResult.contextDir, "context.zip")));
});

test("pack-latest-capture resolves latest repo-scoped capture and supports explicit input", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-latest-"));
  const fixtureRoot = path.join(tmp, "中文路径");
  const { input, repo } = await createInputFixture(fixtureRoot);
  const older = await copyIncomingCapture(input, repo, 102, "20260707T010000");
  const latest = await copyIncomingCapture(input, repo, 102, "20260707T020000");
  const latestLayersPath = path.join(latest, "figma", "layers.json");
  const latestLayers = await readJson(latestLayersPath);
  latestLayers.nodes[0].name = "主页";
  await writeJson(latestLayersPath, latestLayers);

  const outsideRepo = path.join(tmp, "outside-repo");
  await fs.mkdir(outsideRepo, { recursive: true });
  await copyIncomingCapture(input, outsideRepo, 102, "20990101T000000");

  const resolved = JSON.parse((await run(["design", "pack-latest-capture", "--repo", repo, "--issue", "102", "--preflight-only", "--json"])).stdout);
  assert.equal(resolved.ok, true);
  assert.equal(path.resolve(resolved.inputPath), path.resolve(latest));
  assert.equal(resolved.latestCapture.selectedCaptureName, "issue-102-20260707T020000");
  assert.equal(resolved.inputPath.includes("outside-repo"), false);
  await assert.rejects(fs.access(path.join(repo, ".pragma", "design-contexts", "issue-102")));

  const explicit = JSON.parse((await run(["design", "pack-latest-capture", "--repo", repo, "--issue", "102", "--input", older, "--preflight-only", "--json"])).stdout);
  assert.equal(explicit.ok, true);
  assert.equal(path.resolve(explicit.inputPath), path.resolve(older));
  assert.equal(explicit.inputSource, "explicit");
});

test("pack-latest-capture protects existing context and force reruns", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-latest-full-"));
  const { input, repo } = await createInputFixture(tmp);
  await copyIncomingCapture(input, repo, 102, "20260707T030000");

  const first = JSON.parse((await run(["design", "pack-latest-capture", "--repo", repo, "--issue", "102", "--json"])).stdout);
  assert.equal(first.ok, true);
  assert.equal(first.command, "design pack-latest-capture");
  assert.equal(first.mode, "full");
  assert.equal(typeof first.timings.resolveInputMs, "number");
  assert.equal(first.validation.ok, true);
  assert.equal(first.readSmokeCheck.ok, true);
  await fs.access(first.summaryPath);
  await assert.rejects(fs.access(path.join(first.contextDir, "context.zip")));
  const summary = await readJson(first.summaryPath);
  assert.equal(summary.command, "design pack-latest-capture");
  assert.equal(summary.latestCapture.selectedCaptureName, "issue-102-20260707T030000");
  assert.equal(summary.validation.ok, true);

  await assert.rejects(
    run(["design", "pack-latest-capture", "--repo", repo, "--issue", "102", "--json"]),
    (error) => {
      assert.equal(error.code, 2);
      const result = JSON.parse(error.stderr);
      assert.equal(result.code, "PRAGMA_CONTEXT_EXISTS");
      assert.match(result.message, /Context already exists/);
      return true;
    }
  );

  const forced = JSON.parse((await run(["design", "pack-latest-capture", "--repo", repo, "--issue", "102", "--force", "--json"])).stdout);
  assert.equal(forced.ok, true);
  assert.equal(forced.contextDir, first.contextDir);
  assert.equal(forced.readSmokeCheck.ok, true);
});

test("from-figma returns timings and updates pipeline summary", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-from-figma-"));
  const { input, repo } = await createInputFixture(tmp);
  const result = JSON.parse((await run(["design", "from-figma", "--input", input, "--repo", repo, "--threshold-mb", "20"])).stdout);
  assert.equal(result.ok, true);
  assert.equal(typeof result.timings.preflightMs, "number");
  const summary = await readJson(result.summaryPath);
  assert.equal(summary.command, "design from-figma");
  assert.equal(typeof summary.timings.readSmokeCheckMs, "number");
});

test("pack-from-figma-capture automatically runs preflight repair before ingest", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-combo-preflight-"));
  const { input, repo } = await createInputFixture(tmp);
  await writeFakePng(path.join(input, "assets", "icons", "drone.png"), 4, 5);
  await fs.rm(path.join(input, "assets", "icons", "drone.svg"), { force: true });
  await writeJson(path.join(input, "assets-manifest.json"), {
    schemaVersion: "2.0",
    kind: "pragma-design-assets",
    assets: [{
      id: "asset-drone-icon",
      name: "Drone",
      type: "png",
      mime: "image/png",
      path: "icons/drone.png",
      width: 32,
      height: 32,
      checksum: "sha256:plugin-webcrypto-unavailable-24",
      required: true
    }]
  });
  const packed = await run(["design", "pack-from-figma-capture", "--input", input, "--repo", repo, "--threshold-mb", "20"]);
  const packedResult = JSON.parse(packed.stdout);
  assert.equal(packedResult.ok, true);
  assert.equal(packedResult.preflight.repairs.some((repair) => repair.code === "ASSET_CHECKSUM_REPAIRED"), true);
  const assets = await readJson(path.join(packedResult.contextDir, "normalized", "assets.json"));
  assert.equal(assets.assets[0].width, 4);
  assert.equal(assets.assets[0].height, 5);
  assert.match(assets.assets[0].checksum, /^sha256:[0-9a-f]{64}$/);
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

test("pack-from-figma-capture creates a default dependency lock for legacy capture input", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-legacy-lock-"));
  const { input, repo } = await createInputFixture(tmp);
  await fs.rm(path.join(input, "dependency-lock.json"), { force: true });
  const packedResult = JSON.parse((await run(["design", "pack-from-figma-capture", "--input", input, "--repo", repo, "--threshold-mb", "20"])).stdout);
  assert.equal(packedResult.ok, true);
  assert.equal(packedResult.preflight.repairs.some((repair) => repair.code === "DEPENDENCY_LOCK_CREATED"), true);
  const deps = await readJson(path.join(packedResult.contextDir, "normalized", "dependencies.json"));
  assert.equal(deps.components.status, "none");
  assert.equal(deps.pageFrames[0].snapshotId, "page-1-23-capture");
});

test("validate --context checks locked dependency snapshots are recoverable from repo registry", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-context-registry-"));
  const { input, repo } = await createInputFixture(tmp);
  const component = JSON.parse((await run(["design", "source", "add", "--role", "components", "--input", input, "--repo", repo, "--file-key", "file-key", "--frame-node-id", "5:100"])).stdout);
  await writeJson(path.join(input, "dependency-lock.json"), {
    schemaVersion: "2.0",
    kind: "pragma-dependency-lock",
    fileKey: "file-key",
    capturedAt: "2026-07-06T10:00:00+08:00",
    pageFrames: [{ nodeId: "1:23", name: "Main", snapshotId: "page-1-23-fixed" }],
    components: {
      status: "reused",
      frameNodeId: "5:100",
      snapshotId: component.snapshotId,
      path: component.path,
      checksum: component.checksum
    },
    assets: { status: "none" },
    rules: {
      lockDependencies: true,
      neverDependOnFloatingLatest: true,
      ifMissingComponentsAndPageHasInstances: "block",
      ifMissingAssetsAndPageHasUnresolvedRefs: "block"
    }
  });
  const packedResult = JSON.parse((await run(["design", "pack-from-figma-capture", "--input", input, "--repo", repo, "--threshold-mb", "20"])).stdout);
  const healthy = JSON.parse((await run(["design", "validate", "--context", packedResult.contextDir, "--json"])).stdout);
  assert.equal(healthy.ok, true);

  const registryPath = path.join(repo, ".pragma", "design-sources", "figma", "file-key", "registry.json");
  const registry = await readJson(registryPath);
  registry.roles.components[0].checksum = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  await writeJson(registryPath, registry);
  await assert.rejects(
    run(["design", "validate", "--context", packedResult.contextDir, "--json"]),
    (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.issues.some((issue) => issue.code === "SNAPSHOT_CHECKSUM_MISMATCH"), true);
      return true;
    }
  );
});

test("validate rejects broken pixel spec asset references", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-invalid-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102");
  const pixelSpecPath = path.join(contextDir, "normalized", "pixel-spec.json");
  const pixelSpec = JSON.parse(await fs.readFile(pixelSpecPath, "utf8"));
  pixelSpec.nodes.find((node) => node.assetBinding?.assetId === "asset-drone-icon").assetBinding.assetId = "asset-missing";
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
