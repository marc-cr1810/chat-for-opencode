import { expect, test, type Page } from "@playwright/test";
import { event, open, sent, sessionID } from "./harness";

const CWD = "/home/dev/chat-for-opencode";
/** A tool step by its name, opened if it's folded. */
async function step(page: Page, name: string | RegExp, nth = 0) {
  const row = page.locator(".tool-row", { has: page.locator(".tool-name", { hasText: name }) }).nth(nth);
  if (!(await row.evaluate((el) => el.classList.contains("open")))) await row.locator(".coll-head").click();
  return row;
}

test.describe("search results", () => {
  test("grep matches are grouped by file, highlighted, and open at their line", async ({ page }) => {
    await open(page, "tools");
    const grep = await step(page, "Grep");
    await expect(grep.locator(".tool-sub")).toHaveText("6 matches in 3 files");
    await expect(grep.locator(".res-file .change-name")).toHaveText(["server.ts", "settings.ts", "chat.ts"]);
    await expect(grep.locator(".res-line").first()).toHaveText("42private retryDelay = 1000;");
    await expect(grep.locator(".res-line mark").first()).toHaveText("retryDelay");
    await grep.locator(".res-line", { hasText: "119" }).click();
    expect((await sent(page, "openFile")).at(-1)).toEqual({ type: "openFile", path: `${CWD}/src/server.ts`, line: 119 });
  });

  test("glob lists files, folded after 20", async ({ page }) => {
    await open(page, "tools");
    const glob = await step(page, "Glob");
    await expect(glob.locator(".tool-sub")).toHaveText("24 files");
    await expect(glob.locator(".res-file")).toHaveCount(20);
    await glob.locator(".res-more").click();
    await expect(glob.locator(".res-file")).toHaveCount(24);
  });
});

test.describe("folding", () => {
  test("a step that only has something to show once it finishes can be unfolded", async ({ page }) => {
    await open(page, "tools");
    const sid = await sessionID(page);
    const part = { id: "prt_9100", messageID: "msg_9100", sessionID: sid, type: "tool", tool: "grep", callID: "c9100" };
    const input = { pattern: "startRetry", path: `${CWD}/src` };
    // Running, it has no output, so nothing to unfold; then it finishes, redrawn in place.
    await event(page, "message.part.updated", { part: { ...part, state: { status: "running", input, time: { start: 0 } } } });
    const row = page.locator('.tool-row[data-pid="prt_9100"]');
    await expect(row).not.toHaveClass(/collapsible/);
    const output = `Found 1 matches\n${CWD}/src/server.ts:\n  Line 120:   private startRetry(attempt: number) {`;
    await event(page, "message.part.updated", { part: { ...part, state: { status: "completed", input, output, title: "", metadata: {}, time: { start: 0, end: 1 } } } });
    await expect(row.locator(".tool-sub")).toHaveText("1 match in 1 file");
    await row.locator(".coll-head").click();
    await expect(row).toHaveClass(/open/);
    await expect(row.locator(".res-line")).toHaveText("120private startRetry(attempt: number) {");
    await row.locator(".coll-head").click();
    await expect(row).not.toHaveClass(/open/);
  });

  test("a one-line result is its own summary", async ({ page }) => {
    await open(page, "tools");
    const sid = await sessionID(page);
    const st = { status: "completed", input: { pattern: "nothingLikeThis" }, output: "No files found", title: "", metadata: {}, time: { start: 0, end: 1 } };
    await event(page, "message.part.updated", { part: { id: "prt_9101", messageID: "msg_9100", sessionID: sid, type: "tool", tool: "grep", callID: "c9101", state: st } });
    await expect(page.locator('.tool-row[data-pid="prt_9101"] .tool-sub')).toHaveText("No files found");
  });
});

test.describe("lsp", () => {
  test("names the lookup and lists places with their line of code", async ({ page }) => {
    await open(page, "tools");
    const def = await step(page, "Definition");
    await expect(def.locator(".tool-arg")).toHaveText("src/chat.ts:210:14");
    await expect(def.locator(".res-hit .code")).toHaveText("private startRetry(attempt: number) {");
    const refs = await step(page, "References");
    await expect(refs.locator(".tool-sub")).toHaveText("3 references in 2 files");
    await expect(refs.locator(".res-hit .loc")).toHaveText(["src/server.ts:88", "src/server.ts:126", "src/chat.ts:210"]);
    const symbols = await step(page, "Symbols");
    await expect(symbols.locator(".res-hit .sym")).toHaveText("watchServer");
    await symbols.locator(".res-hit").click();
    expect((await sent(page, "openFile")).at(-1)).toEqual({ type: "openFile", path: `${CWD}/src/watchdog.ts`, line: 21 });
    const hover = await step(page, "Hover");
    await expect(hover.locator(".code-block")).toContainText("startRetry(attempt: number): void");
  });
});

test.describe("MCP tools", () => {
  test("show the server, the tool in words, and what it was given", async ({ page }) => {
    await open(page, "tools");
    const issue = await step(page, "create issue");
    await expect(issue.locator(".tool-name")).toHaveText("github · create issue");
    await expect(issue.locator(".tool-arg")).toHaveText("Links open twice in the chat panel");
    await expect(issue.locator(".args dt")).toHaveText(["owner", "repo", "title", "labels", "body"]);
    await expect(issue.locator(".args dd").nth(4)).toHaveText("VS Code's webview wrapper opens links from a window listener.");
    await expect(issue.locator(".tool-output")).toContainText('"number": 214');
    await expect(page.locator(".tool-row", { hasText: "context7 · get library docs" })).toBeVisible();
  });
});

test.describe("plan hand-over", () => {
  test("shows the hand-over to build, or that planning went on", async ({ page }) => {
    await open(page, "tools");
    await expect(page.locator(".handoff.kept")).toHaveText("Kept planning: you chose to refine the plan first");
    const handoff = page.locator(".handoff:not(.kept)");
    await expect(handoff).toHaveText("Plan approved@plan@build.opencode/plans/debounce.md");
    // The note OpenCode adds for build isn't shown as an empty message.
    await expect(page.locator(".msg.user.hidden")).toHaveCount(1);
    await handoff.locator(".plan-file").click();
    expect((await sent(page, "openFile")).at(-1)).toEqual({ type: "openFile", path: ".opencode/plans/debounce.md" });
  });
});

test.describe("web", () => {
  test("search results are links, opened once in the browser", async ({ page }) => {
    await open(page, "tools");
    const search = await step(page, "Web search");
    await expect(search.locator(".tool-sub")).toHaveText("2 results");
    await expect(search.locator(".result .domain")).toHaveText(["github.com", "code.visualstudio.com"]);
    await search.locator(".result a").first().click();
    expect(await sent(page, "openExternal")).toEqual([{ type: "openExternal", url: "https://github.com/microsoft/vscode/issues/125993" }]);
  });

  test("a fetched page previews as markdown, its links resolved against the page", async ({ page }) => {
    await open(page, "tools");
    const fetch = await step(page, "Fetch");
    await expect(fetch.locator(".tool-arg")).toHaveText("code.visualstudio.com/api/extension-guides/webview");
    const preview = fetch.locator(".page-preview .markdown");
    await expect(preview).toHaveClass(/report-preview/);
    await expect(preview.locator("a", { hasText: "message passing" })).toHaveAttribute("href", "https://code.visualstudio.com/api/references/vscode-api#Webview");
    await expect(preview.locator("img")).toHaveAttribute("src", "https://code.visualstudio.com/assets/api/webview.png");
    // A page's words aren't taken for workspace files.
    await expect(preview.locator(".file-ref")).toHaveCount(0);
    await fetch.getByText("Show page").click();
    await expect(fetch.locator(".page-preview .markdown")).not.toHaveClass(/report-preview/);
    await fetch.getByText("Open in browser").click();
    expect((await sent(page, "openExternal")).at(-1)).toEqual({ type: "openExternal", url: "https://code.visualstudio.com/api/extension-guides/webview" });
  });
});

test.describe("bad tool calls", () => {
  test("name the tool the model meant, as a warning", async ({ page }) => {
    await open(page, "tools");
    const rows = page.locator(".tool-row.warn");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator(".tool-name s")).toHaveText("read_file");
    await expect(rows.nth(0).locator(".tool-sub")).toHaveText("No such tool; the model was told and can try again");
    await expect(rows.nth(1).locator(".tool-name")).toHaveText("Edit");
    await expect(rows.nth(1).locator(".tool-sub")).toHaveText("Invalid arguments: oldString is required");
  });
});
