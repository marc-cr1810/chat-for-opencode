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
 * Rules the extension puts on a session: edits ask (or are allowed in auto mode) and shell commands ask.
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
export function sessionRules(autoEdit: boolean, agentRules: Rule[] = [], autoRead = false): Rule[] {
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
    if (autoRead && rule.permission === "bash") {
      out.push(...READ_ONLY_COMMANDS.map((pattern): Rule => ({ permission: "bash", pattern, action: "allow" })));
      out.push(...READ_ONLY_EXCEPTIONS.map((pattern): Rule => ({ permission: "bash", pattern, action: "ask" })));
      // The agent's own denies still win over the allowlist.
      out.push(...denies);
    }
    return out;
  });
}

/**
 * Shell commands that only read, allowed without asking when "auto read-only" is on. OpenCode checks
 * each command in a chain, pipe or $(...) separately, so `ls && rm x` still asks for `rm x`.
 */
export const READ_ONLY_COMMANDS = [
  "ls *", "pwd", "cat *", "head *", "tail *", "wc *", "file *", "stat *", "du *", "df *", "tree *",
  "which *", "whereis *", "type *", "echo *", "printf *", "grep *", "egrep *", "fgrep *", "rg *", "fd *", "find *",
  "diff *", "cmp *", "cut *", "tr *", "sort *", "nl *", "column *", "jq *", "od *", "hexdump *",
  "basename *", "dirname *", "realpath *", "readlink *", "date *", "uname *", "whoami", "id *", "hostname",
  "git status*", "git log*", "git diff*", "git show*", "git blame*", "git grep*", "git ls-files*", "git ls-tree*",
  "git rev-parse*", "git describe*", "git shortlog*", "git reflog", "git remote -v", "git remote show*",
  "git branch", "git branch -a", "git branch -r", "git branch -v", "git branch -vv", "git branch --show-current",
  "git branch --list*", "git tag -l*", "git tag --list*", "git stash list*", "git config --get*", "git config --list*",
];

/** Forms of those commands that write files or run other programs; these still ask. */
export const READ_ONLY_EXCEPTIONS = [
  // OpenCode checks a command together with its redirect, so `cat a > b` would otherwise match `cat *`.
  "*>*",
  "find *-delete*", "find *-exec*", "find *-ok*", "find *-fprint*", "find *-fls*",
  "fd *-x*", "fd *--exec*", "fd *-X*",
  "rg *--pre*",
  "sort *-o*", "sort *--output*",
  "git *--output*", "git *--ext-diff*", "git *--textconv*",
];

/** Read-only agents (plan) deny edits; they get the "auto read-only" toggle instead of auto edits. */
export function isReadOnlyAgent(agentRules: Rule[]): boolean {
  return evaluate("edit", "src/file", agentRules) === "deny";
}

/** Whether the agent's own rules deny a request, which the extension then rejects on its behalf. */
export function deniedByAgent(agentRules: Rule[], permission: string, patterns: string[]): boolean {
  return patterns.some((p) => evaluate(permission, p, agentRules) === "deny");
}
