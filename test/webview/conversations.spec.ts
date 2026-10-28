import { expect, test } from "@playwright/test";
import { open, sent } from "./harness";

test.describe("fork", () => {
  test("Fork from here forks before the message and hands back its text", async ({ page }) => {
    await open(page, "edit");
    const bubble = page.locator(".user-bubble").first();
    await bubble.hover();
    await bubble.locator('button[title^="Fork from here"]').click();
    const [fork] = await sent(page, "fork");
    expect(fork).toEqual({ type: "fork", messageID: expect.stringMatching(/^msg/), text: "Fix the bug in math.py" });
  });

  test("a forked message comes back as a draft in the box, not sent", async ({ page }) => {
    await open(page, "empty");
    await page.evaluate(() => (window as any).harness.post({ type: "externalPrompt", text: "Try it another way", mentions: [], draft: true }));
    await expect(page.locator("#input")).toHaveValue("Try it another way");
    await expect(page.locator("#input")).toBeFocused();
    expect(await sent(page, "send")).toHaveLength(0);
  });

  test("the … menu forks the whole conversation, and only offers it once there is one", async ({ page }) => {
    await open(page, "empty");
    await page.locator("#moreBtn").click();
    await expect(page.locator("#morePop")).not.toContainText("Fork conversation");
    await open(page, "edit");
    await page.locator("#moreBtn").click();
    await page.locator("#morePop .pop-item", { hasText: "Fork conversation" }).click();
    expect(await sent(page, "fork")).toEqual([{ type: "fork" }]);
  });
});

test.describe("rename", () => {
  test("from the … menu, the title is edited in place; Enter saves", async ({ page }) => {
    await open(page, "edit");
    await page.locator("#moreBtn").click();
    await page.locator("#morePop .pop-item", { hasText: "Rename conversation" }).click();
    const field = page.locator("header .title-edit");
    await expect(field).toHaveValue("Fix the add bug");
    await field.fill("  Subtraction bug in add  ");
    await field.press("Enter");
    await expect(field).toHaveCount(0);
    await expect(page.locator("#titleText")).toHaveText("Subtraction bug in add");
    expect(await sent(page, "renameSession")).toEqual([{ type: "renameSession", id: expect.any(String), title: "Subtraction bug in add" }]);
  });

  test("Esc, an empty title or no change sends nothing", async ({ page }) => {
    await open(page, "edit");
    const rename = async () => {
      await page.locator("#moreBtn").click();
      await page.locator("#morePop .pop-item", { hasText: "Rename conversation" }).click();
      return page.locator("header .title-edit");
    };
    let field = await rename();
    await field.fill("Something else");
    await field.press("Escape");
    field = await rename();
    await field.fill("   ");
    await field.press("Enter");
    field = await rename();
    await field.press("Enter");
    expect(await sent(page, "renameSession")).toHaveLength(0);
    await expect(page.locator("#titleText")).toHaveText("Fix the add bug");
  });

  test("a past conversation can be renamed from the history list without opening it", async ({ page }) => {
    await open(page, "history");
    await page.locator("#historyBtn").click();
    const row = page.locator(".session-item", { hasText: "Keep plan mode read-only" });
    await row.hover();
    await row.locator('button[title="Rename"]').click();
    const field = row.locator(".title-edit");
    await field.click();
    await field.fill("Plan mode stays read-only");
    await field.press("Enter");
    expect(await sent(page, "renameSession")).toEqual([{ type: "renameSession", id: "ses_h2", title: "Plan mode stays read-only", relist: true }]);
    expect(await sent(page, "loadSession")).toHaveLength(0);
  });
});
