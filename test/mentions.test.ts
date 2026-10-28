import { describe, expect, it } from "vitest";
import { agentParts } from "../src/mentions";

const agents = new Set(["explore", "general", "code-reviewer"]);

describe("agentParts", () => {
  it("makes a part for a subagent mention, with where it sits in the text", () => {
    expect(agentParts("@explore where is the port chosen?", agents)).toEqual([
      { type: "agent", name: "explore", source: { value: "@explore", start: 0, end: 8 } },
    ]);
    expect(agentParts("ask @general, then stop", agents)[0].source).toEqual({ value: "@general", start: 4, end: 12 });
    expect(agentParts("Hand this to @explore.", agents).map((p) => p.name)).toEqual(["explore"]);
  });

  it("handles hyphenated names and several agents, each once", () => {
    const parts = agentParts("@code-reviewer and @explore, then @explore again", agents);
    expect(parts.map((p) => p.name)).toEqual(["code-reviewer", "explore"]);
  });

  it("leaves file mentions, unknown names and e-mail addresses alone", () => {
    expect(agentParts("see @src/explore.ts and @explore.md", agents)).toEqual([]);
    expect(agentParts("@build this", agents)).toEqual([]);
    expect(agentParts("mail me@explore", agents)).toEqual([]);
    // A file named like an agent is mentioned as ./explore, or with a line range.
    expect(agentParts("run @./explore and @explore#L3-9", agents)).toEqual([]);
  });
});
