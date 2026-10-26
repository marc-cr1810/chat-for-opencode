import { describe, expect, it } from "vitest";
import { ListenUrlWatcher, SseParser, unwrapGlobalEvent } from "../src/streams";

describe("SseParser", () => {
  it("parses frames split across chunks", () => {
    const p = new SseParser();
    expect(p.feed('data: {"a":')).toEqual([]);
    expect(p.feed('1}\n\ndata: {"b":2}\n')).toEqual(['{"a":1}']);
    expect(p.feed("\n")).toEqual(['{"b":2}']);
  });

  it("joins multi-line data and ignores other fields", () => {
    const p = new SseParser();
    expect(p.feed("event: x\nid: 1\ndata: line1\ndata: line2\n\n")).toEqual(["line1\nline2"]);
  });

  it("handles CRLF line endings and skips frames without data", () => {
    const p = new SseParser();
    expect(p.feed(": keepalive\r\n\r\ndata: ok\r\n\r\n")).toEqual(["ok"]);
  });

  it("keeps a single space after 'data:' optional", () => {
    const p = new SseParser();
    expect(p.feed("data:tight\n\ndata:  two spaces\n\n")).toEqual(["tight", " two spaces"]);
  });
});

describe("unwrapGlobalEvent", () => {
  it("unwraps the payload and tags the directory", () => {
    const e = unwrapGlobalEvent(JSON.stringify({ directory: "/w", payload: { type: "session.idle", properties: { sessionID: "ses_1" } } }));
    expect(e).toEqual({ type: "session.idle", properties: { sessionID: "ses_1" }, directory: "/w" });
  });

  it("passes plain events through and rejects bad JSON", () => {
    expect(unwrapGlobalEvent('{"type":"x","properties":{}}')).toEqual({ type: "x", properties: {} });
    expect(unwrapGlobalEvent("{nope")).toBeUndefined();
  });
});

describe("ListenUrlWatcher", () => {
  it("finds the URL when the line arrives in pieces", () => {
    const w = new ListenUrlWatcher();
    expect(w.feed("Warning: OPENCODE_SERVER_PASSWORD is not set\nopencode server listening on http://127.0")).toBeUndefined();
    expect(w.feed(".0.1:4567")).toBeUndefined();
    expect(w.feed("\n")).toBe("http://127.0.0.1:4567");
  });

  it("strips a trailing slash", () => {
    expect(new ListenUrlWatcher().feed("listening on http://127.0.0.1:9/\n")).toBe("http://127.0.0.1:9");
  });
});
