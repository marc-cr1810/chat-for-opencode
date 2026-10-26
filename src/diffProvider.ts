import * as vscode from "vscode";

/** Serves in-memory "before"/"proposed" documents for the native diff editor. */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "opencode-diff";
  private readonly contents = new Map<string, string>();
  private counter = 0;

  register(label: string, content: string): vscode.Uri {
    const id = `${++this.counter}`;
    this.contents.set(id, content);
    // Cap memory: only keep the most recent documents.
    if (this.contents.size > 100) this.contents.delete(this.contents.keys().next().value!);
    return vscode.Uri.from({ scheme: DiffContentProvider.scheme, path: `/${label}`, query: id });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.query) ?? "";
  }
}
