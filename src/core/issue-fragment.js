import path from "node:path";
import { readJson, writeText } from "./fs.js";
import { assertValidDesignContext } from "./validate.js";
import { manifestChecksum, repoRelativeManifest, resolveVersionContext } from "./versioning.js";

export async function createIssueFragment(options) {
  const resolved = await resolveVersionContext({
    context: options.context,
    manifest: options.manifest,
    repo: options.repo,
    issue: options.issue,
    version: options.version
  });
  await assertValidDesignContext({ context: resolved.contextDir });
  const manifest = await readJson(resolved.manifestPath);
  const checksum = manifest.packageChecksum || await manifestChecksum(resolved.manifestPath);
  const issueRoot = resolved.issueRoot;
  const repoRoot = options.repo ? path.resolve(String(options.repo)) : path.resolve(issueRoot.split(`${path.sep}.pragma${path.sep}`)[0] || process.cwd());
  const currentPointer = `.pragma/design-contexts/issue-${manifest.issue.number}/current.json`;
  const manifestRef = options.repo ? repoRelativeManifest(repoRoot, resolved.manifestPath) : `.pragma/design-contexts/issue-${manifest.issue.number}/versions/${manifest.version}/manifest.json`;
  const packagePath = manifest.artifact?.storage === "gitea-generic-package"
    ? manifest.artifact.downloadUrl
    : (manifest.artifact?.path || `.pragma/design-contexts/issue-${manifest.issue.number}/versions/${manifest.version}`);
  const markdown = `## Pragma Design Context

Status: generated / pending merge to default branch
Current Version: ${manifest.version}
Current Pointer: \`${currentPointer}\`
Current Manifest: \`${manifestRef}\`
Package Path: ${manifest.artifact?.storage === "gitea-generic-package" ? "`repo lightweight context`" : `\`${packagePath}/\``}
Package URL: ${manifest.artifact?.storage === "gitea-generic-package" ? manifest.artifact.downloadUrl : "not required"}
Checksum: ${checksum}
Context PR: pending
Merged Commit: pending
`;

  if (options.output) {
    await writeText(path.resolve(String(options.output)), markdown);
  }
  return { markdown, checksum, manifest, manifestPath: resolved.manifestPath, version: manifest.version };
}
