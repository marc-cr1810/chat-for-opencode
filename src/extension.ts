import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { OpencodeServer } from "./server";
import { ChatController, ChatHost, ChatStatus, Mention } from "./chat";
import { DiffContentProvider } from "./diffProvider";
import { FixProvider, diagnosticPrompt } from "./codeActions";
import { SettingsPanel } from "./settings";

let server: OpencodeServer | undefined;

export function activate(context: vscode.ExtensionContext) {
  migrateSettings(context).catch(() => {});
  const output = vscode.window.createOutputChannel("Chat for OpenCode");
  const directory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  server = new OpencodeServer(output, directory);
  const diffs = new DiffContentProvider();
  const controllers = new Set<ChatController>();
  const statuses = new Map<ChatController, ChatStatus>();
  let lastActive: { controller: ChatController; reveal: () => void } | undefined;
  let sidebarController: ChatController | undefined;
  // Resolvers waiting for the side bar view to be created (it resolves asynchronously).
  let sidebarWaiters: ((c: ChatController) => void)[] = [];

  const track = (controller: ChatController, reveal: () => void) => {
    controllers.add(controller);
    lastActive = { controller, reveal };
    renderStatusBar();
  };
  const untrack = (controller: ChatController) => {
    controller.dispose();
    controllers.delete(controller);
    statuses.delete(controller);
    if (lastActive?.controller === controller) lastActive = undefined;
    renderStatusBar();
  };

  // --------------------------------------------------------------- status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "opencodeChat.focus";
  const renderStatusBar = () => {
    const all = [...statuses.values()];
    const shown = (lastActive && statuses.get(lastActive.controller)) ?? all[0];
    const agent = shown?.agent ?? "build";
    const model = shown?.model ? ` · ${shown.model}` : "";
    if (all.some((s) => s.attention)) {
      statusBar.text = `$(bell-dot) OpenCode needs you`;
      statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      statusBar.tooltip = "OpenCode is waiting for your approval. Click to review.";
    } else if (all.some((s) => s.busy)) {
      statusBar.text = `$(loading~spin) ${agent}${model}`;
      statusBar.backgroundColor = undefined;
      statusBar.tooltip = "OpenCode is working. Click to open.";
    } else {
      statusBar.text = `$(comment-discussion) ${agent}${model}`;
      statusBar.backgroundColor = undefined;
      statusBar.tooltip = "OpenCode: click to open (Ctrl+Alt+O)";
    }
    statusBar.show();
  };
  renderStatusBar();

  const makeHost = (opts: {
    setTitle: (t: string) => void;
    isVisible: () => boolean;
    reveal: () => void;
    controller: () => ChatController;
  }): ChatHost => ({
    setTitle: opts.setTitle,
    isVisible: opts.isVisible,
    reveal: opts.reveal,
    showLogs: () => output.show(),
    memento: context.workspaceState,
    openSettings: () => SettingsPanel.show(context.extensionUri, server!, context.extension.id),
    reportStatus: (s) => {
      statuses.set(opts.controller(), s);
      renderStatusBar();
    },
  });

  // ------------------------------------------------------------- side bar view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "opencodeChat.chatView",
      {
        resolveWebviewView(view) {
          const reveal = () => view.show(false);
          const controller: ChatController = new ChatController(
            view.webview,
            server!,
            context.extensionUri,
            diffs,
            makeHost({
              setTitle: (title) => (view.description = title === "Chat for OpenCode" ? undefined : title),
              isVisible: () => view.visible,
              reveal,
              controller: () => controller,
            }),
          );
          track(controller, reveal);
          sidebarController = controller;
          sidebarWaiters.splice(0).forEach((resolve) => resolve(controller));
          view.onDidChangeVisibility(() => view.visible && track(controller, reveal));
          view.onDidDispose(() => {
            if (sidebarController === controller) sidebarController = undefined;
            untrack(controller);
          });
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // -------------------------------------------------------------- editor tabs
  const openInTab = () => {
    const panel = vscode.window.createWebviewPanel(
      "opencodeChat.chatPanel",
      "Chat for OpenCode",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { retainContextWhenHidden: true, enableScripts: true },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    const reveal = () => panel.reveal();
    const controller: ChatController = new ChatController(
      panel.webview,
      server!,
      context.extensionUri,
      diffs,
      makeHost({
        setTitle: (title) => (panel.title = title),
        isVisible: () => panel.visible,
        reveal,
        controller: () => controller,
      }),
    );
    track(controller, reveal);
    panel.onDidChangeViewState(() => panel.active && track(controller, reveal));
    panel.onDidDispose(() => untrack(controller));
    setTimeout(() => controller.focus(), 300);
    return controller;
  };

  /** Show the side bar view and wait (up to 5s) for its controller to exist. */
  const openSidebar = async (): Promise<ChatController | undefined> => {
    const ready = sidebarController
      ? Promise.resolve(sidebarController)
      : new Promise<ChatController | undefined>((resolve) => {
          sidebarWaiters.push(resolve);
          setTimeout(() => resolve(undefined), 5000);
        });
    await vscode.commands.executeCommand("workbench.view.extension.opencodeChat-sidebar");
    const controller = await ready;
    setTimeout(() => controller?.focus(), 200);
    return controller;
  };

  const ensureOpen = async () => {
    if (lastActive) {
      lastActive.reveal();
      return lastActive.controller;
    }
    const where = vscode.workspace.getConfiguration("opencodeChat").get<string>("preferredLocation");
    if (where === "sidebar") return (await openSidebar()) ?? openInTab();
    return openInTab();
  };

  // ---------------------------------------------------------- editor actions
  const relPath = (uri: vscode.Uri) => {
    const rel = path.relative(directory, uri.fsPath);
    return rel.startsWith("..") ? uri.fsPath : rel;
  };

  const selectionMention = (editor: vscode.TextEditor): Mention => {
    const sel = editor.selection;
    return {
      path: relPath(editor.document.uri),
      startLine: sel.isEmpty ? undefined : sel.start.line + 1,
      endLine: sel.isEmpty ? undefined : sel.end.character === 0 ? sel.end.line : sel.end.line + 1,
    };
  };

  const mentionToken = (m: Mention) =>
    `@${m.path}${m.startLine ? `#L${m.startLine}${m.endLine && m.endLine !== m.startLine ? `-${m.endLine}` : ""}` : ""}`;

  const askAboutSelection = (instruction: (target: string) => string) => async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const m = selectionMention(editor);
    const target = m.startLine ? `the selected code in ${mentionToken(m)}` : mentionToken(m);
    const c = await ensureOpen();
    c?.sendPrompt(instruction(target), [m]);
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DiffContentProvider.scheme, diffs),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new FixProvider(), {
      providedCodeActionKinds: FixProvider.kinds,
    }),
    vscode.commands.registerCommand("opencodeChat.openInTab", openInTab),
    vscode.commands.registerCommand("opencodeChat.openInSidebar", openSidebar),
    vscode.commands.registerCommand("opencodeChat.focus", async () => {
      const c = await ensureOpen();
      setTimeout(() => c?.focus(), 100);
    }),
    vscode.commands.registerCommand("opencodeChat.newSession", async () => {
      const c = await ensureOpen();
      c?.newSession();
      c?.focus();
    }),
    vscode.commands.registerCommand("opencodeChat.insertAtMention", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const c = await ensureOpen();
      c?.insertMention(selectionMention(editor));
      c?.focus();
    }),
    vscode.commands.registerCommand(
      "opencodeChat.explainSelection",
      askAboutSelection((t) => `Explain ${t}. What does it do and why?`),
    ),
    vscode.commands.registerCommand(
      "opencodeChat.refactorSelection",
      askAboutSelection((t) => `Refactor ${t} to be clearer and simpler without changing its behaviour.`),
    ),
    vscode.commands.registerCommand(
      "opencodeChat.testSelection",
      askAboutSelection(
        (t) => `Write tests for ${t}. Follow the project's existing test setup and conventions, and run them.`,
      ),
    ),
    vscode.commands.registerCommand(
      "opencodeChat.fixDiagnostic",
      async (uri: vscode.Uri, diagnostic: vscode.Diagnostic, mode: "fix" | "explain") => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const { text, mention } = diagnosticPrompt(doc, relPath(uri), diagnostic, mode);
        const c = await ensureOpen();
        c?.sendPrompt(text, [mention]);
      },
    ),
    vscode.commands.registerCommand("opencodeChat.openSettingsPanel", () => SettingsPanel.show(context.extensionUri, server!, context.extension.id)),
    vscode.commands.registerCommand("opencodeChat.restartServer", async () => {
      await server?.restart();
      vscode.window.showInformationMessage("OpenCode server restarted.");
    }),
    statusBar,
    output,
    server,
    { dispose: () => controllers.forEach((c) => c.dispose()) },
  );
}

export function deactivate() {
  return server?.stop();
}

/** Settings were under `opencode.*` before the rename, which clashed with OpenCode's own extension; copy them over once. */
export async function migrateSettings(context: vscode.ExtensionContext) {
  const keys = Object.keys(context.extension.packageJSON.contributes?.configuration?.properties ?? {});
  const config = vscode.workspace.getConfiguration();
  const scopes = [
    ["globalValue", vscode.ConfigurationTarget.Global],
    ["workspaceValue", vscode.ConfigurationTarget.Workspace],
  ] as const;
  for (const key of keys) {
    const old = config.inspect(key.replace(/^opencodeChat\./, "opencode."));
    const now = config.inspect(key);
    for (const [scope, target] of scopes) {
      if (old?.[scope] === undefined || now?.[scope] !== undefined) continue;
      if (target === vscode.ConfigurationTarget.Workspace && !vscode.workspace.workspaceFolders) continue;
      await config.update(key, old[scope], target);
    }
  }
}
