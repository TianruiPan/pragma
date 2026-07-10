# Render Instructions

## Pixel Contract
- Use normalized/pixel-spec/index.json as the primary pixel implementation entrypoint, then read only the frame or Page Region shards needed for the task.
- Preserve bounds, z-index order, text styles, fills, strokes, radii, shadows, opacity, and asset bindings from the shard unless the target product design system requires a documented equivalent.

## Required Assets
- asset-drone-icon

## Dynamic / Non-pixel Regions
- region-dynamic-map-surface-node-1-30-dynamic: implementation-defined; The center map uses the production map service. Treat the Figma map as an intent reference for control placement, visual balance, and overlay density.

## Notes
The center map uses the production map service. Treat the Figma map as an intent reference for control placement, visual balance, and overlay density.
