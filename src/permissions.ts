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
export function sessionRules(autoEdit: boolean, agentRules: Rule[] = []): Rule[] {
  const ours: Rule[] = [
    { permission: "edit", pattern: "*", action: autoEdit ? "allow" : "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
  ];
  return ours.flatMap((rule) => {
    const agent = agentRules.filter((r) => wildcardMatch(rule.permission, r.permission));
    // Without denies the agent's rules make no difference: ours cover everything after them.
    if (!agent.some((r) => r.action === "deny")) return [rule];
    return [
      rule,
      ...agent.map((r): Rule => ({ permission: rule.permission, pattern: r.pattern, action: r.action === "deny" ? "ask" : rule.action })),
    ];
  });
}

/** Whether the agent's own rules deny a request, which the extension then rejects on its behalf. */
export function deniedByAgent(agentRules: Rule[], permission: string, patterns: string[]): boolean {
  return patterns.some((p) => evaluate(permission, p, agentRules) === "deny");
}
