// OpenCode chat webview. Plain DOM, bundled by esbuild.
import { Marked } from "marked";
import katex from "katex";
import hljs from "highlight.js/lib/common";
import markedFootnote from "marked-footnote";
import { icons } from "./icons.js";
import { domain, lspHover, lspLocations, lspName, mainArg, mcpTool, parseGlob, parseGrep, parseSearch } from "./toolOutput.js";

const vscode = acquireVsCodeApi();

// ------------------------------------------------------------------ markdown

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Math: $$…$$ and \[…\] as display blocks, $…$ and \(…\) inline. A $ only opens inline math when
// followed by a non-space and closes on a non-space not followed by a digit, so "$5 and $10" stays text,
// and never runs into a code span, so "$10 and `$HOME`" does too.
function tex(src, displayMode) {
  try {
    return katex.renderToString(src, { displayMode, throwOnError: false, output: "htmlAndMathml" });
  } catch {
    return `<code>${escapeHtml(src)}</code>`;
  }
}
const mathBlock = {
  name: "mathBlock",
  level: "block",
  start: (src) => src.match(/\$\$|\\\[/)?.index,
  tokenizer(src) {
    const m = src.match(/^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/);
    if (m) return { type: "mathBlock", raw: m[0], text: (m[1] ?? m[2]).trim() };
  },
  renderer: (token) => `<div class="math-block">${tex(token.text, true)}</div>`,
};
const mathInline = {
  name: "mathInline",
  level: "inline",
  start: (src) => src.match(/\$|\\\(/)?.index,
  tokenizer(src) {
    const m =
      src.match(/^\$\$([\s\S]+?)\$\$/) ??
      src.match(/^\\\(([\s\S]+?)\\\)/) ??
      src.match(/^\$(?![\s$])((?:\\.|[^\\$`\n])*?[^\s\\`])\$(?!\d)/);
    if (m) return { type: "mathInline", raw: m[0], text: m[1].trim(), display: m[0].startsWith("$$") };
  },
  renderer: (token) => tex(token.text, token.display),
};

// Syntax highlighting for fenced code with a language hljs knows. Unlabelled blocks stay plain:
// guessing is slow on every streamed update and often wrong.
function highlight(code, lang) {
  const name = (lang || "").trim().split(/\s/)[0].toLowerCase();
  if (!name || !hljs.getLanguage(name)) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

// Raw HTML is escaped except for a few formatting tags, rebuilt without attributes (bar <details open>)
// so nothing the model writes can add scripts, styles or event handlers. Entities pass through.
const SAFE_TAGS = new Set(["details", "summary", "kbd", "sub", "sup", "br", "mark", "ins", "del", "s", "u", "b", "i", "em", "strong", "small", "abbr"]);
function safeHtml(html) {
  return html.replace(/<(\/?)([a-z][a-z0-9]*)\b([^<>]*)>|&(?:#\d+|#x[\da-f]+|[a-z]\w*);|[^<&]+|[<&]/gi, (all, close, tag, attrs) => {
    if (all[0] === "&" && all.length > 1) return all;
    if (!tag) return escapeHtml(all);
    const name = tag.toLowerCase();
    if (!SAFE_TAGS.has(name)) return escapeHtml(all);
    if (close) return name === "br" ? "" : `</${name}>`;
    return name === "details" && /\bopen\b/i.test(attrs) ? "<details open>" : `<${name}>`;
  });
}

// GitHub alerts: a quote starting with [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION].
const ALERTS = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };
function alert(quote) {
  const m = quote.match(/^<p>\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|<br>)?/i);
  if (!m) return false;
  const kind = m[1].toLowerCase();
  const body = "<p>" + quote.slice(m[0].length);
  return `<div class="alert alert-${kind}"><div class="alert-title">${icons[`alert_${kind}`]}${ALERTS[kind]}</div>${body.replace(/^<p>\s*<\/p>\s*/, "")}</div>`;
}

// Mermaid diagrams render after the markdown is in the page (see renderDiagrams); until then, and
// whenever the source doesn't parse (say, mid-stream), the block reads as ordinary code. Once drawn,
// the diagram replaces the code block, which the toggle brings back.
function codeBlock(code, lang) {
  const mermaid = lang === "mermaid";
  const copy = `<button class="icon-btn copy-code" title="Copy">${icons.copy}</button>`;
  const buttons = mermaid ? `<span class="code-btns"><button class="icon-btn mermaid-toggle" title="Show diagram">${icons.diagram}</button>${copy}</span>` : copy;
  const block = `<div class="code-block"><div class="code-head"><span>${escapeHtml(lang || "")}</span>${buttons}</div><pre><code>${highlight(code, lang)}</code></pre></div>`;
  return mermaid ? `<div class="mermaid-block" data-src="${escapeHtml(code)}">${block}</div>` : block;
}

// The language for a file path, from its extension or, for names like Makefile, the whole name.
function langForPath(path) {
  const name = String(path || "").split(/[\\/]/).pop().toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : name;
  return ext && hljs.getLanguage(ext) ? ext : "";
}

// Highlighted HTML split into lines, each closing the spans it opens and reopening those carried
// over from earlier lines, so a multi-line string or comment stays colored on every line. Cached,
// since tool steps re-render on every update; very large files stay plain.
const lineCache = new Map();
function highlightLines(code, lang) {
  const key = `${lang}\n${code}`;
  let lines = lineCache.get(key);
  if (lines) return lines;
  const html = lang && code.length < 200_000 ? highlight(code, lang) : escapeHtml(code);
  lines = [];
  const open = [];
  for (const line of html.split("\n")) {
    const carried = open.join("");
    for (const [tag] of line.matchAll(/<span[^>]*>|<\/span>/g)) tag === "</span>" ? open.pop() : open.push(tag);
    lines.push(carried + line + "</span>".repeat(open.length));
  }
  if (lineCache.size > 200) lineCache.delete(lineCache.keys().next().value);
  lineCache.set(key, lines);
  return lines;
}

const marked = new Marked({
  gfm: true,
  extensions: [mathBlock, mathInline],
  breaks: false,
  renderer: {
    html: (html) => safeHtml(typeof html === "string" ? html : html.text),
    blockquote: alert,
    listitem(text, task) {
      return task ? `<li class="task">${text}</li>\n` : false;
    },
    code(code, lang) {
      return codeBlock(code, lang);
    },
    link(href, title, text) {
      const inner = text.replace(/<a class="file-ref"[^>]*>([\s\S]*?)<\/a>/g, "$1");
      if (mdBase) return `<a href="${escapeHtml(resolveUrl(href))}" title="${escapeHtml(title || "")}">${inner}</a>`;
      // A link to a file says which lines it opens at.
      const file = /^(?:[a-z][\w+.-]*:|#)/i.test(href) ? null : fileTarget(href);
      const tip = title || (file ? `Open ${file.path}${file.line ? `:${file.line}${file.end ? `-${file.end}` : ""}` : ""}` : "");
      return `<a href="${escapeHtml(href)}" title="${escapeHtml(tip)}">${inner}</a>`;
    },
    image(href, title, text) {
      // A fetched page's images are on the web, wherever its links point.
      if (mdBase) return /^https?:/.test(resolveUrl(href)) ? `<img src="${escapeHtml(resolveUrl(href))}" alt="${text}">` : text;
      return isWebUrl(href) ? false : localImage(localPath(href), text, title);
    },
    codespan(code) {
      const m = !mdBase && code.match(FILE_REF_EXACT);
      return m ? fileRef(m[1], m[2], m[3], `<code>${code}</code>`) : `<code>${code}</code>`;
    },
    text(text) {
      return typeof text === "string" && !mdBase ? linkFileRefs(text) : false;
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
// A link to a file, optionally at a line or range: path, path:12, path:12-20, path#L12 or path#L12-L20.
function fileTarget(href) {
  const m = String(href).match(/^(.*?)(?:#L?(\d+)(?:-L?(\d+))?|:(\d+)(?:-(\d+))?)?$/);
  let path = m[1];
  try {
    path = decodeURI(path);
  } catch {}
  const line = m[2] ?? m[4];
  const end = m[3] ?? m[5];
  return { path, line: line ? +line : undefined, end: end ? +end : undefined };
}

// Images: web and data URLs load as they are. Workspace files can't be read by the webview, so the
// extension reads them and sends them back (see loadLocalImages); until then the image is empty, and
// one that can't be read says so in its place.
const localImages = new Map(); // path → data URL, or null when it couldn't be read
const requestedImages = new Set();
const isWebUrl = (href) => /^(?:https?|data):/i.test(href);
const localPath = (href) => (/^file:/i.test(href) ? fileUrlToPath(href) : fileTarget(href).path);
const missingImage = (path) => `<span class="img-missing">${icons.imageOff}<code>${escapeHtml(path)}</code> not found</span>`;
function localImage(path, alt, title) {
  const url = localImages.get(path);
  if (url === null) return missingImage(path);
  return `<span class="md-img" data-path="${escapeHtml(path)}" title="${escapeHtml(title || `Open ${path}`)}"><img alt="${alt}" data-local="${escapeHtml(path)}"${url ? ` src="${url}"` : ""}><span class="img-path">${escapeHtml(path)}</span></span>`;
}

marked.use(markedFootnote({ description: "Footnotes" }));
const md = (text) => marked.parse(text || "");

// A web page as markdown (from Fetch): its relative links and images resolve against the page,
// and nothing in it is taken for a workspace file.
let mdBase = null;
function resolveUrl(href) {
  try {
    return new URL(href, mdBase).href;
  } catch {
    return href;
  }
}
function pageMd(text, url) {
  mdBase = url;
  try {
    return md(text);
  } finally {
    mdBase = null;
  }
}

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
  autoRead: false,
  /** From the extension's settings (see sendSettings in chat.ts). */
  settings: {
    defaultAgent: "",
    sendKey: "enter",
    includeSelection: true,
    reasoning: "collapsed",
    toolOutput: "auto",
    contextWarningPercent: 75,
    stallWarningSeconds: 30,
    responseTimeoutSeconds: 0,
  },
  /** When the model last sent anything for this conversation, for the stall warning and timeout. */
  lastActivity: 0,
  /** Set when the timeout stopped a run: { model, secs }. Cleared by the next message. */
  timedOut: null,
  /** Open conversations from the extension: [{ key, sessionID, title, status, worktree }], and the active key. */
  tabs: [],
  activeTab: null,
  /** OpenCode is waiting to retry a failed request: { attempt, message, next, action? } from session.status. */
  retry: null,
  readOnlyAgents: ["plan"],
  models: [],
  model: null,
  /** Agents an @mention hands work to: [{ name, description }]. */
  subagents: [],
  /** MCP server names, to read their tools' IDs back (see mcpTool). */
  mcpServers: [],
  /** The picked model's reasoning variant, or null for the model's default. */
  variant: null,
  /** The effort last picked by hand, carried to models that have no level remembered. */
  lastVariant: null,
  /** "provider/model" -> the effort last picked for that model (null: Default). */
  variantByModel: {},
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
  childParts: new Map(), // subagent sessionID -> Map(partID -> tool or text part)
  childRequested: new Set(),
  unfolded: new Set(), // "<partID>:steps|report|detail" the user opened inside a subagent step
  commandMeta: new Map(), // user message ID -> { name, arguments } for /commands
  worktree: null,
  selection: null,
  includeSelection: true,
  images: [],
  history: saved.history || [],
  historyIndex: -1,
  error: null,
};

const persist = () => vscode.setState({ history: state.history.slice(-50) });
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
      <span class="title-others" id="titleOthers"></span>
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

// Mermaid is large, so it loads on first use from its own file beside this bundle, with the same
// CSP nonce. Rendered diagrams are cached by theme and source so streamed re-renders don't redo them.
const bundleScript = document.currentScript;
let mermaidLoad;
function loadMermaid() {
  mermaidLoad ??= new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = new URL("mermaid/mermaid.min.js", bundleScript.src).href;
    el.nonce = bundleScript.nonce;
    el.onload = () => resolve(window.mermaid);
    el.onerror = reject;
    document.head.append(el);
  });
  return mermaidLoad;
}
const diagramCache = new Map();
let diagramTheme, diagramId = 0;
async function diagramSvg(src) {
  const light = document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light");
  const theme = light ? "default" : "dark";
  const key = `${theme}\n${src}`;
  if (diagramCache.has(key)) return diagramCache.get(key);
  const mermaid = await loadMermaid();
  if (diagramTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 13, themeVariables: { fontSize: "13px" } });
    diagramTheme = theme;
  }
  let svg = null;
  try {
    if (await mermaid.parse(src, { suppressErrors: true })) svg = (await mermaid.render(`mermaid-${++diagramId}`, src)).svg;
  } catch {}
  diagramCache.set(key, svg);
  return svg;
}
function renderDiagrams() {
  for (const block of messagesEl.querySelectorAll(".mermaid-block:not([data-tried])")) {
    block.dataset.tried = "";
    diagramSvg(block.dataset.src).then((svg) => {
      if (!svg || !block.isConnected) return;
      const tools = `<div class="mermaid-tools"><button class="icon-btn mermaid-toggle" title="Show source">${icons.code}</button><button class="icon-btn copy-code" title="Copy source">${icons.copy}</button></div>`;
      block.insertAdjacentHTML("afterbegin", `<div class="mermaid-svg">${tools}${svg}</div>`);
      block.classList.add("rendered");
    }, () => {});
  }
}
new MutationObserver(() => messagesEl.querySelector(".mermaid-block:not([data-tried])") && renderDiagrams()).observe(messagesEl, { childList: true, subtree: true });
// A theme switch redraws diagrams in the new colors.
new MutationObserver(() => {
  for (const block of messagesEl.querySelectorAll(".mermaid-block[data-tried]")) {
    block.classList.remove("rendered", "show-source");
    block.querySelector(".mermaid-svg")?.remove();
    delete block.dataset.tried;
  }
  renderDiagrams();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// Workspace images (see localImage) are asked for once each; the answer fills every copy in the page.
function loadLocalImages() {
  for (const img of messagesEl.querySelectorAll("img[data-local]:not([src])")) {
    const path = img.dataset.local;
    if (localImages.has(path)) showLocalImage(img, localImages.get(path));
    else if (!requestedImages.has(path)) {
      requestedImages.add(path);
      send({ type: "loadImage", path });
    }
  }
}
function showLocalImage(img, url) {
  if (url) img.src = url;
  else (img.closest(".md-img") ?? img).outerHTML = missingImage(img.dataset.local);
}
new MutationObserver(() => messagesEl.querySelector("img[data-local]:not([src])") && loadLocalImages()).observe(messagesEl, { childList: true, subtree: true });

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
          tip(icons.at, "@ mentions files, code and agents like @explore; Ctrl+Alt+K adds the editor selection"),
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
    // A command whose agent is a subagent: OpenCode hands its prompt to that agent as a subtask.
    const subtask = parts.find((p) => p.type === "subtask");
    const meta = state.commandMeta.get(id);
    const command = compaction
      ? { name: "compact", arguments: compaction.auto ? "(automatic, context was full)" : "" }
      : subtask
        ? { name: subtask.command || meta?.name || "task", arguments: meta?.arguments ?? (subtask.command ? "" : subtask.description), agent: subtask.agent }
        : meta;
    if (command) return renderCommandMessage(id, command, compaction ? "" : subtask ? subtask.prompt : text);
    // Only hidden context (like the note plan_exit adds when it hands over to build): nothing to show.
    if (!text.trim() && !files.length) return h("div", { class: "msg user hidden", "data-mid": id });
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
            title: "Fork from here: a new conversation with everything before this message, and this message in the box to send",
            html: icons.fork,
            onClick: () => send({ type: "fork", messageID: id, text }),
          }),
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
  // Running tools and to-dos take the colour of the agent that wrote this reply, not the one selected now.
  const agent = msg.info.agent || msg.info.mode;
  if (agent && state.agents.includes(agent)) el.style.setProperty("--accent", agentColor(agent));
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
  // Subagents started together (task steps with nothing shown between them) share one step.
  let tasks = [];
  const flush = () => {
    if (tasks.length) el.append(tasks.length > 1 ? renderTaskGroup(tasks) : renderTool(tasks[0]));
    tasks = [];
  };
  for (const p of parts) {
    if (p.type === "tool" && p.tool === "task") {
      tasks.push(p);
      continue;
    }
    const node = renderPart(p);
    if (!node) continue;
    flush();
    el.append(node);
  }
  flush();
  if (msg.info.error && msg.info.error.name !== "MessageAbortedError") {
    el.append(h("div", { class: "error-block" }, errorText(msg.info.error)));
  } else if (msg.info.error?.name === "MessageAbortedError") {
    el.append(h("div", { class: "interrupted" }, "Stopped"));
  }
  const foot = turnFooter(msg);
  if (foot) el.append(foot);
  return el;
}

/**
 * Model, time, tokens and cost for a whole turn, under its last reply. OpenCode writes one reply per
 * step (each round of tool calls), so the numbers add up every reply to the same prompt.
 */
function turnFooter(msg) {
  const info = msg.info;
  // Steps that end in tool calls are followed by another; only the turn's last step gets the footer.
  if (!info.time?.completed || !info.finish || info.finish === "tool-calls" || info.finish === "unknown") return null;
  const steps = info.parentID ? state.order.map((id) => state.messages.get(id)?.info).filter((m) => m?.role === "assistant" && m.parentID === info.parentID) : [info];
  const start = state.messages.get(info.parentID)?.info.time?.created ?? steps[0]?.time?.created ?? info.time.created;
  let input = 0;
  let cached = 0;
  let output = 0;
  let cost = 0;
  for (const s of steps) {
    const t = s.tokens || {};
    input += (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
    cached += t.cache?.read || 0;
    output += (t.output || 0) + (t.reasoning || 0);
    cost += s.cost || 0;
  }
  const model = state.models.find((m) => m.providerID === info.providerID && m.modelID === info.modelID)?.name || info.modelID || "";
  const secs = Math.max(1, Math.round((info.time.completed - start) / 1000));
  const dot = () => h("span", { class: "sep" }, "·");
  const tip =
    `${model ? `${model}, ` : ""}${plural(steps.length, "step")} in ${formatWait(secs)}\n` +
    `Tokens sent to the model: ${fmtTokens(input)}${cached ? ` (${fmtTokens(cached)} from cache)` : ""}\n` +
    `Tokens it wrote: ${fmtTokens(output)}` +
    (cost > 0 ? `\nCost: $${cost.toFixed(4)}` : "");
  return h(
    "div",
    { class: "msg-foot", title: tip },
    model ? h("span", { class: "model" }, model) : null,
    model ? dot() : null,
    h("span", { class: "stat" }, formatWait(secs)),
    dot(),
    h("span", { class: "stat" }, `${fmtTokens(input)} in, ${fmtTokens(output)} out`),
    cost > 0 ? [dot(), h("span", { class: "stat" }, cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`)] : null,
    h("button", { class: "icon-btn copy-reply", title: "Copy reply", "data-turn": info.parentID, html: icons.copy }),
  );
}

/** A /command as the user typed it, with the expanded prompt available on demand. */
function renderCommandMessage(id, command, prompt) {
  const head = h(
    "div",
    { class: "cmd-line" },
    h("span", { class: "cmd-name" }, `/${command.name}`),
    command.arguments ? h("span", { class: "cmd-args" }, command.arguments) : null,
    command.agent ? h("span", { class: "cmd-to" }, "→ ", h("span", { class: "agent-tag", style: `--tag: ${agentColor(command.agent)}` }, `@${command.agent}`)) : null,
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
      return collapsible(p.id, h("span", { class: "thinking-label" }, h("span", { class: "tool-icon", html: icons.sparkle }), done ? `Reasoning · ${secs}s` : "Reasoning…"), h("div", { class: "markdown thinking", html: md(p.text) }), done ? "thinking-row" : "thinking-row live", state.settings.reasoning === "expanded");
    }
    case "tool":
      return renderTool(p);
    case "retry":
      return h("div", { class: "row note-row" }, `Retrying (attempt ${p.attempt})… ${errorText(p.error)}`);
    case "compaction":
      return h("div", { class: "row note-row" }, "Conversation compacted");
    case "agent":
      return h("div", { class: "row note-row" }, `@${p.name}`);
    case "file":
      // A file the model returned: images in full, anything else as a card to open or save.
      return h("div", { class: "row file-row", "data-pid": p.id }, p.mime?.startsWith("image/") ? imageCard(p, p.id) : fileCard(p, p.id));
    default:
      return null;
  }
}

// ------------------------------------------------------------- files and images

// File parts and tool attachments by key, for the Open and Save buttons (data URLs are too big to
// keep in the page twice).
const fileParts = new Map();

const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const MIME_NAMES = { "application/pdf": "PDF", "text/markdown": "Markdown", "text/plain": "Text", "text/csv": "CSV", "text/html": "HTML", "application/json": "JSON", "application/zip": "ZIP" };
function fileKind(f) {
  if (MIME_NAMES[f.mime]) return MIME_NAMES[f.mime];
  if (f.mime?.startsWith("image/")) return f.mime.slice(6).replace(/\+xml$/, "").toUpperCase();
  const ext = fileName(f).split(".").pop();
  return ext && ext !== fileName(f) ? ext.toUpperCase() : "File";
}
const fileName = (f) => f.filename || (f.url?.startsWith("file:") ? fileUrlToPath(f.url).split("/").pop() : "") || "file";
/** "PNG · 184 KB": the size is known for data URLs only. */
function fileMeta(f) {
  const m = /^data:[^,]*?(;base64)?,/.exec(f.url || "");
  const body = m ? f.url.length - m[0].length : 0;
  const bytes = m ? (m[1] ? Math.floor((body * 3) / 4) - (f.url.endsWith("==") ? 2 : f.url.endsWith("=") ? 1 : 0) : body) : null;
  return [fileKind(f), bytes !== null ? fmtBytes(bytes) : ""].filter(Boolean).join(" · ");
}

/** An image from a part's URL: data and web URLs as they are, file URLs read through the extension. */
function partImage(f, cls) {
  if (!f.url?.startsWith("file:")) return h("img", { class: cls, alt: fileName(f), src: f.url });
  const path = fileUrlToPath(f.url);
  return h("img", { class: cls, alt: fileName(f), "data-local": path, src: localImages.get(path) || undefined });
}

function fileCard(f, key) {
  fileParts.set(key, f);
  const name = fileName(f);
  return h(
    "div",
    { class: "file-card", "data-file": key },
    h("span", { class: "fc-icon", html: f.mime?.startsWith("image/") ? icons.image : icons.fileText }),
    h("div", { class: "fc-text" }, h("div", { class: "fc-name", title: name }, name), h("div", { class: "fc-meta" }, fileMeta(f))),
    h(
      "div",
      { class: "fc-btns" },
      h("button", { class: "icon-btn", title: "Open", "data-file-action": "open", html: icons.externalLink }),
      h("button", { class: "icon-btn", title: "Save as…", "data-file-action": "save", html: icons.download }),
    ),
  );
}

function imageCard(f, key) {
  return h("div", { class: "image-card", "data-file": key }, partImage(f, "card-img"), fileCard(f, key));
}

/** Files a tool returned (a Read of an image or PDF): images shown, anything else as a card. */
function renderToolFiles(p, name) {
  return h(
    "div",
    { class: "tool-attachments" },
    p.state.attachments.map((a, i) => {
      const f = { ...a, filename: a.filename || name };
      const key = `${p.id}:${i}`;
      if (!f.mime?.startsWith("image/")) return fileCard(f, key);
      fileParts.set(key, f);
      return h("div", { "data-file": key }, partImage(f, "attach-img"));
    }),
  );
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
      return { name: "Read", arg: short(file), file, icon: p.state?.attachments?.some((a) => a.mime?.startsWith("image/")) ? icons.image : icons.file };
    case "edit":
    case "multiedit":
      return { name: "Edit", arg: short(file), file, icon: icons.pencil };
    case "write":
      return { name: "Write", arg: short(file), file, icon: icons.pencil };
    case "patch":
    case "apply_patch": {
      // One file reads like an Edit; several are counted.
      const files = p.state?.metadata?.files || [];
      if (files.length === 1) return { name: "Patch", arg: short(files[0].movePath || files[0].filePath), file: files[0].movePath || files[0].filePath, icon: icons.pencil };
      return { name: "Patch", arg: files.length ? plural(files.length, "file") : p.state?.title || "", icon: icons.pencil };
    }
    case "bash":
      return { name: "Shell", arg: i.command || "", icon: icons.terminal };
    case "glob":
      return { name: "Glob", arg: `${i.pattern || ""}${i.path ? " in " + short(i.path) : ""}`, icon: icons.search };
    case "grep":
      return { name: "Grep", arg: `"${i.pattern || ""}"${i.path ? " in " + short(i.path) : ""}`, icon: icons.search };
    case "list":
      return { name: "List", arg: short(i.path) || ".", icon: icons.folder };
    case "webfetch":
      return { name: "Fetch", arg: String(i.url || "").replace(/^https?:\/\//, ""), icon: icons.globe };
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
    case "lsp": {
      const where = i.operation === "workspaceSymbol" ? i.query || "" : i.operation === "documentSymbol" ? short(file) : `${short(file)}:${i.line}:${i.character}`;
      return { name: lspName(i.operation), arg: where, file: i.operation === "workspaceSymbol" ? undefined : file, icon: icons.braces };
    }
    case "invalid": {
      // A call the model got wrong: named for the tool it meant (OpenCode keeps only its name and the
      // error, not what it was given), struck through if there's no such tool.
      const meant = i.tool && i.tool !== "invalid" ? toolSummary({ ...p, tool: i.tool, state: { input: {} } }) : { name: "Tool call" };
      return { name: meant.name, server: meant.server, arg: "", missing: noSuchTool(i.error), icon: icons.triangle };
    }
    default: {
      const mcp = mcpTool(t, state.mcpServers);
      if (mcp) return { name: mcp.name, server: mcp.server, arg: mainArg(i) || p.state?.title || "", icon: icons.plug };
      return { name: t, arg: p.state?.title || "", icon: icons.wrench };
    }
  }
}

const noSuchTool = (error) => /unavailable tool|no such tool/i.test(String(error || ""));

function renderTool(p) {
  const st = p.state || {};
  const { name, server, missing, arg, file, icon } = toolSummary(p);
  const status = st.status || "pending";
  if (p.tool === "plan_exit" && (status === "completed" || (status === "error" && /dismissed/i.test(st.error || "")))) return renderHandoff(p);
  const head = h(
    "span",
    { class: "tool-head" },
    h("span", { class: "tool-name" }, server ? h("span", { class: "tool-server" }, `${server} · `) : null, missing ? h("s", {}, name) : name),
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
  const input = st.input || {};
  let summary = null;
  let body = null;
  let open = false;
  let cls = "";
  const done = status === "completed";
  const grep = done && p.tool === "grep" ? parseGrep(st.output) : null;
  const glob = done && p.tool === "glob" ? parseGlob(st.output) : null;
  const search = done && (p.tool === "websearch" || p.tool === "codesearch") ? parseSearch(st.output) : null;
  const mcp = server && p.tool !== "invalid";

  if (p.tool === "invalid") {
    cls = "warn";
    const error = String(input.error || st.output || "");
    summary = h("span", { class: "tool-summary warn" }, missing ? "No such tool; the model was told and can try again" : `Invalid arguments: ${firstLine(error.replace(/^Invalid input for tool [^:]*:\s*/i, ""))}`);
    body = h("pre", { class: "tool-output" }, error);
  } else if (status === "error") {
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
      body = h("pre", { class: "tool-output", html: highlightLines(st.input.content, langForPath(st.input.filePath)).join("\n") });
    }
  } else if ((p.tool === "apply_patch" || p.tool === "patch") && meta.files?.length) {
    const add = meta.files.reduce((n, f) => n + (f.additions || 0), 0);
    const del = meta.files.reduce((n, f) => n + (f.deletions || 0), 0);
    summary = h("span", { class: "tool-summary" }, h("span", { class: "add" }, `+${add}`), " ", h("span", { class: "del" }, `-${del}`));
    body = h("div", { class: "patch-files" }, meta.files.map((f, i) => patchFile(p, f, i)));
    open = true;
  } else if (p.tool === "read" && status === "completed" && st.attachments?.length) {
    const name = String(file || "").split(/[\\/]/).pop();
    summary = h("span", { class: "tool-summary" }, fileMeta({ ...st.attachments[0], filename: name }));
    body = renderToolFiles(p, name);
    open = st.attachments.some((a) => a.mime?.startsWith("image/"));
  } else if (p.tool === "read" && status === "completed") {
    const lines = (st.output || "").split("\n").filter((l) => /^\d+[|:\t]/.test(l.trim())).length;
    summary = h("span", { class: "tool-summary" }, lines ? `Read ${lines} lines` : "Read file");
  } else if (grep) {
    const matches = grep.files.reduce((n, f) => n + f.lines.length, 0);
    summary = h("span", { class: "tool-summary" }, `${matches} match${matches === 1 ? "" : "es"} in ${plural(grep.files.length, "file")}${grep.truncated ? ", more not shown" : ""}`);
    const pattern = searchPattern(input.pattern);
    body = foldRows(
      p,
      grep.files.flatMap((f) => [
        resultFile(f.path, f.lines.length),
        ...f.lines.map((l) => h("div", { class: "res-line", "data-open-path": f.path, "data-open-line": l.line, title: `${short(f.path)}:${l.line}` }, h("span", { class: "ln" }, l.line), h("span", { class: "txt", html: markMatches(l.text.trim(), pattern) }))),
      ]),
    );
  } else if (glob) {
    summary = h("span", { class: "tool-summary" }, `${plural(glob.paths.length, "file")}${glob.truncated ? ", more not shown" : ""}`);
    body = foldRows(p, glob.paths.map((path) => resultFile(path)));
  } else if (done && p.tool === "lsp" && Array.isArray(meta.result)) {
    ({ summary, body } = lspBody(p, input.operation, meta.result));
  } else if (done && p.tool === "webfetch" && st.output && (input.format || "markdown") === "markdown" && !st.attachments?.length) {
    summary = h("span", { class: "tool-summary" }, `Markdown · ${fmtBytes(new Blob([st.output]).size)}`);
    const all = expanded.has(p.id);
    body = h(
      "div",
      { class: "page-preview" },
      h("div", { class: `markdown${all ? "" : " report-preview"}`, html: pageHtml(p) }),
      h(
        "div",
        { class: "report-links" },
        h("button", { class: "link-btn", "data-expand": p.id, "data-msg": p.messageID }, all ? "Show less" : "Show page"),
        h("button", { class: "link-btn", "data-open-url": input.url }, "Open in browser"),
      ),
    );
  } else if (search) {
    summary = h("span", { class: "tool-summary" }, plural(search.length, "result"));
    body = foldRows(
      p,
      search.map((r) => h("div", { class: "result" }, h("a", { href: r.url, title: r.url }, r.title), h("span", { class: "domain" }, domain(r.url)), r.snippet ? h("div", { class: "snippet" }, r.snippet) : null)),
      { limit: 5, cls: "result-list" },
    );
  } else if (mcp && status !== "pending") {
    // What the tool was given, then what it gave back (JSON laid out).
    const out = st.output ? prettyJson(String(st.output)) : "";
    if (out && !out.startsWith("{") && !out.startsWith("[")) summary = h("span", { class: "tool-summary" }, firstLine(out));
    body = h("div", {}, argList(input), out ? h("pre", { class: "tool-output" }, out.length > 20000 ? out.slice(0, 20000) + "\n… (truncated)" : out) : null);
  } else if (p.tool === "todowrite") {
    const todos = st.input?.todos || meta.todos || [];
    body = renderTodoList(todos);
    open = true;
  } else if (p.tool === "task") {
    const run = taskRun(p);
    summary = h("span", { class: "tool-summary" }, run.who);
    body = subagentBody(p, run);
    // Open while it works and once it has a report to preview; folded if there's nothing to show.
    open = !!body;
  } else if (st.output) {
    const out = String(st.output);
    const lineCount = out.split("\n").length;
    summary = h("span", { class: "tool-summary" }, p.tool === "bash" ? firstLine(stripAnsi(out)) || "(no output)" : `${lineCount} line${lineCount === 1 ? "" : "s"}`);
    const shown = out.length > 20000 ? out.slice(0, 20000) + "\n… (truncated)" : out;
    body = p.tool === "bash" ? h("pre", { class: "tool-output", html: ansiHtml(shown) }) : h("pre", { class: "tool-output" }, shown);
  } else if (status === "running" && p.tool === "bash" && meta.output) {
    body = h("pre", { class: "tool-output", html: ansiHtml(meta.output) });
    open = true;
  }
  // Other tools (MCP servers, say) can return files too.
  if (st.attachments?.length && p.tool !== "read") body = h("div", {}, body, renderToolFiles(p, ""));

  if (state.settings.toolOutput !== "auto") open = state.settings.toolOutput === "expanded";
  const dot = h("span", { class: `tool-icon status-${status}`, title: status, html: icon });
  if (!body) {
    return h(
      "div",
      { class: `row tool-row ${cls}`, "data-pid": p.id },
      dot,
      h("div", { class: "tool-main" }, head, summary ? h("div", { class: "tool-sub" }, summary) : null),
    );
  }
  const el = h("div", { class: `row tool-row collapsible ${cls} ${open ? "open" : ""}`, "data-pid": p.id }, dot);
  const header = h("div", { class: "coll-head" }, head, h("span", { class: "chev", html: icons.chevronRight }));
  header.addEventListener("click", () => toggleOpen(el));
  el.append(h("div", { class: "tool-main" }, header, summary ? h("div", { class: "tool-sub" }, summary) : null, h("div", { class: "coll-body" }, body)));
  return el;
}

const firstLine = (s) => String(s || "").trim().split("\n")[0].slice(0, 200);

// ------------------------------------------------------------ tool results

// Result lists (and fetched pages) the user opened in full, by part ID.
const expanded = new Set();
const RESULT_ROWS = 20;

/** Rows of a result list, folded after the first few with a row that shows the rest. */
function foldRows(p, rows, { limit = RESULT_ROWS, cls = "results" } = {}) {
  const shown = expanded.has(p.id) ? rows : rows.slice(0, limit);
  const hidden = rows.length - shown.length;
  return h("div", { class: cls }, shown, hidden ? h("div", { class: "res-more", "data-expand": p.id, "data-msg": p.messageID }, `${hidden} more`) : null);
}

/** A file in a result list, named like a row of the Changes panel; opens the file. */
function resultFile(path, count) {
  const rel = short(path);
  const slash = rel.lastIndexOf("/");
  return h(
    "div",
    { class: "res-file", "data-open-path": path, title: rel },
    h("span", { class: "change-name" }, rel.slice(slash + 1)),
    h("span", { class: "change-dir" }, slash > 0 ? rel.slice(0, slash) : ""),
    count ? h("span", { class: "count" }, count) : null,
  );
}

/** Grep's pattern as a JS regex, to highlight matches; null when ripgrep's syntax doesn't carry over. */
function searchPattern(pattern) {
  try {
    return pattern ? new RegExp(pattern, "g") : null;
  } catch {
    return null;
  }
}
function markMatches(text, re) {
  if (!re) return escapeHtml(text);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) break;
    out += escapeHtml(text.slice(last, m.index)) + `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

const LSP_WORDS = { findReferences: "reference", documentSymbol: "symbol", workspaceSymbol: "symbol", incomingCalls: "caller", outgoingCalls: "call", goToImplementation: "implementation" };

/** An lsp step: hover as markdown; everything else as places to open, each with its line of code. */
function lspBody(p, operation, result) {
  if (operation === "hover") {
    const text = lspHover(result);
    return { summary: text ? null : h("span", { class: "tool-summary" }, "Nothing to show"), body: text ? h("div", { class: "markdown", html: md(text) }) : null };
  }
  const places = lspLocations(result, p.state.input?.filePath);
  if (!places.length) return { summary: h("span", { class: "tool-summary" }, "No results"), body: null };
  const files = new Set(places.map((l) => l.path)).size;
  const word = LSP_WORDS[operation] || "location";
  const summary = h("span", { class: "tool-summary" }, `${plural(places.length, word)}${files > 1 ? ` in ${plural(files, "file")}` : ""}`);
  const rows = places.map((l) =>
    h(
      "div",
      { class: "res-hit", "data-open-path": l.path, "data-open-line": l.line },
      h("span", { class: "where" }, l.name ? h("span", { class: "sym" }, l.name) : null, h("span", { class: "loc" }, `${short(l.path)}:${l.line}`)),
      h("span", { class: "code", "data-src": `${l.path}:${l.line}` }, sourceLine(l.path, l.line)),
    ),
  );
  return { summary, body: foldRows(p, rows) };
}

// Lines of code lsp results point at, read by the extension: "path:line" → text. Asked for once per
// file, batched, and filled into the page as they arrive.
const sourceLines = new Map();
const wantedLines = new Map();
function sourceLine(path, line) {
  const key = `${path}:${line}`;
  if (sourceLines.has(key)) return sourceLines.get(key);
  if (!wantedLines.size) queueMicrotask(requestLines);
  if (!wantedLines.has(path)) wantedLines.set(path, new Set());
  wantedLines.get(path).add(line);
  sourceLines.set(key, "");
  return "";
}
function requestLines() {
  for (const [path, lines] of wantedLines) send({ type: "loadLines", path, lines: [...lines] });
  wantedLines.clear();
}

/** A fetched page rendered once it's complete; pages can be large and the step re-renders often. */
const pageCache = new Map();
function pageHtml(p) {
  let html = pageCache.get(p.id);
  if (!html) pageCache.set(p.id, (html = pageMd(p.state.output, p.state.input?.url)));
  return html;
}

const prettyJson = (text) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

/** An MCP call's arguments as a short list: long values are cut, with the whole on hover. */
function argList(input) {
  const entries = Object.entries(input || {});
  if (!entries.length) return null;
  return h(
    "dl",
    { class: "args" },
    entries.flatMap(([k, v]) => {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      return [h("dt", {}, k), h("dd", { title: text.slice(0, 1000) }, text.split("\n")[0])];
    }),
  );
}

/** plan_exit, once answered: the plan agent handing over to build, or staying put. */
function renderHandoff(p) {
  const tag = (agent) => h("span", { class: "agent-tag", style: `--tag: ${agentColor(agent)}` }, `@${agent}`);
  if (p.state.status !== "completed") {
    return h("div", { class: "row", "data-pid": p.id }, h("div", { class: "handoff kept" }, h("span", { class: "tool-icon", html: icons.pencil }), h("span", { class: "muted" }, "Kept planning: you chose to refine the plan first")));
  }
  // OpenCode names the plan file only in the message it adds for build.
  let plan = null;
  for (const m of state.messages.values()) {
    for (const part of m.parts.values()) plan ??= part.type === "text" && part.synthetic ? part.text?.match(/^The plan at (.+?) has been approved/)?.[1] : null;
  }
  return h(
    "div",
    { class: "row", "data-pid": p.id },
    h(
      "div",
      { class: "handoff" },
      h("span", { class: "tool-icon", html: icons.circleCheck }),
      h("span", {}, "Plan approved"),
      tag("plan"),
      h("span", { class: "muted", html: icons.arrowRight }),
      tag("build"),
      plan ? h("a", { class: "file-ref plan-file", href: "#", "data-path": plan, title: `Open ${plan}` }, h("code", {}, plan)) : null,
    ),
  );
}

const PATCH_STATUS = { add: ["A", "added"], delete: ["D", "deleted"], move: ["R", "modified"], update: ["M", "modified"] };

/** One file of an apply_patch step, headed like a row of the Changes panel; the first starts open. */
function patchFile(p, f, i) {
  const rel = f.relativePath || short(f.movePath || f.filePath);
  const slash = rel.lastIndexOf("/");
  const [letter, cls] = PATCH_STATUS[f.type] || PATCH_STATUS.update;
  const head = h(
    "span",
    { class: "patch-file-head" },
    h("span", { class: `change-status ${cls}` }, letter),
    h("span", { class: "change-name" }, rel.slice(slash + 1)),
    h("span", { class: "change-dir" }, slash > 0 ? rel.slice(0, slash) : ""),
    h("span", { class: "counts" }, h("span", { class: "add" }, `+${f.additions || 0}`), " ", h("span", { class: "del" }, `-${f.deletions || 0}`)),
  );
  const body = h(
    "div",
    {},
    f.patch ? renderDiff(f.patch) : null,
    f.type === "delete" ? null : h("button", { class: "link-btn", onClick: () => send({ type: "openDiff", filePath: f.movePath || f.filePath, diff: f.patch }) }, "Open diff"),
  );
  return collapsible(`${p.id}-file${i}`, head, body, "patch-file", i === 0);
}

// ------------------------------------------------------------------ subagents

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const elapsed = (time) => (time?.start ? formatWait(Math.max(0, Math.round(((time.end || Date.now()) - time.start) / 1000))) : "");
const isRunning = (st) => st?.status === "running" || st?.status === "pending";

/** A task step's subagent: its steps so far, its latest words, and "@agent · 4 steps · 35s". */
function taskRun(p) {
  const st = p.state || {};
  const childID = st.metadata?.sessionId;
  if (childID && !state.childParts.has(childID) && !state.childRequested.has(childID)) {
    state.childRequested.add(childID);
    send({ type: "loadChild", sessionID: childID });
  }
  const parts = [...(state.childParts.get(childID)?.values() || [])].sort((a, b) => (a.id < b.id ? -1 : 1));
  const steps = parts.filter((s) => s.type === "tool");
  const text = parts.filter((s) => s.type === "text" && s.text?.trim()).pop()?.text || "";
  const said = text.trim().split("\n").filter((l) => l.trim()).pop()?.replace(/^[#>*\-\s]+/, "").slice(0, 200) || "";
  const who = [st.input?.subagent_type ? `@${st.input.subagent_type}` : "subagent", steps.length ? plural(steps.length, "step") : "", elapsed(st.time)].filter(Boolean).join(" · ");
  return { childID, steps, said, who };
}

function subStep(s) {
  const sum = toolSummary(s);
  return h(
    "div",
    { class: "sub-step", title: sum.arg },
    h("span", { class: `tool-icon status-${s.state?.status || "pending"}`, html: sum.icon }),
    h("span", { class: "tool-name" }, sum.name),
    sum.arg ? h("span", { class: `tool-arg ${sum.file ? "link" : ""}`, onClick: sum.file ? () => openPath(sum.file) : undefined }, sum.arg) : null,
  );
}

function unfold(key, messageID, on = !state.unfolded.has(key)) {
  on ? state.unfolded.add(key) : state.unfolded.delete(key);
  queueRender(messageID);
}

// OpenCode wraps the report in <task_result> and appends the session id; only the report is for reading.
const taskReport = (out) =>
  String(out || "")
    .replace(/<task_metadata>[\s\S]*?<\/task_metadata>/g, "")
    .replace(/^task_id:.*\n+/, "")
    .replace(/<\/?task_result>/g, "")
    .trim();

/**
 * Inside a subagent step: while it runs, its last few steps (older ones folded) and its latest words;
 * once done, the steps fold into one line and the report shows as a short preview.
 */
function subagentBody(p, run) {
  const st = p.state || {};
  const running = isRunning(st);
  const all = state.unfolded.has(`${p.id}:steps`);
  const keep = all ? run.steps.length : running ? 3 : 0;
  const hidden = Math.max(0, run.steps.length - keep);
  const rows = [];
  if (hidden) {
    const label = keep ? `${plural(hidden, "earlier step")}` : plural(hidden, "step");
    rows.push(h("div", { class: "sub-step more", title: "Show all steps", onClick: () => unfold(`${p.id}:steps`, p.messageID, true) }, h("span", { class: "tool-icon", html: icons.more }), h("span", {}, label)));
  }
  rows.push(...run.steps.slice(hidden).map(subStep));
  if (running && run.said) rows.push(h("div", { class: "sub-say", title: run.said }, `“${run.said}”`));
  const nested = rows.length ? h("div", { class: "subagent-steps" }, rows) : null;

  const report = st.status === "completed" ? taskReport(st.output) : "";
  let result = null;
  if (report) {
    // Short reports show whole; longer ones fold to a few lines until asked for.
    const long = report.length > 280 || report.split("\n").length > 4;
    const full = !long || state.unfolded.has(`${p.id}:report`);
    result = h(
      "div",
      {},
      h("div", { class: `markdown subagent-result ${full ? "" : "report-preview"}`, html: md(report) }),
      h(
        "div",
        { class: "report-links" },
        long ? h("button", { class: "link-btn", onClick: () => unfold(`${p.id}:report`, p.messageID) }, full ? "Show less" : "Show full report") : null,
        run.childID ? h("button", { class: "link-btn", title: "Open the subagent's whole conversation", onClick: () => send({ type: "loadSession", id: run.childID }) }, "Open transcript") : null,
      ),
    );
  }
  return nested || result ? h("div", {}, nested, result) : null;
}

/** Several subagents started together: one step listing each, the running ones with what they're doing now. */
function renderTaskGroup(tasks) {
  const runs = tasks.map((p) => [p, taskRun(p)]);
  const count = (fn) => tasks.filter((p) => fn(p.state || {})).length;
  const running = count(isRunning);
  const failed = count((st) => st.status === "error");
  const done = tasks.length - running - failed;
  const starts = tasks.map((p) => p.state?.time?.start).filter(Boolean);
  const ends = tasks.map((p) => p.state?.time?.end);
  const span = starts.length ? { start: Math.min(...starts), end: running || ends.some((e) => !e) ? undefined : Math.max(...ends) } : null;
  const status = running ? "running" : failed ? "error" : "completed";
  const summary = [running ? `${running} running` : "", done ? `${done} done` : "", failed ? `${failed} failed` : "", elapsed(span)].filter(Boolean).join(" · ");

  const rows = runs.flatMap(([p, run]) => {
    const st = p.state || {};
    const key = `${p.id}:detail`;
    const icon = isRunning(st) ? icons.bot : st.status === "error" ? icons.x : icons.check;
    const row = h(
      "div",
      { class: "agent-row", title: "Show this subagent's steps", onClick: () => unfold(key, p.messageID) },
      h("span", { class: `tool-icon status-${st.status || "pending"}`, html: icon }),
      h("span", { class: "what" }, st.input?.description || "Subagent"),
      h("span", { class: "who" }, run.who),
    );
    const out = [row];
    if (state.unfolded.has(key)) {
      const body = subagentBody(p, run);
      if (body) out.push(h("div", { class: "agent-detail" }, body));
    } else if (isRunning(st) && run.steps.length) {
      const now = run.steps.findLast((s) => isRunning(s.state)) || run.steps[run.steps.length - 1];
      const sum = toolSummary(now);
      out.push(h("div", { class: "agent-now", title: sum.arg }, h("span", { class: "tool-icon", html: sum.icon }), h("span", { class: "tool-arg" }, sum.arg || sum.name)));
    }
    return out;
  });

  let open = true;
  if (state.settings.toolOutput !== "auto") open = state.settings.toolOutput === "expanded";
  const el = h("div", { class: `row tool-row collapsible ${open ? "open" : ""}`, "data-pid": `${tasks[0].id}-group` }, h("span", { class: `tool-icon status-${status}`, title: status, html: icons.bot }));
  const head = h("span", { class: "tool-head" }, h("span", { class: "tool-name" }, "Subagents"), h("span", { class: "tool-arg" }, plural(tasks.length, "task")));
  const header = h("div", { class: "coll-head" }, head, h("span", { class: "chev", html: icons.chevronRight }));
  header.addEventListener("click", () => toggleOpen(el));
  el.append(h("div", { class: "tool-main" }, header, h("div", { class: "tool-sub" }, h("span", { class: "tool-summary" }, summary)), h("div", { class: "coll-body" }, h("div", { class: "subagent-steps" }, rows))));
  return el;
}

// ------------------------------------------------------------------ shell colours

// ANSI SGR codes in shell output become spans in the terminal's own colours. Other escape
// sequences (cursor moves, titles) are dropped.
const ANSI_RE = /\x1b\[([\d;]*)m|\x1b\[[\d;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\r(?!\n)/g;
const ANSI_NAMES = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];
const ANSI_HEX = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"];
const ansiColor = (i) => `var(--vscode-terminal-ansi${i > 7 ? "Bright" : ""}${ANSI_NAMES[i % 8]}, ${ANSI_HEX[i]})`;
function ansi256(n) {
  if (!Number.isFinite(n) || n < 0 || n > 255) return null;
  if (n < 16) return ansiColor(n);
  if (n < 232) {
    const c = (v) => (v ? 55 + v * 40 : 0);
    n -= 16;
    return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
const stripAnsi = (s) => String(s ?? "").replace(ANSI_RE, "");
function ansiHtml(text) {
  text = String(text ?? "");
  let out = "";
  let last = 0;
  let st = {};
  const emit = (t) => {
    if (!t) return;
    const css = [st.fg && `color:${st.fg}`, st.bg && `background:${st.bg}`, st.bold && "font-weight:bold", st.dim && "opacity:0.6", st.italic && "font-style:italic", st.underline && "text-decoration:underline"].filter(Boolean).join(";");
    out += css ? `<span style="${css}">${escapeHtml(t)}</span>` : escapeHtml(t);
  };
  for (const m of text.matchAll(ANSI_RE)) {
    emit(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] === undefined) continue;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) st = {};
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 22) st.bold = st.dim = false;
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c >= 30 && c <= 37) st.fg = ansiColor(c - 30);
      else if (c >= 90 && c <= 97) st.fg = ansiColor(c - 82);
      else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = ansiColor(c - 40);
      else if (c >= 100 && c <= 107) st.bg = ansiColor(c - 92);
      else if (c === 49) st.bg = null;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        st[c === 38 ? "fg" : "bg"] = ansi256(codes[i + 2]);
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const [r, g, b] = codes.slice(i + 2, i + 5).map((v) => Math.min(255, Math.max(0, v | 0)));
        st[c === 38 ? "fg" : "bg"] = `rgb(${r},${g},${b})`;
        i += 4;
      }
    }
  }
  emit(text.slice(last));
  return out;
}

function diffStats(diff) {
  let add = 0;
  let del = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

// Lines are highlighted as two texts, the old side (context and removed lines) and the new side
// (context and added lines), so each line is colored with the code around it as it was or will be.
function renderDiff(diff) {
  const box = h("div", { class: "diff" });
  const rows = [];
  let lang = "";
  let oldLn = 0;
  let newLn = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("Index:") || l.startsWith("+++")) lang ||= langForPath(l.replace(/^(Index:|\+\+\+)\s*/, "").replace(/\t.*$/, ""));
    if (l.startsWith("Index:") || l.startsWith("===") || l.startsWith("---") || l.startsWith("+++") || l.startsWith("\\")) continue;
    const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (m) {
      oldLn = +m[1];
      newLn = +m[2];
      rows.push({ kind: "hunk" });
    } else if (l.startsWith("+")) rows.push({ kind: "add", ln: newLn++, text: l.slice(1) });
    else if (l.startsWith("-")) rows.push({ kind: "del", ln: oldLn++, text: l.slice(1) });
    else if (l.startsWith(" ")) {
      oldLn++;
      rows.push({ kind: "ctx", ln: newLn++, text: l.slice(1) });
    }
  }
  const oldRows = rows.filter((r) => r.kind === "ctx" || r.kind === "del");
  const newRows = rows.filter((r) => r.kind === "ctx" || r.kind === "add");
  // A new file has no old side (and a deleted one no new side); an empty text still highlights to one line.
  if (oldRows.length) highlightLines(oldRows.map((r) => r.text).join("\n"), lang).forEach((html, i) => (oldRows[i].html = html));
  if (newRows.length) highlightLines(newRows.map((r) => r.text).join("\n"), lang).forEach((html, i) => (newRows[i].html = html));
  for (const r of rows) {
    if (r.kind === "hunk") box.append(h("div", { class: "diff-line hunk" }, h("span", { class: "ln" }, ""), h("span", { class: "code" }, "⋯")));
    else box.append(h("div", { class: `diff-line ${r.kind}` }, h("span", { class: "ln" }, r.ln), h("span", { class: "code", html: r.html })));
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
  const waiting = state.permissions.length > 0 || state.questions.length > 0;
  el.classList.toggle("hidden", (!state.busy && !state.timedOut) || waiting);
  if ((!state.busy && !state.timedOut) || waiting) return;
  // Build the row once; rebuilding the loader would restart its animation every tick.
  if (!el.firstChild) {
    el.append(
      h("span", { class: "loader" }, h("i"), h("i"), h("i"), h("i"), h("i")),
      h("span", { class: "verb" }),
      h("span", { class: "status-hint" }),
      h(
        "span",
        { class: "status-actions" },
        h("button", { class: "link-btn stop-btn", onClick: () => send({ type: "abort" }) }, "Stop"),
        h("button", { class: "link-btn", onClick: retry }, "Retry"),
        h("button", { class: "link-btn", onClick: () => state.retry?.action?.link && send({ type: "openExternal", url: state.retry.action.link }) }),
      ),
    );
  }
  let verb, hint;
  const stalled = state.busy ? stallSeconds() : 0;
  const r = state.busy && state.retry;
  if (r) {
    // OpenCode retries rate limits and provider errors itself, waiting longer each time; without this the wait looks like a stall.
    verb = r.action?.title || r.message;
    const wait = Math.max(0, Math.ceil((r.next - Date.now()) / 1000));
    // Zen's free limit sends retry-after up to its daily reset, so the wait is the time until the limit resets.
    hint = r.action?.reason === "free_tier_limit" ? `resets in ${formatWait(wait)}` : `retry ${r.attempt} ${wait ? `in ${formatWait(wait)}` : "now"}`;
  } else if (!state.busy) {
    verb = `Timed out: no response from ${state.timedOut.model} for ${state.timedOut.secs}s`;
    hint = "";
  } else if (stalled && state.settings.stallWarningSeconds && stalled >= state.settings.stallWarningSeconds) {
    verb = `No response from ${modelName()} for ${stalled}s`;
    hint = state.settings.responseTimeoutSeconds ? `stops at ${state.settings.responseTimeoutSeconds}s` : "";
  } else {
    verb = `${runningAgent()} is working`;
    hint = `${Math.floor((Date.now() - state.busySince) / 1000)}s · Esc to stop`;
  }
  el.style.setProperty("--accent", agentColor(runningAgent()));
  const warn = r || !state.busy || (stalled && state.settings.stallWarningSeconds && stalled >= state.settings.stallWarningSeconds);
  el.classList.toggle("stalled", !!warn);
  el.classList.toggle("timed-out", !state.busy);
  const [stopBtn, retryBtn, actionBtn] = el.children[3].children;
  stopBtn.classList.toggle("hidden", !state.busy);
  // OpenCode is already retrying; our Retry would only start over.
  retryBtn.classList.toggle("hidden", !!r);
  actionBtn.classList.toggle("hidden", !r?.action?.link);
  const label = r?.action?.label ? r.action.label[0].toUpperCase() + r.action.label.slice(1) : "";
  if (actionBtn.textContent !== label) actionBtn.textContent = label;
  if (r) el.title = [r.message, r.action?.message].filter(Boolean).join("\n");
  else el.removeAttribute("title");
  if (el.children[1].textContent !== verb) el.children[1].textContent = verb;
  if (el.children[2].textContent !== hint) el.children[2].textContent = hint;
}

function formatWait(secs) {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

/**
 * The agent doing the current work: the unfinished reply's agent, else the latest message's. The
 * picker only sets the agent for the next message, so switching it mid-run doesn't change this.
 */
function runningAgent() {
  const infos = state.order.filter((id) => !isReverted(id)).map((id) => state.messages.get(id)?.info).filter(Boolean).reverse();
  const live = infos.find((i) => i.role === "assistant" && !i.time?.completed && (i.agent || i.mode));
  const latest = live || infos.find((i) => i.agent || (i.role === "assistant" && i.mode));
  const name = latest?.agent || latest?.mode;
  return name && state.agents.includes(name) ? name : state.agent;
}

/** Seconds since the model last sent anything, or 0 while a tool is running (tools can take as long as they like). */
function stallSeconds() {
  for (let i = state.order.length - 1; i >= 0; i--) {
    const m = state.messages.get(state.order[i]);
    if (m?.info.role !== "assistant") continue;
    for (const p of m.parts.values()) if (p.type === "tool" && (p.state?.status === "running" || p.state?.status === "pending")) return 0;
    break;
  }
  return Math.floor((Date.now() - Math.max(state.lastActivity, state.busySince)) / 1000);
}

function modelName() {
  const m = state.models.find((x) => state.model && x.providerID === state.model.providerID && x.modelID === state.model.modelID);
  return m ? m.name : state.model?.modelID || "the model";
}

function retry() {
  state.timedOut = null;
  updateStatusRow();
  send({ type: "retry" });
}

/** Stop a run that has been silent past the configured timeout. */
function checkTimeout() {
  const limit = state.settings.responseTimeoutSeconds;
  if (!state.busy || !limit || state.permissions.length || state.questions.length) return;
  const secs = stallSeconds();
  if (secs < limit) return;
  state.timedOut = { model: modelName(), secs };
  send({ type: "abort" });
}

function updateStatusRow() {
  const el = messagesEl.querySelector(".status-row");
  if (el) fillStatusRow(el);
}
setInterval(() => {
  if (!state.busy) return;
  checkTimeout();
  updateStatusRow();
  // Running subagents show how long they've been going.
  for (const [id, m] of state.messages) {
    if ([...m.parts.values()].some((p) => p.type === "tool" && p.tool === "task" && p.state?.status === "running")) queueRender(id);
  }
}, 1000);

function setBusy(busy) {
  if (busy && !state.busy) state.busySince = Date.now();
  if (!busy) state.retry = null;
  state.busy = busy;
  updateStatusRow();
  renderSendBtn();
}

// -------------------------------------------------------------- header etc.

function renderTitle() {
  $("titleText").textContent = displayTitle(state.session?.title);
}

/** OpenCode names untitled sessions "New session - <date>" until the title agent runs. */
function displayTitle(title) {
  return title && !/^New session/i.test(title) ? title : "New conversation";
}

function agentColor(name) {
  if (state.agentColors[name]) return state.agentColors[name];
  const palette = document.body.classList.contains("vscode-light") ? AGENT_COLORS.light : AGENT_COLORS.dark;
  // Subagents continue the palette after the primary agents.
  let i = state.agents.indexOf(name);
  if (i < 0) {
    const sub = state.subagents.findIndex((a) => a.name === name);
    i = sub < 0 ? 0 : state.agents.length + sub;
  }
  return palette[i % palette.length];
}

function renderModeBtn() {
  const btn = $("modeBtn");
  btn.innerHTML = `<span class="agent-name">${escapeHtml(state.agent)}</span>`;
  // The whole panel takes on the active agent's colour.
  document.body.style.setProperty("--accent", agentColor(state.agent));
  // Read-only agents (plan) can't edit, so the toggle is for read-only shell commands instead.
  const edits = $("editsBtn");
  const readOnly = state.readOnlyAgents.includes(state.agent);
  const on = readOnly ? state.autoRead : state.autoEdit;
  const [onLabel, offLabel, onTitle, offTitle] = readOnly
    ? ["Auto read-only", "Approve commands", "Read-only commands (ls, grep, git log…) run without asking — click to approve each", "OpenCode asks before every shell command — click to run read-only ones without asking"]
    : ["Auto-approve edits", "Approve edits", "Edits and read-only commands (ls, grep, git log…) run without asking; other commands still ask — click to require approval", "OpenCode asks before editing files or running commands — click to auto-approve edits and read-only commands"];
  edits.innerHTML = `${on ? icons.zap : icons.shield}<span>${on ? onLabel : offLabel}</span>`;
  edits.classList.toggle("on", on);
  edits.title = on ? onTitle : offTitle;
}

function currentModel() {
  return state.models.find((x) => state.model && x.providerID === state.model.providerID && x.modelID === state.model.modelID);
}

/** Effort levels OpenCode's providers use, lowest first. */
const EFFORT_SCALE = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Whether every one of these variants is a known effort level, so they can be put in order. */
function isRanked(variants) {
  return variants.every((v) => EFFORT_SCALE.includes(v));
}

/** Variants the picked model offers, lowest effort first when they're all known levels; empty hides the picker. */
function modelVariants(m = currentModel()) {
  const variants = m?.variants || [];
  return isRanked(variants) ? [...variants].sort((a, b) => EFFORT_SCALE.indexOf(a) - EFFORT_SCALE.indexOf(b)) : variants;
}

const modelKey = (m) => (m ? `${m.providerID}/${m.modelID}` : "");

/**
 * The level to use on a model that has no `from` level: the same name if it has it, else the
 * nearest one below (so a switch never quietly raises the effort), else its lowest.
 * Variants that aren't known levels can't be compared, so those fall back to Default.
 */
function carryVariant(from, offered) {
  if (!from || offered.includes(from)) return from;
  if (!isRanked(offered) || !EFFORT_SCALE.includes(from)) return null;
  const rank = EFFORT_SCALE.indexOf(from);
  return offered.filter((v) => EFFORT_SCALE.indexOf(v) <= rank).pop() ?? offered[0];
}

/**
 * Switch model. Its effort is the one last picked for it, else the last one picked anywhere,
 * carried over by carryVariant. With `announce`, a level that had to change says so.
 */
function setModel(model, announce = false) {
  state.model = model ? { providerID: model.providerID, modelID: model.modelID } : null;
  const offered = modelVariants();
  const key = modelKey(state.model);
  const remembered = state.variantByModel[key];
  if (!offered.length) state.variant = null;
  else if (key in state.variantByModel && (remembered === null || offered.includes(remembered))) state.variant = remembered;
  else {
    state.variant = carryVariant(state.lastVariant, offered);
    if (announce && state.lastVariant && state.variant !== state.lastVariant) {
      showToast(`${currentModel()?.name || state.model.modelID} has no ${state.lastVariant} effort — using ${state.variant || "Default"}.`, "info");
    }
  }
}

function renderModelBtn() {
  const m = currentModel();
  const name = m ? m.name : state.model ? state.model.modelID : "Default model";
  const variant = state.variant ? `<span class="model-variant">${escapeHtml(state.variant)}</span>` : "";
  $("modelBtn").innerHTML = `<span>${escapeHtml(name)}</span>${variant}${icons.chevronDown}`;
  reportStatus();
}

function reportStatus() {
  const m = currentModel();
  const name = m ? m.name : state.model?.modelID;
  send({ type: "status", agent: state.agent, model: name && state.variant ? `${name} · ${state.variant}` : name });
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
  btn.disabled = !showStop && ((!input.value.trim() && !state.images.length) || !state.ready);
  if (!state.ready && !showStop) btn.title = "Waiting for OpenCode to start";
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
  const warnAt = state.settings.contextWarningPercent;
  const level = pct >= Math.max(90, warnAt) ? "crit" : pct >= warnAt ? "warn" : "";
  btn.className = `ctx-meter ${level}`;
  btn.title =
    `${fmtTokens(last.used)}${limit ? ` of ${fmtTokens(limit)}` : ""} tokens in context` +
    (cost > 0 ? ` · $${cost.toFixed(4)} spent` : "") +
    (level ? "\nThe context is getting full — click to compact the conversation" : "\nClick to compact the conversation");
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
    // Asked by the agent doing the work, so in its colour whatever the picker says.
    { class: "card permission", tabindex: "0", style: `--accent: ${agentColor(runningAgent())}` },
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

  const card = h("div", { class: "card question", tabindex: "-1", style: `--accent: ${agentColor(runningAgent())}` });
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
        // Picking a single answer moves on to the next question.
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
  if (menu.kind === "model" && modelVariants().length) menuEl.append(effortRow());
  menuEl.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}
/**
 * A path as it goes after @. A bare name like `explore` (no dot or slash) wouldn't read as a file, and
 * could be taken for an agent, so it becomes `./explore`.
 */
function mentionPath(p) {
  return /[./]/.test(p) ? p : `./${p}`;
}

/** @ menu entries for the subagents whose name matches what's been typed. */
function agentItems(query) {
  const q = query.toLowerCase();
  return state.subagents
    .filter((a) => a.name.toLowerCase().startsWith(q))
    .map((a) => ({ type: "agent", label: a.name, detail: a.description ? `agent · ${a.description}` : "agent", value: a.name, icon: icons.bot }));
}

function acceptMenu() {
  const it = menu.items[menu.index];
  const kind = menu.kind;
  const start = menu.start;
  closeMenu();
  if (kind === "file" && it.type === "symbol") {
    // The extension looks up the symbol's whole definition and inserts it as @file#Lstart-end.
    const caret = input.selectionStart;
    input.value = input.value.slice(0, start) + input.value.slice(caret);
    input.setSelectionRange(start, start);
    send({ type: "pickSymbol", symbol: it.value });
  } else if (kind === "file") {
    const caret = input.selectionStart;
    const value = it.type === "agent" ? it.value : mentionPath(it.value);
    input.value = input.value.slice(0, start) + "@" + value + " " + input.value.slice(caret);
    const pos = start + value.length + 2;
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
    setModel(it.value, true);
    send({ type: "pickModel", model: state.model, variant: state.variant || undefined });
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
    // Subagents show at once; files and symbols follow when the search comes back.
    const agents = agentItems(at[2]);
    if (!menu || menu.kind !== "file") openMenu("file", agents, start);
    else (menu.start = start), (menu.items = [...agents, ...menu.items.filter((i) => i.type !== "agent")]), (menu.index = 0), drawMenu();
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
  if (menu && !isPickerMenu()) closeMenu();
}

/** The model menu opens from its footer button, not from typing. */
function isPickerMenu() {
  return menu?.kind === "model";
}

function openModelMenu() {
  const items = state.models.map((m) => ({ label: m.name, detail: m.providerName, value: m, icon: state.model && m.providerID === state.model.providerID && m.modelID === state.model.modelID ? icons.check : null }));
  openMenu("model", items, 0);
  menu.index = Math.max(0, items.findIndex((i) => i.icon));
  drawMenu();
}

/**
 * The picked model's reasoning effort, pinned under the model list. Default sits apart from the
 * levels, since it isn't one; known levels go on a fixed-width track, lowest first, and anything
 * else is a plain row of choices, as there's no order to show. ←/→ step through them.
 */
function effortRow() {
  const levels = modelVariants();
  const ranked = isRanked(levels);
  const choice = (v, cls, label) => {
    const el = h("button", { class: `${cls} ${v === state.variant ? "on" : ""}`, title: v || "The model's own setting" }, label);
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      // Redrawing detaches the button, which would read as a click outside the menu.
      e.stopPropagation();
      pickVariant(v);
    });
    return el;
  };
  return h(
    "div",
    { class: "effort-row", title: "Reasoning effort (← / →)" },
    h("span", { class: "menu-label" }, "Effort ", h("span", { class: "menu-detail" }, `(${state.variant || "Default"})`)),
    h(
      "span",
      { class: "effort-choices" },
      choice(null, "effort-chip", "Default"),
      ranked
        ? h("span", { class: `effort-track ${state.variant ? "" : "unset"}` }, ...levels.map((v) => choice(v, "effort-dot", "")))
        : levels.map((v) => choice(v, "effort-chip", v)),
    ),
  );
}

function pickVariant(variant) {
  state.variant = variant;
  state.lastVariant = variant;
  state.variantByModel[modelKey(state.model)] = variant;
  send({ type: "pickVariant", model: state.model, variant: variant || undefined });
  renderModelBtn();
  drawMenu();
}

/** Step the effort up or down while the model menu is open: Default, then each level. */
function stepVariant(by) {
  const levels = [null, ...modelVariants()];
  const next = levels.indexOf(state.variant) + by;
  if (levels.length > 1 && next >= 0 && next < levels.length) pickVariant(levels[next]);
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
  // Until OpenCode has started the agents' permission rules aren't known; keep the text for later.
  if (!state.ready) return;
  state.timedOut = null;
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
    variant: state.variant || undefined,
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
    variant: state.variant || undefined,
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
      variant: state.variant || undefined,
      agent: state.agent,
      autoEdit: state.autoEdit,
    });
    stickToBottom = true;
  };
  area.addEventListener("keydown", (e) => {
    if (isSendKey(e)) {
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

function applyDefaultAgent() {
  const a = state.settings.defaultAgent;
  if (a && state.agents.includes(a) && a !== state.agent) {
    state.agent = a;
    renderModeBtn();
    reportStatus();
  }
}

/** Enter, or Ctrl/Cmd+Enter when the send key setting says so. */
function isSendKey(e) {
  if (e.key !== "Enter" || e.isComposing) return false;
  return state.settings.sendKey === "ctrlEnter" ? e.ctrlKey || e.metaKey : !e.shiftKey && !e.ctrlKey && !e.metaKey;
}

function applySettings(settings, first) {
  const before = state.settings;
  state.settings = { ...state.settings, ...settings };
  if (first || before.includeSelection !== state.settings.includeSelection) {
    state.includeSelection = state.settings.includeSelection;
    renderSelBtn();
  }
  if (!state.order.length) applyDefaultAgent();
  input.placeholder = state.settings.sendKey === "ctrlEnter" ? "Ask OpenCode…  (@ files, / commands, Ctrl+Enter to send)" : "Ask OpenCode…  (@ files, / commands)";
  if (before.reasoning !== state.settings.reasoning || before.toolOutput !== state.settings.toolOutput) queueRender();
  renderContext();
  updateStatusRow();
}
let settingsReceived = false;

function setAutoRead(on) {
  state.autoRead = on;
  renderModeBtn();
  send({ type: "setAutoRead", autoRead: on });
}

function setAutoEdit(on) {
  state.autoEdit = on;
  renderModeBtn();
  send({ type: "setAutoEdit", autoEdit: on });
}

input.addEventListener("input", () => {
  // Typing means writing a prompt, not picking a model: close the model menu so Enter sends.
  if (isPickerMenu()) closeMenu();
  autosize();
  renderSendBtn();
  updateMenuFromInput();
});
input.addEventListener("click", updateMenuFromInput);
input.addEventListener("blur", () => setTimeout(() => !isPickerMenu() && closeMenu(), 150));
input.addEventListener("keydown", (e) => {
  if (menu && menu.items.length) {
    if (e.key === "ArrowDown") return e.preventDefault(), (menu.index = (menu.index + 1) % menu.items.length), drawMenu();
    if (e.key === "ArrowUp") return e.preventDefault(), (menu.index = (menu.index - 1 + menu.items.length) % menu.items.length), drawMenu();
    if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), acceptMenu();
    if (e.key === "Escape") return e.preventDefault(), closeMenu();
    if (menu.kind === "model" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return e.preventDefault(), stepVariant(e.key === "ArrowRight" ? 1 : -1);
  }
  if (isSendKey(e)) {
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
      if (file) addImageFile(file, "pasted-image");
    }
  }
});

// ------------------------------------------------------------ drag and drop

/** URI lists VS Code's Explorer and file managers put on a drag. Dragged text is left to the input. */
const URI_TYPES = ["application/vnd.code.uri-list", "text/uri-list"];
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === "Files" || URI_TYPES.includes(t));

function addImageFile(file, fallback = "dropped-image") {
  const reader = new FileReader();
  reader.onload = () => {
    state.images.push({ dataUrl: reader.result, mime: file.type, name: file.name || `${fallback}.${file.type.split("/")[1]}` });
    renderAttachments();
    renderSendBtn();
  };
  reader.readAsDataURL(file);
}

let dragDepth = 0;
const dropOverlay = h("div", { class: "drop-overlay hidden" }, h("div", { class: "drop-label" }, h("span", { html: icons.at }), "Drop to add to the prompt"));
document.body.append(dropOverlay);
const showDrop = (on) => dropOverlay.classList.toggle("hidden", !on);

document.addEventListener("dragenter", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  showDrop(true);
});
document.addEventListener("dragover", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) showDrop(false);
});
document.addEventListener("drop", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  showDrop(false);
  const dt = e.dataTransfer;
  const list = URI_TYPES.map((t) => dt.getData(t)).find((v) => v);
  if (list) {
    // With paths, the extension reads images itself and makes everything else an @mention.
    const uris = list.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    send({ type: "dropped", uris });
  } else {
    // Only the files' contents came through (no paths): images can still be attached.
    const files = [...dt.files];
    files.filter((f) => f.type.startsWith("image/")).forEach(addImageFile);
    const other = files.filter((f) => !f.type.startsWith("image/"));
    if (other.length) showError(`Couldn't tell where ${other.map((f) => f.name).join(", ")} ${other.length > 1 ? "are" : "is"}; drop files from VS Code's Explorer to mention them.`);
  }
  input.focus();
});

$("sendBtn").addEventListener("click", () => (state.busy && !input.value.trim() ? send({ type: "abort" }) : submit()));
$("modeBtn").addEventListener("click", cycleAgent);
$("editsBtn").addEventListener("click", () => (state.readOnlyAgents.includes(state.agent) ? setAutoRead(!state.autoRead) : setAutoEdit(!state.autoEdit)));
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
  if (isPickerMenu() && !menuEl.contains(e.target)) closeMenu();
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
    const code = copy.closest(".code-block, .mermaid-block").querySelector("code").textContent;
    navigator.clipboard.writeText(code);
    copy.innerHTML = icons.check;
    setTimeout(() => (copy.innerHTML = icons.copy), 1200);
    return;
  }
  const copyReply = e.target.closest(".copy-reply");
  if (copyReply) {
    const turn = copyReply.dataset.turn;
    const text = state.order
      .map((id) => state.messages.get(id))
      .filter((m) => m?.info.role === "assistant" && m.info.parentID === turn)
      .flatMap((m) => [...m.parts.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).filter((p) => p.type === "text" && !p.synthetic && p.text?.trim()).map((p) => p.text.trim()))
      .join("\n\n");
    navigator.clipboard.writeText(text);
    copyReply.innerHTML = icons.check;
    setTimeout(() => (copyReply.innerHTML = icons.copy), 1200);
    return;
  }
  // Files the model or a tool returned: the buttons, or a click on the image itself, open or save them.
  const fileEl = e.target.closest("[data-file]");
  const action = e.target.closest("[data-file-action]")?.dataset.fileAction ?? (e.target.matches("img") ? "open" : null);
  if (fileEl && action) {
    const f = fileParts.get(fileEl.dataset.file);
    if (f) send({ type: action === "save" ? "saveAttachment" : "openAttachment", url: f.url, mime: f.mime, filename: fileName(f) });
    return;
  }
  // Tool results: rows open their file (at a line), "N more" and "Show page" unfold, a page opens.
  const more = e.target.closest("[data-expand]");
  if (more) {
    const id = more.dataset.expand;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    return void queueRender(more.dataset.msg);
  }
  const url = e.target.closest("[data-open-url]")?.dataset.openUrl;
  if (url) return void send({ type: "openExternal", url });
  const row = e.target.closest("[data-open-path]");
  if (row && !e.target.closest("a")) {
    return void send({ type: "openFile", path: row.dataset.openPath, line: row.dataset.openLine ? +row.dataset.openLine : undefined });
  }
  const mdImg = e.target.closest(".md-img");
  if (mdImg) return void openPath(mdImg.dataset.path);
  const toggle = e.target.closest(".mermaid-toggle");
  if (toggle) return void toggle.closest(".mermaid-block").classList.toggle("show-source");
  // VS Code's webview wrapper opens any clicked link itself, from a listener on the window that
  // ignores preventDefault, so links handled here stop there: otherwise a web link opens twice.
  if (e.target.closest("a[href]")) e.stopPropagation();
  const a = e.target.closest("a:not(.file-ref)");
  const href = a?.getAttribute("href");
  if (href) {
    e.preventDefault();
    // Web links open in the browser via VS Code, #anchors (footnotes) scroll within their message,
    // and anything else is treated as a file path.
    if (/^https?:/.test(href)) send({ type: "openExternal", url: href });
    else if (href.startsWith("#")) a.closest(".markdown")?.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
  const target = fileTarget(p);
  send({ type: "openFile", path: target.path, line: line ?? target.line });
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
  item("New conversation in a worktree…", () => send({ type: "newWorktree" }));
  if (state.session) {
    item("Rename conversation…", renameCurrent);
    item("Fork conversation", () => send({ type: "fork" }));
  }
  item(state.session?.share?.url ? "Copy share link" : "Share conversation…", () => send({ type: "share" }));
  item("Compact conversation", () => runBuiltin("compact"));
  item("Providers and MCP servers…", () => send({ type: "openSettings" }));
  item("Show logs", () => send({ type: "showLogs" }));
});

/**
 * Edit a title in place of `el`: Enter or leaving the field saves, Esc cancels. Unchanged or empty
 * titles aren't sent.
 */
function editTitle(el, current, save) {
  const field = h("input", { class: "title-edit", value: current, "aria-label": "Conversation title" });
  field.value = current;
  el.classList.add("hidden");
  el.after(field);
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    const title = field.value.trim();
    field.remove();
    el.classList.remove("hidden");
    if (ok && title && title !== current) save(title);
  };
  field.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") e.preventDefault(), finish(true);
    if (e.key === "Escape") e.preventDefault(), finish(false);
  });
  field.addEventListener("blur", () => finish(true));
  field.addEventListener("click", (e) => e.stopPropagation());
  field.focus();
  field.select();
}

function renameCurrent() {
  const session = state.session;
  if (!session) return;
  $("historyPop").classList.add("hidden");
  editTitle($("titleBtn"), displayTitle(session.title), (title) => {
    // Show it straight away; OpenCode's session.updated confirms it.
    session.title = title;
    renderTitle();
    send({ type: "renameSession", id: session.id, title });
  });
}

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
    const match = (title) => displayTitle(title).toLowerCase().includes(q);
    // Conversations still running (or waiting, or in a worktree) stay open in the background; list them first.
    const open = state.tabs.length > 1 ? state.tabs.filter((t) => match(t.title)) : [];
    if (open.length) {
      listEl.append(h("div", { class: "pop-head" }, "Open"));
      for (const t of open) listEl.append(openItem(t));
      listEl.append(h("div", { class: "pop-head" }, "Recent"));
    }
    const openIDs = new Set(open.map((t) => t.sessionID));
    const items = list.filter((s) => !openIDs.has(s.id) && match(s.title));
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
            title: "Rename",
            html: icons.pencil,
            onClick: (e) => {
              e.stopPropagation();
              const row = e.target.closest(".session-item");
              editTitle(row.querySelector(".s-title"), s.title || "", (title) => {
                s.title = title;
                row.querySelector(".s-title").textContent = title;
                if (state.session?.id === s.id) (state.session.title = title), renderTitle();
                send({ type: "renameSession", id: s.id, title, relist: true });
              });
            },
          }),
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
  state.timedOut = null;
  state.retry = null;
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
  } else if (!messages.length) applyDefaultAgent();
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
  if (e.type.startsWith("message.")) state.lastActivity = Date.now();
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
      // A retry ending (or starting) counts as activity, so the stall warning measures each attempt on its own.
      if (!!state.retry !== (p.status?.type === "retry")) state.lastActivity = Date.now();
      state.retry = p.status?.type === "retry" ? p.status : null;
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
  showToast(message, "error");
}

function showToast(message, kind) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = h("div", { class: "toast" });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle("info", kind === "info");
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
      state.autoRead = !!msg.autoRead;
      state.readOnlyAgents = msg.readOnlyAgents || ["plan"];
      state.agents = msg.agents.length ? msg.agents : ["build"];
      state.agentColors = msg.agentColors || {};
      state.subagents = msg.subagents || [];
      state.mcpServers = msg.mcpServers || [];
      if (!state.agents.includes(state.agent)) state.agent = state.agents[0];
      state.models = msg.models;
      state.cwd = msg.cwd;
      state.commands = msg.commands;
      // The extension decides the starting model (last used, opencodeChat.model or OpenCode's default).
      state.variantByModel = msg.variantByModel || {};
      state.lastVariant = msg.defaultModel?.variant || null;
      setModel(msg.defaultModel || null);
      // The starting model's level comes with it, picked or carried when the panel last closed.
      if (msg.defaultModel?.variant && modelVariants().includes(msg.defaultModel.variant)) state.variant = msg.defaultModel.variant;
      renderModeBtn();
      renderModelBtn();
      renderSendBtn();
      queueRender();
      break;
    case "setModel":
      setModel(msg.model, true);
      renderModelBtn();
      renderContext();
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
    case "childDelta": {
      const part = state.childParts.get(msg.sessionID)?.get(msg.partID);
      if (part) {
        part[msg.field] = (part[msg.field] || "") + msg.delta;
        const owner = taskOwner(msg.sessionID);
        if (owner) queueRender(owner);
      }
      break;
    }
    case "lines":
      for (const [n, text] of Object.entries(msg.lines || {})) sourceLines.set(`${msg.path}:${n}`, text);
      for (const el of messagesEl.querySelectorAll(".code[data-src]")) if (!el.textContent) el.textContent = sourceLines.get(el.dataset.src) || "";
      break;
    case "image":
      localImages.set(msg.path, msg.url || null);
      for (const img of messagesEl.querySelectorAll("img[data-local]")) if (img.dataset.local === msg.path) showLocalImage(img, msg.url || null);
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
      if (msg.draft) {
        // A fork's message: back in the box to change before sending, not sent.
        input.value = msg.text;
        autosize();
        renderSendBtn();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      } else sendExternal(msg.text, msg.mentions);
      break;
    case "settings":
      applySettings(msg.settings, !settingsReceived);
      settingsReceived = true;
      break;
    case "event":
      onEvent(msg.event);
      break;
    case "sessions":
      renderSessions(msg.sessions);
      break;
    case "fileResults":
      if (menu?.kind === "file" && msg.query === fileQuery) {
        menu.items = [
          ...agentItems(msg.query),
          ...msg.files.map((f) => ({ type: "file", label: f.split("/").pop() || f, detail: f, value: f, icon: f.endsWith("/") ? icons.folder : icons.file })),
          ...(msg.symbols || []).map((sym) => ({
            type: "symbol",
            label: sym.container ? `${sym.container}.${sym.name}` : sym.name,
            detail: `${sym.kind.toLowerCase()} · ${sym.path}:${sym.line}`,
            value: sym,
            icon: icons.code,
          })),
        ];
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
      const token = `@${mentionPath(m.path)}${m.startLine ? `#L${m.startLine}${m.endLine && m.endLine !== m.startLine ? `-${m.endLine}` : ""}` : ""} `;
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
    case "addImages":
      state.images.push(...msg.images);
      renderAttachments();
      renderSendBtn();
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

function openItem(t) {
  const pop = $("historyPop");
  return h(
    "div",
    { class: `pop-item session-item ${t.key === state.activeTab ? "current" : ""}`, onClick: () => (t.key !== state.activeTab && send({ type: "switchTab", key: t.key }), pop.classList.add("hidden")) },
    tabStatus(t),
    h("span", { class: "s-title" }, displayTitle(t.title)),
    h("span", { class: "s-time" }, t.status === "attention" ? "needs you" : t.status === "busy" ? "working" : t.worktree ? t.worktree.name : ""),
    h("button", {
      class: "icon-btn s-del",
      title: "Close (the conversation stays in history)",
      html: icons.x,
      onClick: (e) => {
        e.stopPropagation();
        pop.classList.add("hidden");
        send({ type: "closeTab", key: t.key });
      },
    }),
  );
}

function tabStatus(t) {
  if (t.status === "attention") return h("span", { class: "tab-attention", html: icons.shield });
  if (t.status === "busy") return h("span", { class: "tab-busy" });
  if (t.worktree) return h("span", { class: "tab-wt", html: icons.branch });
  return null;
}

/** No tab strip: the title shows when another open conversation is working or needs you. */
function renderTabs(tabs, active) {
  state.tabs = tabs;
  state.activeTab = active;
  const others = tabs.filter((t) => t.key !== active);
  const attention = others.filter((t) => t.status === "attention").length;
  const busy = others.filter((t) => t.status === "busy").length;
  const el = $("titleOthers");
  el.innerHTML = "";
  if (attention) el.append(h("span", { class: "tab-attention", html: icons.shield }));
  else if (busy) el.append(h("span", { class: "tab-busy" }));
  $("titleBtn").title = attention
    ? `${attention} other conversation${attention > 1 ? "s" : ""} need${attention > 1 ? "" : "s"} you`
    : busy
      ? `${busy} other conversation${busy > 1 ? "s are" : " is"} working`
      : "Past conversations";
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
