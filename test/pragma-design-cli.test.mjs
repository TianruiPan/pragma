import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseFigmaUrl } from "../src/core/figma-url.js";
import { buildComponents } from "../src/core/pixel-normalize.js";
import { publishDesignContext } from "../src/core/publish.js";

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
  await writeJson(path.join(input, "figma", "selection.json"), {
    fileKey: "file-key",
    nodes: [{ id: "1:23", name: "Main", width: 1440, height: 900 }],
    frames: {
      page: [{ role: "page", nodeId: "1:23", name: "Main", type: "FRAME", bounds: { x: 0, y: 0, width: 1440, height: 900 }, viewport: { width: 1440, height: 900 }, url: "https://www.figma.com/design/file-key/Demo?node-id=1-23" }]
    }
  });
  await fs.mkdir(path.join(input, "figma"), { recursive: true });

  await writeJson(path.join(input, "figma", "layers.json"), {
    rootNodeIds: ["1:23"],
    nodes: [
      { figmaNodeId: "1:23", name: "Main", type: "FRAME", bounds: { x: 0, y: 0, width: 1440, height: 900 }, fills: ["#ffffff"], radius: 4, styleIds: { fillStyleId: "S:surface" }, boundVariables: { fills: [{ id: "VariableID:surface" }] }, children: ["1:20", "1:30", "1:40"] },
      { figmaNodeId: "1:20", name: "Header panel", type: "FRAME", bounds: { x: 0, y: 0, width: 1440, height: 80 }, children: ["1:24"] },
      { figmaNodeId: "1:24", name: "Title", type: "TEXT", bounds: { x: 24, y: 24, width: 160, height: 32 }, styleIds: { textStyleId: "S:heading" }, text: { content: "Dashboard", fontStyle: "Semi Bold", fontSize: 24, lineHeight: 32, color: "#ffffff" } },
      { figmaNodeId: "1:30", name: "Drone icon", type: "IMAGE", bounds: { x: 200, y: 200, width: 32, height: 32 } },
      { figmaNodeId: "1:40", name: "Primary button", type: "INSTANCE", bounds: { x: 260, y: 200, width: 120, height: 40 }, componentRef: { componentId: "component-button", name: "Button" }, variantProperties: { State: "Pressed" }, componentProperties: { disabled: { value: false } }, availableStates: [{ name: "State", value: "Pressed", source: "figma-variant-property" }] }
    ]
  });
  await writeJson(path.join(input, "asset-bindings.json"), {
    bindings: [{ assetId: "asset-drone-icon", nodeId: "1:30", figmaNodeId: "1:30", sourceNodeIds: ["1:30"], usedByNodeIds: ["1:30"], scope: "page", fit: "contain", placement: { x: 200, y: 200, width: 32, height: 32 }, sourcePaint: { type: "IMAGE", scaleMode: "FILL" } }]
  });
  await writeJson(path.join(input, "figma", "variables.json"), {
    colors: { "text.primary": "#ffffff" },
    radius: { "radius.sm": 4 },
    variables: [{ id: "VariableID:surface", key: "surface-key", name: "surface.primary", resolvedType: "COLOR", valuesByMode: { default: { r: 1, g: 1, b: 1, a: 1 } }, scopes: ["ALL_FILLS"], description: "Local surface color", remote: false }],
    styles: [{ id: "S:surface", key: "surface-style", name: "surface/fill", type: "PAINT", paints: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }] }, { id: "S:heading", key: "heading-style", name: "heading/lg", type: "TEXT", typeStyle: { fontFamily: "Inter", fontStyle: "Semi Bold", fontSize: 24, lineHeight: 32 } }]
  });
  await writeJson(path.join(input, "figma", "components.json"), { components: [], visualStateSources: [{ nodeId: "1:40", name: "Primary button", sourceKind: "component-instance" }], stateFrames: [], metadataCompleteness: { visualStateSourceCount: 1, stateFrameCount: 0, componentMetadataMissingCount: 0, visibilityFactsCount: 4 } });
  await writeJson(path.join(input, "capture-summary.json"), { diagnostics: { styleRefNodeCount: 2, variableRefNodeCount: 1, localVariableCount: 1, localStyleCount: 2, assetBindingCount: 1 } });
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
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102", "versions", "v1");

  const validate = await run(["design", "validate", "--context", contextDir]);
  assert.match(validate.stdout, /OK:/);

  const fragment = await run(["design", "issue-fragment", "--context", contextDir]);
  assert.match(fragment.stdout, /Manifest/);
  assert.match(fragment.stdout, /Current Version: v1/);

  const issueRoot = path.join(repo, ".pragma", "design-contexts", "issue-102");
  const pinnedBeforePublish = JSON.parse((await run(["design", "read", "--context", issueRoot, "--version", "v1", "--summary-only"])).stdout);
  assert.equal(pinnedBeforePublish.version, "v1");
  await assert.rejects(
    run(["design", "read", "--context", contextDir, "--version", "v2", "--summary-only"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /does not match context directory version/);
      return true;
    }
  );

  const publish = JSON.parse((await run(["design", "publish", "--context", contextDir, "--threshold-mb", "20"])).stdout);
  assert.equal(publish.version, "v1");
  assert.match(publish.currentPath, /current\.json$/);
  const current = await readJson(path.join(repo, ".pragma", "design-contexts", "issue-102", "current.json"));
  assert.equal(current.currentVersion, "v1");
  assert.equal(current.currentManifest, "versions/v1/manifest.json");
  const validateRoot = await run(["design", "validate", "--context", path.join(repo, ".pragma", "design-contexts", "issue-102")]);
  assert.match(validateRoot.stdout, /OK:/);

  const read = await run(["design", "read", "--repo", repo, "--issue", "102", "--summary-only"]);
  const readResult = JSON.parse(read.stdout);
  assert.equal(readResult.ok, true);
  assert.equal(readResult.version, "v1");
  assert.match(readResult.checksum, /^sha256:/);
  assert.match(readResult.manifestChecksum, /^sha256:/);
  assert.match(readResult.packageChecksum, /^sha256:/);
  assert.match(readResult.agentContextPath, /agent-context\.md$/);
  assert.match(readResult.agentWorkflowPath, /agent-workflow\.md$/);
  assert.match(readResult.pixelSpecPath, /pixel-spec[\\/]index\.json$/);
  assert.match(readResult.layersPath, /layers[\\/]index\.json$/);
  const manifest = await readJson(path.join(contextDir, "manifest.json"));
  assert.equal(manifest.version, "v1");
  assert.equal(manifest.versionNumber, 1);
  assert.equal(manifest.issue.type, "design");
  assert.match(manifest.sourceChecksum, /^sha256:/);
  assert.match(manifest.packageChecksum, /^sha256:/);
  assert.equal(readResult.packageChecksum, manifest.packageChecksum);
  assert.notEqual(readResult.manifestChecksum, readResult.packageChecksum);
  assert.equal(manifest.entrypoints.agentWorkflow, "normalized/agent-workflow.md");
  assert.equal(manifest.entrypoints.pixelSpec, "normalized/pixel-spec/index.json");
  assert.equal(manifest.entrypoints.layers, "normalized/layers/index.json");
  const currentFragment = await run(["design", "issue-fragment", "--repo", repo, "--issue", "102"]);
  assert.match(currentFragment.stdout, /Current Pointer/);
  assert.match(currentFragment.stdout, /versions\/v1\/manifest\.json/);
  const agentWorkflow = await fs.readFile(path.join(contextDir, "normalized", "agent-workflow.md"), "utf8");
  assert.match(agentWorkflow, /Progressive Disclosure Rules/);
  assert.match(agentWorkflow, /Business Data Safety/);
  assert.match(agentWorkflow, /pragma-context-descriptor\/v1/);
  assert.match(agentWorkflow, /Do not invoke Pragma CLI/);
  const designContext = await readJson(path.join(contextDir, "normalized", "design-context.json"));
  assert.equal(Array.isArray(designContext.pageRegions), true);
  assert.equal(designContext.pageRegions.length > 0, true);
  assert.equal(designContext.pixelSpec, "normalized/pixel-spec/index.json");
  const pixelIndex = await readJson(path.join(contextDir, "normalized", "pixel-spec", "index.json"));
  assert.equal(pixelIndex.kind, "pragma-pixel-spec-index");
  assert.equal(pixelIndex.regions.length > 0, true);
  const regionShards = await Promise.all(pixelIndex.regions.map((region) => readJson(path.join(contextDir, region.path))));
  assert.equal(regionShards.every((shard) => shard.kind === "pragma-pixel-spec-region"), true);
  const regionTitleNode = regionShards.flatMap((shard) => shard.nodes).find((node) => node.figmaNodeId === "1:24");
  assert.equal(regionTitleNode.text.typography.resolvedValue.fontSize, 24);
  assert.equal(regionTitleNode.text.typography.resolvedValue.fontStyle, "Semi Bold");
  const layerIndex = await readJson(path.join(contextDir, "normalized", "layers", "index.json"));
  assert.equal(layerIndex.kind, "pragma-layer-tree-index");
  const layerShard = await readJson(path.join(contextDir, layerIndex.frames[0].path));
  assert.equal(layerShard.kind, "pragma-layer-tree-frame");
  assert.equal(layerShard.nodes.every((node) => !("bounds" in node) && !("componentRef" in node) && !("text" in node) && !("assetBinding" in node)), true);
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
  assert.equal(mainNode.fills[0].color.tokenId, "color-surface-fill");
  assert.equal(titleNode.text.typography.tokenId, "typography-heading-lg");
  const buttonNode = pixelSpec.nodes.find((node) => node.figmaNodeId === "1:40");
  assert.equal(buttonNode.availableStates.some((state) => state.source === "figma-variant-property" && state.value === "Pressed"), true);
  const tokens = await readJson(path.join(contextDir, "normalized", "tokens.json"));
  assert.equal(tokens.tokens.some((token) => token.source?.variableId === "VariableID:surface"), true);
  assert.equal(tokens.tokens.some((token) => token.source?.styleId === "S:heading"), true);
  const components = await readJson(path.join(contextDir, "normalized", "components.json"));
  const buttonInstance = components.instances.find((instance) => instance.figmaNodeId === "1:40");
  assert.equal(buttonInstance.variantProperties.State, "Pressed");
  assert.equal(components.metadataCompleteness.visualStateSourceCount, 1);
  const layers = JSON.parse(await fs.readFile(path.join(contextDir, "normalized", "layers.json"), "utf8"));
  assert.equal(layers.nodes.every((node) => !("bounds" in node) && !("componentRef" in node) && !("text" in node) && !("assetBinding" in node)), true);
  const assets = JSON.parse(await fs.readFile(path.join(contextDir, "normalized", "assets.json"), "utf8"));
  assert.equal(assets.assets.every((assetItem) => !("bindings" in assetItem) && !("fit" in assetItem) && !("crop" in assetItem) && !("placement" in assetItem)), true);
  assert.deepEqual(assets.assets[0].usedByNodeIds, ["node-1-30"]);
  const sourceSummary = await readJson(path.join(contextDir, "source", "capture-summary.json"));
  assert.equal(sourceSummary.diagnostics.assetBindingCount, 1);
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
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102", "versions", "v1");

  const layersPath = path.join(contextDir, "normalized", "layers.json");
  const layers = await readJson(layersPath);
  layers.nodes[0].bounds = { x: 0, y: 0, width: 1, height: 1 };
  await writeJson(layersPath, layers);

  const pixelIndex = await readJson(path.join(contextDir, "normalized", "pixel-spec", "index.json"));
  const pixelPath = path.join(contextDir, pixelIndex.frames[0].path);
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


test("validate enforces agent workflow sections, legacy shard consistency, and runtime-state boundaries", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-workflow-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102", "versions", "v1");

  await fs.writeFile(path.join(contextDir, "normalized", "agent-workflow.md"), "# Agent Workflow\n\n## Read Gate\nOnly.\n", "utf8");
  await assert.rejects(
    run(["design", "validate", "--context", contextDir, "--json"]),
    (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.errors.some((item) => item.includes("agent-workflow.md must include typography")), true);
      return true;
    }
  );

  await run(["design", "ingest", "--input", input, "--repo", repo, "--force"]);
  const pixelIndexPath = path.join(contextDir, "normalized", "pixel-spec", "index.json");
  const pixelIndex = await readJson(pixelIndexPath);
  pixelIndex.availableStates = [{ name: "forced selected", source: "issue-runtime-default", nodeIds: ["node-1-23"] }];
  await writeJson(pixelIndexPath, pixelIndex);
  const legacyPixelPath = path.join(contextDir, "normalized", "pixel-spec.json");
  const legacyPixel = await readJson(legacyPixelPath);
  legacyPixel.nodes.pop();
  await writeJson(legacyPixelPath, legacyPixel);
  const legacyLayersPath = path.join(contextDir, "normalized", "layers.json");
  const legacyLayers = await readJson(legacyLayersPath);
  legacyLayers.nodes.pop();
  await writeJson(legacyLayersPath, legacyLayers);

  await assert.rejects(
    run(["design", "validate", "--context", contextDir, "--json"]),
    (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.issues.some((issue) => issue.code === "LEGACY_AGGREGATE_MISMATCH"), true);
      assert.equal(result.issues.some((issue) => issue.code === "ISSUE_RUNTIME_DEFAULT_STATE"), true);
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
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102", "versions", "v1");
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
  const selection = await readJson(path.join(input, "figma", "selection.json"));
  selection.frames.components = [{ role: "components", nodeId: "5:100", name: "Components", type: "FRAME", bounds: { x: 0, y: 1000, width: 360, height: 240 } }];
  selection.frames.assets = [{ role: "assets", nodeId: "6:200", name: "Assets", type: "FRAME", bounds: { x: 400, y: 1000, width: 360, height: 240 } }];
  await writeJson(path.join(input, "figma", "selection.json"), selection);
  const first = JSON.parse((await run(["design", "source", "add", "--role", "components", "--input", input, "--repo", repo, "--file-key", "file-key"])).stdout);
  assert.equal(first.created, true);
  assert.equal(first.reused, false);
  assert.equal(first.frameNodeId, "5:100");

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

test("read blocks when required Design Issue context is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-block-"));
  const repo = path.join(tmp, "repo");
  await fs.mkdir(path.join(repo, "issues"), { recursive: true });
  const devIssue = path.join(repo, "issues", "issue-101.md");
  await fs.writeFile(devIssue, "## 设计输入\n\n需要 Design Issue：是\nDesign Issue：#102\n", "utf8");
  await assert.rejects(
    run(["design", "read", "--repo", repo, "--dev-issue-file", devIssue]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /尚未提供可读取的 current pointer/);
      return true;
    }
  );
});

test("pack writes zip outside context and publish keeps repo mode zip-free", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-pack-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102", "versions", "v1");
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

test("publish supports MinIO object storage dry run without exposing credentials", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-publish-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102", "versions", "v1");
  const publish = await run([
    "design",
    "publish",
    "--context",
    contextDir,
    "--threshold-mb",
    "0",
    "--minio-endpoint",
    "http://minio.example.com:9000",
    "--minio-bucket",
    "product-project-dev-lab",
    "--dry-run"
  ]);
  const publishResult = JSON.parse(publish.stdout);
  assert.equal(publishResult.mode, "minio-s3");
  assert.equal(publishResult.artifact.bucket, "product-project-dev-lab");
  assert.equal(publishResult.artifact.objectKey, "pragma-design-context/example-org/demo-repo/issue-102/v1/context.zip");
  assert.equal(publishResult.artifact.uri, "s3://product-project-dev-lab/pragma-design-context/example-org/demo-repo/issue-102/v1/context.zip");
  assert.equal("accessKey" in publishResult.artifact, false);
  assert.equal("secretKey" in publishResult.artifact, false);
  assert.match(publishResult.artifact.checksum, /^sha256:/);
  await assert.rejects(fs.access(path.join(repo, ".pragma", "design-contexts", "issue-102", "current.json")));

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

test("publish uploads an immutable MinIO object before advancing current", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-minio-upload-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102", "versions", "v1");
  const uploads = [];
  const previousAccessKey = process.env.PRAGMA_MINIO_PUBLISH_ACCESS_KEY;
  const previousSecretKey = process.env.PRAGMA_MINIO_PUBLISH_SECRET_KEY;
  process.env.PRAGMA_MINIO_PUBLISH_ACCESS_KEY = "test-publisher";
  process.env.PRAGMA_MINIO_PUBLISH_SECRET_KEY = "test-secret";
  try {
    const result = await publishDesignContext({
      context: contextDir,
      "threshold-mb": "0",
      "minio-endpoint": "http://minio.example.com:9000",
      "minio-bucket": "product-project-dev-lab",
      minioClient: {
        async statObject() {
          throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
        },
        async fPutObject(bucket, objectKey, file, metadata) {
          uploads.push({ bucket, objectKey, file, metadata });
          return { etag: "fixture-etag", versionId: null };
        }
      }
    });

    assert.equal(result.mode, "minio-s3");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].bucket, "product-project-dev-lab");
    assert.equal(uploads[0].objectKey, "pragma-design-context/example-org/demo-repo/issue-102/v1/context.zip");
    assert.equal(uploads[0].metadata["X-Amz-Meta-Pragma-Sha256"], result.manifest.packageChecksum);
    await fs.access(path.join(repo, ".pragma", "design-contexts", "issue-102", "current.json"));
  } finally {
    if (previousAccessKey === undefined) delete process.env.PRAGMA_MINIO_PUBLISH_ACCESS_KEY;
    else process.env.PRAGMA_MINIO_PUBLISH_ACCESS_KEY = previousAccessKey;
    if (previousSecretKey === undefined) delete process.env.PRAGMA_MINIO_PUBLISH_SECRET_KEY;
    else process.env.PRAGMA_MINIO_PUBLISH_SECRET_KEY = previousSecretKey;
  }
});

test("publish rejects version and Design Issue mismatches without advancing current", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-publish-identity-"));
  const { input, repo } = await createInputFixture(tmp);
  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const issueRoot = path.join(repo, ".pragma", "design-contexts", "issue-102");
  const contextDir = path.join(issueRoot, "versions", "v1");

  await assert.rejects(
    run(["design", "publish", "--context", contextDir, "--version", "v2"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /does not match context directory version/);
      return true;
    }
  );
  await assert.rejects(
    run(["design", "publish", "--context", contextDir, "--issue", "103"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /does not match manifest\.issue\.number/);
      return true;
    }
  );

  const manifest = await readJson(path.join(contextDir, "manifest.json"));
  assert.equal(manifest.version, "v1");
  assert.equal(manifest.issue.number, 102);
  await assert.rejects(fs.access(path.join(issueRoot, "current.json")));
});

test("pack-from-figma-capture runs the full deterministic pipeline", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-combo-"));
  const { input, repo } = await createInputFixture(tmp);
  const packed = await run(["design", "pack-from-figma-capture", "--input", input, "--repo", repo, "--threshold-mb", "20"]);
  const packedResult = JSON.parse(packed.stdout);
  assert.equal(packedResult.ok, true);
  assert.equal(packedResult.preflight.ok, true);
  assert.equal(packedResult.readSmokeCheck.ok, true);
  assert.match(packedResult.readSmokeCheck.agentWorkflowPath, /agent-workflow\.md$/);
  assert.match(packedResult.readSmokeCheck.layersPath, /layers[\\/]index\.json$/);
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
  await fs.access(path.join(packedResult.contextDir, "normalized", "pixel-spec", "index.json"));
  await fs.access(path.join(packedResult.contextDir, "normalized", "layers", "index.json"));
  await fs.access(path.join(packedResult.contextDir, "normalized", "agent-workflow.md"));
  await fs.access(path.join(packedResult.contextDir, "normalized", "pixel-spec.json"));
  await fs.access(path.join(packedResult.contextDir, "validation", "visual-baseline.json"));
  await assert.rejects(fs.access(path.join(packedResult.contextDir, "context.zip")));
});

test("pack-latest-capture resolves latest repo-scoped capture and supports explicit input", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-latest-"));
  const fixtureRoot = path.join(tmp, "涓枃璺緞");
  const { input, repo } = await createInputFixture(fixtureRoot);
  const older = await copyIncomingCapture(input, repo, 102, "20260707T010000");
  const latest = await copyIncomingCapture(input, repo, 102, "20260707T020000");
  const latestLayersPath = path.join(latest, "figma", "layers.json");
  const latestLayers = await readJson(latestLayersPath);
  latestLayers.nodes[0].name = "涓婚〉";
  await writeJson(latestLayersPath, latestLayers);

  const outsideRepo = path.join(tmp, "outside-repo");
  await fs.mkdir(outsideRepo, { recursive: true });
  await copyIncomingCapture(input, outsideRepo, 102, "20990101T000000");

  const resolved = JSON.parse((await run(["design", "pack-latest-capture", "--repo", repo, "--issue", "102", "--preflight-only", "--json"])).stdout);
  assert.equal(resolved.ok, true);
  assert.equal(path.resolve(resolved.inputPath), path.resolve(latest));
  assert.equal(resolved.latestCapture.selectedCaptureName, "issue-102-20260707T020000");
  assert.equal(resolved.inputPath.includes("outside-repo"), false);
  await assert.rejects(fs.access(path.join(repo, ".pragma", "design-contexts", "issue-102", "versions", "v1")));

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
      assert.match(result.message, /Context version already exists/);
      return true;
    }
  );

  const forced = JSON.parse((await run(["design", "pack-latest-capture", "--repo", repo, "--issue", "102", "--force", "--json"])).stdout);
  assert.equal(forced.ok, true);
  assert.equal(forced.contextDir, first.contextDir);
  assert.equal(forced.readSmokeCheck.ok, true);
});

test("version bump creates immutable v2, read can pin versions, and diff summarizes changes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-version-"));
  const { input, repo } = await createInputFixture(tmp);
  const first = JSON.parse((await run(["design", "pack-from-figma-capture", "--input", input, "--repo", repo, "--threshold-mb", "20"])).stdout);
  assert.match(first.contextDir, /versions[\\/]v1$/);

  const second = JSON.parse((await run(["design", "pack-from-figma-capture", "--input", input, "--repo", repo, "--bump", "auto", "--supersedes", "v1", "--threshold-mb", "20"])).stdout);
  assert.match(second.contextDir, /versions[\\/]v2$/);
  const current = await readJson(path.join(repo, ".pragma", "design-contexts", "issue-102", "current.json"));
  assert.equal(current.currentVersion, "v2");

  const readPinned = JSON.parse((await run(["design", "read", "--repo", repo, "--issue", "102", "--version", "v1", "--summary-only"])).stdout);
  assert.equal(readPinned.version, "v1");
  assert.match(readPinned.manifestPath, /versions[\\/]v1[\\/]manifest\.json$/);

  const diff = JSON.parse((await run(["design", "diff", "--repo", repo, "--issue", "102", "--from", "v1", "--to", "v2", "--json"])).stdout);
  assert.equal(diff.ok, true);
  assert.equal(diff.from.version, "v1");
  assert.equal(diff.to.version, "v2");
  assert.equal(diff.changed, true);
  assert.equal(diff.summary.manifestChanged, true);
  assert.equal(diff.summary.compatibility.reason, "new design context version");
});

test("component normalization preserves main component and component-set identities", () => {
  const normalized = buildComponents({
    componentSets: [{
      id: "4:5",
      name: "Button set",
      type: "COMPONENT_SET",
      components: [{ id: "5:6", name: "State=Default", type: "COMPONENT", componentSetId: "4:5" }]
    }],
    components: [{ id: "5:6", name: "State=Default", type: "COMPONENT", componentSetId: "4:5" }]
  }, [{
    id: "7:8",
    name: "Button instance",
    type: "INSTANCE",
    componentRef: {
      componentId: "5:6",
      mainComponentNodeId: "5:6",
      componentSetId: "4:5",
      componentSetName: "Button set"
    }
  }], new Map([["7:8", "node-7-8"]]));

  assert.deepEqual(normalized.componentSets.map((component) => component.id), ["4:5"]);
  assert.deepEqual(normalized.components.map((component) => component.id), ["5:6"]);
  assert.equal(normalized.instances[0].componentId, "5:6");
  assert.equal(normalized.instances[0].componentSetId, "4:5");
});

test("ingest keeps component and asset capture roots out of page frame shards", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pragma2-role-roots-"));
  const { input, repo } = await createInputFixture(tmp);
  const selection = await readJson(path.join(input, "figma", "selection.json"));
  selection.frames.components = [{ role: "components", nodeId: "5:100", name: "Components", type: "FRAME" }];
  selection.frames.assets = [{ role: "assets", nodeId: "6:200", name: "Assets", type: "FRAME" }];
  await writeJson(path.join(input, "figma", "selection.json"), selection);

  const layers = await readJson(path.join(input, "figma", "layers.json"));
  layers.rootNodeIds.push("5:100", "6:200");
  layers.nodes.push(
    { figmaNodeId: "5:100", name: "Components", type: "FRAME", role: "components", bounds: { x: 0, y: 1000, width: 400, height: 300 }, children: ["5:101"] },
    { figmaNodeId: "5:101", name: "State=Default", type: "COMPONENT", role: "components", bounds: { x: 0, y: 1000, width: 120, height: 40 }, children: [] },
    { figmaNodeId: "6:200", name: "Assets", type: "FRAME", role: "assets", bounds: { x: 500, y: 1000, width: 400, height: 300 }, children: [] }
  );
  await writeJson(path.join(input, "figma", "layers.json"), layers);
  await writeJson(path.join(input, "figma", "components.json"), {
    componentSets: [],
    components: [{ id: "5:101", nodeId: "5:101", name: "State=Default", type: "COMPONENT" }],
    instances: []
  });

  await run(["design", "ingest", "--input", input, "--repo", repo]);
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102", "versions", "v1");
  const designContext = await readJson(path.join(contextDir, "normalized", "design-context.json"));
  const pixelSpec = await readJson(path.join(contextDir, "normalized", "pixel-spec.json"));
  const layerTree = await readJson(path.join(contextDir, "normalized", "layers.json"));
  const components = await readJson(path.join(contextDir, "normalized", "components.json"));

  assert.deepEqual(designContext.frames.map((frame) => frame.figmaNodeId), ["1:23"]);
  assert.equal(pixelSpec.nodes.some((node) => node.figmaNodeId === "5:100" || node.figmaNodeId === "6:200"), false);
  assert.equal(layerTree.nodes.some((node) => node.figmaNodeId === "5:100" || node.figmaNodeId === "6:200"), false);
  assert.equal(components.components.some((component) => component.id === "5:101"), true);
  const validate = await run(["design", "validate", "--context", contextDir]);
  assert.match(validate.stdout, /OK:/);
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
  const capture = await readJson(path.join(input, "capture.json"));
  capture.figma.nodeIds = [];
  await writeJson(path.join(input, "capture.json"), capture);
  const selection = await readJson(path.join(input, "figma", "selection.json"));
  selection.nodes = [];
  selection.frames = {
    page: [{ role: "page", nodeId: "1:23", name: "Plugin page", type: "FRAME", bounds: { x: 0, y: 0, width: 1440, height: 900 }, viewport: { width: 1440, height: 900 }, url: "https://www.figma.com/design/file-key/Demo?node-id=1-23" }],
    components: [{ role: "components", nodeId: "5:100", name: "Components" }],
    assets: [{ role: "assets", nodeId: "6:200", name: "Assets" }]
  };
  await writeJson(path.join(input, "figma", "selection.json"), selection);
  const packedResult = JSON.parse((await run(["design", "pack-from-figma-capture", "--input", input, "--repo", repo, "--threshold-mb", "20"])).stdout);
  assert.equal(packedResult.ok, true);
  assert.equal(packedResult.preflight.repairs.some((repair) => repair.code === "DEPENDENCY_LOCK_CREATED"), true);
  const deps = await readJson(path.join(packedResult.contextDir, "normalized", "dependencies.json"));
  assert.equal(deps.components.status, "none");
  assert.equal(deps.pageFrames[0].snapshotId, "page-1-23-capture");
  assert.equal(deps.pageFrames[0].name, "Plugin page");
  assert.equal(deps.pageFrames[0].viewport.width, 1440);
  assert.equal(deps.pageFrames.some((frame) => frame.nodeId === "5:100" || frame.nodeId === "6:200"), false);
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
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102", "versions", "v1");
  const pixelIndex = await readJson(path.join(contextDir, "normalized", "pixel-spec", "index.json"));
  const pixelSpecPath = path.join(contextDir, pixelIndex.frames[0].path);
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
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102", "versions", "v1");
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
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102", "versions", "v1");
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
  const contextDir = path.join(repo, ".pragma", "design-contexts", "issue-102", "versions", "v1");
  const enriched = await run(["design", "enrich", "--context", contextDir, "--notes", "Use product tabs where available.", "--generated-by", "test", "--model", "none"]);
  const enrichedResult = JSON.parse(enriched.stdout);
  const text = await fs.readFile(enrichedResult.output, "utf8");
  assert.match(text, /## Agent Enrichment/);
  assert.match(text, /generatedBy: test/);
});
