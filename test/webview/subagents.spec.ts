import { expect, test } from "@playwright/test";
import { open, sent } from "./harness";

test.describe("subagents", () => {
  test("agents started together share one step, with the running one's current step", async ({ page }) => {
    await open(page, "subagents");
    const group = page.locator(".tool-row", { has: page.locator(".tool-name", { hasText: "Subagents" }) });
    await expect(group.locator(".tool-arg").first()).toHaveText("2 tasks");
    await expect(group.locator(".tool-summary")).toHaveText(/^1 running · 1 done · \d+s$/);
    await expect(group.locator(".agent-row .what")).toHaveText(["Find SSE parsing code", "Check reconnect handling"]);
    await expect(group.locator(".agent-row .who").first()).toHaveText("@explore · 4 steps · 35s");
    await expect(group.locator(".agent-now")).toHaveText("npx vitest run test/streams.test.ts");

    // A finished agent's line opens to its report, with the whole run a click away.
    await group.locator(".agent-row", { hasText: "Find SSE parsing code" }).click();
    const detail = group.locator(".agent-detail");
    await expect(detail.locator(".sub-step.more")).toHaveText("4 steps");
    await expect(detail.locator(".subagent-result")).toContainText("Two places parse the event stream");
    await expect(detail.locator(".subagent-result")).not.toContainText("task_result");
    await detail.getByRole("button", { name: "Open transcript" }).click();
    expect(await sent(page, "loadSession")).toEqual([{ type: "loadSession", id: "ses_find" }]);
  });

  test("a long run folds its older steps and shows its latest words", async ({ page }) => {
    await open(page, "subagents");
    const audit = page.locator(".tool-row", { has: page.locator(".tool-arg", { hasText: "Audit reconnect handling" }) });
    await expect(audit.locator(".tool-summary")).toHaveText(/^@general · 12 steps · 1m \d+s$/);
    const steps = audit.locator(".subagent-steps");
    await expect(steps.locator(".sub-step.more")).toHaveText("9 earlier steps");
    await expect(steps.locator(".sub-step:not(.more) .tool-name")).toHaveText(["Read", "Grep", "Shell"]);
    await expect(steps.locator(".sub-say")).toHaveText("“Checking the backoff ceiling next…”");

    // Streamed words replace the line as they arrive.
    const partID = await page.evaluate(() => (window as any).harness.scene.children.ses_audit.at(-1).id);
    await page.evaluate((p) => (window as any).harness.post({ type: "childDelta", sessionID: "ses_audit", partID: p, field: "text", delta: " It tops out at 30s." }), partID);
    await expect(steps.locator(".sub-say")).toHaveText("“Checking the backoff ceiling next… It tops out at 30s.”");

    await steps.locator(".sub-step.more").click();
    await expect(steps.locator(".sub-step")).toHaveCount(12);
  });

  test("a long report folds to a preview until asked for", async ({ page }) => {
    await open(page, "subagents");
    const group = page.locator(".tool-row", { has: page.locator(".tool-name", { hasText: "Subagents" }) });
    await group.locator(".agent-row", { hasText: "Find SSE parsing code" }).click();
    const result = group.locator(".subagent-result");
    await expect(result).toHaveClass(/report-preview/);
    await group.getByRole("button", { name: "Show full report" }).click();
    await expect(result).not.toHaveClass(/report-preview/);
    await group.getByRole("button", { name: "Show less" }).click();
    await expect(result).toHaveClass(/report-preview/);
  });

  test("shell output keeps its colours instead of escape codes", async ({ page }) => {
    await open(page, "subagents");
    const shell = page.locator(".tool-row", { has: page.locator(".tool-arg", { hasText: "npm test" }) });
    await expect(shell.locator(".tool-summary")).toHaveText("✓ test/streams.test.ts (12 tests)");
    await shell.locator(".coll-head").click();
    const out = shell.locator(".tool-output");
    await expect(out).toContainText("32 passed | 1 failed");
    expect(await out.textContent()).not.toMatch(/\u001b|\[3\dm/);
    await expect(out.locator('span[style*="ansiGreen"]').first()).toHaveText("✓");
    await expect(out.locator('span[style*="ansiRed"]').first()).toHaveText("✗");
    await expect(out.locator('span[style*="opacity"]').first()).toHaveText("(12 tests)");
  });
});
