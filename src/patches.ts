import { applyPatch, createPatch, parsePatch, reversePatch } from "diff";

/** Pure patch helpers behind the Changes panel and diff views (unit-tested). */

export interface Turn {
  patch: string;
  status?: string;
}

export interface FileChange {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: string;
}

/** Content of a file before an already-applied patch, or false if it no longer applies. */
export function unapply(current: string, diffText: string): string | false {
  const [patch] = parsePatch(diffText);
  if (!patch) return false;
  return applyPatch(current, reversePatch(patch));
}

export function countLines(patch: string) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of parsePatch(patch)[0]?.hunks ?? []) {
    for (const l of hunk.lines) {
      if (l[0] === "+") additions++;
      else if (l[0] === "-") deletions++;
    }
  }
  return { additions, deletions };
}

/**
 * Per-file patches recorded on each user message, in order, skipping turns at or after an undo point.
 * `messages` is OpenCode's /session/:id/message response.
 */
export function collectTurns(messages: any[], revertID?: string): Map<string, Turn[]> {
  const perFile = new Map<string, Turn[]>();
  for (const m of messages) {
    if (m.info.role !== "user" || (revertID && m.info.id >= revertID)) continue;
    for (const d of m.info.summary?.diffs ?? []) {
      if (!d.file || !d.patch) continue;
      if (!perFile.has(d.file)) perFile.set(d.file, []);
      perFile.get(d.file)!.push({ patch: d.patch, status: d.status });
    }
  }
  return perFile;
}

/**
 * The session-wide change for one file: walk its turns backwards from the current content to
 * recover the original, then diff original against current. Returns undefined if nothing changed.
 */
export function cumulativeChange(file: string, turns: Turn[], current: string, exists: boolean): FileChange | undefined {
  let original: string | false = current;
  for (const t of [...turns].reverse()) {
    original = original === false ? false : unapply(original, t.patch);
  }
  const created = turns[0].status === "added";
  if (original === false) {
    // File changed outside OpenCode since; fall back to the latest turn's patch.
    const last = turns[turns.length - 1];
    return { file, patch: last.patch, status: last.status ?? "modified", ...countLines(last.patch) };
  }
  if (original === current && exists) return undefined;
  const patch = createPatch(file, created ? "" : original, current);
  const status = created ? "added" : !exists ? "deleted" : "modified";
  return { file, patch, status, ...countLines(patch) };
}
