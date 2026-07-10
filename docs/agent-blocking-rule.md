# Agent Blocking Rule

Pragma follows the simplified Issue model:

```text
需要 Design Issue：否
- Pragma 不介入，Agent 直接按开发 Issue 实现。

需要 Design Issue：是
- 开发 Issue 必须依赖同 repo 的 Design Issue。
- Agent 必须从默认分支中的 `.pragma/design-contexts/issue-<n>/current.json` 解析当前版本。
```

Blocking message:

```text
该开发 Issue 标记为“需要 Design Issue：是”，但依赖的 Design Issue #102 尚未提供可读取的 current pointer / manifest，或设计 PR 尚未合入当前分支。
请等待 Design Issue 交付、确认设计 PR 已合入默认分支，或将开发 Issue 标记为“需要 Design Issue：否”。
```

`pragma design read --dev-issue-file <file> --repo <repo>` implements the local-file version of this rule. It parses the development issue markdown, finds the dependent Design Issue, resolves `current.json`, and stops with exit code `2` if the current pointer or manifest is missing.

Agent read order for an unblocked package:

1. `.pragma/design-contexts/issue-<n>/current.json` when resolving current
2. `versions/vN/manifest.json`
3. `normalized/agent-context.md` for briefing and package map only
4. `normalized/agent-workflow.md` for read gates and implementation safety rules
5. `normalized/design-context.json` to identify relevant frames and page regions
6. `normalized/pixel-spec/index.json`, then only the needed frame/region shards
7. `normalized/layers/index.json`, then only the needed layer-tree shards
8. `normalized/dependencies.json` for concrete shared components/assets snapshot locks
9. `normalized/assets.json`, `tokens.json`, `components.json`, and `render-instructions.md`
10. `source/figma-get-design-context.md` only as fallback/source evidence
11. `screenshots/*` and `validation/visual-baseline.json` for visual comparison

Development PRs must record the Design Issue, resolved Pragma version, manifest path, and checksum actually consumed. Dev branches should be created from, rebased onto, or merged with the default branch that already contains the design PR; they should not depend directly on a design branch.

If `normalized/dependencies.json` reports `missing` for components while the page has component instances, or `missing` for assets while unresolved/shared asset refs exist, the Agent must stop and request a new Design Context Package instead of guessing from Figma names or screenshots.
