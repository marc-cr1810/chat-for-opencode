import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import { ListenUrlWatcher, SseParser, unwrapGlobalEvent } from "./streams";

export interface OpencodeEvent {
  type: string;
  properties: any;
  /** Directory of the OpenCode instance that emitted it (worktrees have their own). */
  directory?: string;
}

/**
 * Owns one `opencode serve` process for the window and exposes its HTTP API
 * plus the `/event` server-sent-event stream.
 */
export class OpencodeServer implements vscode.Disposable {
  private proc: ChildProcess | undefined;
  private baseUrl: string | undefined;
  private starting: Promise<string> | undefined;
  private eventAbort: AbortController | undefined;
  private readonly emitter = new vscode.EventEmitter<OpencodeEvent>();
  readonly onEvent = this.emitter.event;
  private readonly statusEmitter = new vscode.EventEmitter<"starting" | "ready" | "stopped" | "error">();
  readonly onStatus = this.statusEmitter.event;

  constructor(private readonly output: vscode.OutputChannel, readonly directory: string) {}

  start(): Promise<string> {
    if (this.baseUrl) return Promise.resolve(this.baseUrl);
    if (!this.starting) {
      this.starting = this.spawnServer().finally(() => (this.starting = undefined));
    }
    return this.starting;
  }

  private spawnServer(): Promise<string> {
    this.statusEmitter.fire("starting");
    const bin = vscode.workspace.getConfiguration("opencode").get<string>("binaryPath") || "opencode";
    this.output.appendLine(`Starting ${bin} serve in ${this.directory}`);
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
        cwd: this.directory,
        env: { ...process.env },
      });
      this.proc = proc;
      const watcher = new ListenUrlWatcher();
      let settled = false;
      const timer = setTimeout(() => fail(new Error("Timed out waiting for opencode serve to start")), 30000);
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.statusEmitter.fire("error");
        reject(err);
      };
      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        this.output.append(text);
        const url = settled ? undefined : watcher.feed(text);
        if (url && this.proc === proc) {
          settled = true;
          clearTimeout(timer);
          this.baseUrl = url;
          this.output.appendLine(`OpenCode server ready at ${this.baseUrl}`);
          this.statusEmitter.fire("ready");
          this.subscribe();
          resolve(this.baseUrl);
        }
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      proc.on("error", (err) =>
        fail(new Error(`Could not run "${bin}": ${err.message}. Set opencode.binaryPath in settings.`)),
      );
      proc.on("exit", (code) => {
        this.output.appendLine(`opencode serve exited with code ${code}`);
        fail(new Error(`opencode serve exited with code ${code}`));
        // A process we already replaced (restart) must not tear down its successor.
        if (this.proc !== proc) return;
        this.baseUrl = undefined;
        this.proc = undefined;
        this.eventAbort?.abort();
        this.statusEmitter.fire("stopped");
      });
    });
  }

  /** Long-lived SSE subscription to every instance's events; reconnects while the server is alive. */
  private async subscribe() {
    this.eventAbort?.abort();
    const abort = new AbortController();
    this.eventAbort = abort;
    while (!abort.signal.aborted && this.baseUrl) {
      try {
        const res = await fetch(this.url("/global/event"), {
          headers: { Accept: "text/event-stream" },
          signal: abort.signal,
        });
        if (!res.body) throw new Error("No event stream body");
        const decoder = new TextDecoder();
        const parser = new SseParser();
        for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
          for (const data of parser.feed(decoder.decode(chunk, { stream: true }))) {
            const event = unwrapGlobalEvent(data);
            if (event) this.emitter.fire(event);
          }
        }
      } catch (err: any) {
        if (abort.signal.aborted) return;
        this.output.appendLine(`Event stream error: ${err?.message ?? err}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private url(path: string, query: Record<string, string | number | undefined> = {}) {
    const u = new URL(this.baseUrl + path);
    u.searchParams.set("directory", this.directory);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    await this.start();
    const res = await fetch(this.url(path, query), {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : (undefined as T);
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  /** Stop the server and wait for the process to exit (SIGKILL after 3s). */
  stop(): Promise<void> {
    this.eventAbort?.abort();
    const proc = this.proc;
    this.proc = undefined;
    this.baseUrl = undefined;
    if (!proc || proc.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const force = setTimeout(() => proc.kill("SIGKILL"), 3000);
      proc.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      proc.kill();
    });
  }

  dispose() {
    this.stop();
    this.emitter.dispose();
    this.statusEmitter.dispose();
  }
}
