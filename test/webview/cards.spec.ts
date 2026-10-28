import { expect, test } from "@playwright/test";
import { open, sent } from "./harness";

test.describe("question card", () => {
  test("steps through tabbed questions and sends every answer", async ({ page }) => {
    await open(page, "question");
    const card = page.locator(".card", { has: page.locator(".q-tabs") });
    await expect(card.locator(".q-tab")).toHaveText(["Fix scope", "Worktree close", "Review"]);
    await expect(card.locator(".card-title")).toHaveText("Which fixes should I make once you leave plan mode?");
    // While a card waits, the status line steps aside.
    await expect(page.locator(".status-row")).toBeHidden();

    // A single choice moves on by itself.
    await card.locator(".option", { hasText: "All findings" }).click();
    await expect(card.locator(".card-title")).toHaveText("What should closing a conversation that owns a worktree do?");
    await expect(card.locator(".q-tab.answered")).toHaveText(["Fix scope"]);

    await card.locator(".option", { hasText: "Refuse to close" }).click();
    await expect(card.locator(".card-title")).toHaveText("Review your answers");
    await expect(card.locator(".q-review-a")).toHaveText(["All findings", "Refuse to close"]);

    await card.getByRole("button", { name: "Submit" }).click();
    expect(await sent(page, "questionReply")).toEqual([{ type: "questionReply", id: "que_0001", answers: [["All findings"], ["Refuse to close"]] }]);
    await expect(card).toBeHidden();
  });

  test("Back and the arrow keys move between questions", async ({ page }) => {
    await open(page, "question");
    const card = page.locator(".card", { has: page.locator(".q-tabs") });
    await card.getByRole("button", { name: "Next" }).click();
    await expect(card.locator(".q-tab.active")).toHaveText("Worktree close");
    await card.getByRole("button", { name: "Back" }).click();
    await expect(card.locator(".q-tab.active")).toHaveText("Fix scope");
    await page.keyboard.press("ArrowRight");
    await expect(card.locator(".q-tab.active")).toHaveText("Worktree close");
  });

  test("Skip dismisses the questions", async ({ page }) => {
    await open(page, "question");
    await page.getByRole("button", { name: "Skip" }).click();
    expect(await sent(page, "questionReject")).toEqual([{ type: "questionReject", id: "que_0001" }]);
  });
});

test.describe("permission card", () => {
  test("shows the edit's diff and allows it once", async ({ page }) => {
    await open(page, "edit");
    const card = page.locator(".card", { hasText: "Permission required" });
    await expect(card).toContainText("Edit math.py");
    await expect(card.locator(".diff .del")).toContainText("return a - b");
    await expect(card.locator(".diff .add")).toContainText("return a + b");
    await card.getByRole("button", { name: "Allow once" }).click();
    expect(await sent(page, "permissionReply")).toEqual([expect.objectContaining({ id: "per_0001", reply: "once" })]);
  });

  test("sends the reason with a rejection", async ({ page }) => {
    await open(page, "edit");
    const card = page.locator(".card", { hasText: "Permission required" });
    await card.locator("textarea.feedback").fill("Keep subtraction, rename the function instead");
    await card.getByRole("button", { name: "Reject" }).click();
    expect(await sent(page, "permissionReply")).toEqual([
      expect.objectContaining({ id: "per_0001", reply: "reject", message: "Keep subtraction, rename the function instead" }),
    ]);
  });
});
