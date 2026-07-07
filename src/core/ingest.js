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
import { extractSelectionNodes, listContextFiles, normalizeAssets, slugify } from "./normalize.js";

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

function buildAgentContext({ capture, selectionNodes, screenshots, assets, designerNotes, dynamicRegionNotes, rawContextPresent }) {
  const issueNumber = capture.designIssue?.number;
  const nodeIds = selectionNodes.map((node) => node.id);
  const targetIssues = (capture.targetDevIssues || []).map((issue) => `#${issue.number}${issue.title ? ` ${issue.title}` : ""}`);
  const assetLines = assets.length
    ? assets.map((asset) => `- ${asset.id}: ${asset.role || "asset"}, ${asset.path}${asset.width && asset.height ? `, ${asset.width}x${asset.height}` : ""}`).join("\n")
    : "- No required assets were exported.";
  const screenshotLines = screenshots.length ? screenshots.map((item) => `- ${item}`).join("\n") : "- No screenshots were exported.";

  return `# Design Context for Issue #${issueNumber}\n\n` +
    `## Source\n` +
    `- Provider: ${capture.source?.provider || "figma"}\n` +
    `- Adapter: ${capture.source?.adapter || "figma-mcp"}\n` +
    `- Repo: ${repoName(capture)}\n` +
    `- Figma file: ${capture.figma?.fileKey || "not-provided"}\n` +
    `- Nodes: ${nodeIds.length ? nodeIds.join(", ") : "not-provided"}\n` +
    `- Captured at: ${defaultCapturedAt(capture)}\n` +
    `- Raw context: ${rawContextPresent ? "source/figma-get-design-context.md" : "not provided"}\n\n` +
    `## Linked Development Issues\n${formatList(targetIssues)}\n\n` +
    `## Design Intent\n${normalizeNote(designerNotes || capture.designerNotes)}\n\n` +
    `## Screens / Frames\n${screenshotLines}\n\n` +
    `## Implementation Structure\n` +
    `- Build only the frames and states listed in this package.\n` +
    `- Treat source/figma-get-design-context.md as preserved source evidence, not as a full design IR.\n` +
    `- Prefer existing product components and tokens when the target repo already defines them.\n\n` +
    `## Components\n` +
    `- MVP stores component names and variants as design hints only. No Code Connect mapping is required.\n` +
    `- See source/figma-components.json when it exists.\n\n` +
    `## Layout Essentials\n` +
    `- Follow the exported frame sizes, key spacing, and constraints from normalized/design-context.json.\n` +
    `- Do not infer unrelated pages or hidden Figma nodes outside this selection.\n\n` +
    `## Styles / Tokens\n` +
    `- Use source/figma-variables.json when available.\n` +
    `- Keep only styles required by this Issue in the implementation.\n\n` +
    `## Assets\n${assetLines}\n\n` +
    `## Implementation Notes\n${normalizeNote(dynamicRegionNotes || capture.dynamicRegionNotes)}\n`;
}

function buildHandoffReadme({ capture, contextPath }) {
  const targetIssues = (capture.targetDevIssues || []).map((issue) => `- #${issue.number}${issue.title ? ` ${issue.title}` : ""}`).join("\n") || "- Not provided";
  return `# Pragma Design Context Handoff\n\n` +
    `Design Context Issue: #${capture.designIssue?.number}\n\n` +
    `Target development issues:\n${targetIssues}\n\n` +
    `Manifest: ${contextPath}/manifest.json\n` +
    `Agent context: ${contextPath}/normalized/agent-context.md\n` +
    `Design context: ${contextPath}/normalized/design-context.json\n` +
    `Assets manifest: ${contextPath}/normalized/assets.json\n\n` +
    `Pragma does not update Gitea issues directly. Use the generic Issue writer with the markdown from \`pragma design issue-fragment\`.\n`;
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
  await ensureDir(path.join(contextDir, "handoff"));

  await copyFileIfExists(path.join(inputDir, "capture.json"), path.join(contextDir, "source", "capture.json"));
  await copyFileIfExists(path.join(inputDir, "assets-manifest.json"), path.join(contextDir, "source", "assets-manifest.json"));
  await copyFileIfExists(path.join(inputDir, "figma", "metadata.json"), path.join(contextDir, "source", "figma-metadata.json"));
  await copyFileIfExists(path.join(inputDir, "figma", "selection.json"), path.join(contextDir, "source", "figma-selection.json"));
  await copyFileIfExists(path.join(inputDir, "figma", "get-design-context.md"), path.join(contextDir, "source", "figma-get-design-context.md"));
  await copyFileIfExists(path.join(inputDir, "figma", "variables.json"), path.join(contextDir, "source", "figma-variables.json"));
  await copyFileIfExists(path.join(inputDir, "figma", "components.json"), path.join(contextDir, "source", "figma-components.json"));
  await copyDirIfExists(path.join(inputDir, "screenshots"), path.join(contextDir, "screenshots"));
  await copyDirIfExists(path.join(inputDir, "assets"), path.join(contextDir, "assets"));

  const inputAssetManifest = await readJson(path.join(inputDir, "assets-manifest.json"), undefined).catch(() => undefined);
  const assets = await normalizeAssets(contextDir, inputAssetManifest);
  const assetsManifest = {
    schemaVersion: "2.0",
    kind: "pragma-design-assets",
    assets
  };
  await writeJson(path.join(contextDir, "normalized", "assets.json"), assetsManifest);

  const selection = await readJson(path.join(contextDir, "source", "figma-selection.json"), {}).catch(() => ({}));
  const selectionNodes = extractSelectionNodes(selection, capture);
  const screenshots = await listContextFiles(contextDir, "screenshots");
  const designerNotes = await readText(path.join(inputDir, "designer-notes.md"), capture.designerNotes || "");
  const dynamicRegionNotes = await readText(path.join(inputDir, "dynamic-regions.md"), capture.dynamicRegionNotes || "");
  const rawContextPresent = await pathExists(path.join(contextDir, "source", "figma-get-design-context.md"));
  const agentContext = buildAgentContext({ capture, selectionNodes, screenshots, assets, designerNotes, dynamicRegionNotes, rawContextPresent });
  await writeText(path.join(contextDir, "normalized", "agent-context.md"), agentContext);

  const firstScreenshot = screenshots[0];
  const frames = selectionNodes.length ? selectionNodes.map((node, index) => ({
    id: `frame-${slugify(node.name || node.id, String(index + 1))}`,
    figmaNodeId: node.id,
    name: node.name || node.id,
    type: node.type,
    viewport: node.width || node.height ? { width: node.width, height: node.height } : undefined,
    screenshot: screenshots[index] || firstScreenshot
  })) : screenshots.map((screenshot, index) => ({
    id: `frame-${index + 1}`,
    name: path.basename(screenshot, path.extname(screenshot)),
    screenshot
  }));

  const hasDynamicNotes = normalizeNote(dynamicRegionNotes || capture.dynamicRegionNotes) !== "Not provided.";
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
      fileKey: capture.figma?.fileKey,
      nodes: selectionNodes.map((node) => node.id),
      url: capture.figma?.url
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
    agentContext: "normalized/agent-context.md"
  };
  await writeJson(path.join(contextDir, "normalized", "design-context.json"), designContext);

  const sourceChecksum = sha256Text(JSON.stringify(capture) + agentContext);
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
      fileKey: capture.figma?.fileKey,
      nodes: selectionNodes.map((node) => node.id),
      capturedAt: defaultCapturedAt(capture),
      sourceChecksum
    },
    entrypoints: {
      humanHandoff: "handoff/README.md",
      lanhuUrl: capture.blueLakeUrl || capture.lanhuUrl,
      agentContext: "normalized/agent-context.md",
      designContext: "normalized/design-context.json",
      assetsManifest: "normalized/assets.json",
      assetsDir: "assets/",
      screenshots: "screenshots/"
    },
    artifact: {
      storage: "repo",
      path: repoRelativeContextPath
    }
  };
  if (!manifest.entrypoints.lanhuUrl) delete manifest.entrypoints.lanhuUrl;
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
