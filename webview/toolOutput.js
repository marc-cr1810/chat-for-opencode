// Reading OpenCode's tool output back into structure, for tool steps that show more than text.
// Each parser returns null when the output isn't in the shape it knows, and the step falls back
// to showing it as text.

/** Grep: "Found N matches", then per file "path:" and "  Line 12: text" rows. */
export function parseGrep(output) {
  const files = [];
  let file = null;
  for (const line of String(output || "").split("\n")) {
    const hit = line.match(/^ {2}Line (\d+): ?(.*)$/);
    if (hit && file) file.lines.push({ line: +hit[1], text: hit[2] });
    else if (/^\S.*:$/.test(line) && !line.startsWith("Found ")) files.push((file = { path: line.slice(0, -1), lines: [] }));
  }
  return files.length ? { files, truncated: /\(Results truncated/.test(output) || /more matches available/.test(output) } : null;
}

/** Glob: one absolute path per line, then maybe a note that it was cut short. */
export function parseGlob(output) {
  const text = String(output || "");
  if (!text.trim() || text.trim() === "No files found") return null;
  const paths = text.split("\n").filter((l) => l && !l.startsWith("("));
  return paths.every((p) => /^(\/|[A-Za-z]:[\\/])/.test(p)) ? { paths, truncated: /\(Results are truncated/.test(text) } : null;
}

/**
 * Web search results, from whichever provider OpenCode used: JSON with a list of results, or text
 * blocks of "Title: …" and "URL: …" lines. Each result is { title, url, snippet }.
 */
export function parseSearch(output) {
  const text = String(output || "").trim();
  try {
    const list = findResults(JSON.parse(text));
    if (list) return list;
  } catch {}
  const results = [];
  for (const block of text.split(/\n(?=Title: )/)) {
    const title = block.match(/^Title: (.+)$/m)?.[1]?.trim();
    const url = block.match(/^URL: (\S+)$/m)?.[1];
    if (!title || !/^https?:/.test(url || "")) continue;
    const body = block.match(/^(?:Text|Summary|Highlights?): ([\s\S]*)$/m)?.[1] || "";
    results.push({ title, url, snippet: snippet(body) });
  }
  return results.length ? results : null;
}

function findResults(value) {
  if (Array.isArray(value)) {
    const items = value.filter((r) => r && typeof r === "object" && /^https?:/.test(r.url || ""));
    if (items.length) {
      return items.map((r) => ({
        title: String(r.title || r.url),
        url: r.url,
        snippet: snippet([].concat(r.excerpts ?? r.snippet ?? r.text ?? r.summary ?? r.description ?? "").join(" ")),
      }));
    }
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      const found = findResults(v);
      if (found) return found;
    }
  }
  return null;
}

const snippet = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 300);

/** The site a link points at, without "www.". */
export const domain = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const LSP_NAMES = {
  goToDefinition: "Definition",
  findReferences: "References",
  hover: "Hover",
  documentSymbol: "Symbols",
  workspaceSymbol: "Workspace symbols",
  goToImplementation: "Implementations",
  prepareCallHierarchy: "Call hierarchy",
  incomingCalls: "Callers",
  outgoingCalls: "Calls",
};
export const lspName = (operation) => LSP_NAMES[operation] || "LSP";

const uriPath = (uri) => {
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri;
  }
};

/**
 * The places an lsp result points at, as { path, line, name? } with 1-based lines: locations,
 * location links, symbols and call-hierarchy items. Hover has none (see lspHover). Document symbols
 * don't say which file they're in, so `file` is the one that was asked about.
 */
export function lspLocations(result, file) {
  const out = [];
  const add = (uri, range, name) => (uri || file) && range && out.push({ path: uri ? uriPath(uri) : file, line: range.start.line + 1, ...(name ? { name } : {}) });
  const walk = (items, uri) => {
    for (const r of [].concat(items || [])) {
      if (!r || typeof r !== "object") continue;
      if (r.from || r.to) add((r.from || r.to).uri, (r.from || r.to).selectionRange || (r.from || r.to).range, (r.from || r.to).name);
      else if (r.targetUri) add(r.targetUri, r.targetSelectionRange || r.targetRange);
      else if (r.location) add(r.location.uri, r.location.range, r.name);
      else if (r.name && (r.selectionRange || r.range)) {
        // A document symbol: its children are in the same file.
        add(r.uri || uri, r.selectionRange || r.range, r.name);
        walk(r.children, r.uri || uri);
      } else if (r.uri && r.range) add(r.uri, r.range);
    }
  };
  walk(result);
  return out;
}

/** Hover text as markdown, from any of the shapes LSP allows. */
export function lspHover(result) {
  const parts = [];
  const take = (c) => {
    if (!c) return;
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) c.forEach(take);
    else if (c.language) parts.push("```" + c.language + "\n" + c.value + "\n```");
    else if (c.value) parts.push(c.value);
  };
  for (const r of [].concat(result || [])) take(r?.contents);
  return parts.join("\n\n");
}

/**
 * An MCP tool's server and own name. OpenCode names them "<server>_<tool>" with anything outside
 * [A-Za-z0-9_-] replaced, so the server is the longest known server name that prefixes the ID.
 */
export function mcpTool(id, servers) {
  const clean = (s) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  const server = [...(servers || [])].sort((a, b) => b.length - a.length).find((s) => id.startsWith(clean(s) + "_"));
  if (!server) return null;
  return { server, name: id.slice(clean(server).length + 1).replace(/[_-]+/g, " ").trim() };
}

/** The argument that says most about an MCP call, for the step's header. */
export function mainArg(input) {
  const entries = Object.entries(input || {}).filter(([, v]) => typeof v === "string" && v.trim());
  const preferred = ["title", "name", "query", "q", "url", "path", "filePath", "file", "command", "message", "subject", "libraryName", "id"];
  for (const key of preferred) {
    const hit = entries.find(([k]) => k === key);
    if (hit) return hit[1];
  }
  return entries.find(([, v]) => v.length <= 120)?.[1] || "";
}
