import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { applyPatch, createPatch, parsePatch, reversePatch } from "diff";
import { OpencodeServer, OpencodeEvent } from "./server";
import { DiffContentProvider } from "./diffProvider";

const exec = promisify(execFile);

export interface Mention {
  path: string; // workspace-relative
  startLine?: number;
  endLine?: number;
}

interface SendRequest {
  text: string;
  mentions: Mention[];
  images: { dataUrl: string; mime: string; name: string }[];
  includeSelection: boolean;
  model?: { providerID: string; modelID: string };
  agent: string;
  autoEdit: boolean;
}

interface Worktree {
  name: string;
  branch?: string;
  directory: string;
}

/** One conversation tab. A tab without a sessionID is a draft that has not been sent yet. */
interface Tab {
  key: string;
  sessionID?: string;
  title: string;
  status: "idle" | "busy" | "attention";
  directory: string;
  worktree?: Worktree;
  children: Set<string>;
}

export interface ChatStatus {
  busy: boolean;
  attention: boolean;
  agent: string;
  model?: string;
}

/** What a controller needs from whoever hosts its webview. */
export interface ChatHost {
  setTitle(title: string): void;
  showLogs(): void;
  isVisible(): boolean;
  reveal(): void;
  reportStatus(status: ChatStatus): void;
  openSettings(): void;
}

/** Session permission rules. Shell commands always ask; edits ask unless auto-approved. */
function rulesFor(autoEdit: boolean) {
  return [
    { permission: "edit", pattern: "*", action: autoEdit ? "allow" : "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
  ];
}

let tabCounter = 0;

/** Connects one webview (side bar or editor tab) to a set of OpenCode conversation tabs. */
export class ChatController implements vscode.Disposable {
  private tabs: Tab[] = [];
  private activeKey = "";
  private autoEdit: boolean;
  private agent = "build";
  private model: string | undefined;
  private disposables: vscode.Disposable[] = [];
  private selectionTimer: NodeJS.Timeout | undefined;
  private diffTimer: NodeJS.Timeout | undefined;
  private lastEditor: vscode.TextEditor | undefined;
  private ready = false;
  private pendingPrompts: SendRequest[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly server: OpencodeServer,
    private readonly extensionUri: vscode.Uri,
    private readonly diffs: DiffContentProvider,
    private readonly host: ChatHost,
  ) {
    this.autoEdit = vscode.workspace.getConfiguration("opencode").get<boolean>("autoApproveEdits") ?? false;
    this.addTab();
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist"), vscode.Uri.joinPath(extensionUri, "media")],
    };
    webview.html = this.html();
    this.disposables.push(
      webview.onDidReceiveMessage((msg) => this.handle(msg).catch((err) => this.error(err))),
      server.onEvent((e) => this.onEvent(e)),
      server.onStatus((s) => this.post({ type: "serverStatus", status: s })),
      vscode.window.onDidChangeTextEditorSelection(() => this.queueSelection()),
      vscode.window.onDidChangeActiveTextEditor(() => this.queueSelection()),
    );
  }

  // -------------------------------------------------------------------- tabs

  private get tab(): Tab {
    return this.tabs.find((t) => t.key === this.activeKey) ?? this.tabs[0];
  }

  private get sessionID() {
    return this.tab?.sessionID;
  }

  /** Directory of the active tab: the workspace, or a worktree. */
  private get dir() {
    return this.tab?.directory ?? this.server.directory;
  }

  private addTab(init: Partial<Tab> = {}): Tab {
    const tab: Tab = {
      key: `t${++tabCounter}`,
      title: "New conversation",
      status: "idle",
      directory: this.server.directory,
      children: new Set(),
      ...init,
    };
    this.tabs.push(tab);
    this.activeKey = tab.key;
    return tab;
  }

  private sendTabs() {
    this.post({
      type: "tabs",
      active: this.activeKey,
      tabs: this.tabs.map((t) => ({
        key: t.key,
        title: t.title,
        status: t.status,
        worktree: t.worktree ? { name: t.worktree.name, branch: t.worktree.branch } : undefined,
      })),
    });
    this.host.setTitle(this.tab.sessionID ? this.tab.title : "OpenCode");
    this.reportStatus();
  }

  private reportStatus() {
    this.host.reportStatus({
      busy: this.tabs.some((t) => t.status === "busy"),
      attention: this.tabs.some((t) => t.status === "attention"),
      agent: this.agent,
      model: this.model,
    });
  }

  /** Request scoped to the active tab's directory. */
  private req<T = any>(method: string, p: string, body?: unknown, query: Record<string, any> = {}, dir = this.dir) {
    return this.server.request<T>(method, p, body, { ...query, directory: dir });
  }

  private post(msg: any) {
    this.webview.postMessage(msg);
  }

  private error(err: any) {
    this.post({ type: "error", message: String(err?.message ?? err) });
  }

  focus() {
    this.post({ type: "focus" });
  }

  insertMention(m: Mention) {
    this.post({ type: "insertMention", mention: m });
  }

  /** Send a prompt from outside the webview (code actions, editor context menu). */
  sendPrompt(text: string, mentions: Mention[]) {
    const req: SendRequest = {
      text,
      mentions,
      images: [],
      includeSelection: false,
      agent: this.agent,
      autoEdit: this.autoEdit,
    };
    if (!this.ready) {
      this.pendingPrompts.push(req);
      return;
    }
    this.post({ type: "externalPrompt", text, mentions });
  }

  newSession(worktree?: Worktree) {
    const empty = !worktree && !this.tab.sessionID ? this.tab : undefined;
    if (empty) this.activeKey = empty.key;
    else this.addTab(worktree ? { directory: worktree.directory, worktree, title: `Worktree ${worktree.name}` } : {});
    this.post({ type: "session", session: null, messages: [], worktree: this.tab.worktree });
    this.post({ type: "event", event: { type: "session.diff", properties: { diff: [] } } });
    this.sendTabs();
    this.sendSelection();
  }

  // ---------------------------------------------------------------- selection

  private queueSelection() {
    clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => this.sendSelection(), 150);
  }

  private sendSelection() {
    const editor = vscode.window.activeTextEditor ?? this.lastEditor;
    if (editor && editor.document.uri.scheme === "file") this.lastEditor = editor;
    if (!editor || editor.document.uri.scheme !== "file") {
      this.post({ type: "selection", selection: null });
      return;
    }
    const rel = this.relative(editor.document.uri.fsPath);
    const sel = editor.selection;
    const hasSel = !sel.isEmpty;
    this.post({
      type: "selection",
      selection: {
        path: rel,
        startLine: hasSel ? sel.start.line + 1 : undefined,
        endLine: hasSel ? (sel.end.character === 0 ? sel.end.line : sel.end.line + 1) : undefined,
      },
    });
  }

  /** Path relative to the workspace (editor paths always refer to the main workspace). */
  private relative(fsPath: string) {
    const rel = path.relative(this.server.directory, fsPath);
    return rel.startsWith("..") ? fsPath : rel;
  }

  /** Absolute path in the active tab's directory. */
  private absolute(p: string) {
    return path.isAbsolute(p) ? p : path.join(this.dir, p);
  }

  // ------------------------------------------------------------------ webview

  private async handle(msg: any): Promise<void> {
    switch (msg.type) {
      case "ready":
        return this.init();
      case "send":
        return this.send(msg as SendRequest);
      case "editResend":
        return this.editResend(msg.messageID, msg as SendRequest);
      case "abort":
        if (this.sessionID) await this.req("POST", `/session/${this.sessionID}/abort`);
        return;
      case "status":
        this.agent = msg.agent;
        this.model = msg.model;
        this.reportStatus();
        return;
      case "newSession":
        return this.newSession();
      case "switchTab":
        return this.switchTab(msg.key);
      case "closeTab":
        return this.closeTab(msg.key);
      case "listSessions": {
        const sessions = await this.server.request<any[]>("GET", "/session", undefined, { roots: "true", limit: 50 });
        this.post({
          type: "sessions",
          sessions: sessions
            .filter((s) => !s.parentID && !s.time?.archived)
            .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)),
        });
        return;
      }
      case "loadSession":
        return this.openSession(msg.id);
      case "deleteSession": {
        await this.server.request("DELETE", `/session/${msg.id}`);
        const open = this.tabs.find((t) => t.sessionID === msg.id);
        if (open) await this.closeTab(open.key);
        return this.handle({ type: "listSessions" });
      }
      case "setAutoEdit":
        this.autoEdit = !!msg.autoEdit;
        if (this.sessionID) await this.req("PATCH", `/session/${this.sessionID}`, { permission: rulesFor(this.autoEdit) });
        return;
      case "permissionReply":
        await this.req("POST", `/permission/${msg.id}/reply`, { reply: msg.reply, message: msg.message || undefined });
        this.clearAttention();
        return;
      case "questionReply":
        await this.req("POST", `/question/${msg.id}/reply`, { answers: msg.answers });
        this.clearAttention();
        return;
      case "questionReject":
        await this.req("POST", `/question/${msg.id}/reject`);
        this.clearAttention();
        return;
      case "searchFiles": {
        const results = await this.searchFiles(msg.query);
        this.post({ type: "fileResults", query: msg.query, files: results });
        return;
      }
      case "openFile":
        return this.openFile(msg.path, msg.line);
      case "openDiff":
        return this.openDiff(msg.filePath, msg.diff, msg.before, msg.after);
      case "revert":
        return this.revert(msg.messageID);
      case "unrevert": {
        if (!this.sessionID) return;
        const session = await this.req<any>("POST", `/session/${this.sessionID}/unrevert`);
        this.post({ type: "event", event: { type: "session.updated", properties: { info: session } } });
        return this.sendDiff();
      }
      case "discardFile":
        return this.discardFile(msg.file, msg.patch, msg.status);
      case "compact":
        if (!this.sessionID || !msg.model) return;
        await this.req("POST", `/session/${this.sessionID}/summarize`, msg.model);
        return;
      case "share":
        return this.share();
      case "unshare":
        if (!this.sessionID) return;
        await this.req("DELETE", `/session/${this.sessionID}/share`);
        vscode.window.showInformationMessage("Conversation is no longer shared.");
        return;
      case "newWorktree":
        return this.newWorktree();
      case "applyWorktree":
        return this.applyWorktree();
      case "discardWorktree":
        return this.discardWorktree();
      case "loadChild":
        return this.loadChild(msg.sessionID);
      case "openSettings":
        this.host.openSettings();
        return;
      case "showLogs":
        this.host.showLogs();
        return;
    }
  }

  private async init() {
    this.post({ type: "serverStatus", status: "starting" });
    try {
      await this.server.start();
    } catch (err) {
      this.error(err);
      this.post({ type: "serverStatus", status: "error" });
      return;
    }
    const [providers, agents, commands] = await Promise.all([
      this.server.request<any>("GET", "/config/providers"),
      this.server.request<any[]>("GET", "/agent"),
      this.server.request<any[]>("GET", "/command"),
    ]);
    const models: { providerID: string; providerName: string; modelID: string; name: string; context?: number }[] = [];
    for (const p of providers.providers ?? []) {
      for (const [id, m] of Object.entries<any>(p.models ?? {})) {
        models.push({
          providerID: p.id,
          providerName: p.name ?? p.id,
          modelID: id,
          name: m.name ?? id,
          context: m.limit?.context || undefined,
        });
      }
    }
    let defaultModel: { providerID: string; modelID: string } | undefined;
    const configured = vscode.workspace.getConfiguration("opencode").get<string>("model");
    const cfgModel = configured || (await this.server.request<any>("GET", "/config")).model;
    if (cfgModel && cfgModel.includes("/")) {
      const [providerID, ...rest] = cfgModel.split("/");
      defaultModel = { providerID, modelID: rest.join("/") };
    } else {
      const entry = Object.entries<string>(providers.default ?? {})[0];
      if (entry) defaultModel = { providerID: entry[0], modelID: entry[1] };
    }
    this.post({
      type: "init",
      autoEdit: this.autoEdit,
      models,
      defaultModel,
      agents: agents.filter((a) => a.mode !== "subagent" && !a.hidden).map((a) => a.name),
      agentColors: Object.fromEntries(agents.filter((a) => a.color).map((a) => [a.name, a.color])),
      commands: commands.map((c) => ({ name: c.name, description: c.description ?? "" })),
      cwd: this.server.directory,
    });
    this.sendSelection();
    this.sendTabs();
    if (this.sessionID) await this.loadSession(this.sessionID);
    this.ready = true;
    for (const p of this.pendingPrompts.splice(0)) this.post({ type: "externalPrompt", text: p.text, mentions: p.mentions });
  }

  private async switchTab(key: string) {
    const tab = this.tabs.find((t) => t.key === key);
    if (!tab) return;
    this.activeKey = key;
    if (tab.status === "attention") tab.status = "idle";
    if (tab.sessionID) await this.loadSession(tab.sessionID);
    else this.post({ type: "session", session: null, messages: [], worktree: tab.worktree });
    this.sendTabs();
  }

  private async closeTab(key: string) {
    const idx = this.tabs.findIndex((t) => t.key === key);
    if (idx < 0) return;
    this.tabs.splice(idx, 1);
    if (!this.tabs.length) this.addTab();
    if (key === this.activeKey || !this.tabs.some((t) => t.key === this.activeKey)) {
      return this.switchTab(this.tabs[Math.min(idx, this.tabs.length - 1)].key);
    }
    this.sendTabs();
  }

  /** Open a past session: switch to its tab, reuse an empty tab, or add a new one. */
  private async openSession(id: string) {
    const existing = this.tabs.find((t) => t.sessionID === id);
    if (existing) return this.switchTab(existing.key);
    if (this.tab.sessionID) this.addTab();
    const session = await this.server.request<any>("GET", `/session/${id}`);
    this.tab.sessionID = id;
    this.tab.directory = session.directory || this.server.directory;
    this.tab.title = session.title || "Conversation";
    await this.loadSession(id);
    this.sendTabs();
  }

  private async ensureSession(): Promise<string> {
    const tab = this.tab;
    if (tab.sessionID) return tab.sessionID;
    const session = await this.req<any>("POST", "/session", { permission: rulesFor(this.autoEdit) });
    tab.sessionID = session.id;
    tab.children.clear();
    this.post({ type: "session", session, messages: [], worktree: tab.worktree });
    this.sendTabs();
    return session.id;
  }

  private async loadSession(id: string) {
    const tab = this.tab;
    const [session, messages] = await Promise.all([
      this.req<any>("GET", `/session/${id}`),
      this.req<any[]>("GET", `/session/${id}/message`),
    ]);
    if (tab.sessionID !== id) return;
    tab.title = session.title || tab.title;
    this.post({ type: "session", session, messages, worktree: tab.worktree });
    // Subagent sessions started by task steps.
    for (const m of messages) {
      for (const p of m.parts) {
        const child = p.type === "tool" && p.tool === "task" ? p.state?.metadata?.sessionId : undefined;
        if (child) tab.children.add(child);
      }
    }
    await this.sendDiff();
    // Re-surface anything still waiting for an answer.
    const [perms, questions] = await Promise.all([
      this.req<any[]>("GET", "/permission").catch(() => []),
      this.req<any[]>("GET", "/question").catch(() => []),
    ]);
    const mine = (sid: string) => sid === id || tab.children.has(sid);
    for (const p of perms) if (mine(p.sessionID)) this.post({ type: "event", event: { type: "permission.asked", properties: p } });
    for (const q of questions) if (mine(q.sessionID)) this.post({ type: "event", event: { type: "question.asked", properties: q } });
    await this.req("PATCH", `/session/${id}`, { permission: rulesFor(this.autoEdit) }).catch(() => undefined);
  }

  /** Messages of a subagent session, for the nested view under a task step. */
  private async loadChild(sessionID: string) {
    this.tab.children.add(sessionID);
    const messages = await this.req<any[]>("GET", `/session/${sessionID}/message`).catch(() => []);
    const parts = messages.flatMap((m: any) => m.parts.filter((p: any) => p.type === "tool"));
    this.post({ type: "childParts", sessionID, parts });
  }

  private async send(req: SendRequest) {
    const text = req.text.trim();
    const slash = text.match(/^\/(\S+)\s*([\s\S]*)$/);
    const sessionID = await this.ensureSession();
    const agent = req.agent || "build";

    const fileParts: any[] = [];
    for (const m of req.mentions) {
      const abs = this.absolute(m.path);
      let url = vscode.Uri.file(abs).toString();
      if (m.startLine) url += `?start=${m.startLine}&end=${m.endLine ?? m.startLine}`;
      let mime = "text/plain";
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(abs));
        if (stat.type & vscode.FileType.Directory) mime = "application/x-directory";
      } catch {
        // ignore; opencode will report the missing file
      }
      fileParts.push({ type: "file", mime, url, filename: path.basename(m.path) });
    }
    for (const img of req.images) {
      fileParts.push({ type: "file", mime: img.mime, url: img.dataUrl, filename: img.name });
    }

    if (slash) {
      const commands = await this.server.request<any[]>("GET", "/command");
      if (commands.some((c) => c.name === slash[1])) {
        await this.req("POST", `/session/${sessionID}/command`, {
          command: slash[1],
          arguments: slash[2] ?? "",
          agent,
          model: req.model ? `${req.model.providerID}/${req.model.modelID}` : undefined,
          parts: fileParts.filter((p) => !p.url.startsWith("data:")),
        });
        return;
      }
    }

    const parts: any[] = [{ type: "text", text }];
    const selectionPart = req.includeSelection ? this.selectionContext() : undefined;
    if (selectionPart) parts.push(selectionPart);
    parts.push(...fileParts);

    await this.req("POST", `/session/${sessionID}/prompt_async`, { parts, agent, model: req.model });
  }

  private async revert(messageID: string) {
    if (!this.sessionID) return;
    const status = await this.req<any>("GET", "/session/status").catch(() => ({}));
    if (status?.[this.sessionID]?.type === "busy") await this.req("POST", `/session/${this.sessionID}/abort`);
    const session = await this.req<any>("POST", `/session/${this.sessionID}/revert`, { messageID });
    this.post({ type: "event", event: { type: "session.updated", properties: { info: session } } });
    await this.sendDiff();
  }

  /** Undo back to an earlier message, then send its edited text in its place. */
  private async editResend(messageID: string, req: SendRequest) {
    await this.revert(messageID);
    await this.send(req);
  }

  private async share() {
    if (!this.sessionID) {
      vscode.window.showInformationMessage("Send a message first; there's nothing to share yet.");
      return;
    }
    const current = await this.req<any>("GET", `/session/${this.sessionID}`);
    let url: string | undefined = current.share?.url;
    if (!url) {
      const ok = await vscode.window.showWarningMessage(
        "Create a public link to this conversation? Anyone with the link can read it, including code and file contents it contains.",
        { modal: true },
        "Create link",
      );
      if (ok !== "Create link") return;
      url = (await this.req<any>("POST", `/session/${this.sessionID}/share`)).share?.url;
    }
    if (!url) throw new Error("OpenCode didn't return a share link.");
    await vscode.env.clipboard.writeText(url);
    const pick = await vscode.window.showInformationMessage(`Share link copied: ${url}`, "Open", "Stop sharing");
    if (pick === "Open") vscode.env.openExternal(vscode.Uri.parse(url));
    if (pick === "Stop sharing") await this.handle({ type: "unshare" });
  }

  // -------------------------------------------------------------- worktrees

  private async newWorktree() {
    const name = await vscode.window.showInputBox({
      title: "New conversation in a worktree",
      prompt: "OpenCode works on a separate git worktree and branch. Your files stay untouched until you apply the changes.",
      placeHolder: "Short name, e.g. refactor-auth",
      validateInput: (v) => (/^[\w.-]*$/.test(v) ? undefined : "Use letters, numbers, dots, dashes or underscores"),
    });
    if (name === undefined) return;
    const wt = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Creating worktree…" },
      () => this.server.request<Worktree>("POST", "/experimental/worktree", name ? { name } : {}),
    );
    this.newSession(wt);
  }

  private async git(cwd: string, args: string[], input?: string) {
    if (input !== undefined) {
      return new Promise<string>((resolve, reject) => {
        const child = execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
          err ? reject(new Error(stderr || err.message)) : resolve(stdout),
        );
        child.stdin?.end(input);
      });
    }
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  /** Copy everything the worktree changed (committed or not) into the main workspace as uncommitted changes. */
  private async applyWorktree() {
    const wt = this.tab.worktree;
    if (!wt) return;
    const main = this.server.directory;
    const mainHead = (await this.git(main, ["rev-parse", "HEAD"])).trim();
    const base = (await this.git(wt.directory, ["merge-base", "HEAD", mainHead])).trim();
    await this.git(wt.directory, ["add", "-A"]);
    const patch = await this.git(wt.directory, ["diff", "--cached", "--binary", base]);
    if (!patch.trim()) {
      vscode.window.showInformationMessage("The worktree has no changes to apply.");
      return;
    }
    const files = patch.match(/^diff --git /gm)?.length ?? 0;
    const ok = await vscode.window.showWarningMessage(
      `Apply ${files} changed file${files === 1 ? "" : "s"} from worktree "${wt.name}" to your workspace? They'll show up as uncommitted changes.`,
      { modal: true },
      "Apply",
    );
    if (ok !== "Apply") return;
    try {
      await this.git(main, ["apply", "--3way", "--whitespace=nowarn"], patch);
    } catch (err: any) {
      throw new Error(`Couldn't apply the worktree's changes cleanly: ${err.message}`);
    }
    const next = await vscode.window.showInformationMessage(
      `Applied ${files} file${files === 1 ? "" : "s"} to your workspace.`,
      "Remove worktree",
      "Keep it",
    );
    if (next === "Remove worktree") await this.discardWorktree(true);
  }

  private async discardWorktree(skipConfirm = false) {
    const tab = this.tab;
    const wt = tab.worktree;
    if (!wt) return;
    if (!skipConfirm) {
      const ok = await vscode.window.showWarningMessage(
        `Remove worktree "${wt.name}" and its branch? Changes in it that you haven't applied will be lost.`,
        { modal: true },
        "Remove",
      );
      if (ok !== "Remove") return;
    }
    if (tab.sessionID) await this.req("POST", `/session/${tab.sessionID}/abort`).catch(() => undefined);
    await this.server.request("DELETE", "/experimental/worktree", { directory: wt.directory });
    await this.closeTab(tab.key);
  }

  // ------------------------------------------------------------------ files

  private async openFile(p: string, line?: number) {
    let uri = vscode.Uri.file(this.absolute(p));
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      // A bare file name or a path relative to somewhere else: find it in the workspace.
      const found = await vscode.workspace.findFiles(`**/${p.replace(/^\.?\//, "")}`, "**/node_modules/**", 1);
      const byName = found.length ? found : await vscode.workspace.findFiles(`**/${path.basename(p)}`, "**/node_modules/**", 1);
      if (!byName.length) {
        vscode.window.showWarningMessage(`Couldn't find ${p} in the workspace.`);
        return;
      }
      uri = byName[0];
    }
    const l = Math.max(0, (line ?? 1) - 1);
    await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.One,
      selection: new vscode.Range(l, 0, l, 0),
      preview: true,
    });
  }

  /** The active editor's selection, attached as hidden context. */
  private selectionContext() {
    const editor = vscode.window.activeTextEditor ?? this.lastEditor;
    if (!editor || editor.document.uri.scheme !== "file") return undefined;
    const rel = this.relative(editor.document.uri.fsPath);
    const sel = editor.selection;
    if (sel.isEmpty) {
      return {
        type: "text",
        synthetic: true,
        text: `[Editor context] The user currently has ${rel} open in VS Code. It may or may not be relevant.`,
      };
    }
    const content = editor.document.getText(sel);
    return {
      type: "text",
      synthetic: true,
      text:
        `[Editor context] The user has lines ${sel.start.line + 1}-${sel.end.line + 1} of ${rel} selected in VS Code:\n` +
        "```\n" +
        content +
        "\n```\nIt may or may not be relevant to the request.",
    };
  }

  private async searchFiles(query: string) {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (p: string) => {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    };
    // Open editors first.
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as any;
        if (input?.uri?.scheme === "file") {
          const rel = this.relative(input.uri.fsPath);
          if (!query || rel.toLowerCase().includes(query.toLowerCase())) add(rel);
        }
      }
    }
    if (query) {
      try {
        const found = await this.req<string[]>("GET", "/find/file", undefined, { query, dirs: "true", limit: 30 });
        for (const f of found) add(f);
      } catch {
        // fall back to VS Code search below
      }
      if (out.length < 5) {
        const uris = await vscode.workspace.findFiles(`**/*${query}*`, "**/node_modules/**", 20);
        for (const u of uris) add(this.relative(u.fsPath));
      }
    }
    return out.slice(0, 30);
  }

  private queueDiff() {
    clearTimeout(this.diffTimer);
    this.diffTimer = setTimeout(() => this.sendDiff().catch(() => undefined), 300);
  }

  /**
   * Cumulative changes for the session. Each user message records the per-file patches of its
   * turn; walking them backwards from the current file contents recovers each file's original.
   * Turns that have been undone are skipped.
   */
  private async sendDiff() {
    const sessionID = this.sessionID;
    if (!sessionID) return;
    const [session, messages] = await Promise.all([
      this.req<any>("GET", `/session/${sessionID}`),
      this.req<any[]>("GET", `/session/${sessionID}/message`),
    ]);
    const revertID: string | undefined = session.revert?.messageID;
    const perFile = new Map<string, { patch: string; status?: string }[]>();
    for (const m of messages) {
      if (m.info.role !== "user" || (revertID && m.info.id >= revertID)) continue;
      for (const d of m.info.summary?.diffs ?? []) {
        if (!d.file || !d.patch) continue;
        if (!perFile.has(d.file)) perFile.set(d.file, []);
        perFile.get(d.file)!.push({ patch: d.patch, status: d.status });
      }
    }
    const diff: { file: string; patch: string; additions: number; deletions: number; status: string }[] = [];
    for (const [file, turns] of perFile) {
      const uri = vscode.Uri.file(this.absolute(file));
      let exists = true;
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        exists = false;
      }
      const current = exists ? await this.readText(uri) : "";
      let original: string | false = current;
      for (const t of [...turns].reverse()) {
        original = original === false ? false : this.unapply(original, t.patch);
      }
      const created = turns[0].status === "added";
      if (original === false) {
        // File changed outside OpenCode since; fall back to the latest turn's patch.
        const last = turns[turns.length - 1];
        diff.push({ file, patch: last.patch, status: last.status ?? "modified", ...this.countLines(last.patch) });
        continue;
      }
      if (original === current && exists) continue;
      const patch = createPatch(file, created ? "" : original, current);
      const status = created ? "added" : !exists ? "deleted" : "modified";
      diff.push({ file, patch, status, ...this.countLines(patch) });
    }
    if (sessionID !== this.sessionID) return;
    this.post({ type: "event", event: { type: "session.diff", properties: { sessionID, diff } } });
  }

  private countLines(patch: string) {
    let additions = 0;
    let deletions = 0;
    for (const hunk of parsePatch(patch)[0]?.hunks ?? []) {
      for (const l of hunk.lines) {
        if (l[0] === "+") additions++;
        else if (l[0] === "-") deletions++;
      }
    }
    return { additions, deletions };
  }

  private async readText(uri: vscode.Uri) {
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      return "";
    }
  }

  /** Content of a file before an already-applied patch. */
  private unapply(current: string, diffText: string): string | false {
    const [patch] = parsePatch(diffText);
    if (!patch) return false;
    return applyPatch(current, reversePatch(patch));
  }

  private async openDiff(filePath: string, diffText?: string, before?: string, after?: string) {
    const abs = this.absolute(filePath);
    const uri = vscode.Uri.file(abs);
    const name = path.basename(abs);
    const show = async (left: vscode.Uri, right: vscode.Uri, title: string) => {
      await vscode.commands.executeCommand("vscode.diff", left, right, title, {
        viewColumn: vscode.ViewColumn.One,
        preview: true,
      });
    };
    if (before !== undefined && after !== undefined) {
      return show(this.diffs.register(`${name} (before)`, before), this.diffs.register(`${name} (after)`, after), `${name} (OpenCode)`);
    }
    if (!diffText) {
      await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One });
      return;
    }
    const current = await this.readText(uri);
    // Not yet applied (a pending permission): show current vs proposed.
    const proposed = applyPatch(current, diffText);
    if (proposed !== false && proposed !== current) {
      return show(uri, this.diffs.register(`${name} (proposed)`, proposed), `${name} ↔ proposed`);
    }
    // Already applied: show original vs the live, editable file.
    const original = this.unapply(current, diffText);
    if (original !== false) {
      return show(this.diffs.register(`${name} (before)`, original), uri, `${name} (changes by OpenCode)`);
    }
    await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One });
  }

  /** Throw away OpenCode's changes to one file, after confirming. */
  private async discardFile(file: string, diffText: string, status?: string) {
    const abs = this.absolute(file);
    const uri = vscode.Uri.file(abs);
    const choice = await vscode.window.showWarningMessage(
      status === "added" ? `Delete ${file}? OpenCode created it.` : `Discard OpenCode's changes to ${file}?`,
      { modal: true },
      "Discard",
    );
    if (choice !== "Discard") return;
    if (status === "added") {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } else {
      const original = this.unapply(await this.readText(uri), diffText);
      if (original === false) {
        vscode.window.showErrorMessage(`Couldn't discard changes to ${file}: it has changed since OpenCode edited it.`);
        return;
      }
      await vscode.workspace.fs.writeFile(uri, Buffer.from(original, "utf8"));
    }
    await this.sendDiff();
  }

  // ------------------------------------------------------------------- events

  private tabFor(sessionID: string | undefined) {
    if (!sessionID) return undefined;
    return this.tabs.find((t) => t.sessionID === sessionID || t.children.has(sessionID));
  }

  private clearAttention() {
    if (this.tab.status === "attention") {
      this.tab.status = "busy";
      this.sendTabs();
    }
  }

  private notify(tab: Tab, kind: "done" | "attention") {
    if (!vscode.workspace.getConfiguration("opencode").get<boolean>("notifications", true)) return;
    const visible = this.host.isVisible() && vscode.window.state.focused && tab.key === this.activeKey;
    if (visible) return;
    const name = tab.sessionID ? `"${tab.title}"` : "OpenCode";
    const show = kind === "attention" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const text = kind === "attention" ? `OpenCode needs your approval in ${name}.` : `OpenCode finished ${name}.`;
    show(text, kind === "attention" ? "Review" : "Show").then((pick) => {
      if (!pick) return;
      this.host.reveal();
      this.switchTab(tab.key);
    });
  }

  private onEvent(e: OpencodeEvent) {
    const p = e.properties ?? {};
    if (e.type === "session.created" && p.info?.parentID) {
      const parentTab = this.tabFor(p.info.parentID);
      if (parentTab) parentTab.children.add(p.info.id);
      return;
    }
    const sid: string | undefined = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? p.info?.id;
    const tab = this.tabFor(sid);
    if (!tab) return;
    const isMain = sid === tab.sessionID;
    const active = tab.key === this.activeKey;

    // Tab status, titles and notifications for every tab, active or not.
    if (isMain && e.type === "session.updated" && p.info?.title && p.info.title !== tab.title) {
      tab.title = p.info.title;
      this.sendTabs();
    }
    if (isMain && e.type === "session.status") {
      const busy = p.status?.type !== "idle";
      const was = tab.status;
      if (busy && was === "idle") tab.status = "busy";
      if (!busy && was !== "idle") {
        tab.status = "idle";
        this.notify(tab, "done");
      }
      if (tab.status !== was) this.sendTabs();
    }
    if (e.type === "permission.asked" || e.type === "question.asked") {
      tab.status = "attention";
      this.sendTabs();
      this.notify(tab, "attention");
    }

    if (!active) return;
    // OpenCode's own diff events are per turn; recompute the session-wide view instead.
    if (isMain && (e.type === "session.diff" || e.type === "session.idle")) {
      this.queueDiff();
      if (e.type === "session.diff") return;
    }
    if (!isMain) {
      // Subagent sessions: stream their tool steps into the nested view; surface their prompts.
      if (e.type === "message.part.updated" && p.part?.type === "tool") {
        this.post({ type: "childParts", sessionID: sid, parts: [p.part] });
        return;
      }
      if (!e.type.startsWith("permission.") && !e.type.startsWith("question.")) return;
    }
    this.post({ type: "event", event: e });
  }

  // --------------------------------------------------------------------- html

  private html() {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const script = this.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
    const style = this.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${this.webview.cspSource} 'unsafe-inline'`,
      `img-src ${this.webview.cspSource} data: https:`,
      `font-src ${this.webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>OpenCode</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose() {
    clearTimeout(this.selectionTimer);
    clearTimeout(this.diffTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}
