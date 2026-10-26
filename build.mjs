import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const configs = [
  {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: true,
  },
  {
    entryPoints: ["webview/main.js"],
    bundle: true,
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
    target: "es2022",
  },
];

for (const config of configs) {
  if (watch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  } else {
    await esbuild.build(config);
  }
}
if (watch) console.log("watching...");
