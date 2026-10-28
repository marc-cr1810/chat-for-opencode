/** An OpenCode agent part: hands the prompt's work to that subagent. */
export interface AgentPart {
  type: "agent";
  name: string;
  source: { value: string; start: number; end: number };
}

/**
 * An agent part for each @name in the prompt that names one of `subagents`, once per agent.
 * File mentions (@src/app.ts) and names that aren't agents are left alone.
 */
export function agentParts(text: string, subagents: ReadonlySet<string>): AgentPart[] {
  const parts: AgentPart[] = [];
  // Punctuation may end the mention, but a dot only at the end of a sentence: @explore.md is a file.
  const re = /(^|\s)@([\w-]+)(?=$|[\s,;:!?)]|\.(?:\s|$))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[2];
    if (!subagents.has(name) || parts.some((p) => p.name === name)) continue;
    const start = m.index + m[1].length;
    parts.push({ type: "agent", name, source: { value: `@${name}`, start, end: start + name.length + 1 } });
  }
  return parts;
}
