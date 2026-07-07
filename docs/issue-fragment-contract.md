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
