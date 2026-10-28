import { describe, expect, it } from "vitest";
import { deniedByAgent, evaluate, isReadOnlyAgent, quietlyReadOnly, Rule, sessionRules, withoutQuietRedirects, wildcardMatch } from "../src/permissions";

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
const outcome = (agent: Rule[], autoEdit: boolean, permission: string, pattern: string, autoRead = false) => {
  const action = evaluate(permission, pattern, agent, sessionRules(autoEdit, agent, autoRead));
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

describe("auto read-only", () => {
  const run = (cmd: string, agent = plan) => outcome(agent, false, "bash", cmd, true);

  it("only applies to agents that can't edit", () => {
    expect(isReadOnlyAgent(plan)).toBe(true);
    expect(isReadOnlyAgent(build)).toBe(false);
  });

  it("runs read-only commands without asking", () => {
    for (const cmd of ["ls", "ls -la src", "git status", "git log --oneline -5", "git diff HEAD~1", "rg foo src", "cat a.ts", "find . -name '*.ts'", "git branch"])
      expect(run(cmd), cmd).toBe("allow");
  });

  it("still asks for anything else", () => {
    for (const cmd of ["rm -rf x", "npm test", "git commit -m x", "git branch -D main", "git push", "sed -i s/a/b/ f", "lsof", "tee out"])
      expect(run(cmd), cmd).toBe("ask");
  });

  it("asks for read commands that write or run things", () => {
    for (const cmd of ["cat a > b", "echo hi >> f", "find . -delete", "find . -exec rm {} ;", "fd x -x rm", "rg --pre ./evil foo", "sort -o out in", "git diff --output=x"])
      expect(run(cmd), cmd).toBe("ask");
  });

  // OpenCode asks for these (the session rules ask on any `>`); the extension approves them itself.
  it("approves read-only commands that only discard output or merge streams", () => {
    expect(withoutQuietRedirects("ls x >/dev/null 2>&1")).toBe("ls x");
    for (const cmd of ["ls src 2>/dev/null", "git log --oneline -5 2>&1", "ls x >/dev/null 2>&1", "pwd 2>/dev/null", "rg foo > /dev/null", "cat a.ts &>/dev/null"])
      expect(quietlyReadOnly([cmd], plan, false), cmd).toBe(true);
    expect(quietlyReadOnly(["ls src 2>/dev/null", "head -5 a.ts"], build, true)).toBe(true);
  });

  it("leaves it to you when a redirect writes a file, or the command isn't read-only", () => {
    for (const cmd of ["cat a > b 2>/dev/null", "cat a > b 2>&1", "ls > out", "ls > out >/dev/null 2>&1", "rm x 2>/dev/null", "npm test 2>&1", "find . -delete 2>/dev/null", "sed -i s/a/b/ f 2>/dev/null"])
      expect(quietlyReadOnly([cmd], plan, false), cmd).toBe(false);
    expect(quietlyReadOnly(["ls 2>/dev/null", "npm test"], plan, false)).toBe(false);
    expect(quietlyReadOnly([], plan, false)).toBe(false);
  });

  it("covers the other everyday read-only commands", () => {
    for (const cmd of ["sed -n 1,40p src/chat.ts", "node --version", "go version", "env", "printenv PATH", "git rev-list --count HEAD", "test -f x", "xxd a.bin", "uniq -c", "git cat-file -p HEAD"])
      expect(run(cmd), cmd).toBe("allow");
    for (const cmd of ["sed -n '1w out' f", "sed --in-place s/a/b/ f", "env FOO=1 npm test", "xxd -r a b", "node script.js", "npx tsc --version"])
      expect(run(cmd), cmd).toBe("ask");
  });

  it("works for build's auto mode too, keeping its own denies", () => {
    expect(outcome(build, true, "bash", "git status", true)).toBe("allow");
    expect(outcome(build, true, "bash", "npm test", true)).toBe("ask");
    expect(outcome(build, true, "bash", "rm -rf /", true)).toBe("deny");
    expect(outcome(build, true, "edit", "src/a.ts", true)).toBe("allow");
  });

  it("keeps the agent's own command denies", () => {
    const strict: Rule[] = [...plan, { permission: "bash", pattern: "cat *", action: "deny" }];
    expect(run("cat secrets.txt", strict)).toBe("deny");
    expect(run("ls", strict)).toBe("allow");
  });

  it("is off unless asked for", () => {
    expect(outcome(plan, false, "bash", "ls")).toBe("ask");
  });
});
