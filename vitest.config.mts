import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // test/webview holds the Playwright specs.
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    // Host tests import src/ modules that import "vscode", which only exists inside VS Code.
    alias: { vscode: fileURLToPath(new URL("test/host/vscode.ts", import.meta.url)) },
  },
});
