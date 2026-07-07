# Issue Fragment Contract

Pragma 2.0 emits markdown for a generic Issue writer. The Issue writer owns Gitea issue creation, update, state transitions, comments, and dependency creation.

A completed Design Context Issue receives a fragment shaped like this:

```markdown
## Pragma Design Context

状态：已生成
Manifest：`.pragma/design-contexts/issue-102/manifest.json`
Package：同 repo `.pragma/design-contexts/issue-102/`
版本：issue-102-v1
Checksum：sha256:<manifest-checksum>
```

If the full package is stored in Gitea Generic Package Registry, `Package` includes the registry download URL.

The fragment intentionally does not inline pixel facts. Development Agents must follow the manifest entrypoints and read `normalized/pixel-spec.json`, `normalized/dependencies.json`, assets, tokens, components, render instructions, source evidence, screenshots, and visual baseline from the package.

Dependency locks are package facts, not Issue body content. The Issue fragment should point to the manifest/package; the concrete shared snapshot IDs and checksums live in `normalized/dependencies.json`.
