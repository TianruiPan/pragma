import path from "node:path";
import { CliError } from "./errors.js";
import { ingestDesignContext } from "./ingest.js";
import { packDesignContext } from "./pack.js";
import { publishDesignContext } from "./publish.js";
import { createIssueFragment } from "./issue-fragment.js";
import { validateDesignContext } from "./validate.js";

export async function packFromFigmaCapture(options) {
  if (!options.input) throw new CliError("--input is required for design pack-from-figma-capture.");
  const ingest = await ingestDesignContext(options);
  const context = ingest.contextDir;
  const pack = await packDesignContext({ ...options, context, zip: options.zip || path.join(context, "context.zip") });
  const publish = await publishDesignContext({ ...options, context, zip: pack.zipPath });
  const fragmentOutput = options["issue-fragment-output"] || options.issueFragmentOutput || path.join(context, "handoff", "issue-fragment.md");
  const fragment = await createIssueFragment({ context, output: fragmentOutput });
  const validation = await validateDesignContext({ context, checkRemote: options["check-remote"] || options.checkRemote });
  if (!validation.ok) {
    throw new CliError(`pack-from-figma-capture produced an invalid package:\n- ${validation.errors.join("\n- ")}`);
  }
  return {
    contextDir: context,
    manifestPath: ingest.manifestPath,
    zipPath: pack.zipPath,
    publishMode: publish.mode,
    artifact: publish.manifest.artifact,
    issueFragmentPath: fragmentOutput,
    issueFragmentChecksum: fragment.checksum,
    warnings: validation.warnings
  };
}