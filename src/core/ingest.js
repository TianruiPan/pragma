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
import { extractSelectionNodes, listContextFiles, normalizeAssets, slugify } from "./normalize.js";
import {
  buildComponents,
  buildLayerModel,
  buildPixelSpec,
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

function buildAgentContext({ capture, selectionNodes, screenshots, assets, designerNotes, dynamicRegionNotes, rawContextPresent, pixelSpec, dependencies }) {
  const issueNumber = capture.designIssue?.number;
  const nodeIds = selectionNodes.map((node) => node.id);
  const targetIssues = (capture.targetDevIssues || []).map((issue) => `#${issue.number}${issue.title ? ` ${issue.title}` : ""}`);
  const assetLines = assets.length
    ? assets.map((asset) => `- ${asset.id}: ${asset.role || "asset"}, ${asset.path}${asset.width && asset.height ? `, ${asset.width}x${asset.height}` : ""}`).join("\n")
    : "- No required assets were exported.";
  const screenshotLines = screenshots.length ? screenshots.map((item) => `- ${item}`).join("\n") : "- No screenshots were exported.";

  return `# Design Context for Issue #${issueNumber}\n\n` +
    `## Required Read Order\n` +
    `1. manifest.json\n` +
    `2. normalized/agent-context.md (briefing and package map only)\n` +
    `3. normalized/pixel-spec.json (primary pixel implementation spec)\n` +
    `4. normalized/dependencies.json (locked shared components/assets snapshots)\n` +
    `5. normalized/assets.json\n` +
    `6. normalized/tokens.json\n` +
    `7. normalized/components.json\n` +
    `8. normalized/render-instructions.md\n` +
    `9. source/figma-get-design-context.md only as fallback/source evidence\n` +
    `10. screenshots/* and validation/visual-baseline.json for visual comparison\n\n` +
    `## Source\n` +
    `- Provider: ${capture.source?.provider || "figma"}\n` +
    `- Adapter: ${capture.source?.adapter || "figma-mcp"}\n` +
    `- Repo: ${repoName(capture)}\n` +
    `- Figma file: ${capture.figma?.fileKey || "not-provided"}\n` +
    `- Nodes: ${nodeIds.length ? nodeIds.join(", ") : "not-provided"}\n` +
    `- Captured at: ${defaultCapturedAt(capture)}\n` +
    `- Raw context: ${rawContextPresent ? "source/figma-get-design-context.md" : "not provided"}\n\n` +
    `## Package Map\n` +
    `- Pixel spec: normalized/pixel-spec.json (${pixelSpec.nodes.length} nodes)\n` +
    `- Layers: normalized/layers.json\n` +
    `- Tokens: normalized/tokens.json\n` +
    `- Components: normalized/components.json\n` +
    `- Dependencies: normalized/dependencies.json (${dependencies.components.status} components, ${dependencies.assets.status} assets)\n` +
    `- Assets: normalized/assets.json\n` +
    `- Render instructions: normalized/render-instructions.md\n` +
    `- Visual baseline: validation/visual-baseline.json\n\n` +
    `## Linked Development Issues\n${formatList(targetIssues)}\n\n` +
    `## Design Intent\n${normalizeNote(designerNotes || capture.designerNotes)}\n\n` +
    `## Screens / Frames\n${screenshotLines}\n\n` +
    `## Assets\n${assetLines}\n\n` +
    `## Implementation Notes\n${normalizeNote(dynamicRegionNotes || capture.dynamicRegionNotes)}\n\n` +
    `## Non-goal\n` +
    `This file is not a pixel implementation spec. Use normalized/pixel-spec.json for bounds, styles, layer order, and bindings.\n`;
}

function buildHandoffReadme({ capture, contextPath }) {
  const targetIssues = (capture.targetDevIssues || []).map((issue) => `- #${issue.number}${issue.title ? ` ${issue.title}` : ""}`).join("\n") || "- Not provided";
  return `# Pragma Design Context Handoff\n\n` +
    `Design Context Issue: #${capture.designIssue?.number}\n\n` +
    `Target development issues:\n${targetIssues}\n\n` +
    `Manifest: ${contextPath}/manifest.json\n` +
    `Agent briefing: ${contextPath}/normalized/agent-context.md\n` +
    `Pixel spec: ${contextPath}/normalized/pixel-spec.json\n` +
    `Dependencies: ${contextPath}/normalized/dependencies.json\n` +
    `Design context: ${contextPath}/normalized/design-context.json\n` +
    `Assets manifest: ${contextPath}/normalized/assets.json\n` +
    `Visual baseline: ${contextPath}/validation/visual-baseline.json\n\n` +
    `Pragma does not update Gitea issues directly. Use the generic Issue writer with the markdown from \`pragma design issue-fragment\`.\n`;
}

function buildFrames(selectionNodes, screenshots) {
  const firstScreenshot = screenshots[0];
  if (selectionNodes.length) {
    return selectionNodes.map((node, index) => ({
      id: `frame-${slugify(node.name || node.id, String(index + 1))}`,
      figmaNodeId: node.id,
      name: node.name || node.id,
      type: node.type,
      viewport: node.width || node.height ? { width: node.width, height: node.height } : undefined,
      screenshot: screenshots[index] || firstScreenshot
    }));
  }
  return screenshots.map((screenshot, index) => ({
    id: `frame-${index + 1}`,
    name: path.basename(screenshot, path.extname(screenshot)),
    screenshot
  }));
}

export async function ingestDesignContext(options) {
  const inputDir = path.resolve(String(options.input));
  if (!(await pathExists(inputDir))) throw new CliError(`Input directory does not exist: ${inputDir}`);
  const capturePath = path.join(inputDir, "capture.json");
  const capture = await readJson(capturePath);
  const issueNumber = Number(options.issue ?? capture.designIssue?.number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new CliError("A positive design issue number is required. Use --issue or capture.designIssue.number.");
  }
  capture.designIssue = { ...(capture.designIssue || {}), number: issueNumber };

  const repoPath = path.resolve(String(options.repo || capture.repo?.localPath || process.cwd()));
  const packageVersion = options.version || `issue-${issueNumber}-v1`;
  const contextId = packageVersion.startsWith("design-context-") ? packageVersion : `design-context-${packageVersion}`;
  const repoRelativeContextPath = contextRepoPath(issueNumber);
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
  await ensureDir(path.join(contextDir, "validation"));
  await ensureDir(path.join(contextDir, "handoff"));

  await copyFileIfExists(path.join(inputDir, "capture.json"), path.join(contextDir, "source", "capture.json"));
  await copyFileIfExists(path.join(inputDir, "dependency-lock.json"), path.join(contextDir, "source", "dependency-lock.json"));
  await copyFileIfExists(path.join(inputDir, "assets-manifest.json"), path.join(contextDir, "source", "assets-manifest.json"));
  await copyFileIfExists(path.join(inputDir, "asset-bindings.json"), path.join(contextDir, "source", "asset-bindings.json"));
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

  const layerModel = buildLayerModel(layerSource, selectionNodes);
  const assetBindings = normalizeAssetBindings(assetBindingsSource, layerModel.figmaToNormalized);
  const assets = await normalizeAssets(contextDir, inputAssetManifest, assetBindings);
  const pixelSpec = buildPixelSpec({
    contextId,
    rawNodes: layerModel.rawNodes,
    layers: layerModel.layers,
    figmaToNormalized: layerModel.figmaToNormalized,
    assetBindings,
    dynamicRegionNotes
  });
  const tokens = buildTokens(variablesSource);
  const components = buildComponents(componentsSource, layerModel.rawNodes);
  const visualBaseline = buildVisualBaseline(pixelSpec, screenshots);
  const dependencies = buildDependencies({ dependencyLock, capture, selectionNodes });

  const assetsManifest = {
    schemaVersion: "2.0",
    kind: "pragma-design-assets",
    assets
  };
  await writeJson(path.join(contextDir, "normalized", "layers.json"), layerModel.layers);
  await writeJson(path.join(contextDir, "normalized", "pixel-spec.json"), pixelSpec);
  await writeJson(path.join(contextDir, "normalized", "tokens.json"), tokens);
  await writeJson(path.join(contextDir, "normalized", "components.json"), components);
  await writeJson(path.join(contextDir, "normalized", "dependencies.json"), dependencies);
  await writeJson(path.join(contextDir, "normalized", "assets.json"), assetsManifest);
  await writeText(path.join(contextDir, "normalized", "render-instructions.md"), buildRenderInstructions({ pixelSpec, assets, dynamicRegionNotes }));
  await writeJson(path.join(contextDir, "validation", "visual-baseline.json"), visualBaseline);

  const agentContext = buildAgentContext({ capture, selectionNodes, screenshots, assets, designerNotes, dynamicRegionNotes, rawContextPresent, pixelSpec, dependencies });
  await writeText(path.join(contextDir, "normalized", "agent-context.md"), agentContext);

  const frames = buildFrames(selectionNodes, screenshots);
  const hasDynamicNotes = normalizeNote(dynamicRegionNotes || capture.dynamicRegionNotes) !== "Not provided.";
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
    frames,
    sections: capture.sections || [],
    dynamicRegions: hasDynamicNotes ? [
      {
        name: "Implementation-defined regions",
        rule: "implementation-defined",
        notes: normalizeNote(dynamicRegionNotes || capture.dynamicRegionNotes)
      }
    ] : [],
    assetsManifest: "normalized/assets.json",
    dependencies: "normalized/dependencies.json",
    pixelSpec: "normalized/pixel-spec.json",
    agentContext: "normalized/agent-context.md"
  };
  await writeJson(path.join(contextDir, "normalized", "design-context.json"), designContext);

  const sourceChecksum = sha256Text(JSON.stringify(capture) + JSON.stringify(pixelSpec));
  const manifest = {
    schemaVersion: "2.0",
    kind: "pragma-design-context-package",
    id: contextId,
    version: packageVersion,
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
      capturedAt: defaultCapturedAt(capture),
      sourceChecksum,
      url: capture.figma?.url,
      originalNodeId: capture.figma?.originalLinkedNodeId || figmaUrlFacts.nodeId
    },
    entrypoints: {
      humanHandoff: "handoff/README.md",
      lanhuUrl: capture.blueLakeUrl || capture.lanhuUrl,
      agentContext: "normalized/agent-context.md",
      designContext: "normalized/design-context.json",
      pixelSpec: "normalized/pixel-spec.json",
      layers: "normalized/layers.json",
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
    repoRelativeContextPath,
    issueNumber
  };
}
