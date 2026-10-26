import * as vscode from "vscode";
import * as path from "path";
import { applyPatch } from "diff";
import { OpencodeServer, OpencodeEvent } from "./server";
import { DiffContentProvider } from "./diffProvider";

interface Mention {
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

/** Session permission rules. Shell commands always ask; edits ask unless auto-approved. */
function rulesFor(autoEdit: boolean) {
  return [
    { permission: "edit", pattern: "*", action: autoEdit ? "allow" : "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
  ];
}

/** Connects one webview (sidebar or editor tab) to one OpenCode session at a time. */
export class ChatController implements vscode.Disposable {
  private sessionID: string | undefined;
  private childSessions = new Set<string>();
  private autoEdit: boolean;
  private disposables: vscode.Disposable[] = [];
  private selectionTimer: NodeJS.Timeout | undefined;
  private lastEditor: vscode.TextEditor | undefined;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly server: OpencodeServer,
    private readonly extensionUri: vscode.Uri,
    private readonly diffs: DiffContentProvider,
    private readonly onTitle: (title: string) => void,
    private readonly showLogs: () => void,
  ) {
    this.autoEdit = vscode.workspace.getConfiguration("opencode").get<boolean>("autoApproveEdits") ?? false;
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

  newSession() {
    this.sessionID = undefined;
    this.childSessions.clear();
    this.onTitle("OpenCode");
    this.post({ type: "session", session: null, messages: [] });
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

  private relative(fsPath: string) {
    const rel = path.relative(this.server.directory, fsPath);
    return rel.startsWith("..") ? fsPath : rel;
  }

  private absolute(p: string) {
    return path.isAbsolute(p) ? p : path.join(this.server.directory, p);
  }

  // ------------------------------------------------------------------ webview

  private async handle(msg: any): Promise<void> {
    switch (msg.type) {
      case "ready":
        return this.init();
      case "send":
        return this.send(msg as SendRequest);
      case "abort":
        if (this.sessionID) await this.server.request("POST", `/session/${this.sessionID}/abort`);
        return;
      case "newSession":
        return this.newSession();
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
        return this.loadSession(msg.id);
      case "deleteSession":
        await this.server.request("DELETE", `/session/${msg.id}`);
        if (msg.id === this.sessionID) this.newSession();
        return this.handle({ type: "listSessions" });
      case "setAutoEdit":
        this.autoEdit = !!msg.autoEdit;
        if (this.sessionID) {
          await this.server.request("PATCH", `/session/${this.sessionID}`, { permission: rulesFor(this.autoEdit) });
        }
        return;
      case "permissionReply":
        await this.server.request("POST", `/permission/${msg.id}/reply`, {
          reply: msg.reply,
          message: msg.message || undefined,
        });
        return;
      case "questionReply":
        await this.server.request("POST", `/question/${msg.id}/reply`, { answers: msg.answers });
        return;
      case "questionReject":
        await this.server.request("POST", `/question/${msg.id}/reject`);
        return;
      case "searchFiles": {
        const results = await this.searchFiles(msg.query);
        this.post({ type: "fileResults", query: msg.query, files: results });
        return;
      }
      case "openFile": {
        const uri = vscode.Uri.file(this.absolute(msg.path));
        const line = Math.max(0, (msg.line ?? 1) - 1);
        await vscode.window.showTextDocument(uri, {
          viewColumn: vscode.ViewColumn.One,
          selection: new vscode.Range(line, 0, line, 0),
          preview: true,
        });
        return;
      }
      case "openDiff":
        return this.openDiff(msg.filePath, msg.diff, msg.before, msg.after);
      case "compact": {
        if (!this.sessionID || !msg.model) return;
        await this.server.request("POST", `/session/${this.sessionID}/summarize`, msg.model);
        return;
      }
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "opencode");
        return;
      case "showLogs":
        this.showLogs();
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
    const models: { providerID: string; providerName: string; modelID: string; name: string }[] = [];
    for (const p of providers.providers ?? []) {
      for (const [id, m] of Object.entries<any>(p.models ?? {})) {
        models.push({ providerID: p.id, providerName: p.name ?? p.id, modelID: id, name: m.name ?? id });
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
    if (this.sessionID) await this.loadSession(this.sessionID);
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionID) return this.sessionID;
    const session = await this.server.request<any>("POST", "/session", { permission: rulesFor(this.autoEdit) });
    this.sessionID = session.id;
    this.childSessions.clear();
    this.post({ type: "session", session, messages: [] });
    return session.id;
  }

  private async loadSession(id: string) {
    const [session, messages] = await Promise.all([
      this.server.request<any>("GET", `/session/${id}`),
      this.server.request<any[]>("GET", `/session/${id}/message`),
    ]);
    this.sessionID = id;
    this.childSessions.clear();
    this.onTitle(session.title || "OpenCode");
    this.post({ type: "session", session, messages });
    // Re-surface anything still waiting for an answer.
    const [perms, questions] = await Promise.all([
      this.server.request<any[]>("GET", "/permission").catch(() => []),
      this.server.request<any[]>("GET", "/question").catch(() => []),
    ]);
    for (const p of perms) if (p.sessionID === id) this.post({ type: "event", event: { type: "permission.asked", properties: p } });
    for (const q of questions) if (q.sessionID === id) this.post({ type: "event", event: { type: "question.asked", properties: q } });
    await this.server
      .request("PATCH", `/session/${id}`, { permission: rulesFor(this.autoEdit) })
      .catch(() => undefined);
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
        await this.server.request("POST", `/session/${sessionID}/command`, {
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

    await this.server.request("POST", `/session/${sessionID}/prompt_async`, {
      parts,
      agent,
      model: req.model,
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
        const found = await this.server.request<string[]>("GET", "/find/file", undefined, {
          query,
          dirs: "true",
          limit: 30,
        });
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

  private async openDiff(filePath: string, diffText?: string, before?: string, after?: string) {
    const abs = this.absolute(filePath);
    const uri = vscode.Uri.file(abs);
    let original = before;
    let modified = after;
    if (original === undefined || modified === undefined) {
      let current = "";
      try {
        current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      } catch {
        current = "";
      }
      if (diffText) {
        const patched = applyPatch(current, diffText);
        if (patched !== false) {
          original = current;
          modified = patched;
        } else {
          // Patch already applied: reverse direction.
          original = undefined;
        }
      }
      if (original === undefined || modified === undefined) {
        await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One });
        return;
      }
    }
    const left = this.diffs.register(`${path.basename(abs)} (before)`, original);
    const right = this.diffs.register(`${path.basename(abs)} (proposed)`, modified);
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${path.basename(abs)} ↔ OpenCode`,
      { viewColumn: vscode.ViewColumn.One, preview: true },
    );
  }

  // ------------------------------------------------------------------- events

  private belongs(sessionID: string | undefined) {
    return !!sessionID && (sessionID === this.sessionID || this.childSessions.has(sessionID));
  }

  private onEvent(e: OpencodeEvent) {
    const p = e.properties ?? {};
    if (e.type === "session.created" && p.info?.parentID && this.belongs(p.info.parentID)) {
      this.childSessions.add(p.info.id);
      return;
    }
    const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    if (!this.belongs(sid)) return;
    if (e.type === "session.updated" && sid === this.sessionID && p.info?.title) this.onTitle(p.info.title);
    // Only permission/question prompts from subagent sessions surface in the main view.
    if (sid !== this.sessionID && !e.type.startsWith("permission.") && !e.type.startsWith("question.")) return;
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
    this.disposables.forEach((d) => d.dispose());
  }
}
