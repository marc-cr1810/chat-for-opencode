/** Session permission rules (unit-tested). Mirrors OpenCode's evaluation: last matching rule wins. */

export type Action = "allow" | "ask" | "deny";

export interface Rule {
  permission: string;
  pattern: string;
  action: Action;
}

/** OpenCode's wildcard match: `*` is any run, `?` one character, and "cmd *" also matches "cmd". */
export function wildcardMatch(str: string, pattern: string): boolean {
  str = str.replaceAll("\\", "/");
  let re = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (re.endsWith(" .*")) re = re.slice(0, -3) + "( .*)?";
  return new RegExp(`^${re}$`, "s").test(str);
}

/** The action OpenCode would take, given the agent's rules followed by the session's. */
export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Action {
  return (
    rulesets
      .flat()
      .findLast((r) => wildcardMatch(permission, r.permission) && wildcardMatch(pattern, r.pattern))?.action ?? "ask"
  );
}

/**
 * Rules the extension puts on a session: edits ask (or are allowed in auto mode) and shell commands ask,
 * except read-only ones when `readOnlyShell` is on (build's auto mode, or plan's auto read-only).
 *
 * Session rules are evaluated after the agent's own, so a plain `edit: allow` would override an agent
 * that denies edits (plan mode). Each of our rules is therefore followed by the agent's rules for the
 * same permission, with the agent's denies turned into asks and everything else following the toggle.
 * The extension then rejects those asks itself (see `deniedByAgent`).
 *
 * Denies are not written to the session because OpenCode only ever appends session rules, and every
 * deny in a session is copied to the subagents it starts: one plan-mode message would otherwise stop
 * build's subagents from editing for the rest of the conversation.
 */
export function sessionRules(autoEdit: boolean, agentRules: Rule[] = [], readOnlyShell = false): Rule[] {
  const ours: Rule[] = [
    { permission: "edit", pattern: "*", action: autoEdit ? "allow" : "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
  ];
  return ours.flatMap((rule) => {
    const agent = agentRules.filter((r) => wildcardMatch(rule.permission, r.permission));
    const denies = agent.filter((r) => r.action === "deny").map((r): Rule => ({ ...r, permission: rule.permission, action: "ask" }));
    const out = [rule];
    // Without denies the agent's rules make no difference: ours cover everything after them.
    if (denies.length) out.push(...agent.map((r): Rule => ({ permission: rule.permission, pattern: r.pattern, action: r.action === "deny" ? "ask" : rule.action })));
    if (readOnlyShell && rule.permission === "bash") {
      out.push(...readOnlyRules());
      // The agent's own denies still win over the allowlist.
      out.push(...denies);
    }
    return out;
  });
}

/** Tools whose `--version` (or `version`) only prints and exits. */
const VERSION_TOOLS = [
  "node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "tsc", "python", "python3", "pip", "pip3", "go", "cargo", "rustc",
  "rustup", "java", "javac", "dotnet", "ruby", "gem", "php", "composer", "gcc", "g++", "clang", "make", "cmake", "git",
  "docker", "kubectl", "gh", "opencode", "code",
];

/**
 * Shell commands that only read, allowed without asking in the auto modes. OpenCode checks each
 * command in a chain, pipe or $(...) separately, so `ls && rm x` still asks for `rm x`. `cd` isn't
 * listed because OpenCode never asks about it (only about directories outside the project).
 */
export const READ_ONLY_COMMANDS = [
  "ls *", "pwd", "cat *", "head *", "tail *", "wc *", "file *", "stat *", "du *", "df *", "tree *",
  "which *", "whereis *", "type *", "echo *", "printf *", "grep *", "egrep *", "fgrep *", "rg *", "fd *", "find *",
  "diff *", "cmp *", "cut *", "tr *", "sort *", "uniq *", "nl *", "column *", "jq *", "od *", "hexdump *", "xxd *",
  "strings *", "md5sum *", "sha1sum *", "sha256sum *", "sed -n *", "test *", "true", "false", "env", "printenv*",
  "basename *", "dirname *", "realpath *", "readlink *", "date *", "uname *", "whoami", "id *", "hostname",
  "git status*", "git log*", "git diff*", "git show*", "git blame*", "git grep*", "git ls-files*", "git ls-tree*",
  "git rev-parse*", "git rev-list*", "git describe*", "git shortlog*", "git reflog", "git remote -v", "git remote show*",
  "git branch", "git branch -a", "git branch -r", "git branch -v", "git branch -vv", "git branch --show-current",
  "git branch --list*", "git tag -l*", "git tag --list*", "git stash list*", "git config --get*", "git config --list*",
  "git cat-file*", "git merge-base*", "git name-rev*", "git for-each-ref*", "git show-ref*", "git check-ignore*",
  "git count-objects*", "git worktree list*", "git submodule status*",
  ...VERSION_TOOLS.map((t) => `${t} --version`), "go version", "java -version",
];

/** Forms of those commands that write files or run other programs; these still ask. */
export const READ_ONLY_EXCEPTIONS = [
  "find *-delete*", "find *-exec*", "find *-ok*", "find *-fprint*", "find *-fls*",
  "fd *-x*", "fd *--exec*", "fd *-X*",
  "rg *--pre*",
  "sort *-o*", "sort *--output*",
  "git *--output*", "git *--ext-diff*", "git *--textconv*",
  // sed scripts can write (w, W, -i) or run commands (e).
  "sed *-i*", "sed *--in-place*", "sed *w *", "sed *W *", "sed *e *", "sed *;e*",
  "xxd *-r*",
];

/** The allowlist as rules, in order: last match wins. */
function readOnlyRules(): Rule[] {
  const rule = (pattern: string, action: Action): Rule => ({ permission: "bash", pattern, action });
  return [
    ...READ_ONLY_COMMANDS.map((c) => rule(c, "allow")),
    // OpenCode checks a command together with its redirects, so `cat a > b` would otherwise match `cat *`.
    // Redirects that only discard output are approved by the extension instead (see quietlyReadOnly).
    rule("*>*", "ask"),
    ...READ_ONLY_EXCEPTIONS.map((c) => rule(c, "ask")),
  ];
}

// Redirects that don't write a file: output thrown away or sent to the other stream.
const QUIET_REDIRECT = /\s*(?:\d|&)?>\s*\/dev\/null\s*$|\s*\d?>&\d\s*$/;

/** A command without its trailing `2>/dev/null`, `>/dev/null`, `2>&1` and the like. */
export function withoutQuietRedirects(command: string): string {
  let out = command.trim();
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(QUIET_REDIRECT, "");
  }
  return out;
}

/**
 * Whether a shell request only asked because of redirects that discard output: every command is
 * read-only once those are removed. Session rules can't express this without hundreds of patterns
 * (and OpenCode appends them on every change), so the extension approves these itself.
 */
export function quietlyReadOnly(patterns: string[], agentRules: Rule[], autoEdit: boolean): boolean {
  const rules = sessionRules(autoEdit, agentRules, true);
  return (
    patterns.length > 0 &&
    patterns.every((p) => evaluate("bash", withoutQuietRedirects(p), agentRules, rules) === "allow")
  );
}

/** Read-only agents (plan) deny edits; they get the "auto read-only" toggle instead of auto edits. */
export function isReadOnlyAgent(agentRules: Rule[]): boolean {
  return evaluate("edit", "src/file", agentRules) === "deny";
}

/** Whether the agent's own rules deny a request, which the extension then rejects on its behalf. */
export function deniedByAgent(agentRules: Rule[], permission: string, patterns: string[]): boolean {
  return patterns.some((p) => evaluate(permission, p, agentRules) === "deny");
}
