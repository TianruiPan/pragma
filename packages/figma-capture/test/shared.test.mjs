import test from "node:test";
import assert from "node:assert/strict";
import { parseFigmaUrl, normalizeFigmaNodeId, figmaNodeIdForUrl, resolveRequiredFigmaFileKey } from "../dist/shared/figma-url.js";
import { normalizeBridgeEndpoint } from "../dist/shared/bridge-url.js";
import { assertFrameRoles, buildCaptureJson, buildSelectionJson } from "../dist/shared/roles.js";
import { collectComponentInstances, collectVisualStateSources, serializeLayerNode } from "../dist/shared/layer.js";
import { createAssetBinding, createAssetRecord, sniffAssetBytes, sniffMime } from "../dist/shared/assets.js";

test("normalizes and parses Figma node ids", () => {
  assert.equal(normalizeFigmaNodeId("1206-31342"), "1206:31342");
  assert.equal(figmaNodeIdForUrl("1206:31342"), "1206-31342");
  const parsed = parseFigmaUrl("https://www.figma.com/design/abc123/File?node-id=1-23");
  assert.equal(parsed.fileKey, "abc123");
  assert.equal(parsed.nodeId, "1:23");
});

test("resolves required fileKey with explicit fallback order", () => {
  assert.equal(resolveRequiredFigmaFileKey({ override: "manual", figmaUrl: "https://www.figma.com/design/urlKey/File", pluginFileKey: "plugin" }), "manual");
  assert.equal(resolveRequiredFigmaFileKey({ figmaUrl: "https://www.figma.com/design/urlKey/File", pluginFileKey: "plugin" }), "urlKey");
  assert.equal(resolveRequiredFigmaFileKey({ pluginFileKey: "plugin" }), "plugin");
  assert.throws(() => resolveRequiredFigmaFileKey({}), /fileKey is required/);
});

test("normalizes localhost bridge endpoint and rejects unsupported hosts", () => {
  const endpoint = normalizeBridgeEndpoint("http://localhost:48732/capture");
  assert.equal(endpoint.healthUrl, "http://localhost:48732/health");
  assert.equal(normalizeBridgeEndpoint("localhost:48732/capture").captureUrl, "http://localhost:48732/capture");
  assert.equal(normalizeBridgeEndpoint("http://localhost:48732").captureUrl, "http://localhost:48732/capture");
  assert.equal(normalizeBridgeEndpoint("http://localhost:48732/capture/").captureUrl, "http://localhost:48732/capture");
  assert.throws(() => normalizeBridgeEndpoint("http://127.0.0.1:48732/capture"), /localhost:48732/);
  assert.throws(() => normalizeBridgeEndpoint("http://localhost:48732/wrong"), /localhost:48732/);
});

test("validates required page role and duplicate assignments", () => {
  assert.throws(() => assertFrameRoles({ page: [] }), /page frame/);
  assert.throws(() => assertFrameRoles({ page: [{ nodeId: "1:1", name: "Page" }], components: { nodeId: "1:1", name: "Components" } }), /more than one role/);
});

test("builds capture and selection json with frame roles", () => {
  const frames = { page: [{ nodeId: "1:1", name: "Home", role: "page" }], components: null, assets: null };
  const capture = buildCaptureJson({
    repo: { owner: "local", name: "repo" },
    designIssue: { number: 2, title: "Home design delivery" },
    targetDevIssues: [{ number: 3, title: "Implement Home" }],
    figma: { fileKey: "abc", frames }
  }, "2026-07-07T00:00:00.000Z");
  const selection = buildSelectionJson({ fileKey: "abc", frames });
  assert.deepEqual(capture.figma.nodeIds, ["1:1"]);
  assert.equal(capture.designIssue.title, "Home design delivery");
  assert.equal(capture.targetDevIssues[0].title, "Implement Home");
  assert.equal(selection.frames.page[0].role, "page");
});

test("builds selection json with multiple component and asset frames", () => {
  const frames = {
    page: [{ nodeId: "1:1", name: "Home", role: "page", url: "https://www.figma.com/design/abc/File?node-id=1-1" }],
    components: [{ nodeId: "2:1", name: "Components A" }, { nodeId: "2:2", name: "Components B" }],
    assets: [{ nodeId: "3:1", name: "Assets A" }, { nodeId: "3:2", name: "Assets B" }]
  };
  const selection = buildSelectionJson({ fileKey: "abc", frames });
  assert.equal(selection.frames.components.length, 2);
  assert.equal(selection.frames.assets.length, 2);
  assert.equal(selection.frames.page[0].url.includes("node-id=1-1"), true);
  assert.equal(selection.nodes.length, 5);
});

test("serializes layer nodes and extracts component refs", () => {
  const serialized = serializeLayerNode({
    id: "7:8",
    name: "Primary button",
    type: "INSTANCE",
    visible: false,
    absoluteBoundingBox: { x: 10, y: 20, width: 120, height: 40 },
    width: 120,
    height: 40,
    fillStyleId: "S:fill",
    textStyleId: "S:text",
    boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "VariableID:1" }] },
    variantProperties: { State: "Pressed" },
    componentProperties: { state: { value: "default" } },
    children: [{ id: "7:9", name: "Label", type: "TEXT", characters: "Submit", fills: [{ type: "SOLID", color: { r: 1, g: 0.5, b: 0 }, opacity: 0.8 }], absoluteBoundingBox: { x: 20, y: 30, width: 80, height: 20 } }]
  }, { mainComponent: { id: "5:6", name: "Button", parent: { id: "4:5", name: "Button set" } } });
  assert.equal(serialized.bounds.width, 120);
  assert.equal(serialized.size.width, 120);
  assert.equal(serialized.hidden, true);
  assert.equal(serialized.componentRef.componentSetName, "Button set");
  assert.equal(serialized.componentRef.variantProperties.State, "Pressed");
  assert.equal(serialized.styleIds.fillStyleId, "S:fill");
  assert.equal(serialized.tokenRefs.boundVariables.fills[0].id, "VariableID:1");
  assert.equal(serialized.availableStates.some((state) => state.source === "figma-node-visibility" && state.value === "hidden"), true);
  assert.equal(serialized.children[0].text.content, "Submit");
  assert.equal(serialized.children[0].text.color.resolvedValue, "#FF8000");
  const instances = collectComponentInstances([serialized]);
  assert.equal(instances[0].mainComponentNodeId, "5:6");
  assert.equal(instances[0].componentSetId, "4:5");
  assert.equal(instances[0].hidden, true);
  assert.equal(instances[0].availableStates.some((state) => state.name === "State" && state.value === "Pressed"), true);
  assert.equal(instances[0].bounds.height, 40);
  const visualStateSources = collectVisualStateSources([serialized]);
  assert.equal(visualStateSources[0].sourceKind, "component-instance");
  assert.equal(/runtimeDefault|businessDefault/i.test(JSON.stringify(serialized)), false);
});

test("creates asset records with bindings and sniffs png", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png[19] = 2;
  png[23] = 3;
  const mime = sniffMime(png);
  const sniffed = sniffAssetBytes(png);
  const asset = createAssetRecord({
    id: "asset-home-bg",
    name: "Home background",
    mime,
    path: "assets/images/home.png",
    checksum: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceNodeIds: ["1:2"],
    usedByNodeIds: ["1:2"],
    bindings: [{ assetId: "asset-home-bg", figmaNodeId: "1:2", sourceNodeIds: ["1:2"], usedByNodeIds: ["1:2"], scope: "page", fit: "cover" }]
  });
  assert.equal(asset.type, "png");
  assert.equal(asset.checksum, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(sniffed.width, 2);
  assert.equal(sniffed.height, 3);
  assert.deepEqual(asset.usedByNodeIds, ["1:2"]);
  assert.equal(asset.bindings, undefined);
  const binding = createAssetBinding({ assetId: "asset-home-bg", figmaNodeId: "1:2", sourceNodeIds: ["1:2"], usedByNodeIds: ["1:2"], scope: "page", fit: "cover", placement: { x: 1, y: 2, width: 3, height: 4 } });
  assert.equal(binding.fit, "cover");
  assert.deepEqual(binding.sourceNodeIds, ["1:2"]);
  assert.equal(binding.scope, "page");
  assert.equal(binding.placement.width, 3);

  const invalidChecksum = createAssetRecord({
    id: "asset-invalid-checksum",
    name: "Invalid checksum",
    mime,
    path: "assets/images/invalid-checksum.png",
    checksum: "sha256:plugin-webcrypto-unavailable-24"
  });
  assert.equal(invalidChecksum.checksum, undefined);
  assert.equal(invalidChecksum.checksumStatus, "unavailable");

  const unavailable = createAssetRecord({
    id: "asset-no-checksum",
    name: "No checksum",
    mime,
    path: "assets/images/no-checksum.png"
  });
  assert.equal(unavailable.checksum, undefined);
  assert.equal(unavailable.checksumStatus, "unavailable");
});
