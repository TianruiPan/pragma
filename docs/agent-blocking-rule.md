# Agent Blocking Rule

When a development issue is labeled or described as `design/context`, the Agent must not start implementation until its dependent Design Context Issue is complete and exposes a Pragma manifest.

Blocking message:

```text
该开发 Issue 标记为 design/context，但依赖的 Design Context Issue #102 尚未交付 Pragma Context。
请等待设计交付完成，或将设计分类调整为 design/reference / design/none。
```

`pragma design read --dev-issue-file <file> --repo <repo>` implements the local-file version of this rule. It parses the development issue markdown, finds the dependency, and stops with exit code `2` if the manifest is missing.
