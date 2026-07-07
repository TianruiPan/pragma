# Pragma 2.0 MVP

This is a separate Pragma 2.0 MVP workspace. It does not reuse or modify the Pragma 1.0 implementation packages.

Pragma 2.0 MVP is an AI-native design context delivery layer for Gitea issue workflows:

- Designer-side Codex/Figma MCP skills capture design data into a `pragma-input/` directory.
- `pragma design ingest` deterministically normalizes capture facts into a self-contained Design Context Package.
- `normalized/agent-context.md` is only an Agent briefing and package map.
- `normalized/pixel-spec.json` is the primary pixel implementation contract for bounds, styles, layer order, states, dynamic regions, and asset bindings.
- `normalized/dependencies.json` locks the concrete shared components/assets snapshots used by the issue package; packages never depend on floating `latest`.
- `.pragma/design-sources/figma/<fileKey>/` stores reusable components/assets snapshots with content-hash de-duplication.
- `pragma design prepare-figma-capture`, `from-figma`, and `source add/sync` provide the deterministic Figma Capture Bridge-facing CLI surface without embedding Figma tokens or Plugin UI.
- `pragma design pack-from-figma-capture` runs ingest, pack, publish, issue-fragment, and validate in one command.
- `pragma design enrich` can write optional enrichment notes, but never overwrites machine facts.
- `pragma design validate` checks package structure, checksums, dependency locks, pixel-spec references, asset bindings, tokens, components, asset MIME/magic bytes, UTF-8 text, and visual baseline screenshots.

## Folder Contract

Default repo path for a Design Context Issue:

```text
.pragma/design-contexts/issue-102/
  manifest.json
  source/
    figma-get-design-context.md
    figma-layers.json
    figma-variables.json
    figma-components.json
  normalized/
    agent-context.md
    design-context.json
    pixel-spec.json
    layers.json
    tokens.json
    components.json
    dependencies.json
    assets.json
    render-instructions.md
  assets/
  screenshots/
  validation/
    visual-baseline.json
  handoff/README.md
  checksums.json
```

Shared design source registry in the same target repo:

```text
.pragma/design-sources/figma/<fileKey>/
  registry.json
  sources.json
  snapshots/
    components-<frameNodeId>-<contentSha>/
      capture.json
      normalized/components.json
      normalized/tokens.json
      screenshots/
      checksums.json
    assets-<frameNodeId>-<contentSha>/
      capture.json
      normalized/assets.json
      assets/
      checksums.json
```

`registry.json` keeps `latest` pointers for designer convenience. Issue packages lock only concrete `snapshotId`, `path`, and `checksum` in `normalized/dependencies.json`.

Size policy:

- `<= 20MB`: commit the complete context directory to the same repo.
- `> 20MB` and `<= 100MB`: keep manifest, normalized specs, lightweight indexes, visual baseline, and thumbnails in repo; publish full `context.zip` to Gitea Generic Package Registry.
- `> 100MB`: not a routine MVP path; reduce or split the context.

## Agent Read Order

1. `manifest.json`
2. `normalized/agent-context.md` for briefing and package map
3. `normalized/pixel-spec.json` as the primary pixel implementation spec
4. `normalized/dependencies.json` for locked shared components/assets snapshots
5. `normalized/assets.json`, `tokens.json`, `components.json`, `render-instructions.md`
6. `source/figma-get-design-context.md` only as fallback/source evidence
7. `screenshots/*` and `validation/visual-baseline.json` for visual comparison

## Quick Start

Generate the sample context:

```bash
npm run sample:ingest
npm run sample:validate
npm run sample:read
```

Generate the sample end-to-end context and issue fragment:

```bash
npm run sample:pack-from-figma-capture
```

Run tests:

```bash
npm test
```

## CLI

```bash
node src/cli.js design prepare-figma-capture --url <figma-url> --repo <repo-path> --page <node-id> [--components <node-id>|none] [--assets <node-id>|none] [--json]
node src/cli.js design source add --role components|assets --input <capture-dir> --repo <repo-path> --file-key <fileKey> --frame-node-id <node-id> [--dry-run] [--json]
node src/cli.js design source sync --input <capture-dir> --repo <repo-path> --file-key <fileKey> [--components-frame <node-id>] [--assets-frame <node-id>] [--dry-run] [--json]
node src/cli.js design from-figma --input <pragma-input> --repo <repo-path> [--force] [--json]
node src/cli.js design ingest --input <pragma-input> --repo <repo-path> [--issue 102] [--version issue-102-v1]
node src/cli.js design pack --context <context-dir> [--zip <path>]
node src/cli.js design publish --context <context-dir> [--threshold-mb 20] [--dry-run] [--prune-repo]
node src/cli.js design issue-fragment --context <context-dir> [--output fragment.md]
node src/cli.js design pack-from-figma-capture --input <pragma-input> --repo <repo-path> [--force]
node src/cli.js design enrich --context <context-dir> --notes <text> [--generated-by <id>] [--model <model>]
node src/cli.js design read --repo <repo-path> --issue 102
node src/cli.js design read --repo <repo-path> --dev-issue-file issue-101.md
node src/cli.js design asset --context <context-dir> --id asset-drone-icon
node src/cli.js design validate --context <context-dir>
```

`from-figma` currently expects a Plugin / Capture Bridge-produced `pragma-input/` via `--input` or `--capture-dir`. Without that directory it returns a structured error; Pragma core does not connect to Figma credentials or implement the Plugin UI.

`publish` supports Gitea Generic Package Registry when the package is larger than the threshold:

```bash
node src/cli.js design publish \
  --context .pragma/design-contexts/issue-102 \
  --gitea-base-url https://gitea.example.com \
  --owner example-org \
  --package-name pragma-design-context \
  --token-env GITEA_TOKEN \
  --prune-repo
```

`--prune-repo` removes large `assets/`, `source/`, and local `context.zip` after a real registry upload, leaving the repo with manifest, normalized specs, handoff notes, visual baseline, and screenshots.

Pragma only produces context files and markdown fragments. It does not create/update Gitea issues, move issue state, or establish dependencies; those actions belong to the generic Issue writer.
