// OpenCode chat webview. Plain DOM, bundled by esbuild.
import { Marked } from "marked";
import { icons } from "./icons.js";

const vscode = acquireVsCodeApi();

// ------------------------------------------------------------------ markdown

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html: (html) => escapeHtml(typeof html === "string" ? html : html.text),
    code(code, lang) {
      return `<div class="code-block"><div class="code-head"><span>${escapeHtml(lang || "")}</span><button class="icon-btn copy-code" title="Copy">${icons.copy}</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
    },
    link(href, title, text) {
      const inner = text.replace(/<a class="file-ref"[^>]*>([\s\S]*?)<\/a>/g, "$1");
      return `<a href="${escapeHtml(href)}" title="${escapeHtml(title || "")}">${inner}</a>`;
    },
    codespan(code) {
      const m = code.match(FILE_REF_EXACT);
      return m ? fileRef(m[1], m[2], m[3], `<code>${code}</code>`) : `<code>${code}</code>`;
    },
    text(text) {
      return typeof text === "string" ? linkFileRefs(text) : false;
    },
  },
});

// File references like src/app.ts, app.ts:42 or src/app.ts:10-20 become clickable.
const FILE_PATH = String.raw`((?:[\w@.-]+\/)+[\w@.-]+\.\w+|[\w@-][\w@.-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|md|json|jsonc|yml|yaml|toml|css|scss|html|vue|svelte|sh|sql|lua|zig|ex|exs))`;
const FILE_REF_EXACT = new RegExp(String.raw`^${FILE_PATH}(?::(\d+)(?:-(\d+))?)?$`);
const FILE_REF_IN_TEXT = new RegExp(String.raw`(?<![\w/.:@-])${FILE_PATH}(?::(\d+)(?:-(\d+))?)?(?![\w/])`, "g");
function fileRef(path, line, end, inner) {
  return `<a class="file-ref" href="#" data-path="${escapeHtml(path)}"${line ? ` data-line="${line}"` : ""} title="Open ${escapeHtml(path)}${line ? `:${line}${end ? `-${end}` : ""}` : ""}">${inner}</a>`;
}
function linkFileRefs(text) {
  return text.replace(FILE_REF_IN_TEXT, (all, path, line, end) => fileRef(path, line, end, all));
}
const md = (text) => marked.parse(text || "");

// --------------------------------------------------------------------- state

// Agent palette in OpenCode theme order: build is blue, plan is purple, then green, orange, peach.
// Agents with a `color` in their OpenCode config use that instead.
const AGENT_COLORS = {
  dark: ["#5c9cf5", "#9d7cd8", "#7fd88f", "#f5a742", "#fab283"],
  light: ["#2f6fd0", "#7650b8", "#2f8a4a", "#b86e10", "#c4621f"],
};
const BUILTIN_COMMANDS = [
  { name: "new", description: "Start a new conversation", builtin: true },
  { name: "clear", description: "Start a new conversation", builtin: true },
  { name: "compact", description: "Summarize the conversation to free up context", builtin: true },
  { name: "model", description: "Switch model", builtin: true },
  { name: "history", description: "Resume a past conversation", builtin: true },
];

const saved = vscode.getState() || {};
const state = {
  ready: false,
  serverStatus: "starting",
  agent: "build",
  agents: ["build", "plan"],
  agentColors: {},
  autoEdit: false,
  models: [],
  model: saved.model || null,
  commands: [],
  session: null,
  messages: new Map(), // id -> { info, parts: Map }
  order: [], // message ids
  busy: false,
  busySince: 0,
  permissions: [], // pending requests
  questions: [],
  todos: [],
  todosOpen: true,
  diff: [],
  changesOpen: false,
  childParts: new Map(), // subagent sessionID -> Map(partID -> tool part)
  childRequested: new Set(),
  commandMeta: new Map(), // user message ID -> { name, arguments } for /commands
  worktree: null,
  selection: null,
  includeSelection: true,
  images: [],
  history: saved.history || [],
  historyIndex: -1,
  error: null,
};

const persist = () => vscode.setState({ model: state.model, history: state.history.slice(-50) });
const send = (msg) => vscode.postMessage(msg);

// ---------------------------------------------------------------------- dom

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
};

const app = document.getElementById("app");
app.innerHTML = `
  <header class="header">
    <button class="title-btn" id="titleBtn" title="Past conversations">
      <span class="title-text" id="titleText">New conversation</span>
      <span class="chev">${icons.chevronDown}</span>
    </button>
    <div class="header-actions">
      <button class="icon-btn" id="historyBtn" title="Past conversations">${icons.history}</button>
      <button class="icon-btn" id="newBtn" title="New conversation">${icons.plus}</button>
      <button class="icon-btn" id="moreBtn" title="More">${icons.more}</button>
    </div>
  </header>
  <div class="popover hidden" id="historyPop"></div>
  <div class="popover hidden" id="morePop"></div>
  <nav class="tabbar hidden" id="tabbar"></nav>
  <div class="worktree-bar hidden" id="worktreeBar"></div>
  <main class="messages" id="messages"></main>
  <div class="bottom">
    <div class="changes hidden" id="changes"></div>
    <div class="todos hidden" id="todos"></div>
    <div id="cards"></div>
    <div class="composer" id="composer">
      <div class="menu hidden" id="menu"></div>
      <div class="attachments hidden" id="attachments"></div>
      <textarea id="input" rows="1" placeholder="Ask OpenCode…  (@ files, / commands)"></textarea>
      <div class="composer-foot">
        <div class="foot-left">
          <button class="agent-pill" id="modeBtn" title="Switch agent (Tab)"></button>
          <button class="pill edits-pill" id="editsBtn"></button>
          <button class="pill sel-pill hidden" id="selBtn" title="Include current selection"></button>
        </div>
        <div class="foot-right">
          <button class="icon-btn" id="atBtn" title="Add file (@)">${icons.at}</button>
          <button class="icon-btn" id="slashBtn" title="Commands (/)">${icons.slash}</button>
          <button class="ctx-meter hidden" id="ctxBtn"></button>
          <button class="pill model-pill" id="modelBtn" title="Switch model"></button>
          <button class="send-btn" id="sendBtn" title="Send (Enter)">${icons.arrowUp}</button>
        </div>
      </div>
    </div>
  </div>
`;

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const input = $("input");
const menuEl = $("menu");

// ---------------------------------------------------------------- rendering

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}
function scrollToBottom(force) {
  if (force || stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}
let stickToBottom = true;
messagesEl.addEventListener("scroll", () => (stickToBottom = isNearBottom()));

function renderEmpty() {
  return h(
    "div",
    { class: "empty" },
    h("div", { class: "empty-logo", html: icons.logo }),
    h("div", { class: "empty-title" }, state.serverStatus === "error" ? "OpenCode couldn't start" : "What should we build?"),
    state.serverStatus === "error"
      ? h("div", { class: "empty-sub" }, "Check that the opencode CLI is installed, then run “OpenCode: Restart Server”.", h("br"), h("a", { href: "#", onClick: (e) => (e.preventDefault(), send({ type: "showLogs" })) }, "Show logs"))
      : h(
          "div",
          { class: "empty-tips" },
          tip(icons.at, "Mention files with @, or press Ctrl+Alt+K in the editor"),
          tip(icons.slash, "Type / for commands"),
          tip(icons.bot, "Tab switches agent (build / plan)"),
        ),
  );
}
function tip(icon, text) {
  return h("div", { class: "tip" }, h("span", { class: "tip-icon", html: icon }), text);
}

let renderQueued = new Set();
let fullRender = true;
function queueRender(messageID) {
  if (messageID) renderQueued.add(messageID);
  else fullRender = true;
  requestAnimationFrame(flush);
}
function flush() {
  if (fullRender) {
    fullRender = false;
    renderQueued.clear();
    messagesEl.innerHTML = "";
    const visible = state.order.filter((id) => !isReverted(id));
    if (!visible.length && !state.session?.revert) messagesEl.append(renderEmpty());
    for (const id of visible) messagesEl.append(renderMessage(id));
    if (state.session?.revert) messagesEl.append(renderRevertBanner());
    messagesEl.append(renderStatusRow());
    renderContext();
    scrollToBottom();
    return;
  }
  // Inner scroll boxes (reasoning, command output…) that were scrolled to the bottom stay there.
  const pinned = [...messagesEl.querySelectorAll(SCROLL_BOXES)].filter(isScrolledToBottom);
  for (const id of renderQueued) {
    const old = messagesEl.querySelector(`[data-mid="${id}"]`);
    if (isReverted(id) || !state.messages.has(id)) {
      old?.remove();
      continue;
    }
    const fresh = renderMessage(id);
    if (old) {
      // A message being edited in place keeps its editor until the edit is sent or cancelled.
      if (!old.querySelector(".user-bubble.editing")) morph(old, fresh);
    } else {
      messagesEl.querySelector(".empty")?.remove();
      const status = messagesEl.querySelector(".status-row");
      messagesEl.insertBefore(fresh, status);
    }
  }
  renderQueued.clear();
  for (const box of pinned) if (box.isConnected) box.scrollTop = box.scrollHeight;
  updateStatusRow();
  renderContext();
  scrollToBottom();
}

const SCROLL_BOXES = ".thinking, .tool-output, .subagent-steps, .summary-row .markdown, .diff";
const isScrolledToBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 24;

const isReverted = (id) => !!state.session?.revert && id >= state.session.revert.messageID;

function renderRevertBanner() {
  const undone = state.order.filter((id) => isReverted(id) && state.messages.get(id)?.info.role === "user").length;
  return h(
    "div",
    { class: "revert-banner" },
    h("span", { class: "tool-icon", html: icons.undo }),
    h("span", {}, `Undid ${undone} message${undone === 1 ? "" : "s"} and restored files. Sending a new message makes this permanent.`),
    h("button", { class: "btn", onClick: () => send({ type: "unrevert" }) }, h("span", { html: icons.redo }), "Redo"),
  );
}

let pendingUndo = null; // prompt to restore once the undo actually happens

function undoTo(id) {
  const msg = state.messages.get(id);
  const text = [...msg.parts.values()].filter((p) => p.type === "text" && !p.synthetic && !p.ignored).map((p) => p.text).join("\n");
  pendingUndo = { id, text };
  send({ type: "revert", messageID: id });
}

/**
 * Update `a` in place to match `b`, touching only what changed. Keeping the existing nodes means
 * clicks, hover and CSS animations survive while a reply streams in.
 */
function morph(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName || (a.nodeType === 1 && a.dataset.pid !== b.dataset.pid)) {
    if (a.nodeType === 1 && b.nodeType === 1 && a.dataset.user && a.dataset.pid === b.dataset.pid) {
      b.dataset.user = a.dataset.user;
      b.classList.toggle("open", a.dataset.user === "open");
    }
    a.replaceWith(b);
    return;
  }
  if (a.nodeType !== 1) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  for (const { name } of [...a.attributes]) {
    if (!b.hasAttribute(name) && name !== "data-user") a.removeAttribute(name);
  }
  for (const { name, value } of [...b.attributes]) {
    if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  }
  if (a.dataset.user) a.classList.toggle("open", a.dataset.user === "open");
  const ac = [...a.childNodes];
  const bc = [...b.childNodes];
  bc.forEach((child, i) => (ac[i] ? morph(ac[i], child) : a.appendChild(child)));
  for (let i = bc.length; i < ac.length; i++) ac[i].remove();
}

function renderMessage(id) {
  const msg = state.messages.get(id);
  const parts = [...msg.parts.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (msg.info.role === "user") {
    const text = parts.filter((p) => p.type === "text" && !p.synthetic && !p.ignored).map((p) => p.text).join("\n");
    const files = parts.filter((p) => p.type === "file");
    const compaction = parts.find((p) => p.type === "compaction");
    const command = compaction ? { name: "compact", arguments: compaction.auto ? "(automatic, context was full)" : "" } : state.commandMeta.get(id);
    if (command) return renderCommandMessage(id, command, compaction ? "" : text);
    return h(
      "div",
      { class: "msg user", "data-mid": id },
      h(
        "div",
        { class: "user-bubble" },
        h(
          "div",
          { class: "msg-actions" },
          h("button", { class: "icon-btn", title: "Edit and resend from here", html: icons.pencil, onClick: (e) => startEdit(id, e.target.closest(".user-bubble"), text) }),
          h("button", {
            class: "icon-btn",
            title: "Undo to here: removes this message and everything after it, and restores files",
            html: icons.undo,
            onClick: () => undoTo(id),
          }),
        ),
        files.length
          ? h(
              "div",
              { class: "user-files" },
              files.map((f) =>
                f.mime?.startsWith("image/")
                  ? h("img", { class: "thumb", src: f.url, alt: f.filename || "image" })
                  : h("span", { class: "chip file-chip", onClick: () => openPath(fileUrlToPath(f.url)) }, h("span", { html: icons.file }), f.filename || f.url),
              ),
            )
          : null,
        h("div", { class: "user-text" }, text),
      ),
    );
  }
  const el = h("div", { class: "msg assistant", "data-mid": id });
  if (msg.info.summary === true || msg.info.mode === "compaction") {
    // The summary written by /compact: folded away, like the command that produced it.
    const summary = parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\n\n");
    el.append(
      collapsible(
        `${id}-summary`,
        h("span", { class: "thinking-label" }, h("span", { class: "tool-icon", html: icons.listCheck }), msg.info.time?.completed ? "Conversation summary" : "Summarizing conversation…"),
        h("div", { class: "markdown", html: md(summary) }),
        "summary-row",
        false,
      ),
    );
    return el;
  }
  for (const p of parts) {
    const node = renderPart(p);
    if (node) el.append(node);
  }
  if (msg.info.error && msg.info.error.name !== "MessageAbortedError") {
    el.append(h("div", { class: "error-block" }, errorText(msg.info.error)));
  } else if (msg.info.error?.name === "MessageAbortedError") {
    el.append(h("div", { class: "interrupted" }, "Stopped"));
  }
  return el;
}

/** A /command as the user typed it, with the expanded prompt available on demand. */
function renderCommandMessage(id, command, prompt) {
  const head = h(
    "div",
    { class: "cmd-line" },
    h("span", { class: "cmd-name" }, `/${command.name}`),
    command.arguments ? h("span", { class: "cmd-args" }, command.arguments) : null,
  );
  return h(
    "div",
    { class: "msg user", "data-mid": id },
    h(
      "div",
      { class: "user-bubble command-bubble" },
      h(
        "div",
        { class: "msg-actions" },
        h("button", { class: "icon-btn", title: "Undo to here: removes this command and everything after it, and restores files", html: icons.undo, onClick: () => undoTo(id) }),
      ),
      prompt ? collapsible(`${id}-prompt`, head, h("div", { class: "cmd-prompt" }, prompt), "cmd-row", false) : head,
    ),
  );
}

function errorText(err) {
  return err?.data?.message || err?.message || err?.name || "Unknown error";
}

function renderPart(p) {
  switch (p.type) {
    case "text":
      if (p.synthetic || p.ignored || !p.text) return null;
      return h("div", { class: "row text-row", "data-pid": p.id }, h("div", { class: "markdown", html: md(p.text) }));
    case "reasoning": {
      if (!p.text?.trim()) return null;
      const done = !!p.time?.end;
      const secs = done ? Math.max(1, Math.round((p.time.end - p.time.start) / 1000)) : null;
      return collapsible(p.id, h("span", { class: "thinking-label" }, h("span", { class: "tool-icon", html: icons.sparkle }), done ? `Reasoning · ${secs}s` : "Reasoning…"), h("div", { class: "markdown thinking", html: md(p.text) }), done ? "thinking-row" : "thinking-row live", false);
    }
    case "tool":
      return renderTool(p);
    case "retry":
      return h("div", { class: "row note-row" }, `Retrying (attempt ${p.attempt})… ${errorText(p.error)}`);
    case "compaction":
      return h("div", { class: "row note-row" }, "Conversation compacted");
    case "agent":
      return h("div", { class: "row note-row" }, `@${p.name}`);
    default:
      return null;
  }
}

/** Expand/collapse, remembering the user's choice so streaming updates don't undo it. */
function toggleOpen(el) {
  const open = !el.classList.contains("open");
  el.classList.toggle("open", open);
  el.dataset.user = open ? "open" : "closed";
  // Opening something still streaming jumps to the newest text so it keeps following.
  if (open && el.classList.contains("live")) {
    for (const box of el.querySelectorAll(SCROLL_BOXES)) box.scrollTop = box.scrollHeight;
  }
}

function collapsible(pid, head, body, cls, open) {
  const el = h("div", { class: `row collapsible ${cls} ${open ? "open" : ""}`, "data-pid": pid });
  const header = h("div", { class: "coll-head" }, head, h("span", { class: "chev", html: icons.chevronRight }));
  header.addEventListener("click", () => toggleOpen(el));
  el.append(header, h("div", { class: "coll-body" }, body));
  return el;
}

const short = (p) => {
  if (!p) return "";
  const cwd = state.cwd || "";
  if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  return p;
};

function toolSummary(p) {
  const i = p.state?.input || {};
  const t = p.tool;
  const file = i.filePath || i.file_path || i.path;
  switch (t) {
    case "read":
      return { name: "Read", arg: short(file), file, icon: icons.file };
    case "edit":
    case "multiedit":
      return { name: "Edit", arg: short(file), file, icon: icons.pencil };
    case "write":
      return { name: "Write", arg: short(file), file, icon: icons.pencil };
    case "patch":
    case "apply_patch":
      return { name: "Patch", arg: p.state?.title || "", icon: icons.pencil };
    case "bash":
      return { name: "Shell", arg: i.command || "", icon: icons.terminal };
    case "glob":
      return { name: "Glob", arg: `${i.pattern || ""}${i.path ? " in " + short(i.path) : ""}`, icon: icons.search };
    case "grep":
      return { name: "Grep", arg: `"${i.pattern || ""}"${i.path ? " in " + short(i.path) : ""}`, icon: icons.search };
    case "list":
      return { name: "List", arg: short(i.path) || ".", icon: icons.folder };
    case "webfetch":
      return { name: "Fetch", arg: i.url || "", icon: icons.globe };
    case "websearch":
    case "codesearch":
      return { name: "Web search", arg: i.query || "", icon: icons.globe };
    case "task":
      return { name: "Subagent", arg: i.description || i.subagent_type || "", icon: icons.bot };
    case "todowrite":
      return { name: "Todos", arg: "", icon: icons.listCheck };
    case "todoread":
      return { name: "Todos", arg: "", icon: icons.listCheck };
    case "skill":
      return { name: "Skill", arg: i.name || "", icon: icons.sparkle };
    case "question":
      return { name: "Question", arg: "", icon: icons.help };
    default:
      return { name: t, arg: p.state?.title || "", icon: icons.wrench };
  }
}

function renderTool(p) {
  const st = p.state || {};
  const { name, arg, file, icon } = toolSummary(p);
  const status = st.status || "pending";
  const head = h(
    "span",
    { class: "tool-head" },
    h("span", { class: "tool-name" }, name),
    arg
      ? h(
          "span",
          {
            class: `tool-arg ${file ? "link" : ""}`,
            title: arg,
            onClick: file
              ? (e) => {
                  e.stopPropagation();
                  openPath(file);
                }
              : undefined,
          },
          arg,
        )
      : null,
  );
  const meta = st.metadata || {};
  let summary = null;
  let body = null;
  let open = false;

  if (status === "error") {
    summary = h("span", { class: "tool-summary err" }, firstLine(st.error));
    body = h("pre", { class: "tool-output err" }, st.error || "");
  } else if (p.tool === "edit" || p.tool === "write" || p.tool === "multiedit") {
    const diff = meta.diff || meta.filediff?.patch;
    if (diff) {
      const { add, del } = diffStats(diff);
      summary = h("span", { class: "tool-summary" }, h("span", { class: "add" }, `+${add}`), " ", h("span", { class: "del" }, `-${del}`));
      body = h("div", {}, renderDiff(diff), file ? h("button", { class: "link-btn", onClick: () => send({ type: "openDiff", filePath: file, before: meta.filediff?.before, after: meta.filediff?.after, diff }) }, "Open diff") : null);
      open = true;
    } else if (p.tool === "write" && st.input?.content) {
      const lines = st.input.content.split("\n").length;
      summary = h("span", { class: "tool-summary" }, `${lines} lines`);
      body = h("pre", { class: "tool-output" }, st.input.content);
    }
  } else if (p.tool === "read" && status === "completed") {
    const lines = (st.output || "").split("\n").filter((l) => /^\d+[|:\t]/.test(l.trim())).length;
    summary = h("span", { class: "tool-summary" }, lines ? `Read ${lines} lines` : "Read file");
  } else if (p.tool === "todowrite") {
    const todos = st.input?.todos || meta.todos || [];
    body = renderTodoList(todos);
    open = true;
  } else if (p.tool === "task") {
    const childID = meta.sessionId;
    const steps = childID ? [...(state.childParts.get(childID)?.values() || [])].sort((a, b) => (a.id < b.id ? -1 : 1)) : [];
    if (childID && !state.childParts.has(childID) && !state.childRequested.has(childID)) {
      state.childRequested.add(childID);
      send({ type: "loadChild", sessionID: childID });
    }
    const running = steps.filter((s) => s.state?.status === "running" || s.state?.status === "pending").length;
    summary = h(
      "span",
      { class: "tool-summary" },
      st.input?.subagent_type ? `@${st.input.subagent_type}` : "subagent",
      steps.length ? ` · ${steps.length} step${steps.length === 1 ? "" : "s"}${running ? " (working)" : ""}` : "",
    );
    const nested = steps.length
      ? h(
          "div",
          { class: "subagent-steps" },
          steps.map((s) => {
            const sum = toolSummary(s);
            return h(
              "div",
              { class: "sub-step", title: sum.arg },
              h("span", { class: `tool-icon status-${s.state?.status || "pending"}`, html: sum.icon }),
              h("span", { class: "tool-name" }, sum.name),
              sum.arg ? h("span", { class: `tool-arg ${sum.file ? "link" : ""}`, onClick: sum.file ? () => openPath(sum.file) : undefined }, sum.arg) : null,
            );
          }),
        )
      : null;
    if (nested || st.output) body = h("div", {}, nested, st.output ? h("div", { class: "markdown subagent-result", html: md(st.output) }) : null);
    open = status === "running" && !!nested;
  } else if (st.output) {
    const out = String(st.output);
    const lineCount = out.split("\n").length;
    summary = h("span", { class: "tool-summary" }, p.tool === "bash" ? firstLine(out) || "(no output)" : `${lineCount} line${lineCount === 1 ? "" : "s"}`);
    body = h("pre", { class: "tool-output" }, out.length > 20000 ? out.slice(0, 20000) + "\n… (truncated)" : out);
  } else if (status === "running" && p.tool === "bash" && meta.output) {
    body = h("pre", { class: "tool-output" }, meta.output);
    open = true;
  }

  const dot = h("span", { class: `tool-icon status-${status}`, title: status, html: icon });
  if (!body) {
    return h(
      "div",
      { class: "row tool-row", "data-pid": p.id },
      dot,
      h("div", { class: "tool-main" }, head, summary ? h("div", { class: "tool-sub" }, summary) : null),
    );
  }
  const el = h("div", { class: `row tool-row collapsible ${open ? "open" : ""}`, "data-pid": p.id }, dot);
  const header = h("div", { class: "coll-head" }, head, h("span", { class: "chev", html: icons.chevronRight }));
  header.addEventListener("click", () => toggleOpen(el));
  el.append(h("div", { class: "tool-main" }, header, summary ? h("div", { class: "tool-sub" }, summary) : null, h("div", { class: "coll-body" }, body)));
  return el;
}

const firstLine = (s) => String(s || "").trim().split("\n")[0].slice(0, 200);

function diffStats(diff) {
  let add = 0;
  let del = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

function renderDiff(diff) {
  const box = h("div", { class: "diff" });
  let oldLn = 0;
  let newLn = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("Index:") || l.startsWith("===") || l.startsWith("---") || l.startsWith("+++") || l.startsWith("\\")) continue;
    const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (m) {
      oldLn = +m[1];
      newLn = +m[2];
      box.append(h("div", { class: "diff-line hunk" }, h("span", { class: "ln" }, ""), h("span", { class: "code" }, "⋯")));
      continue;
    }
    if (l.startsWith("+")) box.append(h("div", { class: "diff-line add" }, h("span", { class: "ln" }, newLn++), h("span", { class: "code" }, l.slice(1))));
    else if (l.startsWith("-")) box.append(h("div", { class: "diff-line del" }, h("span", { class: "ln" }, oldLn++), h("span", { class: "code" }, l.slice(1))));
    else if (l.startsWith(" ")) {
      oldLn++;
      box.append(h("div", { class: "diff-line ctx" }, h("span", { class: "ln" }, newLn++), h("span", { class: "code" }, l.slice(1))));
    }
  }
  return box;
}

function renderTodoList(todos) {
  return h(
    "ul",
    { class: "todo-list" },
    todos.map((t) =>
      h(
        "li",
        { class: `todo ${t.status}` },
        h("span", { class: "todo-box", html: t.status === "completed" ? icons.check : t.status === "in_progress" ? icons.circleDot : t.status === "cancelled" ? icons.x : icons.circle }),
        h("span", { class: "todo-text" }, t.content),
      ),
    ),
  );
}

// Status: block loader, agent name and elapsed time.
function renderStatusRow() {
  const el = h("div", { class: "status-row" });
  fillStatusRow(el);
  return el;
}
function fillStatusRow(el) {
  el.classList.toggle("hidden", !state.busy || state.permissions.length > 0 || state.questions.length > 0);
  if (!state.busy) return;
  // Build the loader once; rebuilding it would restart its animation every tick.
  if (!el.firstChild) {
    el.append(
      h("span", { class: "loader" }, h("i"), h("i"), h("i"), h("i"), h("i")),
      h("span", { class: "verb" }),
      h("span", { class: "status-hint" }),
    );
  }
  const secs = Math.floor((Date.now() - state.busySince) / 1000);
  const verb = `${state.agent} is working`;
  const hint = `${secs}s · Esc to stop`;
  if (el.children[1].textContent !== verb) el.children[1].textContent = verb;
  if (el.children[2].textContent !== hint) el.children[2].textContent = hint;
}
function updateStatusRow() {
  const el = messagesEl.querySelector(".status-row");
  if (el) fillStatusRow(el);
}
setInterval(() => state.busy && updateStatusRow(), 1000);

function setBusy(busy) {
  if (busy && !state.busy) state.busySince = Date.now();
  state.busy = busy;
  updateStatusRow();
  renderSendBtn();
}

// -------------------------------------------------------------- header etc.

function renderTitle() {
  $("titleText").textContent = state.session?.title && !/^New session/i.test(state.session.title) ? state.session.title : "New conversation";
}

function agentColor(name) {
  if (state.agentColors[name]) return state.agentColors[name];
  const palette = document.body.classList.contains("vscode-light") ? AGENT_COLORS.light : AGENT_COLORS.dark;
  const i = state.agents.indexOf(name);
  return palette[(i < 0 ? 0 : i) % palette.length];
}

function renderModeBtn() {
  const btn = $("modeBtn");
  btn.innerHTML = `<span class="agent-name">${escapeHtml(state.agent)}</span>`;
  // The whole panel takes on the active agent's colour.
  document.body.style.setProperty("--accent", agentColor(state.agent));
  const edits = $("editsBtn");
  edits.classList.toggle("hidden", state.agent === "plan");
  edits.innerHTML = `${state.autoEdit ? icons.zap : icons.shield}<span>${state.autoEdit ? "Auto-approve edits" : "Approve edits"}</span>`;
  edits.classList.toggle("on", state.autoEdit);
  edits.title = state.autoEdit ? "Edits are applied without asking — click to require approval" : "OpenCode asks before editing files — click to auto-approve";
}

function renderModelBtn() {
  const m = state.models.find((x) => state.model && x.providerID === state.model.providerID && x.modelID === state.model.modelID);
  const name = m ? m.name : state.model ? state.model.modelID : "Default model";
  $("modelBtn").innerHTML = `<span>${escapeHtml(name)}</span>${icons.chevronDown}`;
  reportStatus();
}

function reportStatus() {
  const m = state.models.find((x) => state.model && x.providerID === state.model.providerID && x.modelID === state.model.modelID);
  send({ type: "status", agent: state.agent, model: m ? m.name : state.model?.modelID });
}

function renderSelBtn() {
  const btn = $("selBtn");
  const s = state.selection;
  btn.classList.toggle("hidden", !s);
  if (!s) return;
  const name = s.path.split("/").pop();
  const range = s.startLine ? (s.startLine === s.endLine ? `:${s.startLine}` : `:${s.startLine}-${s.endLine}`) : "";
  btn.innerHTML = `${state.includeSelection ? icons.eye : icons.eyeOff}<span>${escapeHtml(name + range)}</span>`;
  btn.title = state.includeSelection ? `${s.path}${range} is shared with OpenCode — click to stop sharing` : "Not sharing the current file — click to share";
  btn.classList.toggle("off", !state.includeSelection);
}

function renderSendBtn() {
  const btn = $("sendBtn");
  const showStop = state.busy && !input.value.trim();
  btn.innerHTML = showStop ? icons.stop : icons.arrowUp;
  btn.title = showStop ? "Stop (Esc)" : "Send (Enter)";
  btn.classList.toggle("stop", showStop);
  btn.disabled = !showStop && !input.value.trim() && !state.images.length;
}

function renderChanges() {
  const el = $("changes");
  const files = state.diff.filter((f) => f.file);
  el.classList.toggle("hidden", !files.length);
  if (!files.length) return;
  const add = files.reduce((n, f) => n + (f.additions || 0), 0);
  const del = files.reduce((n, f) => n + (f.deletions || 0), 0);
  el.innerHTML = "";
  el.append(
    h(
      "div",
      { class: "changes-head", onClick: () => ((state.changesOpen = !state.changesOpen), renderChanges()) },
      h("span", { class: "chev", html: state.changesOpen ? icons.chevronDown : icons.chevronRight }),
      `${files.length} file${files.length === 1 ? "" : "s"} changed`,
      h("span", { class: "add" }, `+${add}`),
      h("span", { class: "del" }, `-${del}`),
    ),
  );
  if (!state.changesOpen) return;
  const list = h("div", { class: "changes-list" });
  for (const f of files) {
    const status = f.status || "modified";
    list.append(
      h(
        "div",
        { class: "change-row", title: `Open diff for ${f.file}`, onClick: () => send({ type: "openDiff", filePath: f.file, diff: f.patch }) },
        h("span", { class: `change-status ${status}` }, status[0].toUpperCase()),
        h("span", { class: "change-name" }, f.file.split("/").pop()),
        h("span", { class: "change-dir" }, f.file.includes("/") ? f.file.slice(0, f.file.lastIndexOf("/")) : ""),
        h("span", { class: "add" }, `+${f.additions || 0}`),
        h("span", { class: "del" }, `-${f.deletions || 0}`),
        h("button", {
          class: "icon-btn",
          title: status === "added" ? "Delete this new file" : "Discard changes to this file",
          html: icons.undo,
          onClick: (e) => {
            e.stopPropagation();
            send({ type: "discardFile", file: f.file, patch: f.patch, status });
          },
        }),
      ),
    );
  }
  el.append(list);
}

const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

function renderContext() {
  const btn = $("ctxBtn");
  let last = null;
  let cost = 0;
  for (const id of state.order) {
    if (isReverted(id)) continue;
    const info = state.messages.get(id)?.info;
    if (info?.role !== "assistant") continue;
    cost += info.cost || 0;
    const t = info.tokens;
    const used = t ? t.total || t.input + t.output + t.reasoning + (t.cache?.read || 0) + (t.cache?.write || 0) : 0;
    if (used > 0) last = { used, providerID: info.providerID, modelID: info.modelID };
  }
  btn.classList.toggle("hidden", !last);
  if (!last) return;
  const model =
    state.models.find((m) => m.providerID === last.providerID && m.modelID === last.modelID) ||
    state.models.find((m) => state.model && m.providerID === state.model.providerID && m.modelID === state.model.modelID);
  const limit = model?.context;
  const pct = limit ? Math.min(100, Math.round((last.used / limit) * 100)) : null;
  const r = 6;
  const circ = 2 * Math.PI * r;
  const ring = pct === null ? "" : `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="${r}" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2"/><circle cx="8" cy="8" r="${r}" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="${(circ * pct) / 100} ${circ}" transform="rotate(-90 8 8)"/></svg>`;
  btn.innerHTML = `${ring}<span>${pct === null ? fmtTokens(last.used) : `${pct}%`}</span>${cost > 0 ? `<span class="ctx-cost">$${cost.toFixed(2)}</span>` : ""}`;
  btn.className = `ctx-meter ${pct >= 90 ? "crit" : pct >= 75 ? "warn" : ""}`;
  btn.title =
    `${fmtTokens(last.used)}${limit ? ` of ${fmtTokens(limit)}` : ""} tokens in context` +
    (cost > 0 ? ` · $${cost.toFixed(4)} spent` : "") +
    "\nClick to compact the conversation";
}

function renderTodos() {
  const el = $("todos");
  const todos = state.todos;
  const active = todos.length && todos.some((t) => t.status !== "completed" && t.status !== "cancelled");
  el.classList.toggle("hidden", !active);
  if (!active) return;
  const done = todos.filter((t) => t.status === "completed").length;
  el.innerHTML = "";
  const head = h("div", { class: "todos-head", onClick: () => ((state.todosOpen = !state.todosOpen), renderTodos()) }, h("span", { class: "chev", html: state.todosOpen ? icons.chevronDown : icons.chevronRight }), `Tasks ${done}/${todos.length}`);
  el.append(head);
  if (state.todosOpen) el.append(renderTodoList(todos));
}

function renderAttachments() {
  const el = $("attachments");
  el.classList.toggle("hidden", !state.images.length);
  el.innerHTML = "";
  state.images.forEach((img, i) =>
    el.append(h("div", { class: "attach" }, h("img", { src: img.dataUrl }), h("button", { class: "attach-x", title: "Remove", html: icons.x, onClick: () => (state.images.splice(i, 1), renderAttachments(), renderSendBtn()) }))),
  );
}

// ------------------------------------------------------- permission cards

function renderCards() {
  const cards = $("cards");
  cards.innerHTML = "";
  const perm = state.permissions[0];
  const q = state.questions[0];
  $("composer").classList.toggle("hidden", !!perm || !!q);
  if (perm) cards.append(renderPermission(perm));
  else if (q) cards.append(renderQuestion(q));
  updateStatusRow();
  if (perm || q) setTimeout(() => cards.querySelector("textarea, .option")?.focus(), 0);
}

function permissionTitle(p) {
  const md0 = p.metadata || {};
  const file = md0.filepath || md0.filePath || (p.patterns || [])[0];
  switch (p.permission) {
    case "edit":
      return { title: `Edit ${short(file)}`, file };
    case "bash":
      return { title: "Run shell command", command: md0.command || (p.patterns || []).join(" ") };
    case "webfetch":
      return { title: `Fetch ${md0.url || (p.patterns || [])[0] || "URL"}` };
    case "external_directory":
      return { title: `Access outside workspace: ${(p.patterns || []).join(", ")}` };
    case "doom_loop":
      return { title: "Repeated tool call detected — continue?" };
    default:
      return { title: `${p.permission}${p.patterns?.length ? `: ${p.patterns.join(", ")}` : ""}` };
  }
}

function renderPermission(p) {
  const info = permissionTitle(p);
  const meta = p.metadata || {};
  const diff = meta.diff;
  const feedback = h("textarea", { class: "feedback", rows: 2, placeholder: "Reason for rejecting (optional, sent to the agent)" });
  const reply = (r) => {
    send({ type: "permissionReply", id: p.id, reply: r, message: r === "reject" ? feedback.value.trim() : undefined });
    state.permissions = state.permissions.filter((x) => x.id !== p.id);
    if (r === "always" && p.permission === "edit" && !state.autoEdit) setAutoEdit(true);
    renderCards();
  };
  const card = h(
    "div",
    { class: "card permission", tabindex: "0" },
    h("div", { class: "card-kicker" }, h("span", { html: icons.shield }), "Permission required"),
    h("div", { class: "card-title" }, info.title),
    info.command ? h("pre", { class: "card-command" }, info.command) : null,
    meta.description ? h("div", { class: "card-desc" }, meta.description) : null,
    diff ? h("div", { class: "card-diff" }, renderDiff(diff)) : null,
    diff && info.file ? h("button", { class: "link-btn", onClick: () => send({ type: "openDiff", filePath: info.file, diff, before: meta.filediff?.before, after: meta.filediff?.after }) }, "Open diff in editor") : null,
    feedback,
    h(
      "div",
      { class: "perm-actions" },
      h("button", { class: "btn primary", onClick: () => reply("once"), title: "Enter" }, "Allow once"),
      h("button", { class: "btn", onClick: () => reply("always"), title: p.always?.length ? `Always allow ${p.always.join(", ")} this session` : "Always allow this session" }, "Allow always"),
      h("button", { class: "btn danger", onClick: () => reply("reject"), title: "Esc" }, "Reject"),
    ),
  );
  card.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return e.preventDefault(), reply("reject");
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    reply(e.target === feedback && feedback.value.trim() ? "reject" : "once");
  });
  setTimeout(() => card.focus(), 0);
  return card;
}

/** Answers in progress, kept across re-renders (another card arriving rebuilds this one). */
const questionDrafts = new Map();

/**
 * One question shows as before. Several are tabbed: a strip of headers (ticked once answered),
 * one question at a time with Back / Next, and a final Review tab that submits them all.
 */
function renderQuestion(q) {
  const qs = q.questions;
  let d = questionDrafts.get(q.id);
  if (!d) questionDrafts.set(q.id, (d = { answers: qs.map(() => new Set()), customs: qs.map(() => ""), step: 0 }));
  const multi = qs.length > 1;
  const review = qs.length; // index of the Review tab
  const answered = (i) => d.answers[i].size > 0 || d.customs[i].trim() !== "";
  const done = () => {
    questionDrafts.delete(q.id);
    state.questions = state.questions.filter((x) => x.id !== q.id);
    renderCards();
  };
  const submit = () => {
    send({ type: "questionReply", id: q.id, answers: d.answers.map((s, i) => (d.customs[i].trim() ? [...s, d.customs[i].trim()] : [...s])) });
    done();
  };
  const skip = () => (send({ type: "questionReject", id: q.id }), done());

  const card = h("div", { class: "card question", tabindex: "-1" });
  const tabs = multi ? h("div", { class: "q-tabs", role: "tablist" }) : null;
  const body = h("div", { class: "q-body" });
  const actions = h("div", { class: "card-actions" });
  if (tabs) card.append(tabs);
  card.append(body, actions);

  const go = (step) => {
    d.step = Math.max(0, Math.min(review, step));
    show();
    setTimeout(() => (body.querySelector(".option") ?? actions.querySelector(".btn.primary"))?.focus(), 0);
  };

  const renderTabs = () => {
    if (!tabs) return;
    tabs.innerHTML = "";
    [...qs.map((qi, i) => ({ label: qi.header || `Question ${i + 1}`, i })), { label: "Review", i: review }].forEach(({ label, i }) =>
      tabs.append(
        h(
          "button",
          { class: `q-tab${i === d.step ? " active" : ""}${i < review && answered(i) ? " answered" : ""}`, role: "tab", "aria-selected": String(i === d.step), onClick: () => go(i) },
          i < review ? h("span", { class: "q-tick", html: answered(i) ? icons.check : "" }) : null,
          label,
        ),
      ),
    );
  };

  const renderOne = (idx) => {
    const qi = qs[idx];
    const opts = h("div", { class: "options" });
    const mark = () => {
      opts.querySelectorAll(".option").forEach((b, j) => b.classList.toggle("selected", d.answers[idx].has(qi.options[j].label)));
      renderTabs();
    };
    qi.options.forEach((o) => {
      const btn = h(
        "button",
        { class: "option", title: o.description },
        h("span", {}, h("span", { class: "opt-label" }, o.label), o.description ? h("span", { class: "opt-desc" }, o.description) : null),
      );
      btn.addEventListener("click", () => {
        if (!qi.multiple) d.answers[idx].clear();
        if (d.answers[idx].has(o.label)) d.answers[idx].delete(o.label);
        else d.answers[idx].add(o.label);
        mark();
        // Picking a single answer moves on, like Claude Code.
        if (!qi.multiple && d.answers[idx].size) multi ? go(idx + 1) : submit();
      });
      opts.append(btn);
    });
    // With tabs the header is already the tab label.
    if (!multi && qi.header) body.append(h("div", { class: "q-header" }, qi.header));
    body.append(h("div", { class: "card-title" }, qi.question), opts);
    if (qi.multiple) body.append(h("div", { class: "q-hint" }, "Choose any that apply"));
    if (qi.custom !== false) {
      const t = h("input", { class: "custom", placeholder: "Something else…", value: d.customs[idx] });
      t.addEventListener("input", () => ((d.customs[idx] = t.value), renderTabs()));
      t.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        multi ? go(idx + 1) : submit();
      });
      body.append(t);
    }
    mark();
  };

  const renderReview = () => {
    body.append(h("div", { class: "card-title" }, "Review your answers"));
    const list = h("div", { class: "q-review" });
    qs.forEach((qi, i) => {
      const parts = [...d.answers[i], ...(d.customs[i].trim() ? [d.customs[i].trim()] : [])];
      list.append(
        h(
          "button",
          { class: "q-review-row", onClick: () => go(i), title: "Change this answer" },
          h("span", { class: "q-review-q" }, qi.question),
          h("span", { class: `q-review-a${parts.length ? "" : " missing"}` }, parts.length ? parts.join(", ") : "Not answered"),
        ),
      );
    });
    body.append(list);
  };

  const show = () => {
    body.innerHTML = "";
    actions.innerHTML = "";
    renderTabs();
    if (d.step === review) renderReview();
    else renderOne(d.step);
    if (multi) {
      actions.append(h("button", { class: "btn", disabled: d.step === 0 ? "" : undefined, onClick: () => go(d.step - 1) }, "Back"));
      actions.append(
        d.step === review
          ? h("button", { class: "btn primary", onClick: submit }, "Submit")
          : h("button", { class: "btn primary", onClick: () => go(d.step + 1) }, d.step === review - 1 ? "Review" : "Next"),
      );
    } else {
      actions.append(h("button", { class: "btn primary", onClick: submit }, "Submit"));
    }
    actions.append(h("button", { class: "btn q-skip", onClick: skip, title: "Dismiss without answering" }, "Skip"));
  };

  // ←/→ switch questions, except while typing an answer.
  card.addEventListener("keydown", (e) => {
    if (!multi || e.target instanceof HTMLInputElement || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowRight") e.preventDefault(), go(d.step + 1);
    if (e.key === "ArrowLeft") e.preventDefault(), go(d.step - 1);
  });
  show();
  return card;
}

// --------------------------------------------------------------- composer

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 300) + "px";
}

let menu = null; // { kind: 'file'|'command'|'model', items, index, start }

function openMenu(kind, items, start) {
  menu = { kind, items, index: 0, start };
  drawMenu();
}
function closeMenu() {
  menu = null;
  menuEl.classList.add("hidden");
}
function drawMenu() {
  if (!menu || !menu.items.length) {
    menuEl.classList.add("hidden");
    return;
  }
  menuEl.classList.remove("hidden");
  menuEl.innerHTML = "";
  menu.items.forEach((it, i) => {
    const row = h(
      "div",
      { class: `menu-item ${i === menu.index ? "active" : ""}` },
      it.icon ? h("span", { class: "menu-icon", html: it.icon }) : null,
      h("span", { class: "menu-label" }, it.label),
      it.detail ? h("span", { class: "menu-detail" }, it.detail) : null,
    );
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      menu.index = i;
      acceptMenu();
    });
    menuEl.append(row);
  });
  menuEl.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}
function acceptMenu() {
  const it = menu.items[menu.index];
  const kind = menu.kind;
  const start = menu.start;
  closeMenu();
  if (kind === "file") {
    const caret = input.selectionStart;
    input.value = input.value.slice(0, start) + "@" + it.value + " " + input.value.slice(caret);
    const pos = start + it.value.length + 2;
    input.setSelectionRange(pos, pos);
  } else if (kind === "command") {
    if (it.builtin) {
      input.value = "";
      runBuiltin(it.value);
    } else {
      input.value = `/${it.value} `;
      input.setSelectionRange(input.value.length, input.value.length);
    }
  } else if (kind === "model") {
    state.model = { providerID: it.value.providerID, modelID: it.value.modelID };
    persist();
    renderModelBtn();
    renderContext();
  }
  autosize();
  renderSendBtn();
  input.focus();
}

let fileQuery = null;
let fileSearchTimer;
function updateMenuFromInput() {
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const at = before.match(/(^|\s)@([^\s@]*)$/);
  if (at) {
    const start = caret - at[2].length - 1;
    fileQuery = at[2];
    if (!menu || menu.kind !== "file") openMenu("file", [], start);
    else menu.start = start;
    // Debounce: searching on every keystroke floods the server.
    clearTimeout(fileSearchTimer);
    const query = at[2];
    fileSearchTimer = setTimeout(() => send({ type: "searchFiles", query }), 120);
    return;
  }
  const slash = before.match(/^\/(\S*)$/);
  if (slash) {
    const q = slash[1].toLowerCase();
    const items = [...BUILTIN_COMMANDS, ...state.commands]
      .filter((c) => c.name.toLowerCase().includes(q))
      .map((c) => ({ label: "/" + c.name, detail: c.description, value: c.name, builtin: c.builtin, icon: icons.slash }));
    openMenu("command", items, 0);
    return;
  }
  if (menu && menu.kind !== "model") closeMenu();
}

function openModelMenu() {
  const items = state.models.map((m) => ({ label: m.name, detail: m.providerName, value: m, icon: state.model && m.providerID === state.model.providerID && m.modelID === state.model.modelID ? icons.check : null }));
  openMenu("model", items, 0);
  menu.index = Math.max(0, items.findIndex((i) => i.icon));
  drawMenu();
}

function runBuiltin(name) {
  if (name === "new" || name === "clear") send({ type: "newSession" });
  else if (name === "compact") send({ type: "compact", model: state.model });
  else if (name === "model") openModelMenu();
  else if (name === "history") toggleHistory(true);
}

function parseMentions(text) {
  const mentions = [];
  const re = /(^|\s)@([^\s]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[2].replace(/[.,;:!?)]+$/, "");
    const lr = raw.match(/^(.*)#L(\d+)(?:-(\d+))?$/);
    if (lr) mentions.push({ path: lr[1], startLine: +lr[2], endLine: lr[3] ? +lr[3] : +lr[2] });
    else if (/[./]/.test(raw)) mentions.push({ path: raw });
  }
  return mentions;
}

function submit() {
  const text = input.value.trim();
  if (!text && !state.images.length) return;
  const slash = text.match(/^\/(\S+)$/);
  if (slash && BUILTIN_COMMANDS.some((c) => c.name === slash[1])) {
    input.value = "";
    autosize();
    return runBuiltin(slash[1]);
  }
  send({
    type: "send",
    text,
    mentions: parseMentions(text),
    images: state.images,
    includeSelection: state.includeSelection && !!state.selection,
    model: state.model || undefined,
    agent: state.agent,
    autoEdit: state.autoEdit,
  });
  state.history.push(text);
  state.historyIndex = -1;
  persist();
  input.value = "";
  state.images = [];
  renderAttachments();
  autosize();
  renderSendBtn();
  closeMenu();
  stickToBottom = true;
  scrollToBottom(true);
}

function cycleAgent() {
  state.agent = state.agents[(state.agents.indexOf(state.agent) + 1) % state.agents.length];
  renderModeBtn();
  reportStatus();
}

/** Send a prompt that came from the editor (code action, context menu). */
function sendExternal(text, mentions) {
  send({
    type: "send",
    text,
    mentions,
    images: [],
    includeSelection: false,
    model: state.model || undefined,
    agent: state.agent,
    autoEdit: state.autoEdit,
  });
  state.history.push(text);
  persist();
  stickToBottom = true;
  scrollToBottom(true);
}

/** Replace a user message's bubble with an editor; resending undoes to that message first. */
function startEdit(id, bubble, text) {
  if (!bubble || bubble.classList.contains("editing")) return;
  bubble.classList.add("editing");
  const area = h("textarea", { class: "edit-area", rows: Math.min(10, text.split("\n").length + 1) });
  area.value = text;
  const cancel = () => queueRender(id);
  const resend = () => {
    const value = area.value.trim();
    if (!value) return;
    send({
      type: "editResend",
      messageID: id,
      text: value,
      mentions: parseMentions(value),
      images: [],
      includeSelection: false,
      model: state.model || undefined,
      agent: state.agent,
      autoEdit: state.autoEdit,
    });
    stickToBottom = true;
  };
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      resend();
    } else if (e.key === "Escape") cancel();
  });
  bubble.innerHTML = "";
  bubble.append(
    area,
    h(
      "div",
      { class: "edit-actions" },
      h("span", { class: "muted" }, "Resending undoes this message and everything after it."),
      h("button", { class: "btn", onClick: cancel }, "Cancel"),
      h("button", { class: "btn primary", onClick: resend }, "Resend"),
    ),
  );
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

function setAutoEdit(on) {
  state.autoEdit = on;
  renderModeBtn();
  send({ type: "setAutoEdit", autoEdit: on });
}

input.addEventListener("input", () => {
  autosize();
  renderSendBtn();
  updateMenuFromInput();
});
input.addEventListener("click", updateMenuFromInput);
input.addEventListener("blur", () => setTimeout(() => menu?.kind !== "model" && closeMenu(), 150));
input.addEventListener("keydown", (e) => {
  if (menu && menu.items.length) {
    if (e.key === "ArrowDown") return e.preventDefault(), (menu.index = (menu.index + 1) % menu.items.length), drawMenu();
    if (e.key === "ArrowUp") return e.preventDefault(), (menu.index = (menu.index - 1 + menu.items.length) % menu.items.length), drawMenu();
    if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), acceptMenu();
    if (e.key === "Escape") return e.preventDefault(), closeMenu();
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    return submit();
  }
  if (e.key === "Tab" && !e.shiftKey && state.agents.length > 1) {
    e.preventDefault();
    return cycleAgent();
  }
  if (e.key === "Escape" && state.busy) {
    e.preventDefault();
    return send({ type: "abort" });
  }
  if (e.key === "ArrowUp" && !input.value.includes("\n") && input.selectionStart === 0 && state.history.length) {
    e.preventDefault();
    state.historyIndex = state.historyIndex < 0 ? state.history.length - 1 : Math.max(0, state.historyIndex - 1);
    input.value = state.history[state.historyIndex];
    autosize();
    renderSendBtn();
  } else if (e.key === "ArrowDown" && state.historyIndex >= 0 && input.selectionStart === input.value.length) {
    e.preventDefault();
    state.historyIndex++;
    if (state.historyIndex >= state.history.length) {
      state.historyIndex = -1;
      input.value = "";
    } else input.value = state.history[state.historyIndex];
    autosize();
    renderSendBtn();
  }
});
input.addEventListener("paste", (e) => {
  for (const item of e.clipboardData?.items || []) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        state.images.push({ dataUrl: reader.result, mime: item.type, name: file.name || `pasted-image.${item.type.split("/")[1]}` });
        renderAttachments();
        renderSendBtn();
      };
      reader.readAsDataURL(file);
    }
  }
});

$("sendBtn").addEventListener("click", () => (state.busy && !input.value.trim() ? send({ type: "abort" }) : submit()));
$("modeBtn").addEventListener("click", cycleAgent);
$("editsBtn").addEventListener("click", () => setAutoEdit(!state.autoEdit));
$("selBtn").addEventListener("click", () => ((state.includeSelection = !state.includeSelection), renderSelBtn()));
$("atBtn").addEventListener("click", () => {
  const pos = input.selectionStart;
  const pre = input.value.slice(0, pos);
  const ins = pre && !/\s$/.test(pre) ? " @" : "@";
  input.value = pre + ins + input.value.slice(pos);
  input.focus();
  input.setSelectionRange(pos + ins.length, pos + ins.length);
  updateMenuFromInput();
});
$("slashBtn").addEventListener("click", () => {
  input.value = "/";
  input.focus();
  input.setSelectionRange(1, 1);
  updateMenuFromInput();
});
$("ctxBtn").addEventListener("click", () => {
  send({ type: "compact", model: state.model || undefined, ask: true });
});
$("modelBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (menu?.kind === "model") return closeMenu();
  openModelMenu();
});
document.addEventListener("click", (e) => {
  if (menu?.kind === "model" && !menuEl.contains(e.target)) closeMenu();
  if (!$("historyPop").contains(e.target) && !e.target.closest("#historyBtn, #titleBtn")) $("historyPop").classList.add("hidden");
  if (!$("morePop").contains(e.target) && !e.target.closest("#moreBtn")) $("morePop").classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
  // Esc stops the run, unless a permission or question card is open (Esc answers those instead).
  if (e.key === "Escape" && state.busy && document.activeElement !== input && !state.permissions.length && !state.questions.length) send({ type: "abort" });
});

// Clicks inside rendered markdown
messagesEl.addEventListener("click", (e) => {
  const copy = e.target.closest(".copy-code");
  if (copy) {
    const code = copy.closest(".code-block").querySelector("code").textContent;
    navigator.clipboard.writeText(code);
    copy.innerHTML = icons.check;
    setTimeout(() => (copy.innerHTML = icons.copy), 1200);
    return;
  }
  const a = e.target.closest("a:not(.file-ref)");
  const href = a?.getAttribute("href");
  if (href) {
    e.preventDefault();
    // Web links open in the browser via VS Code; anything else is treated as a file path.
    if (/^https?:/.test(href)) send({ type: "openExternal", url: href });
    else openPath(href);
  }
  const ref = e.target.closest(".file-ref");
  if (ref) {
    e.preventDefault();
    send({ type: "openFile", path: ref.dataset.path, line: ref.dataset.line ? +ref.dataset.line : undefined });
  }
});

function fileUrlToPath(url) {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
}
function openPath(p, line) {
  const m = String(p).match(/^(.*?)(?::(\d+))?$/);
  send({ type: "openFile", path: m[1], line: line ?? (m[2] ? +m[2] : undefined) });
}

// --------------------------------------------------------- history / more

function toggleHistory(show) {
  const pop = $("historyPop");
  const visible = show ?? pop.classList.contains("hidden");
  pop.classList.toggle("hidden", !visible);
  if (visible) {
    pop.innerHTML = `<div class="pop-loading">Loading…</div>`;
    send({ type: "listSessions" });
  }
}
$("historyBtn").addEventListener("click", () => toggleHistory());
$("titleBtn").addEventListener("click", () => toggleHistory());
$("newBtn").addEventListener("click", () => send({ type: "newSession" }));
$("newBtn").title = "New conversation (opens a new tab if this one has messages)";
$("moreBtn").addEventListener("click", () => {
  const pop = $("morePop");
  pop.classList.toggle("hidden");
  pop.innerHTML = "";
  const item = (label, fn) => pop.append(h("div", { class: "pop-item", onClick: () => (pop.classList.add("hidden"), fn()) }, label));
  item("New conversation in a worktree…", () => send({ type: "newWorktree" }));
  item(state.session?.share?.url ? "Copy share link" : "Share conversation…", () => send({ type: "share" }));
  item("Compact conversation", () => runBuiltin("compact"));
  item("Providers and MCP servers…", () => send({ type: "openSettings" }));
  item("Show logs", () => send({ type: "showLogs" }));
});

function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function renderSessions(list) {
  const pop = $("historyPop");
  pop.innerHTML = "";
  const search = h("input", { class: "pop-search", placeholder: "Search conversations…" });
  const listEl = h("div", { class: "pop-list" });
  const draw = () => {
    listEl.innerHTML = "";
    const q = search.value.toLowerCase();
    const items = list.filter((s) => (s.title || "").toLowerCase().includes(q));
    if (!items.length) listEl.append(h("div", { class: "pop-loading" }, "No conversations"));
    for (const s of items) {
      listEl.append(
        h(
          "div",
          { class: `pop-item session-item ${state.session?.id === s.id ? "current" : ""}`, onClick: () => (send({ type: "loadSession", id: s.id }), pop.classList.add("hidden")) },
          h("span", { class: "s-title" }, s.title || "Untitled"),
          h("span", { class: "s-time" }, relTime(s.time?.updated || s.time?.created || Date.now())),
          h("button", {
            class: "icon-btn s-del",
            title: "Delete",
            html: icons.trash,
            onClick: (e) => {
              e.stopPropagation();
              send({ type: "deleteSession", id: s.id });
            },
          }),
        ),
      );
    }
  };
  search.addEventListener("input", draw);
  pop.append(search, listEl);
  draw();
  search.focus();
}

// ---------------------------------------------------------------- messages

function upsertMessage(info) {
  let m = state.messages.get(info.id);
  if (!m) {
    m = { info, parts: new Map() };
    state.messages.set(info.id, m);
    state.order.push(info.id);
    state.order.sort();
  } else m.info = info;
  return m;
}

function loadSession(session, messages) {
  state.session = session;
  state.childParts.clear();
  state.childRequested.clear();
  state.messages.clear();
  state.order = [];
  state.permissions = [];
  state.questions = [];
  state.todos = [];
  state.diff = [];
  renderChanges();
  for (const { info, parts } of messages) {
    const m = upsertMessage(info);
    for (const p of parts) m.parts.set(p.id, p);
  }
  const last = messages[messages.length - 1]?.info;
  const lastUser = [...messages].reverse().find((m) => m.info.role === "user")?.info;
  if (lastUser?.agent && state.agents.includes(lastUser.agent)) {
    state.agent = lastUser.agent;
    renderModeBtn();
  }
  setBusy(!!last && last.role === "assistant" && !last.time?.completed && !last.error);
  // Last todo state from history
  for (const { parts } of messages) for (const p of parts) if (p.type === "tool" && p.tool === "todowrite" && p.state?.input?.todos) state.todos = p.state.input.todos;
  renderTitle();
  renderTodos();
  renderCards();
  stickToBottom = true;
  queueRender();
}

function onEvent(e) {
  const p = e.properties || {};
  switch (e.type) {
    case "message.updated": {
      upsertMessage(p.info);
      if (p.info.role === "assistant" && !p.info.time?.completed) setBusy(true);
      queueRender(p.info.id);
      break;
    }
    case "message.removed": {
      state.messages.delete(p.messageID);
      state.order = state.order.filter((x) => x !== p.messageID);
      queueRender();
      break;
    }
    case "message.part.updated": {
      const part = p.part;
      let m = state.messages.get(part.messageID);
      if (!m) m = upsertMessage({ id: part.messageID, sessionID: part.sessionID, role: "assistant", time: {} });
      m.parts.set(part.id, part);
      if (part.type === "tool" && part.tool === "todowrite" && part.state?.input?.todos) {
        state.todos = part.state.input.todos;
        renderTodos();
      }
      queueRender(part.messageID);
      break;
    }
    case "message.part.delta": {
      const m = state.messages.get(p.messageID);
      const part = m?.parts.get(p.partID);
      if (part) {
        part[p.field] = (part[p.field] || "") + p.delta;
        queueRender(p.messageID);
      }
      break;
    }
    case "message.part.removed": {
      state.messages.get(p.messageID)?.parts.delete(p.partID);
      queueRender(p.messageID);
      break;
    }
    case "session.status":
      setBusy(p.status?.type !== "idle");
      break;
    case "session.idle":
      setBusy(false);
      break;
    case "session.updated":
      if (p.info?.id === state.session?.id) {
        const revertChanged = JSON.stringify(state.session.revert) !== JSON.stringify(p.info.revert);
        state.session = p.info;
        renderTitle();
        if (revertChanged) queueRender();
        if (pendingUndo && p.info.revert?.messageID === pendingUndo.id) {
          if (!input.value.trim()) {
            input.value = pendingUndo.text;
            autosize();
            renderSendBtn();
          }
          pendingUndo = null;
        }
      }
      break;
    case "session.error":
      if (p.error && p.error.name !== "MessageAbortedError") showError(errorText(p.error));
      setBusy(false);
      break;
    case "session.diff":
      state.diff = p.diff || [];
      renderChanges();
      break;
    case "todo.updated":
      state.todos = p.todos || [];
      renderTodos();
      break;
    case "permission.asked":
      if (!state.permissions.some((x) => x.id === p.id)) state.permissions.push(p);
      renderCards();
      break;
    case "permission.replied":
      state.permissions = state.permissions.filter((x) => x.id !== (p.requestID || p.permissionID || p.id));
      renderCards();
      break;
    case "question.asked":
      if (!state.questions.some((x) => x.id === p.id)) state.questions.push(p);
      renderCards();
      break;
    case "question.replied":
    case "question.rejected":
      state.questions = state.questions.filter((x) => x.id !== (p.requestID || p.id));
      renderCards();
      break;
  }
}

let errorTimer;
function showError(message) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = h("div", { class: "toast" });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => el.classList.remove("show"), 8000);
  el.onclick = () => el.classList.remove("show");
}

window.addEventListener("message", (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init":
      state.ready = true;
      state.autoEdit = msg.autoEdit;
      state.agents = msg.agents.length ? msg.agents : ["build"];
      state.agentColors = msg.agentColors || {};
      if (!state.agents.includes(state.agent)) state.agent = state.agents[0];
      state.models = msg.models;
      state.cwd = msg.cwd;
      state.commands = msg.commands;
      if (!state.model || !state.models.some((m) => m.providerID === state.model.providerID && m.modelID === state.model.modelID)) state.model = msg.defaultModel || null;
      renderModeBtn();
      renderModelBtn();
      queueRender();
      break;
    case "serverStatus":
      state.serverStatus = msg.status;
      document.body.classList.toggle("server-error", msg.status === "error");
      if (!state.order.length) queueRender();
      break;
    case "session":
      state.worktree = msg.worktree || null;
      renderWorktreeBar();
      loadSession(msg.session, msg.messages);
      break;
    case "tabs":
      renderTabs(msg.tabs, msg.active);
      break;
    case "childParts": {
      if (!state.childParts.has(msg.sessionID)) state.childParts.set(msg.sessionID, new Map());
      const map = state.childParts.get(msg.sessionID);
      for (const part of msg.parts) map.set(part.id, part);
      const owner = taskOwner(msg.sessionID);
      if (owner) queueRender(owner);
      break;
    }
    case "commandMeta":
      for (const e of msg.entries) {
        state.commandMeta.set(e.messageID, { name: e.name, arguments: e.arguments });
        queueRender(e.messageID);
      }
      break;
    case "externalPrompt":
      sendExternal(msg.text, msg.mentions);
      break;
    case "event":
      onEvent(msg.event);
      break;
    case "sessions":
      renderSessions(msg.sessions);
      break;
    case "fileResults":
      if (menu?.kind === "file" && msg.query === fileQuery) {
        menu.items = msg.files.map((f) => ({ label: f.split("/").pop() || f, detail: f, value: f, icon: f.endsWith("/") ? icons.folder : icons.file }));
        menu.index = 0;
        drawMenu();
      }
      break;
    case "selection":
      state.selection = msg.selection;
      renderSelBtn();
      break;
    case "insertMention": {
      const m = msg.mention;
      const token = `@${m.path}${m.startLine ? `#L${m.startLine}${m.endLine && m.endLine !== m.startLine ? `-${m.endLine}` : ""}` : ""} `;
      const pos = input.selectionStart ?? input.value.length;
      const pre = input.value.slice(0, pos);
      const ins = (pre && !/\s$/.test(pre) ? " " : "") + token;
      input.value = pre + ins + input.value.slice(pos);
      input.setSelectionRange(pos + ins.length, pos + ins.length);
      autosize();
      renderSendBtn();
      break;
    }
    case "focus":
      input.focus();
      break;
    case "error":
      showError(msg.message);
      break;
  }
});

/** Message that holds the task step which started a subagent session. */
function taskOwner(childID) {
  for (const [id, m] of state.messages) {
    for (const p of m.parts.values()) if (p.type === "tool" && p.tool === "task" && p.state?.metadata?.sessionId === childID) return id;
  }
  return undefined;
}

function renderTabs(tabs, active) {
  const bar = $("tabbar");
  bar.classList.toggle("hidden", tabs.length < 2);
  bar.innerHTML = "";
  for (const t of tabs) {
    const el = h(
      "div",
      { class: `tab ${t.key === active ? "active" : ""} status-${t.status}`, title: t.title, onClick: () => t.key !== active && send({ type: "switchTab", key: t.key }) },
      t.status === "busy" ? h("span", { class: "tab-busy" }) : t.status === "attention" ? h("span", { class: "tab-attention", html: icons.shield }) : null,
      t.worktree ? h("span", { class: "tab-wt", title: `Worktree ${t.worktree.name}`, html: icons.branch }) : null,
      h("span", { class: "tab-title" }, t.title),
      h("button", {
        class: "tab-close",
        title: "Close tab (the conversation stays in history)",
        html: icons.x,
        onClick: (e) => {
          e.stopPropagation();
          send({ type: "closeTab", key: t.key });
        },
      }),
    );
    bar.append(el);
  }
  bar.append(h("button", { class: "icon-btn tab-new", title: "New conversation tab", html: icons.plus, onClick: () => send({ type: "newSession" }) }));
  bar.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderWorktreeBar() {
  const bar = $("worktreeBar");
  const wt = state.worktree;
  bar.classList.toggle("hidden", !wt);
  if (!wt) return;
  bar.innerHTML = "";
  bar.append(
    h("span", { class: "tool-icon", html: icons.branch }),
    h("span", { class: "wt-text" }, "Working in worktree ", h("b", {}, wt.name), wt.branch ? ` (${wt.branch})` : "", ". Your files are untouched."),
    h("button", { class: "btn", onClick: () => send({ type: "applyWorktree" }) }, "Apply to workspace"),
    h("button", { class: "btn danger", onClick: () => send({ type: "discardWorktree" }) }, "Remove"),
  );
}

renderModeBtn();
renderModelBtn();
renderSendBtn();
queueRender();
send({ type: "ready" });
