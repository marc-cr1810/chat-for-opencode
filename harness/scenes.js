// Conversations for the harness, built from the same message and part shapes OpenCode's API returns.
// They are written by hand (no real user data); the text describes this extension accurately so the
// screenshots read sensibly.

const CWD = "/home/dev/chat-for-opencode";
const T0 = Date.UTC(2026, 9, 26, 9, 0, 0);

// IDs sort in creation order, as OpenCode's do, and the webview orders messages by ID: create each
// user message before its reply.
let seq = 0;
const id = (prefix) => `${prefix}_${String(++seq).padStart(4, "0")}`;

function session(title, extra = {}) {
  return { id: id("ses"), title, directory: CWD, time: { created: T0, updated: T0 + 60_000 }, ...extra };
}

// Replies answer the user message before them, as OpenCode's parentID says.
let lastUser;

/** A user message. */
function user(s, text, agent = "build") {
  const info = { id: id("msg"), sessionID: s.id, role: "user", agent, model: { providerID: "opencode", modelID: "big-pickle" }, time: { created: T0 } };
  lastUser = info.id;
  return { info, parts: [{ id: id("prt"), messageID: info.id, sessionID: s.id, type: "text", text }] };
}

/**
 * An assistant message; `parts` come from the helpers below. Pass done: false for one still streaming,
 * and finish: "tool-calls" for a step that another follows.
 */
function assistant(s, agent, parts, { done = true, tokens = 12_000, output = 800, cost = 0, secs = 20, finish = "stop", model = "big-pickle" } = {}) {
  const info = {
    id: id("msg"),
    sessionID: s.id,
    parentID: lastUser,
    role: "assistant",
    agent,
    mode: agent,
    modelID: model,
    providerID: "opencode",
    path: { cwd: CWD, root: CWD },
    cost,
    tokens: { input: tokens, output, reasoning: 0, cache: { read: 0, write: 0 } },
    time: done ? { created: T0, completed: T0 + secs * 1000 } : { created: T0 },
    ...(done ? { finish } : {}),
  };
  return { info, parts: parts.map((p) => ({ id: id("prt"), messageID: info.id, sessionID: s.id, ...p })) };
}

const text = (t) => ({ type: "text", text: t, time: { start: T0, end: T0 + 1000 } });
const reasoning = (t, secs) => ({ type: "reasoning", text: t, time: { start: T0, end: T0 + secs * 1000 } });
/** A tool call; status defaults to completed. */
const tool = (name, input, output = "", extra = {}) => ({
  type: "tool",
  tool: name,
  callID: id("call"),
  state: { status: "completed", input, output, title: "", metadata: {}, time: { start: T0, end: T0 + 500 } },
  ...extra,
});
/** File contents as OpenCode's read tool returns them: numbered lines. */
const numbered = (lines) => Array.from({ length: lines }, (_, i) => `${String(i + 1).padStart(5, "0")}| …`).join("\n");

export const scenes = {
  /** Nothing loaded: the empty state. */
  empty() {
    return { cwd: CWD, agent: "build" };
  },

  /**
   * Subagents: two started together (one done, one still running), then a single long-running one
   * whose older steps fold away, and a shell step with coloured output.
   */
  subagents() {
    const s = session("SSE reconnects");
    const src = (f) => `${CWD}/src/${f}`;
    const step = (child, tool, input, status = "completed") => ({ id: id("prt"), sessionID: child, messageID: `${child}-m`, type: "tool", tool, callID: id("call"), state: { status, input, output: "", time: { start: T0 } } });
    const say = (child, t) => ({ id: id("prt"), sessionID: child, messageID: `${child}-m`, type: "text", text: t });
    const task = (description, subagent_type, child, status, output = "", secs = 35) => {
      const t = tool("task", { description, subagent_type, prompt: "…" }, output);
      t.state.metadata = { sessionId: child };
      t.state.status = status;
      // Relative to now, so a batch's overall time reads sensibly.
      t.state.time = status === "running" ? { start: Date.now() - secs * 1000 } : { start: Date.now() - (secs + 8) * 1000, end: Date.now() - 8000 };
      return t;
    };
    const report = `<task_result>
## SSE parsing

Two places parse the event stream:

- \`src/streams.ts:12\` splits the body into events and keeps a partial line across chunks
- \`src/server.ts:88\` reconnects with a capped backoff

Both handle a dropped connection, and nothing else in \`src/\` reads \`text/event-stream\`.
</task_result>`;
    const esc = "\u001b";
    const testOut = `${esc}[32m✓${esc}[39m test/streams.test.ts ${esc}[2m(12 tests)${esc}[22m\n${esc}[31m✗${esc}[39m test/patches.test.ts ${esc}[2m(1 failed)${esc}[22m\n\n ${esc}[1m${esc}[32mTests${esc}[39m${esc}[22m  32 passed | ${esc}[31m1 failed${esc}[39m`;
    return {
      cwd: CWD,
      agent: "build",
      busy: true,
      session: s,
      children: {
        ses_find: [
          step("ses_find", "grep", { pattern: "text/event-stream", path: src("") }),
          step("ses_find", "read", { filePath: src("streams.ts") }),
          step("ses_find", "read", { filePath: src("server.ts") }),
          step("ses_find", "glob", { pattern: "**/*.ts", path: src("") }),
        ],
        ses_check: [
          step("ses_check", "read", { filePath: src("server.ts") }),
          step("ses_check", "grep", { pattern: "reconnect|backoff", path: src("") }),
          step("ses_check", "bash", { command: "npx vitest run test/streams.test.ts" }, "running"),
          say("ses_check", "Running the stream tests to see how a dropped connection is handled."),
        ],
        ses_audit: [
          ...["streams.ts", "server.ts", "chat.ts", "extension.ts", "settings.ts", "permissions.ts", "patches.ts", "diffProvider.ts", "codeActions.ts"].map((f) => step("ses_audit", "read", { filePath: src(f) })),
          step("ses_audit", "read", { filePath: src("server.ts") }),
          step("ses_audit", "grep", { pattern: "reconnect|backoff", path: src("") }),
          step("ses_audit", "bash", { command: "npx vitest run test/streams.test.ts" }, "running"),
          say("ses_audit", "The tests pass.\n\nChecking the backoff ceiling next…"),
        ],
      },
      messages: [
        user(s, "Find every place we parse SSE events and check they handle reconnects."),
        assistant(s, "build", [
          text("I'll split this between two agents."),
          task("Find SSE parsing code", "explore", "ses_find", "completed", report, 35),
          task("Check reconnect handling", "general", "ses_check", "running", "", 42),
        ], { done: true }),
        user(s, "Now audit the whole extension for the same problem."),
        assistant(s, "build", [
          task("Audit reconnect handling", "general", "ses_audit", "running", "", 64),
          tool("bash", { command: "npm test" }, testOut),
        ], { done: false }),
      ],
    };
  },

  /** A finished edit and a new file, both highlighted by their file's language. */
  changes() {
    const s = session("Debounce the resize handler");
    const file = `${CWD}/webview/layout.ts`;
    const diff = [
      `Index: ${file}`,
      "===================================================================",
      `--- ${file}`,
      `+++ ${file}`,
      "@@ -1,9 +1,11 @@",
      ` import { measure } from "./measure";`,
      "+import { debounce } from \"./debounce\";",
      " ",
      " /**",
      "  * Lays the panel out again; called on every resize.",
      "  */",
      " export function layout(width: number) {",
      "   const cols = Math.max(1, Math.floor(width / 320));",
      "   return measure(cols);",
      " }",
      "-window.addEventListener(\"resize\", () => layout(window.innerWidth));",
      "+",
      "+window.addEventListener(\"resize\", debounce(() => layout(window.innerWidth), 100));",
      "",
    ].join("\n");
    const content = `/** Calls fn once calls stop for \`ms\` milliseconds. */
export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms = 200) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: T) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
`;
    const edit = tool("edit", { filePath: file, oldString: "window.addEventListener", newString: "window.addEventListener" });
    edit.state.metadata = { diff };
    return {
      cwd: CWD,
      agent: "build",
      session: s,
      messages: [
        user(s, "Debounce the resize handler in layout.ts"),
        assistant(s, "build", [
          tool("write", { filePath: `${CWD}/webview/debounce.ts`, content }),
          edit,
          text("Added `webview/debounce.ts` and wrapped the resize handler in it."),
        ]),
      ],
    };
  },

  /**
   * Files and the rest of what replies can carry: an apply_patch over several files, a Read of an
   * image and a PDF, files the model returned, workspace images in markdown (one missing), a command
   * run as a subtask, links with line anchors, and each turn's time, tokens and cost.
   */
  files() {
    const s = session("Docs and review");
    const rel = (f) => `${CWD}/${f}`;
    const patch = (f, lines) => [`Index: ${f}`, "===================================================================", `--- ${f}`, `+++ ${f}`, ...lines, ""].join("\n");
    const serverPatch = patch(rel("src/server.ts"), [
      "@@ -117,5 +117,5 @@",
      "   private scheduleRetry(attempt: number) {",
      "-    const delay = this.retryDelay * 2 ** attempt;",
      "+    const delay = this.backoffMs * 2 ** attempt;",
      "     this.timer = setTimeout(() => this.connect(), Math.min(delay, 30_000));",
      "   }",
    ]);
    const applyPatch = tool("apply_patch", { patchText: "*** Begin Patch\n…\n*** End Patch" }, "Success. Updated the following files:\nM src/server.ts\nM src/settings.ts\nA test/backoff.test.ts");
    applyPatch.state.metadata = {
      files: [
        { filePath: rel("src/server.ts"), relativePath: "src/server.ts", type: "update", patch: serverPatch, additions: 1, deletions: 1 },
        { filePath: rel("src/settings.ts"), relativePath: "src/settings.ts", type: "update", patch: patch(rel("src/settings.ts"), ["@@ -40,3 +40,3 @@", "-  retryDelay: number;", "+  backoffMs: number;", "   retries: number;"]), additions: 1, deletions: 1 },
        { filePath: rel("test/backoff.test.ts"), relativePath: "test/backoff.test.ts", type: "add", patch: patch(rel("test/backoff.test.ts"), ["@@ -0,0 +1,2 @@", '+import { expect, test } from "vitest";', '+test("backoff caps at 30s", () => expect(Math.min(1000 * 2 ** 10, 30_000)).toBe(30_000));']), additions: 2, deletions: 0 },
      ],
    };

    // Drawn stand-ins for a screenshot and a diagram (no real images).
    const svgUrl = (body, w, hgt) => `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}">${body}</svg>`)}`;
    const shot = svgUrl(
      `<rect width="640" height="400" fill="#181818"/><line x1="0" y1="36" x2="640" y2="36" stroke="#2b2b2b"/><rect x="16" y="12" width="150" height="12" rx="3" fill="#ccc" opacity=".7"/>` +
        `<rect x="16" y="52" width="300" height="34" rx="7" fill="#313131" stroke="#2b2b2b"/><rect x="28" y="64" width="220" height="10" rx="3" fill="#ccc" opacity=".6"/>` +
        `<line x1="20" y1="102" x2="20" y2="190" stroke="#2b2b2b" stroke-width="2"/><rect x="34" y="128" width="560" height="56" rx="5" fill="#2b2b2b"/>` +
        `<rect x="34" y="138" width="560" height="10" fill="#9bb955" opacity=".3"/><rect x="34" y="158" width="560" height="10" fill="#f00" opacity=".25"/>` +
        `<rect x="16" y="206" width="520" height="10" rx="3" fill="#ccc" opacity=".5"/><rect x="16" y="318" width="608" height="66" rx="10" fill="#313131" stroke="#5c9cf5"/><circle cx="604" cy="367" r="10" fill="#5c9cf5"/>`,
      640,
      400,
    );
    const node = (x, y, t) => `<rect x="${x}" y="${y}" width="130" height="36" rx="6" fill="#2b2b2b" stroke="#5c9cf5"/><text x="${x + 65}" y="${y + 23}" font-family="sans-serif" font-size="13" fill="#ccc" text-anchor="middle">${t}</text>`;
    const flow = svgUrl(`<rect width="560" height="120" fill="#1f1f1f"/>${node(20, 40, "Webview")}${node(215, 40, "Extension")}${node(410, 40, "OpenCode")}<path d="M150 58h63M345 58h63" stroke="#ccc" stroke-opacity=".6"/>`, 560, 120);

    const readImage = tool("read", { filePath: rel("docs/screenshot-dark.png") }, "Image read successfully");
    readImage.state.attachments = [{ type: "file", mime: "image/svg+xml", url: shot }];
    const readPdf = tool("read", { filePath: rel("docs/spec.pdf") }, "PDF read successfully");
    readPdf.state.attachments = [{ type: "file", mime: "application/pdf", url: `data:application/pdf;base64,${btoa("%PDF-1.4 " + "x".repeat(2000))}` }];
    const notes = "# Screenshot notes\n\nThe header now has a dropdown in place of the tab strip.\n";

    const review = tool("task", { description: "Review src/chat.ts", subagent_type: "review", prompt: "…" }, "<task_result>\n**2 findings.** `openExternal` accepts any http(s) URL from the webview.\n</task_result>");
    review.state.metadata = { sessionId: "ses_review" };

    const messages = [
      user(s, "Rename retryDelay to backoffMs everywhere"),
      assistant(s, "build", [applyPatch], { finish: "tool-calls", tokens: 14_200, output: 310, cost: 0.011, secs: 9 }),
      assistant(s, "build", [text("Renamed `retryDelay` to `backoffMs` in `src/server.ts` and `src/settings.ts`, and added `test/backoff.test.ts`.")], { tokens: 15_100, output: 120, cost: 0.006, secs: 12 }),
      user(s, "Does the screenshot in docs/ still match the panel? Then give me a diagram of the event flow."),
      assistant(s, "build", [
        readImage,
        readPdf,
        text("The screenshot still shows the old tab strip; the header now has a dropdown instead. Here's the event flow:"),
        { type: "file", mime: "image/svg+xml", filename: "event-flow.svg", url: flow },
        { type: "file", mime: "text/markdown", filename: "screenshot-notes.md", url: `data:text/markdown;base64,${btoa(notes)}` },
      ], { tokens: 18_400, output: 640, cost: 0.024, secs: 31 }),
      user(s, "Update the screenshots section of the README"),
      assistant(s, "build", [
        text(`## Screenshots

The chat panel in the side bar, mid-edit:

![Chat panel, dark theme](docs/screenshot-dark.png)

I left the old tab-strip image out, since it no longer exists: ![Tabs](docs/tabs.png)

The retry loop is [startRetry](src/server.ts#L120-L140), and its delay comes from [the settings](src/settings.ts:40). [OpenCode's docs](https://opencode.ai/docs) cover the server side.`),
      ], { tokens: 19_000, output: 410, cost: 0.018, secs: 14 }),
    ];
    // A command whose agent is a subagent: the user message is a single subtask part.
    const cmd = user(s, "");
    cmd.parts = [{ id: id("prt"), messageID: cmd.info.id, sessionID: s.id, type: "subtask", agent: "review", command: "review", description: "review changes", prompt: "Review the changes in src/chat.ts for bugs and risky behaviour." }];
    messages.push(cmd, assistant(s, "build", [review, text("The review agent found two issues; the first, in `src/chat.ts:544`, is worth fixing before release.")], { tokens: 21_300, output: 520, cost: 0.031, secs: 52 }));

    return {
      cwd: CWD,
      agent: "build",
      session: s,
      images: { "docs/screenshot-dark.png": shot },
      children: { ses_review: [] },
      messages,
    };
  },

  /**
   * Tool steps that show structure: grep matches and glob files to open, MCP calls with their
   * arguments, lsp lookups, the plan agent handing over to build, a fetched page and web search
   * results, and tool calls the model got wrong.
   */
  tools() {
    const s = session("Tool steps");
    const abs = (f) => `${CWD}/${f}`;
    const done = (name, input, output, metadata = {}) => {
      const t = tool(name, input, output);
      t.state.metadata = metadata;
      return t;
    };
    const grepOut = [
      "Found 6 matches",
      `${abs("src/server.ts")}:`,
      "  Line 42:   private retryDelay = 1000;",
      "  Line 119:     const delay = this.retryDelay * 2 ** attempt;",
      "  Line 131:     this.retryDelay = settings.retryDelay;",
      "",
      `${abs("src/settings.ts")}:`,
      "  Line 40:   retryDelay: number;",
      '  Line 77:   retryDelay: get("retryDelay", 1000),',
      "",
      `${abs("src/chat.ts")}:`,
      "  Line 388:       retryDelay: this.server.retryDelay,",
    ].join("\n");
    const tests = Array.from({ length: 24 }, (_, i) => abs(`test/case${String(i + 1).padStart(2, "0")}.test.ts`));
    const range = (line) => ({ start: { line: line - 1, character: 2 }, end: { line: line - 1, character: 12 } });
    const loc = (f, line) => ({ uri: `file://${abs(f)}`, range: range(line) });

    const issue = done(
      "github_create_issue",
      { owner: "marc-cr1810", repo: "chat-for-opencode", title: "Links open twice in the chat panel", labels: ["bug"], body: "VS Code's webview wrapper opens links from a window listener.\nThe panel opens them too." },
      JSON.stringify({ number: 214, url: "https://github.com/marc-cr1810/chat-for-opencode/issues/214", state: "open" }),
    );
    const docs = tool("context7_get-library-docs", { libraryName: "vscode webview API" });
    docs.state.status = "running";

    // plan_exit: first answered No, then Yes, after which OpenCode adds a hidden note for build.
    const planTurns = () => {
      const ask = user(s, "Plan the debounce change", "plan");
      const kept = assistant(s, "plan", [text("The plan is in `.opencode/plans/debounce.md`: one helper, one call site, a test."), done("plan_exit", {}, "")]);
      Object.assign(kept.parts[1].state, { status: "error", error: "The user dismissed this question" });
      const yes = user(s, "Fine, go ahead", "plan");
      const handover = assistant(s, "plan", [done("plan_exit", {}, "User approved switching to build agent. Wait for further instructions.")]);
      const note = user(s, "", "build");
      note.parts = [{ id: id("prt"), messageID: note.info.id, sessionID: s.id, type: "text", synthetic: true, text: "The plan at .opencode/plans/debounce.md has been approved, you can now edit files. Execute the plan" }];
      return [ask, kept, yes, handover, note, assistant(s, "build", [tool("write", { filePath: abs("webview/debounce.ts"), content: "export {};\n" })])];
    };

    const page = `# Webview API

The webview API allows extensions to create fully customizable views within Visual Studio Code. Webviews can render almost any HTML content and communicate with extensions using [message passing](/api/references/vscode-api#Webview).

## Links

Links in webviews open through the editor; see server.ts in the samples. ![Diagram](/assets/api/webview.png)

${"More of the guide follows. ".repeat(40)}`;
    const searchOut = [
      "Title: Error loading webview: Could not register service worker",
      "URL: https://github.com/microsoft/vscode/issues/125993",
      "Text: InvalidStateError after updating; deleting the Service Worker cache folder and restarting fixes it for most people.",
      "",
      "Title: Webview API | Visual Studio Code Extension API",
      "URL: https://code.visualstudio.com/api/extension-guides/webview",
      "Text: Webviews are loaded in an iframe with a service worker that serves local resources.",
    ].join("\n");

    const messages = [
      user(s, "Where is retryDelay used, and which tests are there?"),
      assistant(s, "build", [done("grep", { pattern: "retryDelay", path: abs("src") }, grepOut, { matches: 6, truncated: false }), done("glob", { pattern: "**/*.test.ts" }, tests.join("\n"), { count: 24, truncated: false })]),
      user(s, "Who calls startRetry, and what's in watchdog.ts?"),
      assistant(s, "build", [
        done("lsp", { operation: "goToDefinition", filePath: abs("src/chat.ts"), line: 210, character: 14 }, "[]", { result: [{ targetUri: `file://${abs("src/server.ts")}`, targetRange: range(120), targetSelectionRange: range(120) }] }),
        done("lsp", { operation: "findReferences", filePath: abs("src/server.ts"), line: 120, character: 11 }, "[]", { result: [loc("src/server.ts", 88), loc("src/server.ts", 126), loc("src/chat.ts", 210)] }),
        done("lsp", { operation: "documentSymbol", filePath: abs("src/watchdog.ts") }, "[]", { result: [{ name: "watchServer", kind: 12, range: range(21), selectionRange: range(21), children: [] }] }),
        done("lsp", { operation: "hover", filePath: abs("src/server.ts"), line: 120, character: 11 }, "[]", { result: [{ contents: { kind: "markdown", value: "```ts\n(method) OpencodeServer.startRetry(attempt: number): void\n```" } }] }),
      ]),
      user(s, "File an issue for the link bug"),
      assistant(s, "build", [issue, docs], { done: false }),
      ...planTurns(),
      user(s, "Why does VS Code say it could not register a service worker?"),
      assistant(s, "build", [done("websearch", { query: "vscode webview could not register service worker" }, searchOut), done("webfetch", { url: "https://code.visualstudio.com/api/extension-guides/webview", format: "markdown" }, page)]),
      user(s, "Read server.ts and tidy the retry code"),
      assistant(s, "build", [
        done("invalid", { tool: "read_file", error: "Model tried to call unavailable tool 'read_file'. Available tools: read, edit, write." }, "The arguments provided to the tool are invalid: Model tried to call unavailable tool 'read_file'."),
        done("invalid", { tool: "edit", error: "Invalid input for tool edit: oldString is required" }, "The arguments provided to the tool are invalid: Invalid input for tool edit: oldString is required"),
      ]),
    ];
    return {
      cwd: CWD,
      agent: "build",
      session: s,
      messages,
      lines: {
        [`${abs("src/server.ts")}:120`]: "private startRetry(attempt: number) {",
        [`${abs("src/server.ts")}:88`]: "this.startRetry(0);",
        [`${abs("src/server.ts")}:126`]: "this.startRetry(attempt + 1);",
        [`${abs("src/chat.ts")}:210`]: "this.server.startRetry(0);",
        [`${abs("src/watchdog.ts")}:21`]: "export function watchServer(serverPid: number, ownerPid = process.pid, everyMs = 1000) {",
      },
    };
  },

  /** The rest of the markdown: alerts, task lists, safe inline HTML, images, footnotes and a diagram. */
  extras() {
    const s = session("Release checklist");
    const f = "```";
    return {
      cwd: CWD,
      agent: "plan",
      session: s,
      messages: [
        user(s, "What's left before the 0.6 release?", "plan"),
        assistant(s, "plan", [
          text(`> [!NOTE]
> The math and highlighting work is done but not committed yet.

> [!WARNING]
> Mermaid adds 3.4 MB to the package, though it only loads when a reply has a diagram.

**Checklist**

- [x] Render math with KaTeX
- [x] Highlight code blocks
- [ ] Update the README screenshots
- [ ] Bump the version to 0.6.0

Press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>O</kbd> to open the chat. Water is H<sub>2</sub>O, and E = mc<sup>2</sup>. A <mark>highlighted</mark> word; <script>alert(1)</script> and <img src=x onerror=alert(1)> stay as text.

<details>
<summary>How the release workflow runs</summary>

Pushing a \`v*\` tag builds the package and attaches it to a GitHub release.

</details>

The build copies KaTeX and Mermaid into \`dist/\`[^assets], and the webview loads Mermaid lazily[^lazy].

${f}mermaid
flowchart LR
  A[Reply text] --> B{Has a mermaid block?}
  B -- no --> C[Markdown only]
  B -- yes --> D[Load mermaid.min.js]
  D --> E[Render SVG]
${f}

${f}mermaid
sequenceDiagram
  participant W as Webview
  participant E as Extension
  participant O as OpenCode
  W->>E: prompt
  E->>O: POST /session/:id/prompt_async
  O-->>E: message.part.updated
  E-->>W: event
${f}

[^assets]: KaTeX's stylesheet and fonts, and Mermaid's prebuilt bundle.
[^lazy]: On the first reply that contains a diagram.`),
        ]),
      ],
    };
  },

  /** Fenced code in a few languages, highlighted, plus an unlabelled block left plain. */
  code() {
    const s = session("Debounce helper");
    const f = "```";
    return {
      cwd: CWD,
      agent: "build",
      session: s,
      messages: [
        user(s, "Write a debounce helper, in TypeScript and Python."),
        assistant(s, "build", [
          text(`TypeScript:

${f}ts
// Calls fn once calls stop for \`ms\` milliseconds.
export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms = 200) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: T) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
${f}

Python:

${f}python
import threading

def debounce(ms: float = 200):
    """Run the wrapped function once calls stop for ms milliseconds."""
    def wrap(fn):
        timer = None
        def call(*args, **kwargs):
            nonlocal timer
            if timer:
                timer.cancel()
            timer = threading.Timer(ms / 1000, fn, args, kwargs)
            timer.start()
        return call
    return wrap
${f}

The change to the caller:

${f}diff
-window.addEventListener("resize", layout);
+window.addEventListener("resize", debounce(layout, 100));
${f}

${f}
plain output, no language
${f}`),
        ]),
      ],
    };
  },

  /** Inline and display math, plus dollar amounts that must stay text. */
  math() {
    const s = session("Quadratic formula");
    return {
      cwd: CWD,
      agent: "build",
      session: s,
      messages: [
        user(s, "What are the roots of $ax^2 + bx + c = 0$?"),
        assistant(s, "build", [
          text(String.raw`For $a \neq 0$ the roots are

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

The discriminant \(\Delta = b^2 - 4ac\) decides how many real roots there are:

\[
\begin{cases} \Delta > 0 & \text{two} \\ \Delta = 0 & \text{one} \\ \Delta < 0 & \text{none} \end{cases}
\]

A sum like $\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$ works inline too, while prices like $5 and $10 stay as text, and ${"`"}$HOME${"`"} in code is left alone.`),
        ]),
      ],
    };
  },

  /** Plan agent reading the code, then a long markdown answer. */
  walkthrough() {
    const s = session("How the extension talks to OpenCode");
    return {
      cwd: CWD,
      agent: "plan",
      session: s,
      messages: [
        user(s, "How does this extension talk to OpenCode?", "plan"),
        assistant(s, "plan", [
          reasoning("Start with the entry point and the server wrapper, then follow a prompt through.", 3),
          tool("glob", { pattern: "src/**/*.ts" }, "src/chat.ts\nsrc/codeActions.ts\nsrc/diffProvider.ts\nsrc/extension.ts\nsrc/patches.ts\nsrc/permissions.ts\nsrc/server.ts\nsrc/settings.ts\nsrc/streams.ts"),
          tool("read", { filePath: `${CWD}/src/server.ts` }, numbered(168)),
          tool("read", { filePath: `${CWD}/src/streams.ts` }, numbered(64)),
        ]),
        assistant(s, "plan", [
          tool("grep", { pattern: "prompt_async", path: `${CWD}/src` }, "src/chat.ts:644\nsrc/chat.ts:171"),
          tool("bash", { command: "git log --oneline -3" }, "40fab83 Release title uses the new name\n047303a Screenshots for the README and store listing\n4d744bf Point links at the renamed repo"),
          reasoning("Enough to explain the flow.", 2),
          text(`It runs OpenCode as a local server and talks to it over HTTP, so anything you've configured for the CLI works here too.

**Starting the server**
\`server.ts\` spawns \`opencode serve\` in your workspace on a free port and restarts it if it exits. Every request carries the workspace directory, so worktree conversations reach the right checkout.

**Listening**
It keeps one stream open on \`/global/event\`. \`streams.ts\` splits it into events, and each \`ChatController\` picks out the ones for its conversations:

- \`message.part.updated\` streams text, reasoning and tool steps
- \`permission.asked\` and \`question.asked\` become the cards above the input
- \`session.status\` drives the status line, including retries

**Sending**
A prompt goes to \`POST /session/:id/prompt_async\` with the agent and model you picked (\`src/chat.ts:644\`):

\`\`\`ts
await this.req("POST", \`/session/\${sessionID}/prompt_async\`, { parts, agent, model });
\`\`\`

The reply arrives on the event stream, so sending and rendering stay separate.`),
        ], { tokens: 94_000 }),
      ],
    };
  },

  /** A finished review with the agent asking two questions; the run is still going. */
  question() {
    const s = session("Bug review and fix plan");
    const ask = user(s, "Review this extension for bugs and plan the fixes", "plan");
    const q = tool(
      "question",
      {
        questions: [
          {
            question: "Which fixes should I make once you leave plan mode?",
            header: "Fix scope",
            options: [
              { label: "P1 only (Recommended)", description: "Wrong-tab actions, cancel edit, close-tab safety, delete confirmation." },
              { label: "P1 + P2", description: "Also restart handling, stale cards and the server process leak." },
              { label: "All findings", description: "Include the P3 robustness and polish items too." },
            ],
          },
          {
            question: "What should closing a conversation that owns a worktree do?",
            header: "Worktree close",
            options: [
              { label: "Confirm and remove (Recommended)", description: "Warn that unapplied changes are lost, then remove the worktree and branch." },
              { label: "Refuse to close", description: "Require Apply or Remove first." },
              { label: "Close and keep it", description: "Leave the worktree on disk." },
            ],
          },
        ],
      },
      "",
    );
    q.state = { status: "running", input: q.state.input, time: { start: T0 } };
    const answer = assistant(
      s,
      "plan",
      [
        text(`Review done; no files changed and \`npx tsc --noEmit\` passes.

**P1 — correctness**
- **Wrong conversation after a switch:** handlers read \`this.tab\` again after an \`await\`, so switching mid-request can act on another conversation. Capture the tab at the start instead.
- **Cancel edit does nothing:** the re-render skips bubbles still marked \`.editing\`.

**P2 — lifecycle**
- **Server restart:** the panel keeps the old models and agents until reloaded.

**Plan**
1. Capture the tab, session and directory at the start of each handler.
2. Re-send \`init\` after a restart.
3. Add tests for both.`),
        q,
      ],
      { done: false, tokens: 61_000 },
    );
    const qp = answer.parts[1];
    return {
      cwd: CWD,
      agent: "plan",
      busy: true,
      session: s,
      messages: [ask, answer],
      question: { id: "que_0001", sessionID: s.id, questions: qp.state.input.questions, tool: { messageID: answer.info.id, callID: qp.callID } },
    };
  },

  /** Build agent about to edit a file, waiting for approval. */
  edit() {
    const s = session("Fix the add bug", { directory: "/home/dev/calc" });
    const ask = user(s, "Fix the bug in math.py");
    const file = "/home/dev/calc/math.py";
    const diff = `Index: ${file}\n===================================================================\n--- ${file}\n+++ ${file}\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n`;
    const edit = tool("edit", { filePath: file, oldString: "return a - b", newString: "return a + b" });
    edit.state = { status: "running", input: edit.state.input, time: { start: T0 } };
    const reply = assistant(s, "build", [tool("read", { filePath: file }, numbered(6)), text("`add` subtracts instead of adding. Fixing it:"), edit], { done: false, tokens: 9_000 });
    const ep = reply.parts[2];
    return {
      cwd: "/home/dev/calc",
      agent: "build",
      busy: true,
      session: s,
      messages: [ask, reply],
      permission: { id: "per_0001", sessionID: s.id, permission: "edit", patterns: ["math.py"], always: ["*"], metadata: { filepath: file, diff }, tool: { messageID: reply.info.id, callID: ep.callID } },
    };
  },

  /** The walkthrough, with two conversations running in the background and some history. */
  history() {
    const base = scenes.walkthrough();
    const tab = (key, title, status, sessionID) => ({ key, sessionID, title, status });
    return {
      ...base,
      tabs: [
        tab("t1", base.session.title, "idle", base.session.id),
        tab("t2", "Bug review and fix plan", "attention", "ses_bg1"),
        tab("t3", "Add a multiply function", "busy", "ses_bg2"),
      ],
      sessions: [
        { id: "ses_h1", title: "Tabbed questions with Back and Next", ago: 2 * 3600 },
        { id: "ses_h2", title: "Keep plan mode read-only", ago: 5 * 3600 },
        { id: "ses_h3", title: "Stall warning and response timeout", ago: 26 * 3600 },
        { id: "ses_h4", title: "Settings screen for providers and MCP", ago: 3 * 86400 },
      ],
    };
  },
};
