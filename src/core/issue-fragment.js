import path from "node:path";
import { readJson, writeText } from "./fs.js";
import { sha256File } from "./checksum.js";
import { assertValidDesignContext } from "./validate.js";

export async function createIssueFragment(options) {
  const contextDir = path.resolve(String(options.context));
  await assertValidDesignContext({ context: contextDir });
  const manifestPath = path.join(contextDir, "manifest.json");
  const manifest = await readJson(manifestPath);
  const checksum = await sha256File(manifestPath);
  const repoPath = manifest.artifact?.path || `.pragma/design-contexts/issue-${manifest.issue.number}`;
  const manifestRef = `${repoPath}/manifest.json`;
  const packageText = manifest.artifact?.storage === "gitea-generic-package"
    ? `${manifest.artifact.downloadUrl}`
    : `同 repo \`${repoPath}/\``;
  const version = manifest.artifact?.packageVersion || manifest.version || manifest.id;
  const markdown = `## Pragma Design Context\n\n` +
    `状态：已生成\n` +
    `Manifest：\`${manifestRef}\`\n` +
    `Package：${packageText}\n` +
    `版本：${version}\n` +
    `Checksum：${checksum}\n`;

  if (options.output) {
    await writeText(path.resolve(String(options.output)), markdown);
  }
  return { markdown, checksum, manifest };
}
