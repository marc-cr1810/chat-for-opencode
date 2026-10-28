import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { applyPatch } from "diff";
import { collectTurns, cumulativeChange, FileChange, unapply } from "./patches";
import { deniedByAgent, isReadOnlyAgent, quietlyReadOnly, Rule, sessionRules } from "./permissions";
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
  /** The model's reasoning variant (low / high / max …); none means the model's default. */
  variant?: string;
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
  busy: boolean;
  /** Permission / question requests waiting for the user. */
  pending: Set<string>;
  directory: string;
  worktree?: Worktree;
  children: Set<string>;
  /** Agent whose rules the session currently carries. */
  agent?: string;
  /** Agent and toggle those rules were written for; the server appends, so skip rewriting the same ones. */
  rulesKey?: string;
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
  /** Workspace storage, used to remember which messages were /commands. */
  memento: vscode.Memento;
}

interface CommandMeta {
  name: string;
  arguments: string;
  sessionID: string;
}

const COMMANDS_KEY = "opencode.commandMessages";
/** The model last picked in any panel, for opencodeChat.rememberLastModel. */
const LAST_MODEL_KEY = "opencode.lastModel";
/** "provider/model" -> the reasoning effort last picked for that model (null: the model's default). */
const VARIANTS_KEY = "opencode.modelVariants";

type ModelRef = { providerID: string; modelID: string; variant?: string };

let tabCounter = 0;
/** Shared across controllers so one event shown in two views notifies only once. */
const recentNotifications = new Map<string, number>();
/** Every live controller, so a notification can check whether any visible panel already shows the session. */
const liveControllers = new Set<ChatController>();

/** IDs of the prompts subagents were given (user messages in their sessions), so their text isn't shown as the subagent's own. */
const childPrompts = new Set<string>();

/** Connects one webview (side bar or editor tab) to a set of OpenCode conversation tabs. */
export class ChatController implements vscode.Disposable {
  private tabs: Tab[] = [];
  private activeKey = "";
  private autoEdit: boolean;
  /** Run read-only shell commands without asking, for read-only agents (plan). */
  private autoRead: boolean;
  private agent = "build";
  /** Each agent's own permission rules, from /agent. */
  private agentRules = new Map<string, Rule[]>();
  private model: string | undefined;
  /** Models OpenCode offers, from the last init. */
  private models: (ModelRef & { variants: string[] })[] = [];
  /** The model picked in this panel, kept so a reloaded webview comes back on it. */
  private pickedModel: ModelRef | undefined;
  private disposables: vscode.Disposable[] = [];
  private selectionTimer: NodeJS.Timeout | undefined;
  private diffTimer: NodeJS.Timeout | undefined;
  private lastEditor: vscode.TextEditor | undefined;
  private ready = false;
  /** The webview has loaded and asked for init at least once. */
  private webviewLoaded = false;
  private initializing: Promise<void> | undefined;
  private pendingPrompts: { text: string; mentions: Mention[] }[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly server: OpencodeServer,
    private readonly extensionUri: vscode.Uri,
    private readonly diffs: DiffContentProvider,
    private readonly host: ChatHost,
  ) {
    this.autoEdit = vscode.workspace.getConfiguration("opencodeChat").get<boolean>("autoApproveEdits") ?? false;
    this.autoRead = vscode.workspace.getConfiguration("opencodeChat").get<boolean>("autoApproveReadOnly") ?? false;
    this.addTab();
    liveControllers.add(this);
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist"), vscode.Uri.joinPath(extensionUri, "media")],
    };
    webview.html = this.html();
    this.disposables.push(
      webview.onDidReceiveMessage((msg) => this.handle(msg).catch((err) => this.error(err))),
      server.onEvent((e) => this.onEvent(e)),
      server.onStatus((s) => {
        this.post({ type: "serverStatus", status: s });
        if (s === "stopped" || s === "error") this.ready = false;
        // A restart (or a recovery after failing to start) needs the agents, models and commands again.
        if (s === "ready" && this.webviewLoaded && !this.initializing) void this.runInit();
      }),
      server.onReconnect(() => void this.resync().catch(() => undefined)),
      vscode.window.onDidChangeTextEditorSelection(() => this.queueSelection()),
      vscode.window.onDidChangeActiveTextEditor(() => this.queueSelection()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("opencodeChat")) return;
        this.sendSettings();
        if (e.affectsConfiguration("opencodeChat.model")) this.applyConfiguredModel();
      }),
    );
  }

  /** Panel behaviour the user can configure; sent on start and whenever the settings change. */
  private sendSettings() {
    const cfg = vscode.workspace.getConfiguration("opencodeChat");
    this.post({
      type: "settings",
      settings: {
        defaultAgent: cfg.get<string>("defaultAgent", ""),
        sendKey: cfg.get<string>("sendKey", "enter"),
        includeSelection: cfg.get<boolean>("includeSelection", true),
        reasoning: cfg.get<string>("reasoning", "collapsed"),
        toolOutput: cfg.get<string>("toolOutput", "auto"),
        contextWarningPercent: cfg.get<number>("contextWarningPercent", 75),
        stallWarningSeconds: cfg.get<number>("stallWarningSeconds", 30),
        responseTimeoutSeconds: cfg.get<number>("responseTimeoutSeconds", 0),
      },
    });
  }

  /** Stop the current run and send the last prompt again, replacing the attempt that stalled. */
  private async retry() {
    const tab = this.tab;
    const sid = tab.sessionID;
    if (!sid) return;
    await this.req("POST", `/session/${sid}/abort`, undefined, {}, tab.directory).catch(() => undefined);
    const messages = await this.req<any[]>("GET", `/session/${sid}/message`, undefined, {}, tab.directory);
    const user = messages.findLast((m: any) => m.info.role === "user" && !m.parts.some((p: any) => p.type === "compaction"));
    if (!user) return;
    const parts = user.parts
      .filter((p: any) => p.type === "text" || p.type === "file")
      .map(({ id, sessionID, messageID, ...rest }: any) => rest);
    const session = await this.req<any>("POST", `/session/${sid}/revert`, { messageID: user.info.id }, {}, tab.directory);
    if (tab === this.tab) this.post({ type: "event", event: { type: "session.updated", properties: { info: session } } });
    const agent = user.info.agent ?? this.agent;
    await this.applyRules(tab, agent);
    // A stored model can carry its variant, which the prompt takes separately.
    const { variant, ...model } = user.info.model ?? {};
    await this.req("POST", `/session/${sid}/prompt_async`, { parts, agent, model: user.info.model && model, variant }, {}, tab.directory);
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
      busy: false,
      pending: new Set(),
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
        sessionID: t.sessionID,
        title: t.title,
        status: this.statusOf(t),
        worktree: t.worktree ? { name: t.worktree.name, branch: t.worktree.branch } : undefined,
      })),
    });
    this.host.setTitle(this.tab.sessionID ? this.tab.title : "Chat for OpenCode");
    this.reportStatus();
  }

  private reportStatus() {
    this.host.reportStatus({
      busy: this.tabs.some((t) => t.busy),
      attention: this.tabs.some((t) => t.pending.size > 0),
      agent: this.agent,
      model: this.model,
    });
  }

  /** Request scoped to the active tab's directory. */
  private req<T = any>(method: string, p: string, body?: unknown, query: Record<string, any> = {}, dir = this.dir) {
    return this.server.request<T>(method, p, body, { ...query, directory: dir });
  }

  /** Put the extension's rules for `agent` on the tab's session, keeping anything the agent denies. */
  private async applyRules(tab: Tab, agent: string) {
    if (!tab.sessionID) return;
    tab.agent = agent;
    const key = this.rulesKey(tab.sessionID, agent);
    if (tab.rulesKey === key) return;
    const permission = this.rulesFor(agent);
    await this.req("PATCH", `/session/${tab.sessionID}`, { permission }, {}, tab.directory);
    tab.rulesKey = key;
  }

  private rulesFor(agent: string) {
    const rules = this.agentRules.get(agent) ?? [];
    return sessionRules(this.autoEdit, rules, this.readOnlyShell(rules));
  }

  /** Read-only shell commands run without asking in either auto mode: plan's auto read-only, or build's auto edits. */
  private readOnlyShell(rules: Rule[]) {
    return isReadOnlyAgent(rules) ? this.autoRead : this.autoEdit;
  }

  /** Answer a request the extension can settle itself: one the agent denies, or a read-only command that only asked over a `2>/dev/null`. */
  private settleItself(tab: Tab, p: any): boolean {
    return this.rejectIfDenied(tab, p) || this.approveIfQuiet(tab, p);
  }

  private approveIfQuiet(tab: Tab, p: any): boolean {
    const rules = tab.agent ? this.agentRules.get(tab.agent) : undefined;
    if (!rules || p.sessionID !== tab.sessionID || p.permission !== "bash" || !this.readOnlyShell(rules)) return false;
    if (!quietlyReadOnly(p.patterns ?? [], rules, this.autoEdit)) return false;
    this.req("POST", `/permission/${p.id}/reply`, { reply: "once" }, {}, tab.directory).catch(() => undefined);
    return true;
  }

  private rulesKey(sessionID: string, agent: string) {
    return `${sessionID}|${agent}|${this.autoEdit}|${this.autoRead}`;
  }

  /** Reject a request the running agent's own rules deny; the session only asks for those (see sessionRules). */
  private rejectIfDenied(tab: Tab, p: any): boolean {
    const rules = tab.agent ? this.agentRules.get(tab.agent) : undefined;
    const patterns: string[] = p.patterns ?? [];
    if (!rules || p.sessionID !== tab.sessionID || !deniedByAgent(rules, p.permission, patterns)) return false;
    const message = `The ${tab.agent} agent is not allowed to do this (${p.permission}: ${patterns.join(", ")}).`;
    this.req("POST", `/permission/${p.id}/reply`, { reply: "reject", message }, {}, tab.directory).catch(() => undefined);
    return true;
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
  async sendPrompt(text: string, mentions: Mention[]) {
    // Editor actions refer to files in the main workspace, so don't send them into a worktree tab.
    if (this.tab.worktree) {
      const main = [...this.tabs].reverse().find((t) => !t.worktree);
      if (main) await this.switchTab(main.key);
      else this.newSession();
    }
    if (!this.ready) {
      this.pendingPrompts.push({ text, mentions });
      return;
    }
    this.post({ type: "externalPrompt", text, mentions });
  }

  newSession(worktree?: Worktree) {
    const empty = !worktree && !this.tab.sessionID ? this.tab : undefined;
    if (empty) this.activeKey = empty.key;
    else this.leave(this.tab), this.addTab(worktree ? { directory: worktree.directory, worktree, title: `Worktree ${worktree.name}` } : {});
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

  /**
   * The model a panel starts on: what it last had picked, else the model last used anywhere
   * (unless opencodeChat.rememberLastModel is off), else opencodeChat.model, else OpenCode's own default.
   */
  private async startingModel(providerDefaults: Record<string, string> | undefined): Promise<ModelRef | undefined> {
    const cfg = vscode.workspace.getConfiguration("opencodeChat");
    const known = (m: ModelRef | undefined) => {
      const found = m && this.findModel(m);
      if (!found) return undefined;
      // Drop a remembered variant the model no longer offers.
      return m.variant && !found.variants.includes(m.variant) ? { providerID: m.providerID, modelID: m.modelID } : m;
    };
    const remembered = cfg.get<boolean>("rememberLastModel", true) ? this.host.memento.get<ModelRef>(LAST_MODEL_KEY) : undefined;
    const picked = known(this.pickedModel) ?? known(remembered) ?? this.parseModel(cfg.get<string>("model"));
    if (picked) return picked;
    const fromConfig = this.parseModel((await this.server.request<any>("GET", "/config")).model);
    if (fromConfig) return fromConfig;
    const entry = Object.entries(providerDefaults ?? {})[0];
    return entry ? { providerID: entry[0], modelID: entry[1] } : undefined;
  }

  /** "provider/model", or a bare model ID if exactly one provider offers it. */
  private parseModel(value: string | undefined): ModelRef | undefined {
    value = value?.trim();
    if (!value) return undefined;
    const slash = value.indexOf("/");
    if (slash > 0) return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
    const matches = this.models.filter((m) => m.modelID === value);
    return matches.length === 1 ? { providerID: matches[0].providerID, modelID: matches[0].modelID } : undefined;
  }

  private findModel(m: ModelRef) {
    return this.models.find((x) => x.providerID === m.providerID && x.modelID === m.modelID);
  }

  private async rememberModel(model: ModelRef | undefined) {
    this.pickedModel = model ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant || undefined } : undefined;
    if (this.pickedModel) await this.host.memento.update(LAST_MODEL_KEY, this.pickedModel);
  }

  /** opencodeChat.model was just changed: switch this panel to it now rather than at the next start. */
  private applyConfiguredModel() {
    const model = this.parseModel(vscode.workspace.getConfiguration("opencodeChat").get<string>("model"));
    if (!model) return;
    if (!this.findModel(model)) {
      void vscode.window.showWarningMessage(`OpenCode has no model ${model.providerID}/${model.modelID}; check opencodeChat.model.`);
      return;
    }
    void this.rememberModel(model);
    this.post({ type: "setModel", model });
  }

  /**
   * Absolute path in the active tab's directory. Relative paths (mentions, file references, diffs)
   * deliberately resolve against the active tree, so in a worktree tab they point at the worktree's
   * copy of the file, which is the one the agent is working on.
   */
  private absolute(p: string) {
    return path.isAbsolute(p) ? p : path.join(this.dir, p);
  }

  // ------------------------------------------------------------------ webview

  private async handle(msg: any): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.webviewLoaded = true;
        return this.runInit();
      case "send":
        await this.whenReady();
        return this.send(msg as SendRequest);
      case "editResend":
        await this.whenReady();
        return this.editResend(msg.messageID, msg as SendRequest);
      case "retry":
        await this.whenReady();
        return this.retry();
      case "abort":
        if (this.sessionID) await this.req("POST", `/session/${this.sessionID}/abort`);
        return;
      case "status":
        this.agent = msg.agent;
        this.model = msg.model;
        this.reportStatus();
        return;
      case "pickModel":
        return this.rememberModel(msg.model && { ...msg.model, variant: msg.variant });
      case "pickVariant": {
        if (!msg.model) return;
        const byModel = this.host.memento.get<Record<string, string | null>>(VARIANTS_KEY, {});
        await this.host.memento.update(VARIANTS_KEY, { ...byModel, [`${msg.model.providerID}/${msg.model.modelID}`]: msg.variant ?? null });
        return this.rememberModel({ ...msg.model, variant: msg.variant });
      }
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
        await this.applyRules(this.tab, this.tab.agent ?? this.agent);
        return;
      case "setAutoRead":
        this.autoRead = !!msg.autoRead;
        await this.applyRules(this.tab, this.tab.agent ?? this.agent);
        return;
      case "permissionReply":
        await this.req("POST", `/permission/${msg.id}/reply`, { reply: msg.reply, message: msg.message || undefined });
        this.resolvePending(msg.id);
        return;
      case "questionReply":
        await this.req("POST", `/question/${msg.id}/reply`, { answers: msg.answers });
        this.resolvePending(msg.id);
        return;
      case "questionReject":
        await this.req("POST", `/question/${msg.id}/reject`);
        this.resolvePending(msg.id);
        return;
      case "searchFiles": {
        const results = await this.searchFiles(msg.query);
        this.post({ type: "fileResults", query: msg.query, files: results });
        return;
      }
      case "openFile":
        return this.openFile(msg.path, msg.line);
      case "openExternal":
        if (/^https?:\/\//.test(msg.url)) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case "openDiff":
        return this.openDiff(msg.filePath, msg.diff, msg.before, msg.after);
      case "revert":
        if (!(await this.confirmIfBusy("Undo"))) return;
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
        return this.compact(msg.model, !!msg.ask);
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

  private runInit() {
    return (this.initializing ??= this.init().finally(() => (this.initializing = undefined)));
  }

  /**
   * Prompts need the agents' rules, which init fetches; a session created without them would get
   * looser permissions than the agent allows. Starts (or restarts) the server if it isn't up.
   */
  private async whenReady() {
    if (!this.ready) await this.runInit();
    if (!this.ready) throw new Error("OpenCode isn't running. Use Restart Server, or check the output log.");
  }

  /** The event stream dropped and came back: catch up on whatever finished or changed in the gap. */
  private async resync() {
    if (!this.ready) return;
    const dirs = [...new Set(this.tabs.filter((t) => t.sessionID).map((t) => t.directory))];
    const statuses = await Promise.all(dirs.map((d) => this.req<Record<string, any>>("GET", "/session/status", undefined, {}, d).catch(() => undefined)));
    dirs.forEach((dir, i) => {
      const status = statuses[i];
      if (!status) return;
      for (const tab of this.tabs.filter((t) => t.sessionID && t.directory === dir)) {
        // Idle sessions aren't listed.
        const busy = !!status[tab.sessionID!] && status[tab.sessionID!].type !== "idle";
        if (busy === tab.busy) continue;
        tab.busy = busy;
        if (!busy) {
          tab.pending.clear();
          this.notify(tab, "done");
        }
      }
    });
    this.sendTabs();
    if (this.tab.sessionID) await this.loadSession(this.tab.sessionID);
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
    this.agentRules = new Map(agents.map((a) => [a.name, a.permission ?? []]));
    const models: { providerID: string; providerName: string; modelID: string; name: string; context?: number; variants: string[] }[] = [];
    for (const p of providers.providers ?? []) {
      for (const [id, m] of Object.entries<any>(p.models ?? {})) {
        models.push({
          providerID: p.id,
          providerName: p.name ?? p.id,
          modelID: id,
          name: m.name ?? id,
          context: m.limit?.context || undefined,
          variants: Object.entries<any>(m.variants ?? {}).filter(([, v]) => !v?.disabled).map(([name]) => name),
        });
      }
    }
    this.models = models;
    const defaultModel = await this.startingModel(providers.default);
    this.post({
      type: "init",
      autoEdit: this.autoEdit,
      autoRead: this.autoRead,
      readOnlyAgents: agents.filter((a) => isReadOnlyAgent(a.permission ?? [])).map((a) => a.name),
      models,
      defaultModel,
      variantByModel: this.host.memento.get<Record<string, string | null>>(VARIANTS_KEY, {}),
      agents: agents.filter((a) => a.mode !== "subagent" && !a.hidden).map((a) => a.name),
      agentColors: Object.fromEntries(agents.filter((a) => a.color).map((a) => [a.name, a.color])),
      commands: commands.map((c) => ({ name: c.name, description: c.description ?? "" })),
      cwd: this.server.directory,
    });
    this.sendSettings();
    this.sendSelection();
    this.sendTabs();
    if (this.sessionID) await this.loadSession(this.sessionID);
    this.ready = true;
    for (const p of this.pendingPrompts.splice(0)) this.post({ type: "externalPrompt", text: p.text, mentions: p.mentions });
  }

  /**
   * Switching away from a conversation keeps it open only while it still needs the panel: it's running,
   * waiting for an answer, or in a worktree. Anything else is just history.
   */
  private leave(tab: Tab | undefined) {
    if (!tab || tab.busy || tab.pending.size || tab.worktree) return;
    this.tabs = this.tabs.filter((t) => t !== tab);
  }

  private async switchTab(key: string) {
    const tab = this.tabs.find((t) => t.key === key);
    if (!tab) return;
    // Not this.tab: after closeTab the active key is gone and this.tab falls back to another tab.
    const prev = this.tabs.find((t) => t.key === this.activeKey);
    if (prev !== tab) this.leave(prev);
    this.activeKey = key;
    if (tab.sessionID) await this.loadSession(tab.sessionID);
    else this.post({ type: "session", session: null, messages: [], worktree: tab.worktree });
    this.sendTabs();
  }

  private async closeTab(key: string) {
    let idx = this.tabs.findIndex((t) => t.key === key);
    if (idx < 0) return;
    const tab = this.tabs[idx];
    // Once closed, nothing here would show its approval requests, so a running conversation would hang
    // on them. Stop it, unless another panel has it open and keeps track of it.
    const openElsewhere = [...liveControllers].some((c) => c !== this && c.tabs.some((t) => t.sessionID === tab.sessionID));
    if (tab.sessionID && (tab.busy || tab.pending.size) && !openElsewhere) {
      const pick = await vscode.window.showWarningMessage(
        `"${tab.title}" is still running. Stop it and close the tab?`,
        { modal: true },
        "Stop and Close",
      );
      if (pick !== "Stop and Close") return;
      await this.req("POST", `/session/${tab.sessionID}/abort`, undefined, {}, tab.directory).catch(() => undefined);
      idx = this.tabs.indexOf(tab);
      if (idx < 0) return;
    }
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
    // Only reuse an empty, non-worktree draft; otherwise open a fresh tab.
    if (this.tab.sessionID || this.tab.worktree) this.leave(this.tab), this.addTab();
    const session = await this.server.request<any>("GET", `/session/${id}`);
    this.tab.sessionID = id;
    this.tab.directory = session.directory || this.server.directory;
    this.tab.title = session.title || "Conversation";
    await this.loadSession(id);
    this.sendTabs();
  }

  private async ensureSession(tab = this.tab): Promise<string> {
    if (tab.sessionID) return tab.sessionID;
    const session = await this.req<any>("POST", "/session", { permission: this.rulesFor(this.agent) }, {}, tab.directory);
    tab.sessionID = session.id;
    tab.agent = this.agent;
    tab.rulesKey = this.rulesKey(session.id, this.agent);
    tab.children.clear();
    if (tab === this.tab) this.post({ type: "session", session, messages: [], worktree: tab.worktree });
    this.sendTabs();
    return session.id;
  }

  private async loadSession(id: string) {
    const tab = this.tab;
    const [session, messages] = await Promise.all([
      this.req<any>("GET", `/session/${id}`),
      this.req<any[]>("GET", `/session/${id}/message`),
    ]);
    // The user may have switched tabs (or this tab to another session) while loading.
    if (tab !== this.tab || tab.sessionID !== id) return;
    tab.title = session.title || tab.title;
    this.post({ type: "session", session, messages, worktree: tab.worktree });
    // A run waiting to retry (a rate limit, say) has no message to show it; pass its status on.
    const status = await this.req<any>("GET", "/session/status").catch(() => ({}));
    if (status?.[id]?.type === "retry" && tab === this.tab) this.post({ type: "event", event: { type: "session.status", properties: { sessionID: id, status: status[id] } } });
    const commands = this.host.memento.get<Record<string, CommandMeta>>(COMMANDS_KEY, {});
    const entries = messages.filter((m: any) => commands[m.info.id]).map((m: any) => ({ messageID: m.info.id, ...commands[m.info.id] }));
    if (entries.length) this.post({ type: "commandMeta", entries });
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
    for (const p of perms) if (mine(p.sessionID) && !this.settleItself(tab, p)) this.post({ type: "event", event: { type: "permission.asked", properties: p } });
    for (const q of questions) if (mine(q.sessionID)) this.post({ type: "event", event: { type: "question.asked", properties: q } });
    // Rules follow the agent of the latest prompt, which may still be running.
    const last = messages.findLast((m: any) => m.info.role === "user")?.info.agent;
    await this.applyRules(tab, last ?? this.agent).catch(() => undefined);
  }

  /** Messages of a subagent session, for the nested view under a task step: its tool steps and what it says. */
  private async loadChild(sessionID: string) {
    this.tab.children.add(sessionID);
    const messages = await this.req<any[]>("GET", `/session/${sessionID}/message`).catch(() => []);
    const parts = messages.flatMap((m: any) => m.parts.filter((p: any) => p.type === "tool" || (p.type === "text" && !p.synthetic && m.info.role === "assistant")));
    this.post({ type: "childParts", sessionID, parts });
  }

  private async send(req: SendRequest) {
    const text = req.text.trim();
    const slash = text.match(/^\/(\S+)\s*([\s\S]*)$/);
    // The user can switch tabs while this awaits; everything below belongs to the tab it was sent from.
    const tab = this.tab;
    const dir = tab.directory;
    const sessionID = await this.ensureSession(tab);
    const agent = req.agent || "build";
    const selectionPart = req.includeSelection ? this.selectionContext() : undefined;

    const fileParts: any[] = [];
    for (const m of req.mentions) {
      const abs = path.isAbsolute(m.path) ? m.path : path.join(dir, m.path);
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
      const command = commands.find((c) => c.name === slash[1]);
      if (command) {
        // A command can name its own agent, which then runs instead of the selected one.
        await this.applyRules(tab, command.agent ?? agent);
        await this.req("POST", `/session/${sessionID}/command`, {
          command: slash[1],
          arguments: slash[2] ?? "",
          agent,
          model: req.model ? `${req.model.providerID}/${req.model.modelID}` : undefined,
          variant: req.variant,
          parts: fileParts.filter((p) => !p.url.startsWith("data:")),
        }, {}, dir);
        return;
      }
    }

    const parts: any[] = [{ type: "text", text }];
    if (selectionPart) parts.push(selectionPart);
    parts.push(...fileParts);

    await this.applyRules(tab, agent);
    await this.req("POST", `/session/${sessionID}/prompt_async`, { parts, agent, model: req.model, variant: req.variant }, {}, dir);
  }

  private async revert(messageID: string) {
    if (!this.sessionID) return;
    const status = await this.req<any>("GET", "/session/status").catch(() => ({}));
    if (status?.[this.sessionID]?.type === "busy") await this.req("POST", `/session/${this.sessionID}/abort`);
    const session = await this.req<any>("POST", `/session/${this.sessionID}/revert`, { messageID });
    this.post({ type: "event", event: { type: "session.updated", properties: { info: session } } });
    await this.sendDiff();
  }

  /** Webviews can't show confirm() dialogs, so ask in VS Code before interrupting a run. */
  private async confirmIfBusy(action: string) {
    if (!this.tab.busy) return true;
    const ok = await vscode.window.showWarningMessage(
      `OpenCode is still working. Stop it and ${action.toLowerCase()}?`,
      { modal: true },
      action,
    );
    return ok === action;
  }

  private async compact(model: { providerID: string; modelID: string } | undefined, ask: boolean) {
    const sessionID = this.sessionID;
    if (!sessionID) {
      vscode.window.showInformationMessage("Nothing to compact yet.");
      return;
    }
    if (ask) {
      const ok = await vscode.window.showWarningMessage(
        "Compact this conversation? OpenCode will summarize it to free up context.",
        { modal: true },
        "Compact",
      );
      if (ok !== "Compact") return;
    }
    if (!model) {
      // No model picked in the UI: use the one the conversation last ran on.
      const messages = await this.req<any[]>("GET", `/session/${sessionID}/message`);
      const last = [...messages].reverse().find((m) => m.info.role === "assistant" && m.info.modelID)?.info;
      if (last) model = { providerID: last.providerID, modelID: last.modelID };
    }
    if (!model) throw new Error("Pick a model first; compacting needs one to write the summary.");
    // No progress popup: the panel already shows "Summarizing conversation…" while it runs.
    await this.req("POST", `/session/${sessionID}/summarize`, model);
  }

  /** Undo back to an earlier message, then send its edited text in its place. */
  private async editResend(messageID: string, req: SendRequest) {
    if (!(await this.confirmIfBusy("Resend"))) return;
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
    const diff: FileChange[] = [];
    for (const [file, turns] of collectTurns(messages, session.revert?.messageID)) {
      const uri = vscode.Uri.file(this.absolute(file));
      let exists = true;
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        exists = false;
      }
      const change = cumulativeChange(file, turns, exists ? await this.readText(uri) : "", exists);
      if (change) diff.push(change);
    }
    if (sessionID !== this.sessionID) return;
    this.post({ type: "event", event: { type: "session.diff", properties: { sessionID, diff } } });
  }

  private async readText(uri: vscode.Uri) {
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      return "";
    }
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
    const original = unapply(current, diffText);
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
      const original = unapply(await this.readText(uri), diffText);
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

  /** OpenCode stores a /command as its expanded prompt; remember the name so it can be shown as typed. */
  private rememberCommand(messageID: string, meta: CommandMeta) {
    const all = { ...this.host.memento.get<Record<string, CommandMeta>>(COMMANDS_KEY, {}), [messageID]: meta };
    const ids = Object.keys(all).sort();
    for (const old of ids.slice(0, Math.max(0, ids.length - 1000))) delete all[old];
    this.host.memento.update(COMMANDS_KEY, all);
  }

  private statusOf(t: Tab): "idle" | "busy" | "attention" {
    return t.pending.size ? "attention" : t.busy ? "busy" : "idle";
  }

  /** A permission / question request was answered (here or elsewhere). */
  private resolvePending(requestID: string | undefined) {
    if (!requestID) return;
    const tab = this.tabs.find((t) => t.pending.has(requestID));
    if (tab?.pending.delete(requestID)) this.sendTabs();
  }

  private notify(tab: Tab, kind: "done" | "attention") {
    const cfg = vscode.workspace.getConfiguration("opencodeChat");
    if (!cfg.get<boolean>("notifications", true)) return;
    if (kind === "done" && !cfg.get<boolean>("notifyWhenFinished", true)) return;
    // A visible panel with this conversation open already shows its state (the tab strip marks busy / needs you).
    const shown = [...liveControllers].some((c) => c.host.isVisible() && c.tabs.some((t) => t === tab || (!!tab.sessionID && t.sessionID === tab.sessionID)));
    if (shown) return;
    // The same session can be open in the side bar and an editor tab; notify once.
    const key = `${kind}:${tab.sessionID}`;
    const now = Date.now();
    if ((recentNotifications.get(key) ?? 0) > now - 10000) return;
    recentNotifications.set(key, now);
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
    const sid: string | undefined =
      p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? (e.type.startsWith("session.") ? p.info?.id : undefined);
    const tab = this.tabFor(sid);
    if (!tab) return;
    const isMain = sid === tab.sessionID;
    const active = tab.key === this.activeKey;

    if (e.type === "command.executed" && p.messageID) {
      this.rememberCommand(p.messageID, { name: p.name, arguments: p.arguments ?? "", sessionID: sid! });
      if (active) this.post({ type: "commandMeta", entries: [{ messageID: p.messageID, name: p.name, arguments: p.arguments ?? "" }] });
      return;
    }

    // Tab status, titles and notifications for every tab, active or not.
    if (isMain && e.type === "session.updated" && p.info?.title && p.info.title !== tab.title) {
      tab.title = p.info.title;
      this.sendTabs();
    }
    if (isMain && e.type === "session.status") {
      const busy = p.status?.type !== "idle";
      if (busy !== tab.busy) {
        tab.busy = busy;
        if (!busy) {
          // Anything still pending was cancelled along with the run.
          tab.pending.clear();
          this.notify(tab, "done");
        }
        this.sendTabs();
      }
    }
    if (isMain && e.type === "permission.asked" && this.settleItself(tab, p)) return;
    if ((e.type === "permission.asked" || e.type === "question.asked") && p.id && !tab.pending.has(p.id)) {
      tab.pending.add(p.id);
      this.sendTabs();
      this.notify(tab, "attention");
    }
    if (e.type === "permission.replied" || e.type === "question.replied" || e.type === "question.rejected") {
      this.resolvePending(p.requestID ?? p.id);
    }

    if (!active) return;
    // OpenCode's own diff events are per turn; recompute the session-wide view instead.
    if (isMain && (e.type === "session.diff" || e.type === "session.idle")) {
      this.queueDiff();
      if (e.type === "session.diff") return;
    }
    if (!isMain) {
      // Subagent sessions: stream their tool steps and text into the nested view; surface their prompts.
      // The prompt the subagent was given is a user message; only its own words count.
      if (e.type === "message.updated" && p.info?.role === "user") childPrompts.add(p.info.id);
      if (e.type === "message.part.updated" && (p.part?.type === "tool" || (p.part?.type === "text" && !p.part.synthetic && !childPrompts.has(p.part.messageID)))) {
        this.post({ type: "childParts", sessionID: sid, parts: [p.part] });
        return;
      }
      if (e.type === "message.part.delta" && !childPrompts.has(p.messageID)) {
        this.post({ type: "childDelta", sessionID: sid, partID: p.partID, field: p.field, delta: p.delta });
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
    const katexStyle = this.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "katex", "katex.min.css"));
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
<link rel="stylesheet" href="${katexStyle}">
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
    liveControllers.delete(this);
    clearTimeout(this.selectionTimer);
    clearTimeout(this.diffTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}
