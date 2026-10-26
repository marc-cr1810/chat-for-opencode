import * as vscode from "vscode";
import type { Mention } from "./chat";

/** Offers "Fix with OpenCode" / "Explain with OpenCode" for diagnostics in the lightbulb menu. */
export class FixProvider implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext) {
    const actions: vscode.CodeAction[] = [];
    // One pair of actions for the most severe diagnostic under the cursor keeps the menu short.
    const diagnostic = [...context.diagnostics].sort((a, b) => a.severity - b.severity)[0];
    if (!diagnostic) return actions;
    for (const mode of ["fix", "explain"] as const) {
      const action = new vscode.CodeAction(
        mode === "fix" ? "Fix with OpenCode" : "Explain with OpenCode",
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = [diagnostic];
      action.command = {
        command: "opencodeChat.fixDiagnostic",
        title: action.title,
        arguments: [document.uri, diagnostic, mode],
      };
      actions.push(action);
    }
    return actions;
  }
}

const SEVERITY = ["error", "warning", "info", "hint"];

/** Prompt text plus a mention of the surrounding lines, so OpenCode gets the code as context. */
export function diagnosticPrompt(
  doc: vscode.TextDocument,
  relPath: string,
  d: vscode.Diagnostic,
  mode: "fix" | "explain",
): { text: string; mention: Mention } {
  const startLine = Math.max(1, d.range.start.line + 1 - 5);
  const endLine = Math.min(doc.lineCount, d.range.end.line + 1 + 5);
  const line = d.range.start.line + 1;
  const source = d.source ? ` (${d.source}${d.code !== undefined ? ` ${typeof d.code === "object" ? d.code.value : d.code}` : ""})` : "";
  const kind = SEVERITY[d.severity] ?? "problem";
  const where = `@${relPath}#L${startLine}-${endLine}`;
  const text =
    mode === "fix"
      ? `Fix this ${kind} on line ${line} of ${where}${source}:\n\n> ${d.message}\n\nMake the smallest change that fixes it.`
      : `Explain this ${kind} on line ${line} of ${where}${source}:\n\n> ${d.message}\n\nWhat causes it and how could it be fixed? Don't change any files.`;
  return { text, mention: { path: relPath, startLine, endLine } };
}
