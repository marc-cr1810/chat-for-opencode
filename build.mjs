import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readdirSync } from "node:fs";

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
    minify: !watch,
  },
];

// KaTeX's stylesheet and fonts for math in the webview. woff2 only: every webview engine reads it.
mkdirSync("dist/katex/fonts", { recursive: true });
cpSync("node_modules/katex/dist/katex.min.css", "dist/katex/katex.min.css");
for (const f of readdirSync("node_modules/katex/dist/fonts").filter((f) => f.endsWith(".woff2"))) {
  cpSync(`node_modules/katex/dist/fonts/${f}`, `dist/katex/fonts/${f}`);
}

// Mermaid's prebuilt bundle, which the webview loads only when a reply has a diagram.
mkdirSync("dist/mermaid", { recursive: true });
cpSync("node_modules/mermaid/dist/mermaid.min.js", "dist/mermaid/mermaid.min.js");

for (const config of configs) {
  if (watch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  } else {
    await esbuild.build(config);
  }
}
if (watch) console.log("watching...");
