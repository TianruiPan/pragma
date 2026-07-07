#!/usr/bin/env node
import { CliError } from "./core/errors.js";
import { ingestDesignContext } from "./core/ingest.js";
import { packDesignContext } from "./core/pack.js";
import { publishDesignContext } from "./core/publish.js";
import { createIssueFragment } from "./core/issue-fragment.js";
import { readDesignContext } from "./core/read.js";
import { resolveDesignAsset } from "./core/asset.js";
import { validateDesignContext } from "./core/validate.js";
import { packFromFigmaCapture } from "./core/pack-from-figma-capture.js";
import { enrichAgentContext } from "./core/enrich.js";
import { fromFigma } from "./core/from-figma.js";
import { addDesignSourceSnapshot, prepareFigmaCapture, syncDesignSources } from "./core/source-registry.js";

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      const key = withoutPrefix.slice(0, equalsIndex);
      const value = withoutPrefix.slice(equalsIndex + 1);
      options[key] = value;
      continue;
    }
    const negative = withoutPrefix.startsWith("no-");
    const key = negative ? withoutPrefix.slice(3) : withoutPrefix;
    const next = argv[index + 1];
    if (!negative && next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = !negative;
    }
  }
  return { options, positionals };
}

function help() {
  return `Pragma 2.0 MVP\n\n` +
    `Commands:\n` +
    `  pragma design prepare-figma-capture --url <figma-url> --repo <repo> --page <node> [--components <node>|none] [--assets <node>|none] [--json]\n` +
    `  pragma design from-figma --input <pragma-input> --repo <repo> [--force] [--json]\n` +
    `  pragma design source add --role components|assets --input <dir> --repo <repo> --file-key <key> --frame-node-id <node> [--dry-run] [--json]\n` +
    `  pragma design source sync --input <dir> --repo <repo> --file-key <key> [--components-frame <node>] [--assets-frame <node>] [--dry-run] [--json]\n` +
    `  pragma design ingest --input <dir> --repo <repo> [--issue 102] [--force]\n` +
    `  pragma design pack --context <dir> [--zip <path>]\n` +
    `  pragma design publish --context <dir> [--threshold-mb 20] [--dry-run] [--prune-repo]\n` +
    `  pragma design issue-fragment --context <dir> [--output fragment.md]\n` +
    `  pragma design pack-from-figma-capture --input <dir> --repo <repo> [--force] [--issue-fragment-output fragment.md]\n` +
    `  pragma design enrich --context <dir> --notes <text> [--generated-by <id>] [--model <model>]\n` +
    `  pragma design read --context <dir> | --repo <repo> --issue 102 | --dev-issue-file issue.md\n` +
    `  pragma design asset --context <dir> --id <asset-id> [--copy-to <path>]\n` +
    `  pragma design validate --context <dir> [--json]\n`;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv) {
  const [scope, command, ...rest] = argv;
  if (!scope || scope === "help" || scope === "--help" || scope === "-h") {
    process.stdout.write(help());
    return;
  }
  if (scope !== "design") {
    throw new CliError(`Unknown scope: ${scope}. Only "design" is supported in the MVP.`);
  }
  const { options, positionals } = parseArgs(rest);
  switch (command) {
    case "prepare-figma-capture": {
      const result = await prepareFigmaCapture(options);
      printJson(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    case "from-figma": {
      const result = await fromFigma(options);
      printJson(result);
      return;
    }
    case "source": {
      const action = positionals[0];
      if (action === "add") {
        const result = await addDesignSourceSnapshot(options);
        printJson({ command: "design source add", ...result });
        return;
      }
      if (action === "sync") {
        const result = await syncDesignSources(options);
        printJson({ command: "design source sync", ...result });
        return;
      }
      throw new CliError(`Unknown design source action: ${action || "<missing>"}. Use "add" or "sync".`);
    }
    case "ingest": {
      if (!options.input) throw new CliError("--input is required for design ingest.");
      const result = await ingestDesignContext(options);
      printJson({ ok: true, command: "design ingest", ...result });
      return;
    }
    case "pack": {
      if (!options.context) throw new CliError("--context is required for design pack.");
      const result = await packDesignContext(options);
      printJson({ ok: true, command: "design pack", ...result });
      return;
    }
    case "publish": {
      if (!options.context) throw new CliError("--context is required for design publish.");
      const result = await publishDesignContext(options);
      printJson({ ok: true, command: "design publish", mode: result.mode, contextDir: result.contextDir, zipPath: result.zipPath, sizeBytes: result.sizeBytes, checksum: result.checksum, artifact: result.manifest.artifact });
      return;
    }
    case "issue-fragment": {
      if (!options.context) throw new CliError("--context is required for design issue-fragment.");
      const result = await createIssueFragment(options);
      process.stdout.write(result.markdown);
      return;
    }
    case "pack-from-figma-capture": {
      const result = await packFromFigmaCapture(options);
      printJson({ ok: true, command: "design pack-from-figma-capture", ...result });
      return;
    }
    case "enrich": {
      const result = await enrichAgentContext(options);
      printJson({ ok: true, command: "design enrich", ...result });
      return;
    }
    case "read": {
      const result = await readDesignContext(options);
      if (options.json) {
        printJson(result);
        return;
      }
      if (result.required === false) {
        process.stdout.write(`${result.message}\n`);
        return;
      }
      if (options["summary-only"] || options.summaryOnly) {
        printJson({
          ok: true,
          manifestPath: result.manifestPath,
          agentContextPath: result.agentContextPath,
          designContextPath: result.designContextPath,
          pixelSpecPath: result.pixelSpecPath,
          assetsPath: result.assetsPath,
          dependenciesPath: result.dependenciesPath,
          tokensPath: result.tokensPath,
          componentsPath: result.componentsPath,
          renderInstructionsPath: result.renderInstructionsPath,
          visualBaselinePath: result.visualBaselinePath,
          artifact: result.manifest.artifact
        });
        return;
      }
      process.stdout.write(`# Pragma Design Context\n\nManifest: ${result.manifestPath}\nAgent context: ${result.agentContextPath}\nPixel spec: ${result.pixelSpecPath}\n\n---\n\n${result.agentContext}\n`);
      return;
    }
    case "asset": {
      if (!options.context) throw new CliError("--context is required for design asset.");
      const result = await resolveDesignAsset(options);
      printJson({ ok: true, command: "design asset", ...result });
      return;
    }
    case "validate": {
      if (!options.context) throw new CliError("--context is required for design validate.");
      const result = await validateDesignContext(options);
      if (options.json) {
        printJson(result);
      } else if (result.ok) {
        process.stdout.write(`OK: ${result.contextDir}\n`);
        for (const warning of result.warnings) process.stderr.write(`Warning: ${warning}\n`);
      } else {
        process.stderr.write(`Validation failed:\n- ${result.errors.join("\n- ")}\n`);
      }
      if (!result.ok) process.exitCode = 1;
      return;
    }
    default:
      throw new CliError(`Unknown design command: ${command || "<missing>"}.\n${help()}`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  const wantsJson = process.argv.slice(2).includes("--json");
  if (error instanceof CliError) {
    if (wantsJson) {
      process.stderr.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message, details: error.details }, null, 2)}\n`);
    } else {
      process.stderr.write(`${error.message}\n`);
    }
    process.exit(error.exitCode);
  }
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
