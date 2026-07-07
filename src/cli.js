#!/usr/bin/env node
import { CliError } from "./core/errors.js";
import { ingestDesignContext } from "./core/ingest.js";
import { packDesignContext } from "./core/pack.js";
import { publishDesignContext } from "./core/publish.js";
import { createIssueFragment } from "./core/issue-fragment.js";
import { readDesignContext } from "./core/read.js";
import { resolveDesignAsset } from "./core/asset.js";
import { validateDesignContext } from "./core/validate.js";

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
    `  pragma design ingest --input <dir> --repo <repo> [--issue 102] [--force]\n` +
    `  pragma design pack --context <dir> [--zip <path>]\n` +
    `  pragma design publish --context <dir> [--threshold-mb 20] [--dry-run]\n` +
    `  pragma design issue-fragment --context <dir> [--output fragment.md]\n` +
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
  const { options } = parseArgs(rest);
  switch (command) {
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
          assetsPath: result.assetsPath,
          artifact: result.manifest.artifact
        });
        return;
      }
      process.stdout.write(`# Pragma Design Context\n\nManifest: ${result.manifestPath}\nAgent context: ${result.agentContextPath}\n\n---\n\n${result.agentContext}\n`);
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
  if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.exitCode);
  }
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
