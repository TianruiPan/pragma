import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { writePragmaInputBundle } from "../dist/bridge/writer.js";
import { createBridgeServer } from "../dist/bridge/server.js";

async function tempDir() {
  return await mkdtemp(path.join(tmpdir(), "pragma-figma-capture-"));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function requestJson(server, { method = "GET", path: requestPath = "/health", body = undefined } = {}) {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, method, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const textBody = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: res.statusCode, body: textBody ? JSON.parse(textBody) : {} });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function sampleBundle(repo) {
  return {
    schemaVersion: "2.0",
    kind: "pragma-figma-capture-bundle",
    createdAt: "2026-07-07T00:00:00.000Z",
    files: [
      { path: "capture.json", kind: "json", content: { repo: { owner: "local", name: "repo", localPath: repo }, designIssue: { number: 12 }, figma: { fileKey: "file123" }, capturedAt: "2026-07-07T00:00:00.000Z" } },
      { path: "figma/selection.json", kind: "json", content: { fileKey: "file123", frames: { page: [{ nodeId: "1:2", name: "Home" }], components: null, assets: null } } },
      { path: "figma/layers.json", kind: "json", content: { nodes: [{ nodeId: "1:2", figmaNodeId: "1:2", name: "Home", type: "FRAME", visible: true, hidden: false, styleIds: { fillStyleId: "S:fill" }, boundVariables: { fills: [{ id: "VariableID:1" }] }, children: [{ nodeId: "2:3", figmaNodeId: "2:3", name: "Button", type: "INSTANCE", visible: false, hidden: true, componentRef: { mainComponentNodeId: "5:6" }, variantProperties: { State: "Pressed" }, componentProperties: { state: { value: "pressed" } }, children: [] }] }] } },
      { path: "figma/components.json", kind: "json", content: { schemaVersion: "2.0", kind: "pragma-components", instances: [{ figmaNodeId: "2:3", mainComponentNodeId: "5:6", visible: false, hidden: true, variantProperties: { State: "Pressed" }, componentProperties: { state: { value: "pressed" } } }], metadataCompleteness: { instanceCount: 1, componentMetadataMissingCount: 0, visibilityFactsCount: 2 } } },
      { path: "figma/variables.json", kind: "json", content: { schemaVersion: "2.0", kind: "pragma-figma-variables", variables: [{ id: "VariableID:1", name: "color/bg" }], styles: [{ id: "S:fill", name: "surface/bg", type: "PAINT" }] } },
      { path: "assets-manifest.json", kind: "json", content: { schemaVersion: "2.0", kind: "pragma-design-assets", assets: [] } },
      { path: "asset-bindings.json", kind: "json", content: { schemaVersion: "2.0", kind: "pragma-asset-bindings", bindings: [] } },
      { path: "designer-notes.md", kind: "text", content: "notes" },
      { path: "dynamic-regions.md", kind: "text", content: "" }
    ]
  };
}

test("writes bundle and resolves missing components when no registry exists", async () => {
  const repo = await tempDir();
  const out = path.join(repo, "out", "pragma-input");
  try {
    const result = await writePragmaInputBundle(sampleBundle(repo), { out, repo });
    assert.equal(result.statuses.components, "missing");
    const lock = JSON.parse(await readFile(path.join(out, "dependency-lock.json"), "utf8"));
    assert.equal(lock.pageFrames[0].snapshotId.startsWith("page-1-2-"), true);
    assert.equal(lock.components.status, "missing");
    assert.equal(lock.assets.status, "none");
    assert.equal(typeof result.captureTimings.serializeMs, "number");
    assert.equal(typeof result.captureTimings.writeFilesMs, "number");
    assert.equal(typeof result.captureTimings.dependencyLockMs, "number");
    assert.equal(typeof result.captureTimings.totalMs, "number");
    const summary = await readJson(path.join(out, "capture-summary.json"));
    assert.equal(summary.kind, "pragma-figma-capture-summary");
    assert.equal(summary.captureTimings.totalMs, result.captureTimings.totalMs);
    assert.equal(summary.diagnostics.frameRoles.page.count, 1);
    assert.equal(summary.diagnostics.componentInstanceCount, 1);
    assert.equal(summary.diagnostics.componentMetadataMissingCount, 0);
    assert.equal(summary.diagnostics.visibilityFactsCount, 2);
    assert.equal(summary.diagnostics.styleRefNodeCount, 1);
    assert.equal(summary.diagnostics.variableRefNodeCount, 1);
    assert.equal(summary.diagnostics.localVariableCount, 1);
    assert.equal(summary.diagnostics.localStyleCount, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("reuses registry latest snapshots when optional frames are not selected", async () => {
  const repo = await tempDir();
  const registryDir = path.join(repo, ".pragma", "design-sources", "figma", "file123");
  const out = path.join(repo, "out", "pragma-input");
  try {
    await mkdir(registryDir, { recursive: true });
    await writeFile(path.join(registryDir, "registry.json"), JSON.stringify({
      schemaVersion: "2.0",
      fileKey: "file123",
      latest: { components: "components-5-6-abcdef", assets: "assets-7-8-fedcba" },
      roles: {
        components: [{ snapshotId: "components-5-6-abcdef", frameNodeId: "5:6", checksum: "sha256:components" }],
        assets: [{ snapshotId: "assets-7-8-fedcba", frameNodeId: "7:8", checksum: "sha256:assets" }]
      }
    }, null, 2));
    const result = await writePragmaInputBundle(sampleBundle(repo), { out, repo });
    assert.equal(result.statuses.components, "reused");
    assert.equal(result.statuses.assets, "reused");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("locks selected multi-frame component and asset slots", async () => {
  const repo = await tempDir();
  const out = path.join(repo, "out", "pragma-input");
  try {
    const bundle = sampleBundle(repo);
    const selectionFile = bundle.files.find((file) => file.path === "figma/selection.json");
    selectionFile.content.frames.components = [{ nodeId: "5:1", name: "Components A" }, { nodeId: "5:2", name: "Components B" }];
    selectionFile.content.frames.assets = [{ nodeId: "6:1", name: "Assets A" }, { nodeId: "6:2", name: "Assets B" }];
    const result = await writePragmaInputBundle(bundle, { out, repo });
    assert.equal(result.statuses.components, "selected");
    assert.equal(result.dependencyLock.components.frameNodeIds.length, 2);
    assert.equal(result.statuses.assets, "selected");
    assert.equal(result.dependencyLock.assets.frameNodeIds.length, 2);
    assert.equal(result.dependencyLock.components.path, null);
    assert.equal(result.dependencyLock.components.checksum, null);
    assert.equal(result.dependencyLock.components.needsSourceSync, true);
    assert.match(result.dependencyLock.components.plannedSnapshotId, /^components-5-1-/);
    assert.notEqual(result.dependencyLock.components.contentChecksum, result.dependencyLock.assets.contentChecksum);
    assert.equal(result.dependencyLock.pageFrames[0].snapshotId.endsWith(result.dependencyLock.components.plannedSnapshotId.split("-").at(-1)), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("rejects unsafe bundle paths", async () => {
  const repo = await tempDir();
  try {
    const bundle = sampleBundle(repo);
    bundle.files.push({ path: "../escape.txt", kind: "text", content: "bad" });
    await assert.rejects(() => writePragmaInputBundle(bundle, { out: path.join(repo, "out") }), /Unsafe bundle path/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("rejects bundles without a resolved fileKey", async () => {
  const repo = await tempDir();
  try {
    const bundle = sampleBundle(repo);
    const captureFile = bundle.files.find((file) => file.path === "capture.json");
    const selectionFile = bundle.files.find((file) => file.path === "figma/selection.json");
    delete captureFile.content.figma.fileKey;
    delete selectionFile.content.fileKey;
    await assert.rejects(() => writePragmaInputBundle(bundle, { out: path.join(repo, "out") }), /fileKey is required/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});


test("writes UTF-8 JSON and diagnostics for Chinese names and unavailable checksums", async () => {
  const repo = await tempDir();
  const out = path.join(repo, "out", "pragma-input");
  try {
    const bundle = sampleBundle(repo);
    const captureFile = bundle.files.find((file) => file.path === "capture.json");
    captureFile.content.figma.fileName = "\u98de\u624b\u4f4d\u7f6e\u8bbe\u8ba1";
    const selectionFile = bundle.files.find((file) => file.path === "figma/selection.json");
    selectionFile.content.frames.page[0].name = "\u9996\u9875-\u98de\u624b\u4f4d\u7f6e";
    const layersFile = bundle.files.find((file) => file.path === "figma/layers.json");
    layersFile.content.nodes[0].name = "\u9996\u9875-\u98de\u624b\u4f4d\u7f6e";
    const assetManifest = bundle.files.find((file) => file.path === "assets-manifest.json");
    assetManifest.content.assets = [{ id: "asset-cn", name: "\u4e2d\u6587\u7d20\u6750", path: "assets/images/cn.png", mime: "image/png", checksumStatus: "unavailable" }];
    const notes = bundle.files.find((file) => file.path === "designer-notes.md");
    notes.content = "\u4e2d\u6587\u8bbe\u8ba1\u8bf4\u660e";

    const result = await writePragmaInputBundle(bundle, { out, repo });
    const selectionText = await readFile(path.join(out, "figma", "selection.json"), "utf8");
    assert.equal(selectionText.includes("\u9996\u9875-\u98de\u624b\u4f4d\u7f6e"), true);
    const selection = JSON.parse(selectionText);
    assert.equal(selection.frames.page[0].name, "\u9996\u9875-\u98de\u624b\u4f4d\u7f6e");
    const notesText = await readFile(path.join(out, "designer-notes.md"), "utf8");
    assert.equal(notesText, "\u4e2d\u6587\u8bbe\u8ba1\u8bf4\u660e");
    assert.equal(result.diagnostics.assetChecksumUnavailableCount, 1);
    const summary = await readJson(path.join(out, "capture-summary.json"));
    assert.equal(summary.diagnostics.assetChecksumUnavailableCount, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("bridge returns structured errors and health detail with last capture summary", async () => {
  const repo = await tempDir();
  const out = path.join(repo, "out", "pragma-input");
  const server = createBridgeServer({ repo, outputRoot: out });
  try {
    await listen(server);
    const missing = await requestJson(server, { path: "/missing" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body.ok, false);
    assert.equal(missing.body.code, "BRIDGE_ROUTE_NOT_FOUND");

    const badJson = await requestJson(server, { method: "POST", path: "/capture", body: "{" });
    assert.equal(badJson.statusCode, 400);
    assert.equal(badJson.body.ok, false);
    assert.equal(badJson.body.code, "BRIDGE_INVALID_JSON");
    assert.equal(typeof badJson.body.hint, "string");

    const posted = await requestJson(server, { method: "POST", path: "/capture", body: JSON.stringify({ bundle: sampleBundle(repo) }) });
    assert.equal(posted.statusCode, 200);
    assert.equal(posted.body.ok, true);
    assert.equal(typeof posted.body.captureTimings.totalMs, "number");

    const detail = await requestJson(server, { path: "/detail" });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.body.version, "0.1.0");
    assert.equal(detail.body.repo, repo);
    assert.equal(detail.body.lastCaptureSummary.statuses.components, "missing");
    assert.equal(typeof detail.body.lastCaptureSummary.captureTimings.totalMs, "number");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(repo, { recursive: true, force: true });
  }
});
