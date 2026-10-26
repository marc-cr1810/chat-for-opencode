import { describe, expect, it } from "vitest";
import { deniedByAgent, evaluate, Rule, sessionRules, wildcardMatch } from "../src/permissions";

// The plan agent's rules as OpenCode 1.18 reports them (trimmed).
const plan: Rule[] = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "read", pattern: "*.env", action: "ask" },
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "edit", pattern: ".opencode/plans/*.md", action: "allow" },
];
const build: Rule[] = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "bash", pattern: "rm *", action: "deny" },
];

/** What OpenCode decides for a request, then what the extension does with an ask. */
const outcome = (agent: Rule[], autoEdit: boolean, permission: string, pattern: string) => {
  const action = evaluate(permission, pattern, agent, sessionRules(autoEdit, agent));
  return action === "ask" && deniedByAgent(agent, permission, [pattern]) ? "deny" : action;
};

describe("wildcardMatch", () => {
  it("follows OpenCode's rules", () => {
    expect(wildcardMatch("git status", "git status*")).toBe(true);
    expect(wildcardMatch("ls", "ls *")).toBe(true);
    expect(wildcardMatch("lsof", "ls *")).toBe(false);
    expect(wildcardMatch(".opencode/plans/a.md", ".opencode/plans/*.md")).toBe(true);
    expect(wildcardMatch("src/a.ts", ".opencode/plans/*.md")).toBe(false);
  });
});

describe("sessionRules", () => {
  it("never writes a deny, which OpenCode would copy to every later subagent", () => {
    for (const agent of [plan, build])
      for (const auto of [true, false]) expect(sessionRules(auto, agent).some((r) => r.action === "deny")).toBe(false);
  });

  it("keeps plan mode from editing, with auto mode on or off", () => {
    for (const auto of [true, false]) expect(outcome(plan, auto, "edit", "src/a.ts")).toBe("deny");
  });

  it("still lets plan mode write its plan files, following the toggle", () => {
    expect(outcome(plan, true, "edit", ".opencode/plans/x.md")).toBe("allow");
    expect(outcome(plan, false, "edit", ".opencode/plans/x.md")).toBe("ask");
  });

  it("applies the toggle to agents that allow edits", () => {
    expect(outcome(build, true, "edit", "src/a.ts")).toBe("allow");
    expect(outcome(build, false, "edit", "src/a.ts")).toBe("ask");
  });

  it("asks for shell commands but keeps the agent's command denies", () => {
    expect(outcome(build, true, "bash", "git status")).toBe("ask");
    expect(outcome(build, true, "bash", "rm -rf /")).toBe("deny");
  });

  it("leaves other permissions to the agent", () => {
    expect(outcome(plan, true, "read", ".env")).toBe("ask");
    expect(outcome(plan, true, "read", "a.ts")).toBe("allow");
  });

  it("overrides rules added earlier, since the server appends them", () => {
    const history = [...sessionRules(true, build), ...sessionRules(true, plan)];
    const action = evaluate("edit", "src/a.ts", plan, history);
    expect(action === "ask" && deniedByAgent(plan, "edit", ["src/a.ts"])).toBe(true);
  });
});
