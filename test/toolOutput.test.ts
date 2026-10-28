import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain JS module from the webview bundle.
import { domain, lspHover, lspLocations, mainArg, mcpTool, parseGlob, parseGrep, parseSearch } from "../webview/toolOutput.js";

describe("parseGrep", () => {
  it("groups OpenCode's grep output by file", () => {
    const out = ["Found 3 matches", "/w/src/a.ts:", "  Line 4: const a = 1;", "  Line 9: a: 2", "", "/w/src/b.ts:", "  Line 1: export {}"].join("\n");
    expect(parseGrep(out)).toEqual({
      files: [
        { path: "/w/src/a.ts", lines: [{ line: 4, text: "const a = 1;" }, { line: 9, text: "a: 2" }] },
        { path: "/w/src/b.ts", lines: [{ line: 1, text: "export {}" }] },
      ],
      truncated: false,
    });
  });
  it("notices truncation, and gives up on anything else", () => {
    expect(parseGrep("Found 100 matches (more matches available)\n/w/a.ts:\n  Line 1: x")?.truncated).toBe(true);
    expect(parseGrep("No files found")).toBeNull();
  });
});

describe("parseGlob", () => {
  it("reads absolute paths and the truncation note", () => {
    expect(parseGlob("/w/a.ts\n/w/b.ts\n\n(Results are truncated: showing first 100 results.)")).toEqual({ paths: ["/w/a.ts", "/w/b.ts"], truncated: true });
    expect(parseGlob("No files found")).toBeNull();
    expect(parseGlob("something else")).toBeNull();
  });
});

describe("parseSearch", () => {
  it("reads Title/URL text blocks", () => {
    const out = "Title: Webview API\nURL: https://code.visualstudio.com/api/webview\nText: Webviews   render HTML.\n\nTitle: Other\nURL: https://example.com/x\nText: More";
    expect(parseSearch(out)).toEqual([
      { title: "Webview API", url: "https://code.visualstudio.com/api/webview", snippet: "Webviews render HTML." },
      { title: "Other", url: "https://example.com/x", snippet: "More" },
    ]);
  });
  it("finds a result list in JSON", () => {
    const out = JSON.stringify({ search_id: "s", results: [{ url: "https://a.dev/", title: "A", excerpts: ["one", "two"] }] });
    expect(parseSearch(out)).toEqual([{ title: "A", url: "https://a.dev/", snippet: "one two" }]);
  });
  it("gives up on plain text", () => {
    expect(parseSearch("No search results found.")).toBeNull();
    expect(domain("https://www.github.com/x")).toBe("github.com");
  });
});

describe("lsp results", () => {
  const range = (line: number) => ({ start: { line, character: 2 }, end: { line, character: 9 } });
  it("turns locations, links, symbols and calls into 1-based places", () => {
    expect(lspLocations([{ uri: "file:///w/a.ts", range: range(9) }])).toEqual([{ path: "/w/a.ts", line: 10 }]);
    expect(lspLocations([{ targetUri: "file:///w/b.ts", targetRange: range(0), targetSelectionRange: range(3) }])).toEqual([{ path: "/w/b.ts", line: 4 }]);
    expect(lspLocations([{ name: "f", location: { uri: "file:///w/c.ts", range: range(1) } }])).toEqual([{ path: "/w/c.ts", line: 2, name: "f" }]);
    expect(lspLocations([{ from: { name: "g", uri: "file:///w/d.ts", range: range(5), selectionRange: range(6) }, fromRanges: [] }])).toEqual([{ path: "/w/d.ts", line: 7, name: "g" }]);
  });
  it("puts document symbols in the file that was asked about", () => {
    const symbols = [{ name: "Server", kind: 5, range: range(0), selectionRange: range(1), children: [{ name: "start", kind: 6, range: range(4), selectionRange: range(4) }] }];
    expect(lspLocations(symbols, "/w/s.ts")).toEqual([
      { path: "/w/s.ts", line: 2, name: "Server" },
      { path: "/w/s.ts", line: 5, name: "start" },
    ]);
  });
  it("reads hover contents in any shape", () => {
    expect(lspHover([{ contents: { kind: "markdown", value: "**x**" } }])).toBe("**x**");
    expect(lspHover([{ contents: [{ language: "ts", value: "let x: number" }, "doc"] }])).toBe("```ts\nlet x: number\n```\n\ndoc");
  });
});

describe("MCP tools", () => {
  it("splits the server off by the longest matching name", () => {
    expect(mcpTool("github_create_issue", ["github"])).toEqual({ server: "github", name: "create issue" });
    expect(mcpTool("my_docs_get-page", ["my", "my_docs"])).toEqual({ server: "my_docs", name: "get page" });
    expect(mcpTool("context7_resolve", ["context.7"])).toBeNull();
    expect(mcpTool("context_7_resolve", ["context.7"])).toEqual({ server: "context.7", name: "resolve" });
    expect(mcpTool("bash", ["github"])).toBeNull();
  });
  it("puts the most telling argument in the header", () => {
    expect(mainArg({ owner: "o", repo: "r", title: "Links open twice", body: "…" })).toBe("Links open twice");
    expect(mainArg({ count: 3, topic: "webviews" })).toBe("webviews");
  });
});
