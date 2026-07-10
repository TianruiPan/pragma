# Agent Workflow

## Read Gate
Stop before implementation until manifest.json, normalized/agent-context.md, this workflow, normalized/design-context.json, and the required pixel-spec shards for the target Page Regions have been read. Do not use broad full-package searches as the primary way to find typography or bounds.

## Typography
Read Page Regions from normalized/design-context.json, then open normalized/pixel-spec/index.json and only the region shards listed by the target regions. Typography facts live in region shard nodes[].text and must be preserved from resolvedValue even when tokenId is absent.

## Progressive Disclosure Rules
Start with manifest and the package map, choose the relevant Page Region, then read its pixel-spec region shard, layer tree frame shard, assets, tokens, and components only as needed. Fall back to source/figma-get-design-context.md only when normalized facts are insufficient.

## State Responsibility
Pragma can list Figma-native available states such as variants, visible or hidden state frames, and component properties. It does not choose the business runtime default state for an Issue; use the development Issue and acceptance criteria for that.

## Business Data Safety
Do not add fake runtime data, fallback records, forced selected/open states, or production-only bypasses just to match a screenshot. If visual parity needs sample data or a forced state, ask the user first and keep it preview/dev-only unless the Issue explicitly requires it.

## CSS Strategy
Prefer scoped styles, local component changes, design-token mapping, or component refactoring. Tail-of-file global overrides are only allowed as a short spike after explicit user approval and must be removed or localized before production work continues.
