# Design Context for Issue #102

## Source
- Provider: figma
- Adapter: figma-mcp
- Repo: example-org/flight-ops-console
- Figma file: demoFigmaFileKey
- Nodes: 1:23
- Captured at: 2026-07-06T10:00:00+08:00
- Raw context: source/figma-get-design-context.md

## Linked Development Issues
- #101 Implement map monitoring page

## Design Intent
Implement the layout hierarchy, panel density, and alert emphasis. The exact map imagery is not a pixel-perfect requirement.

## Screens / Frames
- screenshots/main-frame.webp

## Implementation Structure
- Build only the frames and states listed in this package.
- Treat source/figma-get-design-context.md as preserved source evidence, not as a full design IR.
- Prefer existing product components and tokens when the target repo already defines them.

## Components
- MVP stores component names and variants as design hints only. No Code Connect mapping is required.
- See source/figma-components.json when it exists.

## Layout Essentials
- Follow the exported frame sizes, key spacing, and constraints from normalized/design-context.json.
- Do not infer unrelated pages or hidden Figma nodes outside this selection.

## Styles / Tokens
- Use source/figma-variables.json when available.
- Keep only styles required by this Issue in the implementation.

## Assets
- asset-drone-icon: map-marker, assets/icons/drone.svg, 32x32
- asset-panel-bg: panel-background, assets/images/panel-bg.webp, 320x180

## Implementation Notes
The center map uses the production map service. Treat the Figma map as an intent reference for control placement, visual balance, and overlay density.
