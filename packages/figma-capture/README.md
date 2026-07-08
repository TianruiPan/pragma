# Pragma Figma Capture

MVP Figma Plugin + local Capture Bridge for the Pragma 2.0 designer-side capture contract.

This package is intentionally isolated from the Pragma core/CLI implementation. It writes a deterministic `pragma-input/` directory that core can ingest later.

## Build

```bash
cd packages/figma-capture
npm install
npm run build
npm run typecheck
npm test
```

Load `manifest.json` in Figma after build. The manifest points to `dist/code.js` and `dist/ui.html`.

## Figma Plugin Flow

1. Select one or more target frames in Figma.
2. Add the current selection into persistent slots. Changing the Figma selection does not clear slots.
   - `page`: required; one or more implementation frames/states.
   - `components`: optional; one or more component sheets such as `App Mobile / Components`.
   - `assets`: optional; one or more export boards or asset sheets.
3. Fill the required fields: design issue number and either a Figma file URL or file key. Repo path is required for local bridge writes unless `--repo` was passed when starting the bridge.
4. Use one of the actions:
   - `Export capture`: downloads a JSON bundle containing the `pragma-input/` file tree.
   - `Send to local bridge`: posts the bundle to `http://localhost:48732/capture`.

## Local Bridge

Start the bridge:

```bash
npm run bridge -- serve --host localhost --port 48732 --repo D:/path/to/repo
```

The plugin only supports `http://localhost:48732/capture` for `Send to local bridge`. It checks `http://localhost:48732/health` before posting and reports a readable hint if the bridge is not running. `/health` and `/detail` return version, repo/write-root configuration, and the last capture summary for troubleshooting.

Unpack a plugin-only bundle without running the server:

```bash
npm run bridge -- unpack --bundle D:/Downloads/pragma-input-bundle.json --repo D:/path/to/repo
```

By default the bridge writes to:

```text
<repo>/.pragma/incoming/figma-captures/issue-<number>-<timestamp>/pragma-input/
```

It reads `.pragma/design-sources/figma/<fileKey>/registry.json` when present and writes `dependency-lock.json` with `selected`, `reused`, `missing`, or `none` statuses. `reused` entries point to concrete registry snapshots. `selected` entries keep `frameNodeIds` and are marked `pending-preflight` until Pragma core materializes the snapshot. It never writes Figma tokens, credentials, full Figma files, or unrelated pages.

## Output Shape

```text
pragma-input/
  capture.json
  dependency-lock.json
  figma/
    metadata.json
    selection.json
    get-design-context.md
    layers.json
    variables.json
    components.json
  screenshots/
    00-page-*.png
  assets/
    images/
    exports/
  assets-manifest.json
  asset-bindings.json
  designer-notes.md
  dynamic-regions.md
  capture-summary.json
```

## Core Handoff Fields

- `capture.json.figma.frames`: explicit page/components/assets role selection.
- `figma/selection.json.frames.*[].url`: generated per-frame Figma URLs when a fileKey is available.
- `dependency-lock.json`: bridge-resolved snapshot dependency status; reused entries are concrete, while selected components/assets include `frameNodeIds` and `needsSourceSync: true` for core `preflight --fix`.
- `figma/layers.json`: provider facts for node tree, bounds, styles, text, layout, component refs, and image fill refs.
- `figma/components.json.instances`: page component instance facts with bounds and component refs.
- `assets-manifest.json` + `asset-bindings.json`: page-bound and selected asset-frame exports with MIME/path/node bindings; asset width/height are sniffed from exported files, while placement size stays in bindings.
- `capture-summary.json`: bridge-written capture timings and diagnostics, including `serializeMs`, `exportScreenshotsMs`, `exportAssetsMs`, `writeFilesMs`, `dependencyLockMs`, `totalMs`, frame role counts, unavailable checksums, unresolved shared refs, and pending preflight dependencies.

Example bridge response fields:

```json
{
  "ok": true,
  "outputDir": "D:/repo/.pragma/incoming/figma-captures/issue-12-20260707T000000/pragma-input",
  "captureTimings": {
    "serializeMs": 12,
    "exportScreenshotsMs": 80,
    "exportAssetsMs": 45,
    "writeFilesMs": 10,
    "dependencyLockMs": 8,
    "totalMs": 155
  },
  "diagnostics": {
    "assetChecksumUnavailableCount": 1,
    "unresolvedSharedRefCount": 0,
    "dynamicRegionNotesMissing": true,
    "selectedPendingPreflight": []
  }
}
```

Structured bridge errors use this shape:

```json
{
  "ok": false,
  "code": "BRIDGE_INVALID_JSON",
  "error": "Expected property name or '}' in JSON at position 1",
  "hint": "Check that the plugin is posting a pragma-figma-capture-bundle to http://localhost:48732/capture and that --repo/--out paths are writable."
}
```

## Known MVP Limits

- The plugin cannot call Figma MCP `get_design_context`; it writes an explicit plugin summary instead of fabricating MCP output.
- Plugin-only export cannot inspect repo `.pragma/design-sources`; local bridge or Pragma core must resolve `reused` snapshots.
- Export/send blocks if fileKey cannot be resolved from override, Figma URL, or `figma.fileKey`.
- If WebCrypto is unavailable, plugin assets omit `checksum` and write `checksumStatus: "unavailable"`; Pragma core `preflight --fix` recomputes the real sha256.
- Image fill bytes are captured when Figma exposes `getImageByHash`; other complex export settings may need manual asset-frame selection.
- MIME sniffing is best-effort in-plugin; Pragma core validation should remain authoritative.

## Release Checklist

Before pushing plugin changes:

```bash
npm run build
npm run typecheck
npm test
```

Commit `dist/` with the source files because the development Figma manifest loads the built `dist/code.js` and `dist/ui.html` directly.
