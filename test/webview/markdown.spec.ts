import { expect, test } from "@playwright/test";
import { open } from "./harness";

test.describe("markdown", () => {
  test("renders inline and display math, leaving prices and code alone", async ({ page }) => {
    await open(page, "math");
    const answer = page.locator(".text-row .markdown").last();
    // $$…$$ and \[…\] become display blocks; $…$, \(…\) and the inline sum render in place.
    await expect(answer.locator(".math-block .katex-display")).toHaveCount(2);
    await expect(answer.locator(".katex").and(page.locator(":not(.katex-display) > .katex"))).toHaveCount(3);
    await expect(answer.locator(".math-block").first().locator("annotation")).toHaveText(String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`);
    await expect(answer).toContainText("prices like $5 and $10 stay as text");
    await expect(answer.locator("code")).toHaveText("$HOME");
  });
});

test.describe("code blocks", () => {
  test("highlights labelled languages and copies the plain source", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, "code");
    const blocks = page.locator(".text-row .code-block");
    await expect(blocks.locator(".code-head span")).toHaveText(["ts", "python", "diff", ""]);
    await expect(blocks.nth(0).locator(".hljs-keyword", { hasText: "function" })).toHaveCount(1);
    await expect(blocks.nth(0).locator(".hljs-comment")).toContainText("Calls fn once");
    await expect(blocks.nth(1).locator(".hljs-string")).toContainText("Run the wrapped function");
    await expect(blocks.nth(2).locator(".hljs-addition")).toHaveCount(1);
    await expect(blocks.nth(3).locator("code span")).toHaveCount(0);

    await blocks.nth(0).locator(".copy-code").click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("export function debounce<T extends unknown[]>");
    expect(copied).not.toContain("<span");
  });
});

test.describe("markdown extras", () => {
  test("renders alerts, task lists, safe inline HTML and footnotes", async ({ page }) => {
    await open(page, "extras");
    const answer = page.locator(".text-row .markdown").last();
    await expect(answer.locator(".alert .alert-title")).toHaveText(["Note", "Warning"]);
    await expect(answer.locator(".alert-note")).toContainText("not committed yet");
    await expect(answer.locator("li.task")).toHaveCount(4);
    await expect(answer.locator("li.task input:checked")).toHaveCount(2);
    await expect(answer.locator("kbd")).toHaveText(["Ctrl", "Alt", "O"]);
    await expect(answer.locator("sub")).toHaveText("2");
    await expect(answer.locator("mark")).toHaveText("highlighted");
    // Anything outside the safe list stays text, and nothing it says runs.
    await expect(answer.locator("script, img")).toHaveCount(0);
    await expect(answer).toContainText("<script>alert(1)</script> and <img src=x onerror=alert(1)> stay as text");

    const details = answer.locator("details");
    await expect(details.locator("p")).toBeHidden();
    await details.locator("summary").click();
    await expect(details.locator("p")).toBeVisible();

    await expect(answer.locator("sup a[data-footnote-ref]")).toHaveText(["1", "2"]);
    await expect(answer.locator(".footnotes li")).toHaveCount(2);
  });

  test("draws mermaid diagrams under the webview's CSP, keeping the source to copy", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await open(page, "extras");
    const blocks = page.locator(".mermaid-block");
    await expect(blocks).toHaveCount(2);
    await expect(blocks.locator(".mermaid-svg > svg")).toHaveCount(2, { timeout: 10_000 });
    // Drawn diagrams sit in the reply on their own, without the code block around them.
    const first = blocks.first();
    await expect(first.locator(".code-block")).toBeHidden();
    await expect(blocks.nth(1).locator(".mermaid-svg")).toContainText("prompt_async");

    await first.locator(".mermaid-svg").hover();
    await first.locator(".mermaid-tools .copy-code").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^flowchart LR\n/);

    // The toggle swaps between the diagram and its source.
    await first.locator(".mermaid-tools .mermaid-toggle").click();
    await expect(first.locator(".mermaid-svg")).toBeHidden();
    await expect(first.locator("pre")).toContainText("flowchart LR");
    await first.locator(".code-head .mermaid-toggle").click();
    await expect(first.locator(".mermaid-svg")).toBeVisible();
    await expect(first.locator(".code-block")).toBeHidden();
    expect(errors.filter((e) => /Content.Security.Policy/i.test(e))).toEqual([]);
  });
});

test.describe("tool steps", () => {
  test("highlight edit diffs and written files by the file's language", async ({ page }) => {
    await open(page, "changes");
    const diff = page.locator(".diff").first();
    await expect(diff.locator(".diff-line.add .hljs-keyword", { hasText: "import" })).toHaveCount(1);
    await expect(diff.locator(".diff-line.del .hljs-string")).toHaveText('"resize"');
    // A doc comment spanning lines stays a comment on each of them.
    await expect(diff.locator(".diff-line.ctx .hljs-comment")).toHaveCount(3);
    await expect(diff.locator(".diff-line.ctx .ln").first()).toHaveText("1");
    // Text survives highlighting exactly.
    await expect(diff.locator(".diff-line.add .code").last()).toHaveText('window.addEventListener("resize", debounce(() => layout(window.innerWidth), 100));');

    await page.locator(".coll-head", { hasText: "debounce.ts" }).click();
    const written = page.locator("pre.tool-output").first();
    await expect(written.locator(".hljs-comment")).toContainText("Calls fn once");
    await expect(written.locator(".hljs-keyword", { hasText: "export" })).toHaveCount(1);
    await expect(written).toContainText("timer = setTimeout(() => fn(...args), ms);");
  });
});
