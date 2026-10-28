import { expect, test } from "@playwright/test";
import { open, sent } from "./harness";

test.describe("apply_patch", () => {
  test("shows each file with its counts and diff, the first one open", async ({ page }) => {
    await open(page, "files");
    const step = page.locator(".tool-row", { has: page.locator(".tool-name", { hasText: "Patch" }) });
    await expect(step.locator(".tool-arg")).toHaveText("3 files");
    await expect(step.locator(".tool-sub")).toHaveText("+4 -2");
    const files = step.locator(".patch-file");
    await expect(files.locator(".change-status")).toHaveText(["M", "M", "A"]);
    await expect(files.locator(".change-name")).toHaveText(["server.ts", "settings.ts", "backoff.test.ts"]);
    await expect(files.nth(0)).toHaveClass(/open/);
    await expect(files.nth(0).locator(".diff-line.add")).toContainText("this.backoffMs");
    await expect(files.nth(2)).not.toHaveClass(/open/);

    // A new file's diff (no old side) renders too.
    await files.nth(2).locator(".coll-head").click();
    await expect(files.nth(2).locator(".diff-line.add")).toHaveCount(2);
    await files.nth(0).getByText("Open diff").click();
    expect((await sent(page, "openDiff")).at(-1)).toMatchObject({ filePath: expect.stringContaining("src/server.ts") });
  });
});

test.describe("files in replies", () => {
  test("shows a Read's image and PDF, and files the model returned", async ({ page }) => {
    await open(page, "files");
    const reads = page.locator(".tool-row", { has: page.locator(".tool-name", { hasText: "Read" }) });
    await expect(reads.nth(0).locator(".attach-img")).toBeVisible();
    await expect(reads.nth(1).locator(".tool-sub")).toHaveText(/^PDF · \d+ KB$/);

    const cards = page.locator(".file-row .file-card");
    await expect(cards.locator(".fc-name")).toHaveText(["event-flow.svg", "screenshot-notes.md"]);
    await expect(cards.locator(".fc-meta").nth(1)).toHaveText("Markdown · 77 B");
    await expect(page.locator(".file-row .image-card img")).toBeVisible();

    await cards.nth(1).locator('[data-file-action="save"]').click();
    await reads.nth(0).locator(".attach-img").click();
    const [save, open1] = [(await sent(page, "saveAttachment")).at(-1), (await sent(page, "openAttachment")).at(-1)];
    expect(save).toMatchObject({ filename: "screenshot-notes.md", mime: "text/markdown", url: expect.stringMatching(/^data:text\/markdown/) });
    expect(open1).toMatchObject({ filename: "screenshot-dark.png", url: expect.stringMatching(/^data:image/) });
  });

  test("loads workspace images in markdown, and says when one is missing", async ({ page }) => {
    await open(page, "files");
    const img = page.locator(".md-img img");
    await expect(img).toHaveAttribute("src", /^data:image\/svg\+xml/);
    await expect(page.locator(".img-missing")).toHaveText("docs/tabs.png not found");
    expect((await sent(page, "loadImage")).map((m) => m.path)).toEqual(["docs/screenshot-dark.png", "docs/tabs.png"]);
    await img.click();
    expect((await sent(page, "openFile")).at(-1)).toEqual({ type: "openFile", path: "docs/screenshot-dark.png" });
  });
});

test.describe("links and commands", () => {
  test("file links with a line anchor open at that line", async ({ page }) => {
    await open(page, "files");
    const link = page.locator(".markdown a", { hasText: "startRetry" });
    await expect(link).toHaveAttribute("title", "Open src/server.ts:120-140");
    await link.click();
    await page.locator(".markdown a", { hasText: "the settings" }).click();
    expect((await sent(page, "openFile")).slice(-2)).toEqual([
      { type: "openFile", path: "src/server.ts", line: 120 },
      { type: "openFile", path: "src/settings.ts", line: 40 },
    ]);
  });

  test("a web link opens once, without reaching VS Code's own link handler", async ({ page }) => {
    await open(page, "files");
    // VS Code's webview wrapper opens links from a click listener on the window.
    await page.evaluate(() => {
      (window as any).linkClicks = 0;
      window.addEventListener("click", (e) => (e.target as Element).closest("a") && (window as any).linkClicks++);
    });
    await page.locator(".markdown a", { hasText: "OpenCode's docs" }).click();
    await page.locator(".markdown a", { hasText: "startRetry" }).click();
    expect(await sent(page, "openExternal")).toEqual([{ type: "openExternal", url: "https://opencode.ai/docs" }]);
    expect(await page.evaluate(() => (window as any).linkClicks)).toBe(0);
  });

  test("a command run as a subtask names its agent", async ({ page }) => {
    await open(page, "files");
    const bubble = page.locator(".command-bubble").last();
    await expect(bubble.locator(".cmd-name")).toHaveText("/review");
    await expect(bubble.locator(".agent-tag")).toHaveText("@review");
    await bubble.locator(".coll-head").click();
    await expect(bubble.locator(".cmd-prompt")).toContainText("Review the changes in src/chat.ts");
  });
});

test.describe("turn footer", () => {
  test("adds up a turn's steps under its last reply, and copies the reply", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, "files");
    const feet = page.locator(".msg-foot");
    // Four turns; the first has two steps but one footer.
    await expect(feet).toHaveCount(4);
    await expect(feet.nth(0)).toHaveText(/^Big Pickle·\d+s·29\.3k in, 430 out·\$0\.02$/);
    await expect(feet.nth(0)).toHaveAttribute("title", /^Big Pickle, 2 steps in \d+s\nTokens sent to the model: 29\.3k\nTokens it wrote: 430\nCost: \$0\.0170$/);
    // Only the latest shows without hovering.
    await expect(feet.nth(0)).toHaveCSS("opacity", "0");
    await expect(feet.nth(3)).toHaveCSS("opacity", "1");

    await feet.nth(0).hover();
    await feet.nth(0).locator(".copy-reply").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Renamed `retryDelay` to `backoffMs`/);
  });
});
