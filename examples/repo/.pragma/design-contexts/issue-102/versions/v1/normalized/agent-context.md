# Design Context for Issue #102

## Required Read Order
1. current.json (only when resolving the current recommended version)
2. versions/vN/manifest.json
3. normalized/agent-context.md (briefing and package map only)
4. normalized/agent-workflow.md (read gate, typography, state, data, and CSS safety rules)
5. normalized/design-context.json (Page Regions and routing)
6. normalized/pixel-spec/index.json, then only the needed frame/region shards
7. normalized/dependencies.json (locked shared components/assets snapshots)
8. normalized/assets.json
9. normalized/tokens.json
10. normalized/components.json
11. normalized/render-instructions.md
12. source/figma-get-design-context.md only as fallback/source evidence
13. screenshots/* and validation/visual-baseline.json for visual comparison

## Source
- Provider: figma
- Adapter: figma-mcp
- Repo: example-org/flight-ops-console
- Figma file: demoFigmaFileKey
- Nodes: 1:23
- Captured at: 2026-07-06T10:00:00+08:00
- Raw context: source/figma-get-design-context.md

## Package Map
- Agent workflow: normalized/agent-workflow.md
- Design context: normalized/design-context.json (3 Page Regions)
- Pixel spec index: normalized/pixel-spec/index.json (6 nodes; read shards progressively)
- Layers index: normalized/layers/index.json
- Tokens: normalized/tokens.json
- Components: normalized/components.json
- Dependencies: normalized/dependencies.json (reused components, reused assets)
- Assets: normalized/assets.json
- Render instructions: normalized/render-instructions.md
- Visual baseline: validation/visual-baseline.json

## Linked Development Issues
- #101 Implement map monitoring page

## Design Intent
Implement the layout hierarchy, panel density, and alert emphasis. The exact map imagery is not a pixel-perfect requirement.

## Screens / Frames
- screenshots/main-frame.webp

## Assets
- asset-drone-icon: map-marker, assets/icons/drone.svg, 32x32
- asset-panel-bg: panel-background, assets/images/panel-bg.png, 1x1

## Implementation Notes
The center map uses the production map service. Treat the Figma map as an intent reference for control placement, visual balance, and overlay density.

## Non-goal
This file is not a pixel implementation spec. Use normalized/agent-workflow.md and normalized/pixel-spec/index.json plus the referenced shards for bounds, styles, typography, layer order, and bindings.
