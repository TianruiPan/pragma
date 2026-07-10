import path from "node:path";
import { DesignContextBlockedError, CliError } from "./errors.js";
import { pathExists, readJson, readText } from "./fs.js";
import { assertValidDesignContext } from "./validate.js";
import { manifestChecksum, resolveVersionContext } from "./versioning.js";

const BLOCKING_HINT = "请等待 Design Issue 交付、确认设计 PR 已合入默认分支，或将开发 Issue 标记为“需要 Design Issue：否”。";

function parseNeedsDesignIssue(text) {
  const match = text.match(/需要\s*Design\s*Issue\s*[:：]\s*(是|否|yes|no|true|false)/i);
  if (!match) {
    const legacy = text.match(/design\/(?:none|reference|context)/i)?.[0]?.toLowerCase();
    if (legacy === "design/context") return true;
    if (legacy) return false;
    return undefined;
  }
  return /^(是|yes|true)$/i.test(match[1]);
}

function parseDependencyIssue(text) {
  const patterns = [
    /Design\s+Issue\s*[:：]\s*#?(\d+)/i,
    /Depends\s+on\s+#(\d+)/i,
    /depends_on\s*[:：]\s*#?(\d+)/i,
    /依赖[\s\S]{0,50}#(\d+)/i,
    /Design\s+Issue[\s\S]{0,30}#(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function parseManifestRef(text) {
  const match = text.match(/Current\s+Manifest\s*[:：]\s*`?([^`\n]+manifest\.json)`?/i)
    || text.match(/Manifest\s*[:：]\s*`?([^`\n]+manifest\.json)`?/i);
  return match ? match[1].trim() : undefined;
}

function blockingMessage(issueNumber) {
  const issueText = issueNumber ? ` #${issueNumber}` : "";
  return `该开发 Issue 标记为“需要 Design Issue：是”，但依赖的 Design Issue${issueText} 尚未提供可读取的 current pointer / manifest，或设计 PR 尚未合入当前分支。\n${BLOCKING_HINT}`;
}

async function contextFromDevIssue(options) {
  const devIssuePath = path.resolve(String(options["dev-issue-file"] || options.devIssueFile));
  const text = await readText(devIssuePath);
  const needsDesignIssue = parseNeedsDesignIssue(text);
  if (needsDesignIssue === false || needsDesignIssue === undefined) {
    return { required: false, needsDesignIssue: Boolean(needsDesignIssue) };
  }
  const dependencyIssue = parseDependencyIssue(text);
  if (!dependencyIssue) throw new DesignContextBlockedError(blockingMessage(undefined));
  const repoPath = path.resolve(String(options.repo || process.cwd()));
  try {
    return { required: true, dependencyIssue, ...(await resolveVersionContext({ repo: repoPath, issue: dependencyIssue, version: options.version })) };
  } catch (error) {
    if (error instanceof CliError && error.code === "PRAGMA_DESIGN_CONTEXT_BLOCKED") {
      throw new DesignContextBlockedError(blockingMessage(dependencyIssue));
    }
    throw error;
  }
}

async function resolveReadContext(options) {
  if (options["dev-issue-file"] || options.devIssueFile) {
    const result = await contextFromDevIssue(options);
    if (!result.required) return result;
    return result;
  }
  if (options["design-issue-file"] || options.designIssueFile) {
    const designIssuePath = path.resolve(String(options["design-issue-file"] || options.designIssueFile));
    const text = await readText(designIssuePath);
    const ref = parseManifestRef(text);
    if (!ref) throw new CliError(`No Current Manifest reference found in ${designIssuePath}`);
    const repoPath = path.resolve(String(options.repo || process.cwd()));
    return resolveVersionContext({ manifest: path.resolve(repoPath, ref) });
  }
  return resolveVersionContext(options);
}

export async function readDesignContext(options) {
  const resolved = await resolveReadContext(options);
  if (resolved && typeof resolved === "object" && resolved.required === false) {
    return {
      required: false,
      needsDesignIssue: false,
      message: "Pragma 不介入：该开发 Issue 标记为“需要 Design Issue：否”。"
    };
  }
  const contextDir = resolved.contextDir;
  await assertValidDesignContext({ context: contextDir, checkRemote: options["check-remote"] || options.checkRemote });
  const manifest = await readJson(resolved.manifestPath);
  const agentContextPath = path.join(contextDir, manifest.entrypoints.agentContext);
  const agentWorkflowPath = manifest.entrypoints.agentWorkflow ? path.join(contextDir, manifest.entrypoints.agentWorkflow) : undefined;
  const designContextPath = path.join(contextDir, manifest.entrypoints.designContext);
  const assetsPath = path.join(contextDir, manifest.entrypoints.assetsManifest);
  const pixelSpecPath = path.join(contextDir, manifest.entrypoints.pixelSpec);
  const layersPath = manifest.entrypoints.layers ? path.join(contextDir, manifest.entrypoints.layers) : undefined;
  const dependenciesPath = path.join(contextDir, manifest.entrypoints.dependencies);
  const tokensPath = path.join(contextDir, manifest.entrypoints.tokens);
  const componentsPath = path.join(contextDir, manifest.entrypoints.components);
  const renderInstructionsPath = path.join(contextDir, manifest.entrypoints.renderInstructions);
  const visualBaselinePath = path.join(contextDir, manifest.entrypoints.visualBaseline);
  const agentContext = await readText(agentContextPath);
  const manifestDigest = await manifestChecksum(resolved.manifestPath);
  const checksum = manifest.packageChecksum || manifestDigest;
  return {
    required: true,
    contextDir,
    issueRoot: resolved.issueRoot,
    version: manifest.version,
    versionNumber: manifest.versionNumber,
    manifestPath: resolved.manifestPath,
    checksum,
    manifestChecksum: manifestDigest,
    packageChecksum: manifest.packageChecksum,
    currentPath: resolved.issueRoot ? path.join(resolved.issueRoot, "current.json") : undefined,
    agentContextPath,
    agentWorkflowPath,
    designContextPath,
    assetsPath,
    pixelSpecPath,
    layersPath,
    dependenciesPath,
    tokensPath,
    componentsPath,
    renderInstructionsPath,
    visualBaselinePath,
    manifest,
    agentContext
  };
}
