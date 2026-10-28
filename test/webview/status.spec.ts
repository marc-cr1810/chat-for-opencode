import { expect, test } from "@playwright/test";
import { event, open, sent, sessionID } from "./harness";

const row = (page) => page.locator(".status-row");
const visibleActions = (page) => page.locator(".status-actions button:not(.hidden)");

test.describe("status line", () => {
  test("keeps the running agent's name and colour when you switch agents mid-run", async ({ page }) => {
    await open(page, "walkthrough");
    const sid = await sessionID(page);
    await event(page, "session.status", { sessionID: sid, status: { type: "busy" } });
    const accent = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).getPropertyValue("--accent").trim());
    await expect(row(page).locator(".verb")).toHaveText("plan is working");
    const planColor = await accent(".status-row");

    // The picker now says build, for the next message; the work under way is still plan's.
    await page.locator("textarea").press("Tab");
    await expect(page.locator("#modeBtn")).toHaveText("build");
    await expect(row(page).locator(".verb")).toHaveText("plan is working");
    expect(await accent(".status-row")).toBe(planColor);
    expect(await accent(".msg.assistant")).toBe(planColor);
    expect(await accent("body")).not.toBe(planColor);
  });

  test("earlier plan replies keep plan's colour once build takes over", async ({ page }) => {
    await open(page, "walkthrough");
    const sid = await sessionID(page);
    const codeColor = (msg: string) => page.locator(`.msg[data-mid="${msg}"] .markdown code`).first().evaluate((el) => getComputedStyle(el).color);
    const planReply = await page.locator(".msg.assistant").last().getAttribute("data-mid");
    const planCode = await codeColor(planReply!);

    // Switch to build and get a build reply.
    await page.locator("textarea").press("Tab");
    const now = Date.now();
    await event(page, "message.updated", { info: { id: "msg_9001", sessionID: sid, role: "user", agent: "build", time: { created: now } } });
    await event(page, "message.updated", { info: { id: "msg_9002", sessionID: sid, role: "assistant", mode: "build", agent: "build", parentID: "msg_9001", time: { created: now } } });
    await event(page, "message.part.updated", { part: { id: "prt_9002", messageID: "msg_9002", sessionID: sid, type: "text", text: "Now in `build`." } });
    await event(page, "session.status", { sessionID: sid, status: { type: "busy" } });

    await expect(page.locator('.msg[data-mid="msg_9002"] .markdown code')).toHaveText("build");
    expect(await codeColor(planReply!)).toBe(planCode);
    expect(await codeColor("msg_9002")).not.toBe(planCode);
    await expect(row(page).locator(".verb")).toHaveText("build is working");
  });

  test("shows the agent working, then warns when the model goes quiet", async ({ page }) => {
    await open(page, "walkthrough", { clock: true });
    const sid = await sessionID(page);
    await event(page, "session.status", { sessionID: sid, status: { type: "busy" } });
    await expect(row(page).locator(".verb")).toHaveText("plan is working");

    await page.clock.runFor(31_000);
    await expect(row(page).locator(".verb")).toHaveText(/^No response from Big Pickle for 3\ds$/);
    await expect(row(page)).toHaveClass(/stalled/);
    await expect(visibleActions(page)).toHaveText(["Stop", "Retry"]);

    // Anything from the model counts as activity.
    await event(page, "message.updated", { info: { id: "msg_9999", sessionID: sid, role: "assistant", time: { created: Date.now() } } });
    await page.clock.runFor(1_000);
    await expect(row(page).locator(".verb")).toHaveText("plan is working");
  });

  test("doesn't count a running tool as a stall", async ({ page }) => {
    await open(page, "walkthrough", { clock: true });
    const sid = await sessionID(page);
    await event(page, "session.status", { sessionID: sid, status: { type: "busy" } });
    await event(page, "message.updated", { info: { id: "msg_9999", sessionID: sid, role: "assistant", agent: "plan", time: { created: 1 } } });
    await event(page, "message.part.updated", {
      part: { id: "prt_9999", messageID: "msg_9999", sessionID: sid, type: "tool", tool: "bash", callID: "c1", state: { status: "running", input: { command: "npm test" }, time: { start: 1 } } },
    });
    await page.clock.runFor(200_000);
    await expect(row(page).locator(".verb")).toHaveText("plan is working");
    await expect(row(page)).not.toHaveClass(/stalled/);
  });

  test("stops a silent run at the configured timeout and offers Retry", async ({ page }) => {
    await open(page, "walkthrough", { clock: true, settings: { responseTimeoutSeconds: 60 } });
    const sid = await sessionID(page);
    await event(page, "session.status", { sessionID: sid, status: { type: "busy" } });
    await page.clock.runFor(45_000);
    await expect(row(page).locator(".status-hint")).toHaveText("stops at 60s");
    expect(await sent(page, "abort")).toHaveLength(0);

    await page.clock.runFor(16_000);
    expect(await sent(page, "abort")).toHaveLength(1);
    await event(page, "session.idle", { sessionID: sid });
    await expect(row(page).locator(".verb")).toHaveText(/^Timed out: no response from Big Pickle for 6\ds$/);
    await expect(row(page)).toHaveClass(/timed-out/);
    await expect(visibleActions(page)).toHaveText(["Retry"]);

    await visibleActions(page).click();
    expect(await sent(page, "retry")).toHaveLength(1);
  });

  test("explains OpenCode's own retries instead of looking stalled", async ({ page }) => {
    await open(page, "walkthrough", { clock: true });
    const sid = await sessionID(page);
    const now = await page.evaluate(() => Date.now());
    await event(page, "session.status", {
      sessionID: sid,
      status: {
        type: "retry",
        attempt: 1,
        message: "Free usage exceeded, subscribe to Go",
        next: now + 13 * 3600_000 + 12 * 60_000,
        action: { reason: "free_tier_limit", provider: "opencode", title: "Free limit reached", message: "Subscribe to OpenCode Go.", label: "subscribe", link: "https://opencode.ai/go" },
      },
    });
    await expect(row(page).locator(".verb")).toHaveText("Free limit reached");
    await expect(row(page).locator(".status-hint")).toHaveText(/^resets in 13h 1[12]m$/);
    await expect(visibleActions(page)).toHaveText(["Stop", "Subscribe"]);
    await visibleActions(page).filter({ hasText: "Subscribe" }).click();
    expect(await sent(page, "openExternal")).toEqual([{ type: "openExternal", url: "https://opencode.ai/go" }]);

    await event(page, "session.status", { sessionID: sid, status: { type: "retry", attempt: 2, message: "Provider is overloaded", next: now + 8_000 } });
    await expect(row(page).locator(".verb")).toHaveText("Provider is overloaded");
    await expect(row(page).locator(".status-hint")).toHaveText(/^retry 2 in \ds$/);

    await event(page, "session.status", { sessionID: sid, status: { type: "idle" } });
    await expect(row(page)).toBeHidden();
  });
});
