# Pragma 2.0 MVP

This is the active Pragma 2.0 MVP workspace. The previous Pragma 1.0 workspace is archived separately and is not the source of truth for current behavior.

Pragma 2.0 MVP is an AI-native design context delivery layer for Gitea issue workflows:

- Designer-side Codex/Figma MCP skills capture design data into a `pragma-input/` directory.
- `pragma design ingest` deterministically normalizes capture facts into a versioned Design Context Package.
- `normalized/agent-context.md` is only an Agent briefing and package map.
- `normalized/agent-workflow.md` defines Agent read gates, progressive-disclosure rules, typography handling, business-data safety, and CSS strategy.
- `normalized/pixel-spec/index.json` is the primary pixel implementation entrypoint; read only the referenced frame/region shards needed for the task.
- `normalized/layers/index.json` is the lightweight layer-tree entrypoint; it links hierarchy without duplicating bounds, style, text, or asset placement facts.
- Legacy aggregate files such as `normalized/pixel-spec.json` and `normalized/layers.json` can exist for compatibility, but must stay derived from the shard facts.
- `normalized/dependencies.json` locks the concrete shared components/assets snapshots used by the issue package; packages never depend on floating `latest`.
- `.pragma/design-sources/figma/<fileKey>/` stores reusable components/assets snapshots with content-hash de-duplication.
- `pragma design prepare-figma-capture`, `preflight`, `from-figma`, and `source add/sync` provide the deterministic Figma Capture Bridge-facing CLI surface without embedding Figma tokens or Plugin UI.
- `pragma design pack-from-figma-capture` runs ingest, pack, publish, issue-fragment, and validate in one command.
- `pragma design pack-latest-capture` resolves the latest repo-scoped incoming capture for an issue, runs preflight-only or the full pipeline, and writes `handoff/pipeline-summary.json`.
- `pragma design enrich` can write optional enrichment notes, but never overwrites machine facts.
- `pragma design validate` checks package structure, checksums, dependency locks, pixel-spec shard references, asset bindings, tokens, components, asset MIME/magic bytes, UTF-8 text, visual baseline screenshots, and source-registry health.

Issue model:

- Dev Issue `需要 Design Issue：否`: Pragma is not required; design links are human reference only.
- Dev Issue `需要 Design Issue：是`: the Dev Issue depends on a same-repo Design Issue, and Agents read Pragma from that Design Issue's `current.json` after the design PR has merged.

Deployments verify the installed CLI with `pragma --version --json`; see `docs/compatibility-handshake.md` for the `pragma-integration/v1` handshake.

## Folder Contract

Default repo path for a Design Issue:

```text
.pragma/design-contexts/issue-102/
  current.json
  versions/
    v1/
      manifest.json
      source/
        figma-get-design-context.md
        figma-layers.json
        figma-variables.json
        figma-components.json
      normalized/
        agent-context.md
        agent-workflow.md
        design-context.json
        pixel-spec.json              # legacy derived aggregate
        pixel-spec/
          index.json
          frames/*.json
          regions/*.json
        layers.json                  # legacy derived aggregate
        layers/
          index.json
          frames/*.tree.json
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
    v2/
      ...
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

1. `.pragma/design-contexts/issue-<n>/current.json` when resolving the current version
2. `.pragma/design-contexts/issue-<n>/versions/vN/manifest.json`
3. `normalized/agent-context.md` for briefing and package map
4. `normalized/agent-workflow.md` for read gates and implementation safety rules
5. `normalized/design-context.json` to identify relevant frames and page regions
6. `normalized/pixel-spec/index.json`, then only the needed frame/region shards
7. `normalized/layers/index.json`, then only the needed layer-tree shards
8. `normalized/dependencies.json` for locked shared components/assets snapshots
9. `normalized/assets.json`, `tokens.json`, `components.json`, `render-instructions.md`
10. `source/figma-get-design-context.md` only as fallback/source evidence
11. `screenshots/*` and `validation/visual-baseline.json` for visual comparison

## Quick Start

Generate the sample context:

```bash
npm run sample:pack-from-figma-capture
npm run sample:validate
npm run sample:read
```

Run tests:

```bash
npm test
```

## CLI

```bash
node src/cli.js design prepare-figma-capture --url <figma-url> --repo <repo-path> --page <node-id> [--components <node-id>|none] [--assets <node-id>|none] [--json]
node src/cli.js design preflight --input <pragma-input> --repo <repo-path> [--fix] [--json]
node src/cli.js design source add --role components|assets --input <capture-dir> --repo <repo-path> --file-key <fileKey> --frame-node-id <node-id> [--dry-run] [--json]
node src/cli.js design source sync --input <capture-dir> --repo <repo-path> --file-key <fileKey> [--components-frame <node-id>] [--assets-frame <node-id>] [--dry-run] [--json]
node src/cli.js design from-figma --input <pragma-input> --repo <repo-path> [--force] [--json]
node src/cli.js design ingest --input <pragma-input> --repo <repo-path> [--issue 102] [--version v1|--bump auto]
node src/cli.js design pack --context <context-dir> [--zip <path>]
node src/cli.js design publish --context <version-dir> [--supersedes vN] [--change-summary <file>] [--threshold-mb 20] [--dry-run] [--prune-repo]
node src/cli.js design publish --repo <repo-path> --issue <design-issue> [--version vN|--bump auto] [--supersedes vN] [--change-summary <file>] [--threshold-mb 20] [--dry-run] [--prune-repo]
node src/cli.js design issue-fragment --repo <repo-path> --issue <design-issue> [--version current|vN] [--output fragment.md]
node src/cli.js design diff --repo <repo-path> --issue <design-issue> --from v1 --to v2 [--json]
node src/cli.js design pack-from-figma-capture --input <pragma-input> --repo <repo-path> [--force]
node src/cli.js design pack-latest-capture --repo <repo-path> --issue <number> [--input <pragma-input>] [--preflight-only] [--force] [--threshold-mb 20] [--json]
node src/cli.js design enrich --context <context-dir> --notes <text> [--generated-by <id>] [--model <model>]
node src/cli.js design read --repo <repo-path> --issue 102 [--version v1]
node src/cli.js design read --repo <repo-path> --dev-issue-file issue-101.md
node src/cli.js design asset --context <context-dir> --id asset-drone-icon
node src/cli.js design validate --context <context-dir>
node src/cli.js design validate --repo <repo-path> --source-registry [--file-key <fileKey>] [--json]
```

`from-figma` currently expects a Plugin / Capture Bridge-produced `pragma-input/` via `--input` or `--capture-dir`. Without that directory it returns a structured error; Pragma core does not connect to Figma credentials or implement the Plugin UI.

`publish` supports Gitea Generic Package Registry when the package is larger than the threshold:

```bash
node src/cli.js design publish \
  --context .pragma/design-contexts/issue-102/versions/v1 \
  --gitea-base-url https://gitea.example.com \
  --owner example-org \
  --package-name pragma-design-context \
  --token-env GITEA_TOKEN \
  --prune-repo
```

`--prune-repo` removes large `assets/`, `source/`, and local `context.zip` after a real registry upload, leaving the repo with manifest, normalized specs, handoff notes, visual baseline, and screenshots.

`current.json` advances only after a non-dry-run publish succeeds. A registry `--dry-run` can prepare and validate the version, but it never marks that version as current.

Pragma only produces context files and markdown fragments. It does not create/update Gitea issues, move issue state, or establish dependencies; those actions belong to the generic Issue writer.
