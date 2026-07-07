import path from "node:path";
import { CliError } from "./errors.js";
import { readText, writeText } from "./fs.js";
import { generateChecksums } from "./checksum.js";
import { assertValidDesignContext } from "./validate.js";

export async function enrichAgentContext(options) {
  const contextDir = path.resolve(String(options.context || ""));
  if (!contextDir || contextDir === path.resolve(".")) throw new CliError("--context is required for design enrich.");
  const validation = await assertValidDesignContext({ context: contextDir });
  const manifest = validation.manifest;
  const basePath = path.join(contextDir, manifest.entrypoints.agentContext);
  const base = await readText(basePath);
  const notes = options["notes-file"] || options.notesFile
    ? await readText(path.resolve(String(options["notes-file"] || options.notesFile)))
    : String(options.notes || "").trim();
  if (!notes) throw new CliError("design enrich requires --notes or --notes-file. Pragma does not call an LLM by itself.");
  const generatedBy = String(options["generated-by"] || options.generatedBy || "external-enrichment");
  const model = String(options.model || "not-recorded");
  const timestamp = new Date().toISOString();
  const output = path.resolve(String(options.output || path.join(contextDir, "normalized", "agent-context.enriched.md")));
  const enriched = `${base}\n\n---\n\n## Agent Enrichment\n- generatedBy: ${generatedBy}\n- model: ${model}\n- timestamp: ${timestamp}\n\n${notes}\n`;
  await writeText(output, enriched);
  await generateChecksums(contextDir);
  return { contextDir, output, generatedBy, model, timestamp };
}