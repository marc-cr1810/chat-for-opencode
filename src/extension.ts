import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { OpencodeServer } from "./server";
import { ChatController } from "./chat";
import { DiffContentProvider } from "./diffProvider";

let server: OpencodeServer | undefined;

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("OpenCode");
  const directory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  server = new OpencodeServer(output, directory);
  const diffs = new DiffContentProvider();
  const controllers = new Set<ChatController>();
  let lastActive: { controller: ChatController; reveal: () => void } | undefined;

  const current = () => lastActive?.controller;
  const track = (controller: ChatController, reveal: () => void) => {
    controllers.add(controller);
    lastActive = { controller, reveal };
  };

  // ------------------------------------------------------------- side bar view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "opencode.chatView",
      {
        resolveWebviewView(view) {
          const controller = new ChatController(
            view.webview,
            server!,
            context.extensionUri,
            diffs,
            (title) => (view.description = title === "OpenCode" ? undefined : title),
            () => output.show(),
          );
          const reveal = () => view.show(false);
          track(controller, reveal);
          view.onDidChangeVisibility(() => view.visible && track(controller, reveal));
          view.onDidDispose(() => {
            controller.dispose();
            controllers.delete(controller);
            if (lastActive?.controller === controller) lastActive = undefined;
          });
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // -------------------------------------------------------------- editor tabs
  const openInTab = () => {
    const panel = vscode.window.createWebviewPanel(
      "opencode.chatPanel",
      "OpenCode",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { retainContextWhenHidden: true, enableScripts: true },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    const controller = new ChatController(
      panel.webview,
      server!,
      context.extensionUri,
      diffs,
      (title) => (panel.title = title),
      () => output.show(),
    );
    const reveal = () => panel.reveal();
    track(controller, reveal);
    panel.onDidChangeViewState(() => panel.active && track(controller, reveal));
    panel.onDidDispose(() => {
      controller.dispose();
      controllers.delete(controller);
      if (lastActive?.controller === controller) lastActive = undefined;
    });
    setTimeout(() => controller.focus(), 300);
    return controller;
  };

  const openSidebar = async () => {
    await vscode.commands.executeCommand("workbench.view.extension.opencode");
    setTimeout(() => lastActive?.controller.focus(), 200);
  };

  const ensureOpen = async () => {
    if (lastActive) {
      lastActive.reveal();
      return lastActive.controller;
    }
    const where = vscode.workspace.getConfiguration("opencode").get<string>("preferredLocation");
    if (where === "sidebar") {
      await openSidebar();
      return current();
    }
    return openInTab();
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DiffContentProvider.scheme, diffs),
    vscode.commands.registerCommand("opencode.openInTab", openInTab),
    vscode.commands.registerCommand("opencode.openInSidebar", openSidebar),
    vscode.commands.registerCommand("opencode.focus", async () => {
      const c = await ensureOpen();
      setTimeout(() => c?.focus(), 100);
    }),
    vscode.commands.registerCommand("opencode.newSession", async () => {
      const c = await ensureOpen();
      c?.newSession();
      c?.focus();
    }),
    vscode.commands.registerCommand("opencode.insertAtMention", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const rel = path.relative(directory, editor.document.uri.fsPath);
      const sel = editor.selection;
      const c = await ensureOpen();
      c?.insertMention({
        path: rel.startsWith("..") ? editor.document.uri.fsPath : rel,
        startLine: sel.isEmpty ? undefined : sel.start.line + 1,
        endLine: sel.isEmpty ? undefined : sel.end.line + 1,
      });
      c?.focus();
    }),
    vscode.commands.registerCommand("opencode.restartServer", async () => {
      await server?.restart();
      vscode.window.showInformationMessage("OpenCode server restarted.");
    }),
    output,
    server,
    { dispose: () => controllers.forEach((c) => c.dispose()) },
  );
}

export function deactivate() {
  server?.stop();
}
