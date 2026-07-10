import fs from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";
import {
  copyDirIfExists,
  copyFileIfExists,
  ensureDir,
  pathExists,
  readJson,
  readText,
  resetDirIfSafe,
  writeJson,
  writeText
} from "./fs.js";
import { generateChecksums, sha256Text } from "./checksum.js";
import { buildDependencies } from "./dependencies.js";
import { parseFigmaUrl } from "./figma-url.js";
import { extractSelectionFrames, extractSelectionNodes, listContextFiles, normalizeAssets, pruneUnreferencedAssetFiles, slugify } from "./normalize.js";
import { chooseVersion, issueRootRelative, normalizeVersion, versionRelative } from "./versioning.js";
import {
  buildAgentWorkflow,
  buildComponents,
  buildLayerModel,
  buildLayerTreePackage,
  buildPageRegions,
  buildPixelSpec,
  buildPixelSpecPackage,
  buildRenderInstructions,
  buildTokens,
  buildVisualBaseline,
  normalizeAssetBindings
} from "./pixel-normalize.js";

function repoName(capture) {
  const owner = capture?.repo?.owner || "unknown-owner";
  const name = capture?.repo?.name || "unknown-repo";
  return `${owner}/${name}`;
}

function defaultCapturedAt(capture) {
  return capture?.capturedAt || new Date().toISOString();
}

function contextRepoPath(issueNumber) {
  return `.pragma/design-contexts/issue-${issueNumber}`;
}

function formatList(items) {
  if (!items.length) return "- Not provided";
  return items.map((item) => `- ${item}`).join("\n");
}

function normalizeNote(value) {
  return String(value || "").trim() || "Not provided.";
}

function buildAgentContext({ capture, selectionNodes, screenshots, assets, designerNotes, dynamicRegionNotes, rawContextPresent, pixelSpec, dependencies, pageRegions }) {
  const issueNumber = capture.designIssue?.number;
  const nodeIds = selectionNodes.map((node) => node.id);
  const targetIssues = (capture.targetDevIssues || []).map((issue) => `#${issue.number}${issue.title ? ` ${issue.title}` : ""}`);
  const assetLines = assets.length
    ? assets.map((asset) => `- ${asset.id}: ${asset.role || "asset"}, ${asset.path}${asset.width && asset.height ? `, ${asset.width}x${asset.height}` : ""}`).join("\n")
    : "- No required assets were exported.";
  const screenshotLines = screenshots.length ? screenshots.map((item) => `- ${item}`).join("\n") : "- No screenshots were exported.";

  return `# Design Context for Issue #${issueNumber}

` +
    `## Required Read Order
` +
    `1. current.json (only when resolving the current recommended version)
` +
    `2. versions/vN/manifest.json
` +
    `3. normalized/agent-context.md (briefing and package map only)
` +
    `4. normalized/agent-workflow.md (read gate, typography, state, data, and CSS safety rules)
` +
    `5. normalized/design-context.json (Page Regions and routing)
` +
    `6. normalized/pixel-spec/index.json, then only the needed frame/region shards
` +
    `7. normalized/dependencies.json (locked shared components/assets snapshots)
` +
    `8. normalized/assets.json
` +
    `9. normalized/tokens.json
` +
    `10. normalized/components.json
` +
    `11. normalized/render-instructions.md
` +
    `12. source/figma-get-design-context.md only as fallback/source evidence
` +
    `13. screenshots/* and validation/visual-baseline.json for visual comparison

` +
    `## Source
` +
    `- Provider: ${capture.source?.provider || "figma"}
` +
    `- Adapter: ${capture.source?.adapter || "figma-mcp"}
` +
    `- Repo: ${repoName(capture)}
` +
    `- Figma file: ${capture.figma?.fileKey || "not-provided"}
` +
    `- Nodes: ${nodeIds.length ? nodeIds.join(", ") : "not-provided"}
` +
    `- Captured at: ${defaultCapturedAt(capture)}
` +
    `- Raw context: ${rawContextPresent ? "source/figma-get-design-context.md" : "not provided"}

` +
    `## Package Map
` +
    `- Agent workflow: normalized/agent-workflow.md
` +
    `- Design context: normalized/design-context.json (${pageRegions.length} Page Regions)
` +
    `- Pixel spec index: normalized/pixel-spec/index.json (${pixelSpec.nodes.length} nodes; read shards progressively)
` +
    `- Layers index: normalized/layers/index.json
` +
    `- Tokens: normalized/tokens.json
` +
    `- Components: normalized/components.json
` +
    `- Dependencies: normalized/dependencies.json (${dependencies.components.status} components, ${dependencies.assets.status} assets)
` +
    `- Assets: normalized/assets.json
` +
    `- Render instructions: normalized/render-instructions.md
` +
    `- Visual baseline: validation/visual-baseline.json

` +
    `## Linked Development Issues
${formatList(targetIssues)}

` +
    `## Design Intent
${normalizeNote(designerNotes || capture.designerNotes)}

` +
    `## Screens / Frames
${screenshotLines}

` +
    `## Assets
${assetLines}

` +
    `## Implementation Notes
${normalizeNote(dynamicRegionNotes || capture.dynamicRegionNotes)}

` +
    `## Non-goal
` +
    `This file is not a pixel implementation spec. Use normalized/agent-workflow.md and normalized/pixel-spec/index.json plus the referenced shards for bounds, styles, typography, layer order, and bindings.
`;
}

function buildHandoffReadme({ capture, contextPath }) {
  const targetIssues = (capture.targetDevIssues || []).map((issue) => `- #${issue.number}${issue.title ? ` ${issue.title}` : ""}`).join("\n") || "- Not provided";
  return `# Pragma Design Context Handoff

` +
    `Design Issue: #${capture.designIssue?.number}

` +
    `Target development issues:
${targetIssues}

` +
    `Manifest: ${contextPath}/manifest.json
` +
    `Agent briefing: ${contextPath}/normalized/agent-context.md
` +
    `Agent workflow: ${contextPath}/normalized/agent-workflow.md
` +
    `Pixel spec index: ${contextPath}/normalized/pixel-spec/index.json
` +
    `Dependencies: ${contextPath}/normalized/dependencies.json
` +
    `Design context: ${contextPath}/normalized/design-context.json
` +
    `Assets manifest: ${contextPath}/normalized/assets.json
` +
    `Visual baseline: ${contextPath}/validation/visual-baseline.json

` +
    `Pragma does not update Gitea issues directly. Use the generic Issue writer with the markdown from \`pragma design issue-fragment\`.
`;
}

function buildFrames(selectionNodes, screenshots, pageFrames = []) {
  const firstScreenshot = screenshots[0];
  const inputs = pageFrames.length ? pageFrames : selectionNodes;
  if (inputs.length) {
    return inputs.map((node, index) => {
      const figmaNodeId = node.nodeId || node.figmaNodeId || node.id;
      const name = node.name || node.title || figmaNodeId || `frame-${index + 1}`;
      const bounds = node.bounds || node.absoluteBoundingBox;
      const viewport = node.viewport || (bounds || node.width || node.height ? {
        width: node.width ?? bounds?.width,
        height: node.height ?? bounds?.height
      } : undefined);
      return {
        id: `frame-${slugify(name || figmaNodeId, String(index + 1))}`,
        figmaNodeId,
        name,
        type: node.type || node.nodeType,
        role: node.role,
        url: node.url,
        viewport,
        screenshot: screenshots[index] || firstScreenshot
      };
    });
  }
  return screenshots.map((screenshot, index) => ({
    id: `frame-${index + 1}`,
    name: path.basename(screenshot, path.extname(screenshot)),
    screenshot
  }));
}

async function cleanupLegacyIssueRoot(issueRoot) {
  for (const name of ["manifest.json", "source", "normalized", "assets", "screenshots", "validation", "handoff", "checksums.json", "context.zip"]) {
    await fs.rm(path.join(issueRoot, name), { recursive: true, force: true });
  }
}

export async function ingestDesignContext(options) {
  const inputDir = path.resolve(String(options.input));
  if (!(await pathExists(inputDir))) throw new CliError(`Input directory does not exist: ${inputDir}`);
  const changeSummaryText = options.changeSummaryText
    || (options["change-summary"] ? await readText(path.resolve(String(options["change-summary"]))) : undefined)
    || (options.changeSummary ? await readText(path.resolve(String(options.changeSummary))).catch(() => String(options.changeSummary)) : undefined);
  const capturePath = path.join(inputDir, "capture.json");
  const capture = await readJson(capturePath);
  const issueNumber = Number(options.issue ?? capture.designIssue?.number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new CliError("A positive design issue number is required. Use --issue or capture.designIssue.number.");
  }
  capture.designIssue = { ...(capture.designIssue || {}), number: issueNumber };

  const repoPath = path.resolve(String(options.repo || capture.repo?.localPath || process.cwd()));
  const issueRoot = path.join(repoPath, contextRepoPath(issueNumber));
  if (options.force) await cleanupLegacyIssueRoot(issueRoot);
  const chosenVersion = await chooseVersion({ issueRoot, requestedVersion: options.version, bump: options.bump });
  const packageVersion = chosenVersion.version;
  const contextId = `design-issue-${issueNumber}-${packageVersion}`;
  const repoRelativeIssuePath = issueRootRelative(issueNumber);
  const repoRelativeContextPath = versionRelative(issueNumber, packageVersion);
  const contextDir = path.resolve(String(options.context || path.join(repoPath, repoRelativeContextPath)));
  if (await pathExists(contextDir)) {
    if (options.force) {
      await resetDirIfSafe(contextDir);
    } else {
      throw new CliError(`Context directory already exists: ${contextDir}. Pass --force to replace it.`);
    }
  }

  await ensureDir(contextDir);
  await ensureDir(path.join(contextDir, "source"));
  await ensureDir(path.join(contextDir, "normalized"));
  await ensureDir(path.join(contextDir, "normalized", "pixel-spec", "frames"));
  await ensureDir(path.join(contextDir, "normalized", "pixel-spec", "regions"));
  await ensureDir(path.join(contextDir, "normalized", "layers", "frames"));
  await ensureDir(path.join(contextDir, "validation"));
  await ensureDir(path.join(contextDir, "handoff"));

  await copyFileIfExists(path.join(inputDir, "capture.json"), path.join(contextDir, "source", "capture.json"));
  await copyFileIfExists(path.join(inputDir, "dependency-lock.json"), path.join(contextDir, "source", "dependency-lock.json"));
  await copyFileIfExists(path.join(inputDir, "assets-manifest.json"), path.join(contextDir, "source", "assets-manifest.json"));
  await copyFileIfExists(path.join(inputDir, "asset-bindings.json"), path.join(contextDir, "source", "asset-bindings.json"));
  await copyFileIfExists(path.join(inputDir, "capture-summary.json"), path.join(contextDir, "source", "capture-summary.json"));
  await copyFileIfExists(path.join(inputDir, "figma", "metadata.json"), path.join(contextDir, "source", "figma-metadata.json"));
  await copyFileIfExists(path.join(inputDir, "figma", "selection.json"), path.join(contextDir, "source", "figma-selection.json"));
  await copyFileIfExists(path.join(inputDir, "figma", "get-design-context.md"), path.join(contextDir, "source", "figma-get-design-context.md"));
  await copyFileIfExists(path.join(inputDir, "figma", "layers.json"), path.join(contextDir, "source", "figma-layers.json"));
  await copyFileIfExists(path.join(inputDir, "figma", "variables.json"), path.join(contextDir, "source", "figma-variables.json"));
  await copyFileIfExists(path.join(inputDir, "figma", "components.json"), path.join(contextDir, "source", "figma-components.json"));
  await copyDirIfExists(path.join(inputDir, "screenshots"), path.join(contextDir, "screenshots"));
  await copyDirIfExists(path.join(inputDir, "assets"), path.join(contextDir, "assets"));

  const selection = await readJson(path.join(contextDir, "source", "figma-selection.json"), {}).catch(() => ({}));
  const metadata = await readJson(path.join(contextDir, "source", "figma-metadata.json"), {}).catch(() => ({}));
  const dependencyLock = await readJson(path.join(contextDir, "source", "dependency-lock.json"), {}).catch(() => ({}));
  const selectionNodes = extractSelectionNodes(selection, capture);
  const layerSource = await readJson(path.join(contextDir, "source", "figma-layers.json"), {}).catch(() => ({}));
  const variablesSource = await readJson(path.join(contextDir, "source", "figma-variables.json"), {}).catch(() => ({}));
  const componentsSource = await readJson(path.join(contextDir, "source", "figma-components.json"), {}).catch(() => ({}));
  const assetBindingsSource = await readJson(path.join(contextDir, "source", "asset-bindings.json"), {}).catch(() => ({}));
  const inputAssetManifest = await readJson(path.join(inputDir, "assets-manifest.json"), undefined).catch(() => undefined);
  const screenshots = await listContextFiles(contextDir, "screenshots");
  const designerNotes = await readText(path.join(inputDir, "designer-notes.md"), capture.designerNotes || "");
  const dynamicRegionNotes = await readText(path.join(inputDir, "dynamic-regions.md"), capture.dynamicRegionNotes || "");
  const rawContextPresent = await pathExists(path.join(contextDir, "source", "figma-get-design-context.md"));
  const selectionFrames = {
    page: extractSelectionFrames(selection, "page"),
    components: extractSelectionFrames(selection, "components"),
    assets: extractSelectionFrames(selection, "assets")
  };

  const layerModel = buildLayerModel(layerSource, selectionNodes);
  const assetBindings = normalizeAssetBindings(assetBindingsSource, layerModel.figmaToNormalized);
  const tokens = buildTokens(variablesSource);
  const assets = await normalizeAssets(contextDir, inputAssetManifest, assetBindings);
  await pruneUnreferencedAssetFiles(contextDir, assets);
  const implementationAssetIds = new Set(assets.map((asset) => asset.id));
  const implementationAssetBindings = assetBindings.filter((binding) => implementationAssetIds.has(binding.assetId));
  const pixelSpec = buildPixelSpec({
    contextId,
    rawNodes: layerModel.rawNodes,
    layers: layerModel.layers,
    figmaToNormalized: layerModel.figmaToNormalized,
    assetBindings: implementationAssetBindings,
    dynamicRegionNotes,
    tokens
  });
  const components = buildComponents(componentsSource, layerModel.rawNodes, layerModel.figmaToNormalized);
  const dependencies = buildDependencies({ dependencyLock, capture, selectionNodes, selectionFrames });
  const frames = buildFrames(selectionNodes, screenshots, dependencies.pageFrames);
  const pageRegionModel = buildPageRegions({ frames, layers: layerModel.layers, pixelSpec, dynamicRegionNotes });
  const hasDynamicNotes = normalizeNote(dynamicRegionNotes || capture.dynamicRegionNotes) !== "Not provided.";
  const dynamicRegions = pageRegionModel.dynamicRegions.length ? pageRegionModel.dynamicRegions : (hasDynamicNotes ? [{
    id: "region-dynamic-notes",
    name: "Implementation-defined regions",
    type: "implementation-defined",
    nodeIds: [],
    rendering: "implementation-defined",
    pixelMatchRequired: false,
    notes: normalizeNote(dynamicRegionNotes || capture.dynamicRegionNotes)
  }] : []);
  pixelSpec.dynamicRegions = dynamicRegions;
  const pixelSpecPackage = buildPixelSpecPackage({
    pixelSpec,
    layers: layerModel.layers,
    frames: pageRegionModel.frames,
    pageRegions: pageRegionModel.pageRegions,
    dynamicRegions
  });
  const layerTreePackage = buildLayerTreePackage({
    layers: layerModel.layers,
    frames: pageRegionModel.frames,
    pixelSpec,
    pageRegions: pageRegionModel.pageRegions
  });
  const visualBaseline = buildVisualBaseline(pixelSpecPackage.legacy, screenshots);

  const assetsManifest = {
    schemaVersion: "2.0",
    kind: "pragma-design-assets",
    assets
  };
  await writeJson(path.join(contextDir, "normalized", "layers.json"), layerTreePackage.legacy);
  await writeJson(path.join(contextDir, "normalized", "layers", "index.json"), layerTreePackage.index);
  for (const shard of layerTreePackage.frameShards) await writeJson(path.join(contextDir, shard.path), shard.data);
  await writeJson(path.join(contextDir, "normalized", "pixel-spec.json"), pixelSpecPackage.legacy);
  await writeJson(path.join(contextDir, "normalized", "pixel-spec", "index.json"), pixelSpecPackage.index);
  for (const shard of pixelSpecPackage.frameShards) await writeJson(path.join(contextDir, shard.path), shard.data);
  for (const shard of pixelSpecPackage.regionShards) await writeJson(path.join(contextDir, shard.path), shard.data);
  await writeJson(path.join(contextDir, "normalized", "tokens.json"), tokens);
  await writeJson(path.join(contextDir, "normalized", "components.json"), components);
  await writeJson(path.join(contextDir, "normalized", "dependencies.json"), dependencies);
  await writeJson(path.join(contextDir, "normalized", "assets.json"), assetsManifest);
  await writeText(path.join(contextDir, "normalized", "render-instructions.md"), buildRenderInstructions({ pixelSpec: pixelSpecPackage.legacy, assets, dynamicRegionNotes }));
  await writeText(path.join(contextDir, "normalized", "agent-workflow.md"), buildAgentWorkflow());
  await writeJson(path.join(contextDir, "validation", "visual-baseline.json"), visualBaseline);

  const agentContext = buildAgentContext({
    capture,
    selectionNodes,
    screenshots,
    assets,
    designerNotes,
    dynamicRegionNotes,
    rawContextPresent,
    pixelSpec: pixelSpecPackage.legacy,
    dependencies,
    pageRegions: pageRegionModel.pageRegions
  });
  await writeText(path.join(contextDir, "normalized", "agent-context.md"), agentContext);

  const figmaUrlFacts = capture.figma?.url ? parseFigmaUrl(capture.figma.url) : {};
  const fileKey = capture.figma?.fileKey || metadata.fileKey || figmaUrlFacts.fileKey;
  const designContext = {
    schemaVersion: "2.0",
    kind: "pragma-design-context",
    id: contextId,
    version: packageVersion,
    summary: capture.summary || capture.designIssue?.title || `Design context for issue #${issueNumber}`,
    issue: {
      provider: "gitea",
      repo: repoName(capture),
      number: issueNumber,
      title: capture.designIssue?.title,
      targetDevIssues: capture.targetDevIssues || []
    },
    source: {
      provider: capture.source?.provider || "figma",
      adapter: capture.source?.adapter || "figma-mcp",
      fileKey,
      nodes: selectionNodes.map((node) => node.id),
      url: capture.figma?.url,
      originalNodeId: capture.figma?.originalLinkedNodeId || figmaUrlFacts.nodeId
    },
    frames: pageRegionModel.frames.map((frame) => ({
      id: frame.id,
      figmaNodeId: frame.figmaNodeId,
      name: frame.name,
      type: frame.type,
      viewport: frame.viewport,
      screenshot: frame.screenshot,
      pixelSpec: `normalized/pixel-spec/frames/${frame.id}.json`,
      layerTree: `normalized/layers/frames/${frame.id}.tree.json`,
      pageRegionIds: pageRegionModel.pageRegions.filter((region) => region.frameId === frame.id).map((region) => region.id)
    })),
    pageRegions: pageRegionModel.pageRegions,
    sections: capture.sections || [],
    dynamicRegions,
    assetsManifest: "normalized/assets.json",
    dependencies: "normalized/dependencies.json",
    pixelSpec: "normalized/pixel-spec/index.json",
    layers: "normalized/layers/index.json",
    agentContext: "normalized/agent-context.md",
    agentWorkflow: "normalized/agent-workflow.md"
  };
  await writeJson(path.join(contextDir, "normalized", "design-context.json"), designContext);

  const sourceChecksum = sha256Text(JSON.stringify(capture) + JSON.stringify(pixelSpecPackage.index));
  const linkedDevelopmentIssues = (capture.targetDevIssues || [])
    .map((issue) => Number(issue.number ?? issue))
    .filter((issue) => Number.isInteger(issue) && issue > 0);
  const manifest = {
    schemaVersion: "2.0",
    kind: "pragma-design-context-package",
    id: contextId,
    version: packageVersion,
    versionNumber: normalizeVersion(packageVersion).versionNumber,
    supersedes: options.supersedes ? normalizeVersion(options.supersedes).version : null,
    changeSummary: changeSummaryText || options["change-summary-text"] || capture.changeSummary || `Initial design context for issue #${issueNumber}.`,
    sourceChecksum,
    packageChecksum: sourceChecksum,
    issue: {
      provider: "gitea",
      repo: repoName(capture),
      number: issueNumber,
      type: "design",
      title: capture.designIssue?.title,
      targetDevIssues: capture.targetDevIssues || []
    },
    linkedDevelopmentIssues,
    compatibility: {
      breakingChange: Boolean(options["breaking-change"] || options.breakingChange || false),
      requiresDevIssueReview: Boolean(options["requires-dev-issue-review"] || options.requiresDevIssueReview || false),
      reason: options["compatibility-reason"] || options.compatibilityReason || (options.supersedes ? "new design context version" : "initial version")
    },
    source: {
      provider: capture.source?.provider || "figma",
      adapter: capture.source?.adapter || "figma-mcp",
      fileKey,
      nodes: selectionNodes.map((node) => node.id),
      capturedAt: defaultCapturedAt(capture),
      sourceChecksum,
      url: capture.figma?.url,
      originalNodeId: capture.figma?.originalLinkedNodeId || figmaUrlFacts.nodeId
    },
    entrypoints: {
      humanHandoff: "handoff/README.md",
      lanhuUrl: capture.blueLakeUrl || capture.lanhuUrl,
      agentContext: "normalized/agent-context.md",
      agentWorkflow: "normalized/agent-workflow.md",
      designContext: "normalized/design-context.json",
      pixelSpec: "normalized/pixel-spec/index.json",
      layers: "normalized/layers/index.json",
      tokens: "normalized/tokens.json",
      components: "normalized/components.json",
      dependencies: "normalized/dependencies.json",
      assetsManifest: "normalized/assets.json",
      renderInstructions: "normalized/render-instructions.md",
      visualBaseline: "validation/visual-baseline.json",
      sourceDesignContext: "source/figma-get-design-context.md",
      assetsDir: "assets/",
      screenshots: "screenshots/"
    },
    artifact: {
      storage: "repo",
      path: repoRelativeContextPath
    }
  };
  if (!manifest.entrypoints.lanhuUrl) delete manifest.entrypoints.lanhuUrl;
  if (!rawContextPresent) delete manifest.entrypoints.sourceDesignContext;
  await writeJson(path.join(contextDir, "manifest.json"), manifest);
  await writeText(path.join(contextDir, "handoff", "README.md"), buildHandoffReadme({ capture, contextPath: repoRelativeContextPath }));
  await generateChecksums(contextDir);

  return {
    contextDir,
    manifestPath: path.join(contextDir, "manifest.json"),
    repoPath,
    issueRoot,
    version: packageVersion,
    versionNumber: normalizeVersion(packageVersion).versionNumber,
    repoRelativeIssuePath,
    repoRelativeContextPath,
    issueNumber
  };
}
