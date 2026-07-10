# Issue Fragment Contract

Pragma 2.0 emits markdown for a generic Issue writer. The Issue writer owns Gitea issue creation, update, state transitions, comments, and dependency creation.

A completed Design Issue receives a fragment shaped like this:

```markdown
## Pragma Design Context

Status: generated / pending merge to default branch
Current Version: v1
Current Pointer: `.pragma/design-contexts/issue-102/current.json`
Current Manifest: `.pragma/design-contexts/issue-102/versions/v1/manifest.json`
Package Path: `.pragma/design-contexts/issue-102/versions/v1/`
Package URL: not required
Checksum: sha256:<package-checksum>
Context PR: pending
Merged Commit: pending
```

If the full package is stored in Gitea Generic Package Registry, `Package URL` contains the registry download URL and the repo package path points at the lightweight context directory.

`current.json` is written only by a successful non-dry-run publish. Registry dry runs must not advance the current pointer to an artifact that has not been uploaded.

The fragment intentionally does not inline pixel facts. Development Agents must follow the current pointer and manifest entrypoints, then read `normalized/agent-workflow.md`, `normalized/design-context.json`, `normalized/pixel-spec/index.json` plus the needed frame/region shards, `normalized/layers/index.json` plus the needed layer-tree shards, dependencies, assets, tokens, components, render instructions, source evidence, screenshots, and visual baseline from the package.

Legacy aggregate files such as `normalized/pixel-spec.json` and `normalized/layers.json` may be present for compatibility, but the manifest shard indexes are the canonical implementation entrypoints when present.

Dependency locks are package facts, not Issue body content. The Issue fragment should point to the current pointer, manifest, package path or URL, and checksum; the concrete shared snapshot IDs and checksums live in `normalized/dependencies.json`.
