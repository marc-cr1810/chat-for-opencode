import { expect, test } from "@playwright/test";
import { open, sent } from "./harness";

test.describe("composer", () => {
  test("Enter sends with the current agent and model", async ({ page }) => {
    await open(page, "empty");
    await page.locator("#input").fill("Explain src/server.ts");
    await page.keyboard.press("Enter");
    expect(await sent(page, "send")).toEqual([
      expect.objectContaining({ text: "Explain src/server.ts", agent: "build", model: { providerID: "opencode", modelID: "big-pickle" } }),
    ]);
    await expect(page.locator("#input")).toHaveValue("");
  });

  test("with sendKey ctrlEnter, Enter adds a line and Ctrl+Enter sends", async ({ page }) => {
    await open(page, "empty", { settings: { sendKey: "ctrlEnter" } });
    const input = page.locator("#input");
    await expect(input).toHaveAttribute("placeholder", /Ctrl\+Enter to send/);
    await input.fill("first line");
    await input.press("Enter");
    expect(await sent(page, "send")).toHaveLength(0);
    await input.press("Control+Enter");
    expect(await sent(page, "send")).toHaveLength(1);
  });

  test("Tab switches agent, and plan gets the read-only command toggle", async ({ page }) => {
    await open(page, "empty");
    await expect(page.locator("#modeBtn")).toHaveText("build");
    await expect(page.locator("#editsBtn")).toHaveText("Approve edits");
    await page.locator("#input").press("Tab");
    await expect(page.locator("#modeBtn")).toHaveText("plan");
    await expect(page.locator("#editsBtn")).toHaveText("Approve commands");
    await page.locator("#editsBtn").click();
    expect(await sent(page, "setAutoRead")).toEqual([{ type: "setAutoRead", autoRead: true }]);
    await expect(page.locator("#editsBtn")).toHaveText("Auto read-only");
  });

  // Known bug: at 300px the edits toggle still runs under the @ and / buttons.
  test.fixme("the footer fits a narrow side bar without overlapping", async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 700 });
    await open(page, "walkthrough");
    const edits = await page.locator("#editsBtn").boundingBox();
    const right = await page.locator(".foot-right").boundingBox();
    expect(edits!.x + edits!.width).toBeLessThanOrEqual(right!.x);
    // Nothing scrolls sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(300);
  });
});

test.describe("context meter", () => {
  test("shows how full the context is and warns past the threshold", async ({ page }) => {
    await open(page, "walkthrough", { settings: { contextWarningPercent: 40 } });
    const meter = page.locator("#ctxBtn");
    await expect(meter).toContainText("47%");
    await expect(meter).toHaveClass(/warn/);
  });
});
