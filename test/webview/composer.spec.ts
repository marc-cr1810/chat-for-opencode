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

  test("effort: Default sits apart from the levels, and the pick goes with the prompt", async ({ page }) => {
    await open(page, "empty");
    await page.locator("#modelBtn").click();
    const effort = page.locator(".effort-row");
    await expect(effort).toContainText("Effort (Default)");
    await expect(effort.locator(".effort-chip.on")).toHaveText("Default");
    await expect(effort.locator(".effort-dot")).toHaveCount(3);
    await expect(effort.locator(".effort-dot.on")).toHaveCount(0);
    await effort.locator('.effort-dot[title="high"]').click();
    await expect(effort).toContainText("(high)");
    await expect(page.locator("#menu")).toBeVisible();
    await expect(page.locator("#modelBtn")).toContainText("high");
    expect(await sent(page, "pickVariant")).toEqual([expect.objectContaining({ variant: "high" })]);
    await page.locator("#modelBtn").click();
    await page.locator("#input").fill("Think hard");
    await page.locator("#input").press("Enter");
    expect(await sent(page, "send")).toEqual([expect.objectContaining({ variant: "high" })]);
  });

  test("effort: levels go lowest first, and ←/→ step through them from Default", async ({ page }) => {
    await open(page, "empty");
    await page.locator("#modelBtn").click();
    await page.locator(".menu-item", { hasText: "Flint 40B" }).click();
    await page.locator("#input").fill("/model");
    await page.keyboard.press("Enter");
    const titles = await page.locator(".effort-dot").evaluateAll((els) => els.map((e) => e.getAttribute("title")));
    expect(titles).toEqual(["low", "medium", "high", "xhigh", "max"]);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".effort-row")).toContainText("(low)");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".effort-row")).toContainText("(Default)");
  });

  test("effort: switching models rounds a missing level down, says so, and remembers each model's own", async ({ page }) => {
    await open(page, "empty");
    const pick = async (name: string) => {
      await page.locator("#modelBtn").click();
      await page.locator(".menu-item", { hasText: name }).click();
    };
    await pick("Flint 40B");
    await page.locator("#modelBtn").click();
    await page.locator('.effort-dot[title="medium"]').click();
    await page.locator("#modelBtn").click();

    await pick("Big Pickle");
    await expect(page.locator("#modelBtn")).toContainText("low");
    await expect(page.locator(".toast.show")).toHaveText("Big Pickle has no medium effort — using low.");

    await pick("Flint 40B");
    await expect(page.locator("#modelBtn")).toContainText("medium");

    await pick("Qwen 3.8 27B");
    await page.locator("#modelBtn").click();
    await expect(page.locator(".effort-row")).toHaveCount(0);
    await page.locator("#modelBtn").click();
    await page.locator("#input").fill("Again");
    await page.locator("#input").press("Enter");
    expect((await sent(page, "send"))[0].variant).toBeUndefined();
  });

  test("effort: variants that aren't known levels are plain choices, and a level can't carry onto them", async ({ page }) => {
    await open(page, "empty");
    await page.locator("#modelBtn").click();
    await page.locator('.effort-dot[title="high"]').click();
    await page.locator(".menu-item", { hasText: "Tuned 7B" }).click();
    await expect(page.locator(".toast.show")).toHaveText("Tuned 7B has no high effort — using Default.");
    await page.locator("#modelBtn").click();
    await expect(page.locator(".effort-track")).toHaveCount(0);
    await expect(page.locator(".effort-chip")).toHaveText(["Default", "fast", "thinking"]);
  });

  test("typing with the model menu open closes it, so Enter sends instead of picking a model", async ({ page }) => {
    await open(page, "empty");
    await page.locator("#modelBtn").click();
    await expect(page.locator("#menu")).toBeVisible();
    await page.locator("#input").click();
    await page.keyboard.type("Hello");
    await expect(page.locator("#menu")).toBeHidden();
    await page.keyboard.press("Enter");
    expect(await sent(page, "send")).toEqual([expect.objectContaining({ text: "Hello" })]);
    expect(await sent(page, "pickModel")).toHaveLength(0);
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

  for (const width of [240, 300, 360]) {
    test(`the footer fits a ${width}px side bar without overlapping`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await open(page, "walkthrough");
      const edits = await page.locator("#editsBtn").boundingBox();
      const right = await page.locator(".foot-right").boundingBox();
      expect(edits!.x + edits!.width).toBeLessThanOrEqual(right!.x);
      // The send button stays inside the box, and nothing scrolls sideways.
      const send = await page.locator("#sendBtn").boundingBox();
      const box = await page.locator(".composer").boundingBox();
      expect(send!.x + send!.width).toBeLessThanOrEqual(box!.x + box!.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }
});

test.describe("context meter", () => {
  test("shows how full the context is and warns past the threshold", async ({ page }) => {
    await open(page, "walkthrough", { settings: { contextWarningPercent: 40 } });
    const meter = page.locator("#ctxBtn");
    await expect(meter).toContainText("47%");
    await expect(meter).toHaveClass(/warn/);
  });
});

test.describe("drag and drop", () => {
  /** Fire a drag over the panel and drop it, with whatever the DataTransfer is given. */
  async function drop(page: import("@playwright/test").Page, data: Record<string, string>, files: { name: string; type: string }[] = []) {
    await page.evaluate(
      ([data, files]) => {
        const dt = new DataTransfer();
        for (const [k, v] of Object.entries(data)) dt.setData(k, v);
        for (const f of files) dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], f.name, { type: f.type }));
        const fire = (type: string) => document.querySelector("#messages")!.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
        fire("dragenter");
        fire("dragover");
        (window as any).overlayDuringDrag = !document.querySelector(".drop-overlay")!.classList.contains("hidden");
        fire("drop");
      },
      [data, files] as const,
    );
  }

  test("files from the Explorer go to the extension, with the overlay showing while dragging", async ({ page }) => {
    await open(page, "empty");
    await drop(page, { "application/vnd.code.uri-list": "file:///home/dev/calc/math.py\r\nfile:///home/dev/calc/shot.png" });
    expect(await page.evaluate(() => (window as any).overlayDuringDrag)).toBe(true);
    await expect(page.locator(".drop-overlay")).toBeHidden();
    expect(await sent(page, "dropped")).toEqual([{ type: "dropped", uris: ["file:///home/dev/calc/math.py", "file:///home/dev/calc/shot.png"] }]);
  });

  test("an image dropped without a path is attached directly; other such files explain why not", async ({ page }) => {
    await open(page, "empty");
    await drop(page, {}, [{ name: "shot.png", type: "image/png" }, { name: "notes.txt", type: "text/plain" }]);
    await expect(page.locator("#attachments img")).toHaveCount(1);
    await expect(page.locator(".toast.show")).toContainText("notes.txt");
    expect(await sent(page, "dropped")).toHaveLength(0);
  });

  test("dragging plain text is left to the input", async ({ page }) => {
    await open(page, "empty");
    await drop(page, { "text/plain": "some words" });
    expect(await page.evaluate(() => (window as any).overlayDuringDrag)).toBe(false);
    expect(await sent(page, "dropped")).toHaveLength(0);
  });

  test("images the extension read from dropped files are attached", async ({ page }) => {
    await open(page, "empty");
    await page.evaluate(() =>
      (window as any).harness.post({ type: "addImages", images: [{ dataUrl: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png", name: "shot.png" }] }),
    );
    await expect(page.locator("#attachments img")).toHaveCount(1);
  });
});

test.describe("@ mentions", () => {
  test("subagents show as soon as @ is typed, and picking one inserts @name", async ({ page }) => {
    await open(page, "empty");
    await page.locator("#input").click();
    await page.keyboard.type("@");
    await expect(page.locator("#menu .menu-item").first()).toContainText("explore");
    await page.keyboard.type("gen");
    await expect(page.locator("#menu .menu-item").first()).toContainText("general");
    await page.keyboard.press("Enter");
    await expect(page.locator("#input")).toHaveValue("@general ");
  });

  test("a file with a bare name like the explore agent's is inserted as @./explore, and sent as a file", async ({ page }) => {
    await open(page, "empty");
    await page.locator("#input").click();
    await page.keyboard.type("Run @expl");
    const items = page.locator("#menu .menu-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("agent");
    await items.nth(1).click();
    await expect(page.locator("#input")).toHaveValue("Run @./explore ");
    await page.keyboard.press("Enter");
    expect(await sent(page, "send")).toEqual([expect.objectContaining({ mentions: [{ path: "./explore" }] })]);
  });

  test("the extension's line-range mention for a bare file name gets the ./ too", async ({ page }) => {
    await open(page, "empty");
    await page.evaluate(() => (window as any).harness.post({ type: "insertMention", mention: { path: "explore", startLine: 3, endLine: 9 } }));
    await expect(page.locator("#input")).toHaveValue("@./explore#L3-9 ");
  });

  test("symbols follow files, and picking one asks the extension for its range", async ({ page }) => {
    await open(page, "empty");
    await page.locator("#input").click();
    await page.keyboard.type("Look at @start");
    const symbol = page.locator("#menu .menu-item", { hasText: "OpencodeServer.start" });
    await expect(symbol).toContainText("method · src/server.ts:48");
    await symbol.click();
    await expect(page.locator("#input")).toHaveValue("Look at ");
    expect(await sent(page, "pickSymbol")).toEqual([
      { type: "pickSymbol", symbol: { name: "start", kind: "Method", container: "OpencodeServer", path: "src/server.ts", line: 48 } },
    ]);
    // The extension answers with the definition's lines.
    await page.evaluate(() => (window as any).harness.post({ type: "insertMention", mention: { path: "src/server.ts", startLine: 48, endLine: 90 } }));
    await expect(page.locator("#input")).toHaveValue("Look at @src/server.ts#L48-90 ");
  });
});
