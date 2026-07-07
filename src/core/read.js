import path from "node:path";
import { DesignContextBlockedError, CliError } from "./errors.js";
import { pathExists, readJson, readText } from "./fs.js";
import { assertValidDesignContext } from "./validate.js";

const BLOCKING_HINT = "请等待设计交付完成，或将设计分类调整为 design/reference / design/none。";

function parseDesignCategory(text) {
  const direct = text.match(/设计分类\s*[:：]\s*(design\/(?:none|reference|context))/i);
  if (direct) return direct[1].toLowerCase();
  const label = text.match(/design\/(?:none|reference|context)/i);
  return label ? label[0].toLowerCase() : undefined;
}

function parseDependencyIssue(text) {
  const patterns = [
    /Depends\s+on\s+#(\d+)/i,
    /depends_on\s*[:：]\s*#?(\d+)/i,
    /设计依赖[\s\S]*?#(\d+)/i,
    /依赖[\s\S]{0,50}#(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function parseManifestRef(text) {
  const match = text.match(/Manifest\s*[:：]\s*`?([^`\n]+manifest\.json)`?/i);
  return match ? match[1].trim() : undefined;
}

function blockingMessage(issueNumber) {
  const issueText = issueNumber ? ` #${issueNumber}` : "";
  return `该开发 Issue 标记为 design/context，但依赖的 Design Context Issue${issueText} 尚未交付 Pragma Context。\n${BLOCKING_HINT}`;
}

async function contextFromDevIssue(options) {
  const devIssuePath = path.resolve(String(options["dev-issue-file"] || options.devIssueFile));
  const text = await readText(devIssuePath);
  const category = parseDesignCategory(text);
  if (category !== "design/context") {
    return { required: false, category: category || "design/none" };
  }
  const dependencyIssue = parseDependencyIssue(text);
  if (!dependencyIssue) {
    throw new DesignContextBlockedError(blockingMessage(undefined));
  }
  const repoPath = path.resolve(String(options.repo || process.cwd()));
  const contextDir = path.join(repoPath, ".pragma", "design-contexts", `issue-${dependencyIssue}`);
  if (!(await pathExists(path.join(contextDir, "manifest.json")))) {
    throw new DesignContextBlockedError(blockingMessage(dependencyIssue));
  }
  return { required: true, category, dependencyIssue, contextDir };
}

async function resolveContextDir(options) {
  if (options.context) return path.resolve(String(options.context));
  if (options.manifest) return path.dirname(path.resolve(String(options.manifest)));
  if (options["dev-issue-file"] || options.devIssueFile) {
    const result = await contextFromDevIssue(options);
    if (!result.required) return result;
    return result.contextDir;
  }
  if (options["design-issue-file"] || options.designIssueFile) {
    const designIssuePath = path.resolve(String(options["design-issue-file"] || options.designIssueFile));
    const text = await readText(designIssuePath);
    const ref = parseManifestRef(text);
    if (!ref) throw new CliError(`No Manifest reference found in ${designIssuePath}`);
    const repoPath = path.resolve(String(options.repo || process.cwd()));
    return path.dirname(path.resolve(repoPath, ref));
  }
  if (options.repo && options.issue) {
    return path.resolve(String(options.repo), ".pragma", "design-contexts", `issue-${Number(options.issue)}`);
  }
  throw new CliError("Use --context, --manifest, --repo --issue, --dev-issue-file, or --design-issue-file.");
}

export async function readDesignContext(options) {
  const resolved = await resolveContextDir(options);
  if (resolved && typeof resolved === "object" && resolved.required === false) {
    return {
      required: false,
      category: resolved.category,
      message: `Design context is not required for ${resolved.category}.`
    };
  }
  const contextDir = resolved;
  await assertValidDesignContext({ context: contextDir, checkRemote: options["check-remote"] || options.checkRemote });
  const manifest = await readJson(path.join(contextDir, "manifest.json"));
  const agentContextPath = path.join(contextDir, manifest.entrypoints.agentContext);
  const designContextPath = path.join(contextDir, manifest.entrypoints.designContext);
  const assetsPath = path.join(contextDir, manifest.entrypoints.assetsManifest);
  const agentContext = await readText(agentContextPath);
  return {
    required: true,
    contextDir,
    manifestPath: path.join(contextDir, "manifest.json"),
    agentContextPath,
    designContextPath,
    assetsPath,
    manifest,
    agentContext
  };
}
