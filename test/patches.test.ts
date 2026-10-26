import { describe, expect, it } from "vitest";
import { createPatch } from "diff";
import { collectTurns, countLines, cumulativeChange, unapply } from "../src/patches";

const v0 = "def add(a, b):\n    return a - b\n";
const v1 = "def add(a, b):\n    return a + b\n";
const v2 = "def add(a, b):\n    return a + b\n\n\ndef multiply(a, b):\n    return a * b\n";
// The shape OpenCode records on user messages (header lines with trailing tabs).
const opencodePatch =
  "Index: math.py\n===================================================================\n--- math.py\t\n+++ math.py\t\n" +
  "@@ -1,2 +1,6 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n+\n+\n+def multiply(a, b):\n+    return a * b\n";

const userMsg = (id: string, diffs: any[]) => ({ info: { id, role: "user", summary: { diffs } }, parts: [] });

describe("unapply", () => {
  it("recovers the original from a real OpenCode patch", () => {
    expect(unapply(v2, opencodePatch)).toBe(v0);
  });

  it("returns false when the file no longer matches", () => {
    expect(unapply("something else\n", opencodePatch)).toBe(false);
  });
});

describe("countLines", () => {
  it("counts additions and deletions", () => {
    expect(countLines(opencodePatch)).toEqual({ additions: 5, deletions: 1 });
  });
});

describe("collectTurns", () => {
  const messages = [
    userMsg("msg_1", [{ file: "math.py", patch: createPatch("math.py", v0, v1), status: "modified" }]),
    { info: { id: "msg_2", role: "assistant" }, parts: [] },
    userMsg("msg_3", [{ file: "math.py", patch: createPatch("math.py", v1, v2), status: "modified" }]),
    userMsg("msg_5", [{ file: "notes.txt", patch: createPatch("notes.txt", "", "hi\n"), status: "added" }]),
  ];

  it("groups patches per file in order", () => {
    const turns = collectTurns(messages);
    expect([...turns.keys()]).toEqual(["math.py", "notes.txt"]);
    expect(turns.get("math.py")).toHaveLength(2);
  });

  it("skips turns at or after the undo point", () => {
    const turns = collectTurns(messages, "msg_3");
    expect(turns.get("math.py")).toHaveLength(1);
    expect(turns.has("notes.txt")).toBe(false);
  });
});

describe("cumulativeChange", () => {
  const t1 = { patch: createPatch("math.py", v0, v1), status: "modified" };
  const t2 = { patch: createPatch("math.py", v1, v2), status: "modified" };

  it("combines several turns into one diff against the original", () => {
    const change = cumulativeChange("math.py", [t1, t2], v2, true)!;
    expect(change.status).toBe("modified");
    expect(unapply(v2, change.patch)).toBe(v0);
    expect(change).toMatchObject({ additions: 5, deletions: 1 });
  });

  it("reports nothing when a file ends up unchanged", () => {
    const noop = { patch: createPatch("math.py", v0, v0), status: "modified" };
    expect(cumulativeChange("math.py", [noop], v0, true)).toBeUndefined();
  });

  it("falls back to the latest patch when the file was edited back by hand", () => {
    expect(cumulativeChange("math.py", [t1, t2], v0, true)?.patch).toBe(t2.patch);
  });

  it("falls back to the latest patch when the file changed outside OpenCode", () => {
    const change = cumulativeChange("math.py", [t1, t2], "unrelated\n", true)!;
    expect(change.patch).toBe(t2.patch);
  });

  it("marks files OpenCode created as added", () => {
    const created = { patch: createPatch("notes.txt", "", "hi\n"), status: "added" };
    expect(cumulativeChange("notes.txt", [created], "hi\n", true)).toMatchObject({ status: "added", additions: 1, deletions: 0 });
  });

  it("marks files that no longer exist as deleted", () => {
    const removed = { patch: createPatch("old.txt", "bye\n", ""), status: "modified" };
    expect(cumulativeChange("old.txt", [removed], "", false)).toMatchObject({ status: "deleted", deletions: 1 });
  });
});
