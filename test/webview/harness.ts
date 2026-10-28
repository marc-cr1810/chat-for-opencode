import type { Page } from "@playwright/test";

export interface OpenOptions {
  theme?: "dark" | "light";
  settings?: Record<string, unknown>;
  /** Install Playwright's fake clock first, for anything timed (stall warning, timeout). */
  clock?: boolean;
}

/** Load a harness scene and wait until the webview has rendered it. */
export async function open(page: Page, scene: string, opts: OpenOptions = {}) {
  if (opts.clock) await page.clock.install();
  const q = new URLSearchParams({ scene });
  if (opts.theme) q.set("theme", opts.theme);
  if (opts.settings) q.set("settings", JSON.stringify(opts.settings));
  await page.goto(`/harness/?${q}`);
  await page.waitForFunction(() => (window as any).harness?.ready);
  await page.evaluate(() => (window as any).harness.ready);
  await page.locator("header.header").waitFor();
}

/** Messages the webview has sent to the host, optionally only one type. */
export function sent(page: Page, type?: string): Promise<any[]> {
  return page.evaluate((t) => (window as any).harness.sent.filter((m: any) => !t || m.type === t), type);
}

/** Deliver an OpenCode event, as the extension forwards them. */
export function event(page: Page, type: string, properties: Record<string, unknown>) {
  return page.evaluate(([t, p]) => (window as any).harness.event(t, p), [type, properties] as const);
}

/** The id of the scene's session, for events. */
export function sessionID(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).harness.scene.session.id);
}
