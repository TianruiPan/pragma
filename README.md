# Pragma 2.0 MVP

This is a separate Pragma 2.0 MVP workspace. It does not reuse or modify the Pragma 1.0 implementation packages.

Pragma 2.0 MVP is an AI-native design context delivery layer for Gitea issue workflows:

- Designer-side Codex/Figma MCP skills capture design data into a `pragma-input/` directory.
- `pragma design ingest` normalizes that captured output into a self-contained Design Context Package.
- `pragma design pack` creates `context.zip` for registry publishing.
- `pragma design publish` keeps small packages in repo and can publish larger packages to Gitea Generic Package Registry.
- `pragma design issue-fragment` emits markdown for the generic Issue writer.
- `pragma design read` enforces the design/context blocking rule before an Agent starts work.
- `pragma design asset` resolves a specific asset by id.
- `pragma design validate` checks package structure, checksums, entrypoints, and asset references.

## Folder Contract

Default repo path for a Design Context Issue:

```text
.pragma/design-contexts/issue-102/
  manifest.json
  source/
  normalized/
    agent-context.md
    design-context.json
    assets.json
  assets/
  screenshots/
  handoff/README.md
  checksums.json
```

Size policy:

- `<= 20MB`: commit the complete context directory to the same repo.
- `> 20MB` and `<= 100MB`: keep `manifest.json`, `normalized/*`, lightweight indexes, and thumbnails in repo; publish full `context.zip` to Gitea Generic Package Registry.
- `> 100MB`: not a routine MVP path; reduce or split the context.

## Quick Start

Generate the sample context:

```bash
npm run sample:ingest
npm run sample:validate
npm run sample:read
```

Run tests:

```bash
npm test
```

## CLI

```bash
node src/cli.js design ingest --input <pragma-input> --repo <repo-path> [--issue 102] [--version issue-102-v1]
node src/cli.js design pack --context <context-dir> [--zip <path>]
node src/cli.js design publish --context <context-dir> [--threshold-mb 20] [--dry-run] [--prune-repo]
node src/cli.js design issue-fragment --context <context-dir> [--output fragment.md]
node src/cli.js design read --repo <repo-path> --issue 102
node src/cli.js design read --repo <repo-path> --dev-issue-file issue-101.md
node src/cli.js design asset --context <context-dir> --id asset-drone-icon
node src/cli.js design validate --context <context-dir>
```

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

`--prune-repo` removes large `assets/`, `source/`, and local `context.zip` after a real registry upload, leaving the repo with manifest, normalized indexes, handoff notes, and screenshots.

Pragma only produces context files and markdown fragments. It does not create/update Gitea issues, move issue state, or establish dependencies; those actions belong to the generic Issue writer.
