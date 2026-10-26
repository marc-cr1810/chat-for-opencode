import * as vscode from "vscode";

/** Serves in-memory "before"/"proposed" documents for the native diff editor. */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "opencode-diff";
  private readonly contents = new Map<string, string>();
  private counter = 0;

  register(label: string, content: string): vscode.Uri {
    const id = `${++this.counter}`;
    this.contents.set(id, content);
    // Cap memory, but never evict a document that is still open in an editor.
    if (this.contents.size > 200) {
      const open = new Set(
        vscode.workspace.textDocuments.filter((d) => d.uri.scheme === DiffContentProvider.scheme).map((d) => d.uri.query),
      );
      for (const key of this.contents.keys()) {
        if (this.contents.size <= 200) break;
        if (!open.has(key)) this.contents.delete(key);
      }
    }
    return vscode.Uri.from({ scheme: DiffContentProvider.scheme, path: `/${label}`, query: id });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.query) ?? "";
  }
}
