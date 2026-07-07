# Agent Blocking Rule

When a development issue is labeled or described as `design/context`, the Agent must not start implementation until its dependent Design Context Issue is complete and exposes a Pragma manifest.

Blocking message:

```text
该开发 Issue 标记为 design/context，但依赖的 Design Context Issue #102 尚未交付 Pragma Context。
请等待设计交付完成，或将设计分类调整为 design/reference / design/none。
```

`pragma design read --dev-issue-file <file> --repo <repo>` implements the local-file version of this rule. It parses the development issue markdown, finds the dependency, and stops with exit code `2` if the manifest is missing.

Agent read order for an unblocked package:

1. `manifest.json`
2. `normalized/agent-context.md` for briefing and package map only
3. `normalized/pixel-spec.json` as the primary pixel implementation spec
4. `normalized/dependencies.json` for concrete shared components/assets snapshot locks
5. `normalized/assets.json`, `tokens.json`, `components.json`, and `render-instructions.md`
6. `source/figma-get-design-context.md` only as fallback/source evidence
7. `screenshots/*` and `validation/visual-baseline.json` for visual comparison

If `normalized/dependencies.json` reports `missing` for components while the page has component instances, or `missing` for assets while unresolved/shared asset refs exist, the Agent must stop and request a new Design Context Package instead of guessing from Figma names or screenshots.
