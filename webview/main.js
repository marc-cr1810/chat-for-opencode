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
      return `<a href="${escapeHtml(href)}" title="${escapeHtml(title || "")}">${text}</a>`;
    },
  },
});
const md = (text) => marked.parse(text || "");

// --------------------------------------------------------------------- state

const MODES = {
  ask: { label: "Ask before edits", icon: icons.hand },
  auto: { label: "Edit automatically", icon: icons.fastForward },
  plan: { label: "Plan mode", icon: icons.pause },
};
const MODE_ORDER = ["ask", "auto", "plan"];
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const VERBS = ["Thinking", "Pondering", "Cooking", "Tinkering", "Crafting", "Noodling", "Brewing", "Computing", "Mulling", "Percolating", "Conjuring", "Scheming"];
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
  mode: "ask",
  models: [],
  model: saved.model || null,
  commands: [],
  session: null,
  messages: new Map(), // id -> { info, parts: Map }
  order: [], // message ids
  busy: false,
  busySince: 0,
  verb: VERBS[0],
  permissions: [], // pending requests
  questions: [],
  todos: [],
  todosOpen: true,
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
  <main class="messages" id="messages"></main>
  <div class="bottom">
    <div class="todos hidden" id="todos"></div>
    <div id="cards"></div>
    <div class="composer" id="composer">
      <div class="menu hidden" id="menu"></div>
      <div class="attachments hidden" id="attachments"></div>
      <textarea id="input" rows="1" placeholder="Ask OpenCode…  (@ files, / commands)"></textarea>
      <div class="composer-foot">
        <div class="foot-left">
          <button class="pill mode-pill" id="modeBtn" title="Switch mode (Shift+Tab)"></button>
          <button class="pill sel-pill hidden" id="selBtn" title="Include current selection"></button>
        </div>
        <div class="foot-right">
          <button class="icon-btn" id="atBtn" title="Add file (@)">${icons.at}</button>
          <button class="icon-btn" id="slashBtn" title="Commands (/)">${icons.slash}</button>
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
          tip(icons.at, "Mention files with @, or press Alt+K in the editor"),
          tip(icons.slash, "Type / for commands"),
          tip(icons.fastForward, "Shift+Tab switches between ask, auto-edit and plan modes"),
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
    if (!state.order.length) messagesEl.append(renderEmpty());
    for (const id of state.order) messagesEl.append(renderMessage(id));
    messagesEl.append(renderStatusRow());
    scrollToBottom();
    return;
  }
  for (const id of renderQueued) {
    const old = messagesEl.querySelector(`[data-mid="${id}"]`);
    const fresh = renderMessage(id);
    if (old) {
      preserveOpen(old, fresh);
      old.replaceWith(fresh);
    } else {
      messagesEl.querySelector(".empty")?.remove();
      const status = messagesEl.querySelector(".status-row");
      messagesEl.insertBefore(fresh, status);
    }
  }
  renderQueued.clear();
  updateStatusRow();
  scrollToBottom();
}

/** Keep expanded tool/thinking blocks expanded across re-renders. */
function preserveOpen(oldEl, newEl) {
  oldEl.querySelectorAll("[data-pid].open").forEach((o) => {
    newEl.querySelector(`[data-pid="${o.dataset.pid}"]`)?.classList.add("open");
  });
  oldEl.querySelectorAll("[data-pid].closed").forEach((o) => {
    newEl.querySelector(`[data-pid="${o.dataset.pid}"]`)?.classList.remove("open");
  });
}

function renderMessage(id) {
  const msg = state.messages.get(id);
  const parts = [...msg.parts.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (msg.info.role === "user") {
    const text = parts.filter((p) => p.type === "text" && !p.synthetic && !p.ignored).map((p) => p.text).join("\n");
    const files = parts.filter((p) => p.type === "file");
    return h(
      "div",
      { class: "msg user", "data-mid": id },
      h(
        "div",
        { class: "user-bubble" },
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
  for (const p of parts) {
    const node = renderPart(p);
    if (node) el.append(node);
  }
  if (msg.info.error && msg.info.error.name !== "MessageAbortedError") {
    el.append(h("div", { class: "error-block" }, errorText(msg.info.error)));
  } else if (msg.info.error?.name === "MessageAbortedError") {
    el.append(h("div", { class: "interrupted" }, "Interrupted by user"));
  }
  return el;
}

function errorText(err) {
  return err?.data?.message || err?.message || err?.name || "Unknown error";
}

function renderPart(p) {
  switch (p.type) {
    case "text":
      if (p.synthetic || p.ignored || !p.text) return null;
      return h("div", { class: "row text-row", "data-pid": p.id }, h("span", { class: "dot text-dot" }), h("div", { class: "markdown", html: md(p.text) }));
    case "reasoning": {
      if (!p.text?.trim()) return null;
      const done = !!p.time?.end;
      const secs = done ? Math.max(1, Math.round((p.time.end - p.time.start) / 1000)) : null;
      return collapsible(p.id, h("span", { class: "thinking-label" }, done ? `Thought for ${secs}s` : "Thinking…"), h("div", { class: "markdown thinking", html: md(p.text) }), "thinking-row", false);
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

function collapsible(pid, head, body, cls, open) {
  const el = h("div", { class: `row collapsible ${cls} ${open ? "open" : ""}`, "data-pid": pid });
  const header = h("div", { class: "coll-head" }, head, h("span", { class: "chev", html: icons.chevronRight }));
  header.addEventListener("click", () => {
    el.classList.toggle("open");
    el.classList.toggle("closed", !el.classList.contains("open"));
  });
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
      return { name: "Read", arg: short(file), file };
    case "edit":
    case "multiedit":
      return { name: "Update", arg: short(file), file };
    case "write":
      return { name: "Write", arg: short(file), file };
    case "patch":
    case "apply_patch":
      return { name: "Patch", arg: p.state?.title || "" };
    case "bash":
      return { name: "Bash", arg: i.command || "" };
    case "glob":
      return { name: "Search", arg: `${i.pattern || ""}${i.path ? " in " + short(i.path) : ""}` };
    case "grep":
      return { name: "Grep", arg: `"${i.pattern || ""}"${i.path ? " in " + short(i.path) : ""}` };
    case "list":
      return { name: "List", arg: short(i.path) || "." };
    case "webfetch":
      return { name: "Fetch", arg: i.url || "" };
    case "websearch":
    case "codesearch":
      return { name: "Web Search", arg: i.query || "" };
    case "task":
      return { name: "Task", arg: i.description || i.subagent_type || "" };
    case "todowrite":
      return { name: "Update Todos", arg: "" };
    case "todoread":
      return { name: "Read Todos", arg: "" };
    case "skill":
      return { name: "Skill", arg: i.name || "" };
    case "question":
      return { name: "Question", arg: "" };
    default:
      return { name: t, arg: p.state?.title || "" };
  }
}

function renderTool(p) {
  const st = p.state || {};
  const { name, arg, file } = toolSummary(p);
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
    summary = h("span", { class: "tool-summary" }, st.input?.subagent_type ? `@${st.input.subagent_type}` : "");
    if (st.output) body = h("div", { class: "markdown", html: md(st.output) });
  } else if (st.output) {
    const out = String(st.output);
    const lineCount = out.split("\n").length;
    summary = h("span", { class: "tool-summary" }, p.tool === "bash" ? firstLine(out) || "(no output)" : `${lineCount} line${lineCount === 1 ? "" : "s"}`);
    body = h("pre", { class: "tool-output" }, out.length > 20000 ? out.slice(0, 20000) + "\n… (truncated)" : out);
  } else if (status === "running" && p.tool === "bash" && meta.output) {
    body = h("pre", { class: "tool-output" }, meta.output);
    open = true;
  }

  const dot = h("span", { class: `dot tool-dot ${status}` });
  if (!body) {
    return h(
      "div",
      { class: "row tool-row", "data-pid": p.id },
      dot,
      h("div", { class: "tool-main" }, head, summary ? h("div", { class: "tool-sub" }, h("span", { class: "elbow" }, "⎿"), summary) : null),
    );
  }
  const el = h("div", { class: `row tool-row collapsible ${open ? "open" : ""}`, "data-pid": p.id }, dot);
  const header = h("div", { class: "coll-head" }, head, h("span", { class: "chev", html: icons.chevronRight }));
  header.addEventListener("click", () => {
    el.classList.toggle("open");
    el.classList.toggle("closed", !el.classList.contains("open"));
  });
  el.append(h("div", { class: "tool-main" }, header, summary ? h("div", { class: "tool-sub" }, h("span", { class: "elbow" }, "⎿"), summary) : null, h("div", { class: "coll-body" }, body)));
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

// Status ("✻ Pondering… (12s · esc to interrupt)")
let spinnerFrame = 0;
function renderStatusRow() {
  const el = h("div", { class: "status-row" });
  fillStatusRow(el);
  return el;
}
function fillStatusRow(el) {
  el.classList.toggle("hidden", !state.busy || state.permissions.length > 0 || state.questions.length > 0);
  if (!state.busy) return;
  const secs = Math.floor((Date.now() - state.busySince) / 1000);
  el.innerHTML = "";
  el.append(h("span", { class: "spinner" }, SPINNER[spinnerFrame % SPINNER.length]), h("span", { class: "verb" }, `${state.verb}…`), h("span", { class: "status-hint" }, `(${secs}s · esc to interrupt)`));
}
function updateStatusRow() {
  const el = messagesEl.querySelector(".status-row");
  if (el) fillStatusRow(el);
}
setInterval(() => {
  if (!state.busy) return;
  spinnerFrame++;
  updateStatusRow();
}, 120);

function setBusy(busy) {
  if (busy && !state.busy) {
    state.busySince = Date.now();
    state.verb = VERBS[Math.floor(Math.random() * VERBS.length)];
  }
  state.busy = busy;
  updateStatusRow();
  renderSendBtn();
}

// -------------------------------------------------------------- header etc.

function renderTitle() {
  $("titleText").textContent = state.session?.title && !/^New session/i.test(state.session.title) ? state.session.title : "New conversation";
}

function renderModeBtn() {
  const m = MODES[state.mode];
  $("modeBtn").innerHTML = `${m.icon}<span>${m.label}</span>`;
  $("modeBtn").className = `pill mode-pill mode-${state.mode}`;
}

function renderModelBtn() {
  const m = state.models.find((x) => state.model && x.providerID === state.model.providerID && x.modelID === state.model.modelID);
  $("modelBtn").innerHTML = `<span>${escapeHtml(m ? m.name : state.model ? state.model.modelID : "Default model")}</span>${icons.chevronDown}`;
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
      return { title: `Make this edit to ${short(file)}?`, file };
    case "bash":
      return { title: "Allow this command?", command: md0.command || (p.patterns || []).join(" ") };
    case "webfetch":
      return { title: `Fetch ${md0.url || (p.patterns || [])[0] || "this URL"}?` };
    case "external_directory":
      return { title: `Access files outside the workspace (${(p.patterns || []).join(", ")})?` };
    case "doom_loop":
      return { title: "OpenCode is repeating the same tool call. Continue?" };
    default:
      return { title: `Allow ${p.permission}${p.patterns?.length ? ` on ${p.patterns.join(", ")}` : ""}?` };
  }
}

function renderPermission(p) {
  const info = permissionTitle(p);
  const meta = p.metadata || {};
  const diff = meta.diff;
  const options = [
    { label: "Yes", reply: "once" },
    {
      label: p.permission === "edit" ? "Yes, allow all edits this session" : p.always?.length ? `Yes, and don't ask again for ${p.always.join(", ")}` : "Yes, and don't ask again",
      reply: "always",
    },
    { label: "No, and tell OpenCode what to do differently", reply: "reject" },
  ];
  const feedback = h("textarea", { class: "feedback", rows: 2, placeholder: "Tell OpenCode what to do instead (optional)" });
  const reply = (r) => {
    send({ type: "permissionReply", id: p.id, reply: r, message: r === "reject" ? feedback.value.trim() : undefined });
    state.permissions = state.permissions.filter((x) => x.id !== p.id);
    if (r === "always" && p.permission === "edit" && state.mode === "ask") setMode("auto");
    renderCards();
  };
  const card = h(
    "div",
    { class: "card permission", tabindex: "0" },
    h("div", { class: "card-title" }, info.title),
    info.command ? h("pre", { class: "card-command" }, info.command) : null,
    meta.description ? h("div", { class: "card-desc" }, meta.description) : null,
    diff ? h("div", { class: "card-diff" }, renderDiff(diff)) : null,
    diff && info.file ? h("button", { class: "link-btn", onClick: () => send({ type: "openDiff", filePath: info.file, diff, before: meta.filediff?.before, after: meta.filediff?.after }) }, "Open diff in editor") : null,
    h(
      "div",
      { class: "options" },
      options.map((o, i) => h("button", { class: `option ${i === 0 ? "primary" : ""}`, onClick: () => reply(o.reply) }, h("span", { class: "num" }, i + 1), o.label)),
    ),
    feedback,
    h("div", { class: "card-hint" }, "Press 1–3 to choose · Esc to reject"),
  );
  card.addEventListener("keydown", (e) => {
    if (e.target === feedback && e.key !== "Escape" && !(e.key === "Enter" && !e.shiftKey)) return;
    if (e.target === feedback && e.key === "Enter") {
      e.preventDefault();
      return reply("reject");
    }
    if (e.key === "1") reply("once");
    else if (e.key === "2") reply("always");
    else if (e.key === "3") {
      e.preventDefault();
      feedback.focus();
    } else if (e.key === "Escape") reply("reject");
  });
  setTimeout(() => card.focus(), 0);
  return card;
}

function renderQuestion(q) {
  const answers = q.questions.map(() => new Set());
  const customs = q.questions.map(() => "");
  const card = h("div", { class: "card question" });
  q.questions.forEach((qi, idx) => {
    const opts = h("div", { class: "options" });
    qi.options.forEach((o, i) => {
      const btn = h(
        "button",
        { class: "option", title: o.description },
        h("span", { class: "num" }, i + 1),
        h("span", {}, h("span", { class: "opt-label" }, o.label), o.description ? h("span", { class: "opt-desc" }, o.description) : null),
      );
      btn.addEventListener("click", () => {
        if (!qi.multiple) answers[idx].clear();
        if (answers[idx].has(o.label)) answers[idx].delete(o.label);
        else answers[idx].add(o.label);
        opts.querySelectorAll(".option").forEach((b, j) => b.classList.toggle("selected", answers[idx].has(qi.options[j].label)));
        if (!qi.multiple && q.questions.length === 1) submit();
      });
      opts.append(btn);
    });
    card.append(h("div", { class: "q-header" }, qi.header), h("div", { class: "card-title" }, qi.question), opts);
    if (qi.custom !== false) {
      const t = h("input", { class: "custom", placeholder: "Something else…" });
      t.addEventListener("input", () => (customs[idx] = t.value));
      t.addEventListener("keydown", (e) => e.key === "Enter" && submit());
      card.append(t);
    }
  });
  const submit = () => {
    const out = answers.map((s, i) => (customs[i].trim() ? [...s, customs[i].trim()] : [...s]));
    send({ type: "questionReply", id: q.id, answers: out });
    state.questions = state.questions.filter((x) => x.id !== q.id);
    renderCards();
  };
  card.append(
    h(
      "div",
      { class: "card-actions" },
      h("button", { class: "btn primary", onClick: submit }, "Submit"),
      h("button", { class: "btn", onClick: () => (send({ type: "questionReject", id: q.id }), (state.questions = state.questions.filter((x) => x.id !== q.id)), renderCards()) }, "Skip"),
    ),
  );
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
  }
  autosize();
  renderSendBtn();
  input.focus();
}

let fileQuery = null;
function updateMenuFromInput() {
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const at = before.match(/(^|\s)@([^\s@]*)$/);
  if (at) {
    const start = caret - at[2].length - 1;
    fileQuery = at[2];
    if (!menu || menu.kind !== "file") openMenu("file", [], start);
    else menu.start = start;
    send({ type: "searchFiles", query: at[2] });
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
    mode: state.mode,
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

function setMode(mode) {
  state.mode = mode;
  renderModeBtn();
  send({ type: "setMode", mode });
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
  if (e.key === "Tab" && e.shiftKey) {
    e.preventDefault();
    return setMode(MODE_ORDER[(MODE_ORDER.indexOf(state.mode) + 1) % MODE_ORDER.length]);
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
$("modeBtn").addEventListener("click", () => setMode(MODE_ORDER[(MODE_ORDER.indexOf(state.mode) + 1) % MODE_ORDER.length]));
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
  if (e.key === "Escape" && state.busy && document.activeElement !== input && !state.permissions.length) send({ type: "abort" });
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
  const a = e.target.closest("a");
  if (a && a.getAttribute("href") && !/^https?:/.test(a.getAttribute("href"))) {
    e.preventDefault();
    openPath(a.getAttribute("href"));
  }
  const code = e.target.closest(".markdown code");
  if (code && !code.closest("pre")) {
    const m = code.textContent.match(/^([\w./-]+\.\w+)(?::(\d+))?$/);
    if (m && m[1].includes("/")) openPath(m[1], m[2] ? +m[2] : undefined);
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
$("moreBtn").addEventListener("click", () => {
  const pop = $("morePop");
  pop.classList.toggle("hidden");
  pop.innerHTML = "";
  const item = (label, fn) => pop.append(h("div", { class: "pop-item", onClick: () => (pop.classList.add("hidden"), fn()) }, label));
  item("Compact conversation", () => runBuiltin("compact"));
  item("Settings", () => send({ type: "openSettings" }));
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
  state.messages.clear();
  state.order = [];
  state.permissions = [];
  state.questions = [];
  state.todos = [];
  for (const { info, parts } of messages) {
    const m = upsertMessage(info);
    for (const p of parts) m.parts.set(p.id, p);
  }
  const last = messages[messages.length - 1]?.info;
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
        state.session = p.info;
        renderTitle();
      }
      break;
    case "session.error":
      if (p.error && p.error.name !== "MessageAbortedError") showError(errorText(p.error));
      setBusy(false);
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
      state.mode = msg.mode;
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
      loadSession(msg.session, msg.messages);
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

renderModeBtn();
renderModelBtn();
renderSendBtn();
queueRender();
send({ type: "ready" });
