import { mkdir, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
await mkdir(dist, { recursive: true });
await mkdir(path.join(dist, "bridge"), { recursive: true });
await mkdir(path.join(dist, "shared"), { recursive: true });

const uiSource = await readFile(path.join(root, "src", "plugin", "ui.html"), "utf8");

await esbuild.build({
  entryPoints: [path.join(root, "src", "plugin", "code.ts")],
  bundle: true,
  outfile: path.join(dist, "code.js"),
  format: "iife",
  target: "es2020",
  sourcemap: false,
  define: {
    __PRAGMA_UI_HTML__: JSON.stringify(uiSource)
  }
});

await copyFile(path.join(root, "src", "plugin", "ui.html"), path.join(dist, "ui.html"));

await esbuild.build({
  entryPoints: [
    path.join(root, "src", "bridge", "cli.ts"),
    path.join(root, "src", "bridge", "server.ts"),
    path.join(root, "src", "bridge", "writer.ts"),
    path.join(root, "src", "bridge", "dependency-lock.ts")
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: path.join(dist, "bridge"),
  sourcemap: false
});

await esbuild.build({
  entryPoints: [
    path.join(root, "src", "shared", "figma-url.ts"),
    path.join(root, "src", "shared", "bridge-url.ts"),
    path.join(root, "src", "shared", "roles.ts"),
    path.join(root, "src", "shared", "layer.ts"),
    path.join(root, "src", "shared", "assets.ts"),
    path.join(root, "src", "shared", "bundle.ts")
  ],
  bundle: false,
  platform: "neutral",
  format: "esm",
  target: "es2020",
  outdir: path.join(dist, "shared"),
  sourcemap: false
});
