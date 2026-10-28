import { defineConfig, devices } from "@playwright/test";

// Webview tests: the real dist/webview.js in harness/index.html, with a stand-in VS Code host.
// `npm run test:webview` builds first.
export default defineConfig({
  testDir: "test/webview",
  testMatch: "*.spec.ts",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:5174",
    // About the width of VS Code's secondary side bar.
    viewport: { width: 420, height: 820 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node harness/serve.mjs",
    url: "http://127.0.0.1:5174/harness/",
    reuseExistingServer: !process.env.CI,
  },
});
