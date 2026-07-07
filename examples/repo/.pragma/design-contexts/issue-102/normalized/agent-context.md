# Design Context for Issue #102

## Required Read Order
1. manifest.json
2. normalized/agent-context.md (briefing and package map only)
3. normalized/pixel-spec.json (primary pixel implementation spec)
4. normalized/dependencies.json (locked shared components/assets snapshots)
5. normalized/assets.json
6. normalized/tokens.json
7. normalized/components.json
8. normalized/render-instructions.md
9. source/figma-get-design-context.md only as fallback/source evidence
10. screenshots/* and validation/visual-baseline.json for visual comparison

## Source
- Provider: figma
- Adapter: figma-mcp
- Repo: example-org/flight-ops-console
- Figma file: demoFigmaFileKey
- Nodes: 1:23
- Captured at: 2026-07-06T10:00:00+08:00
- Raw context: source/figma-get-design-context.md

## Package Map
- Pixel spec: normalized/pixel-spec.json (6 nodes)
- Layers: normalized/layers.json
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
This file is not a pixel implementation spec. Use normalized/pixel-spec.json for bounds, styles, layer order, and bindings.
