import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { OpencodeServer } from "./server";

/** Editor tab for managing providers, API keys and MCP servers through the OpenCode server. */
export class SettingsPanel {
  private static current: SettingsPanel | undefined;

  static show(extensionUri: vscode.Uri, server: OpencodeServer) {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    SettingsPanel.current = new SettingsPanel(extensionUri, server);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly server: OpencodeServer,
  ) {
    this.panel = vscode.window.createWebviewPanel("opencode.settings", "OpenCode Settings", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((msg) =>
      this.handle(msg).catch((err) => this.post({ type: "error", message: String(err?.message ?? err) })),
    );
    this.panel.onDidDispose(() => (SettingsPanel.current = undefined));
  }

  private post(msg: any) {
    this.panel.webview.postMessage(msg);
  }

  private async refresh() {
    const [providers, authMethods, mcp] = await Promise.all([
      this.server.request<any>("GET", "/provider"),
      this.server.request<any>("GET", "/provider/auth").catch(() => ({})),
      this.server.request<any>("GET", "/mcp").catch(() => ({})),
    ]);
    const connected = new Set<string>(providers.connected ?? []);
    this.post({
      type: "state",
      providers: (providers.all ?? [])
        .map((p: any) => ({
          id: p.id,
          name: p.name ?? p.id,
          connected: connected.has(p.id),
          source: p.source,
          env: p.env ?? [],
          models: Object.keys(p.models ?? {}).length,
          apiKey: (authMethods[p.id] ?? [{ type: "api" }]).some((m: any) => m.type === "api"),
        }))
        .sort((a: any, b: any) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name)),
      mcp: Object.entries<any>(mcp).map(([name, s]) => ({ name, status: s.status, error: s.error })),
    });
  }

  private async handle(msg: any) {
    switch (msg.type) {
      case "ready":
        await this.server.start();
        return this.refresh();
      case "setKey": {
        await this.server.request("PUT", `/auth/${encodeURIComponent(msg.providerID)}`, { type: "api", key: msg.key });
        this.post({ type: "notice", message: `Saved API key for ${msg.providerID}. Restart OpenCode to load its models.`, restart: true });
        return this.refresh();
      }
      case "removeKey": {
        const ok = await vscode.window.showWarningMessage(`Remove the stored credentials for ${msg.providerID}?`, { modal: true }, "Remove");
        if (ok !== "Remove") return;
        await this.server.request("DELETE", `/auth/${encodeURIComponent(msg.providerID)}`);
        this.post({ type: "notice", message: `Removed credentials for ${msg.providerID}.`, restart: true });
        return this.refresh();
      }
      case "mcpToggle":
        await this.server.request("POST", `/mcp/${encodeURIComponent(msg.name)}/${msg.connect ? "connect" : "disconnect"}`);
        return this.refresh();
      case "mcpAdd": {
        const config =
          msg.kind === "local"
            ? { type: "local", command: splitCommand(msg.command), enabled: true }
            : { type: "remote", url: msg.url, enabled: true };
        await this.server.request("POST", "/mcp", { name: msg.name, config });
        if (msg.persist) await this.server.request("PATCH", "/global/config", { mcp: { [msg.name]: config } });
        this.post({ type: "notice", message: `Added MCP server "${msg.name}"${msg.persist ? " and saved it to your global config" : " for this session"}.` });
        return this.refresh();
      }
      case "mcpDisable": {
        await this.server.request("POST", `/mcp/${encodeURIComponent(msg.name)}/disconnect`).catch(() => undefined);
        await this.server.request("PATCH", "/global/config", { mcp: { [msg.name]: { enabled: false } } }).catch(async () => {
          // Partial updates may be rejected for servers defined elsewhere; point to the file instead.
          this.post({ type: "notice", message: `Disconnected "${msg.name}". To disable it permanently, edit the config file where it's defined.` });
        });
        return this.refresh();
      }
      case "restart":
        await this.server.restart();
        this.post({ type: "notice", message: "OpenCode restarted." });
        return this.refresh();
      case "openConfig":
        return this.openConfig(msg.scope);
      case "openExtensionSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:local.opencode-vscode");
        return;
    }
  }

  private async openConfig(scope: "global" | "project") {
    const dir = scope === "global" ? path.join(os.homedir(), ".config", "opencode") : this.server.directory;
    for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) {
      const uri = vscode.Uri.file(path.join(dir, name));
      try {
        await vscode.workspace.fs.stat(uri);
        await vscode.window.showTextDocument(uri);
        return;
      } catch {
        // try the next name
      }
    }
    const uri = vscode.Uri.file(path.join(dir, "opencode.json"));
    const ok = await vscode.window.showInformationMessage(`No ${scope} OpenCode config yet. Create ${uri.fsPath}?`, "Create");
    if (ok !== "Create") return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from('{\n  "$schema": "https://opencode.ai/config.json"\n}\n'));
    await vscode.window.showTextDocument(uri);
  }

  private html() {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const style = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "settings.css"));
    const csp = `default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`;
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}"><title>OpenCode Settings</title></head>
<body>
<main>
  <h1>OpenCode settings</h1>
  <div id="notice" class="notice hidden"></div>

  <section>
    <h2>Providers</h2>
    <p class="sub">Models come from providers. Connect one by adding its API key. Keys are stored by OpenCode, not by VS Code.</p>
    <div class="add-row">
      <select id="keyProvider"></select>
      <input id="keyValue" type="password" placeholder="API key" autocomplete="off">
      <button id="saveKey" class="primary">Save key</button>
    </div>
    <input id="providerFilter" placeholder="Filter providers…">
    <div id="providers" class="list"></div>
  </section>

  <section>
    <h2>MCP servers</h2>
    <p class="sub">Tools OpenCode can use through the Model Context Protocol.</p>
    <div id="mcp" class="list"></div>
    <details>
      <summary>Add an MCP server</summary>
      <div class="form">
        <label>Name <input id="mcpName" placeholder="my-server"></label>
        <label>Type
          <select id="mcpKind"><option value="local">Local command</option><option value="remote">Remote URL</option></select>
        </label>
        <label id="mcpCommandRow">Command <input id="mcpCommand" placeholder="npx -y @modelcontextprotocol/server-filesystem ."></label>
        <label id="mcpUrlRow" class="hidden">URL <input id="mcpUrl" placeholder="https://example.com/mcp"></label>
        <label class="check"><input id="mcpPersist" type="checkbox" checked> Save to my global OpenCode config</label>
        <button id="mcpAdd" class="primary">Add server</button>
      </div>
    </details>
  </section>

  <section>
    <h2>Config files</h2>
    <div class="buttons">
      <button data-config="global">Edit global config</button>
      <button data-config="project">Edit project config</button>
      <button id="extSettings">Extension settings</button>
      <button id="restart">Restart OpenCode</button>
    </div>
  </section>
</main>
<script nonce="${nonce}">${SETTINGS_SCRIPT}</script>
</body></html>`;
  }
}

/** Split a command line into argv, honouring simple quotes. */
function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const SETTINGS_SCRIPT = `
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let state = { providers: [], mcp: [] };

function notice(message, isError, restart) {
  const el = $("notice");
  el.className = "notice" + (isError ? " error" : "");
  el.innerHTML = esc(message) + (restart ? ' <button id="noticeRestart">Restart now</button>' : "");
  if (restart) $("noticeRestart").onclick = () => vscode.postMessage({ type: "restart" });
}

function sourceLabel(p) {
  if (p.source === "api") return "API key";
  if (p.source === "env") return "from " + esc(p.env.join(", "));
  if (p.source === "config") return "from config file";
  return "built in";
}

function renderProviders() {
  const q = $("providerFilter").value.toLowerCase();
  const list = state.providers.filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q));
  $("providers").innerHTML = list.slice(0, q ? 200 : 40).map((p) => \`
    <div class="item">
      <span class="dot \${p.connected ? "on" : ""}"></span>
      <span class="name">\${esc(p.name)} <span class="muted">\${esc(p.id)}</span></span>
      <span class="muted">\${p.connected ? p.models + " models · " + sourceLabel(p) : "not connected"}</span>
      \${p.connected && p.source === "api" ? \`<button data-remove="\${esc(p.id)}">Remove key</button>\` : ""}
    </div>\`).join("") + (!q && state.providers.length > 40 ? '<div class="muted more">Filter to see more providers…</div>' : "");
  const sel = $("keyProvider");
  const keep = sel.value;
  sel.innerHTML = state.providers.filter((p) => p.apiKey).map((p) => \`<option value="\${esc(p.id)}">\${esc(p.name)}</option>\`).join("");
  if (keep) sel.value = keep;
}

function renderMcp() {
  $("mcp").innerHTML = state.mcp.length ? state.mcp.map((s) => \`
    <div class="item">
      <span class="dot \${s.status === "connected" ? "on" : s.status === "failed" ? "err" : ""}"></span>
      <span class="name">\${esc(s.name)}</span>
      <span class="muted" title="\${esc(s.error || "")}">\${esc(s.status.replace(/_/g, " "))}\${s.error ? ": " + esc(s.error).slice(0, 80) : ""}</span>
      \${s.status === "connected"
        ? \`<button data-mcp-off="\${esc(s.name)}">Disconnect</button>\`
        : \`<button data-mcp-on="\${esc(s.name)}">Connect</button>\`}
      <button data-mcp-disable="\${esc(s.name)}" title="Disconnect and disable in your global config">Disable</button>
    </div>\`).join("") : '<div class="muted">No MCP servers configured.</div>';
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.remove) vscode.postMessage({ type: "removeKey", providerID: t.dataset.remove });
  if (t.dataset.mcpOn) vscode.postMessage({ type: "mcpToggle", name: t.dataset.mcpOn, connect: true });
  if (t.dataset.mcpOff) vscode.postMessage({ type: "mcpToggle", name: t.dataset.mcpOff, connect: false });
  if (t.dataset.mcpDisable) vscode.postMessage({ type: "mcpDisable", name: t.dataset.mcpDisable });
  if (t.dataset.config) vscode.postMessage({ type: "openConfig", scope: t.dataset.config });
});
$("saveKey").onclick = () => {
  const key = $("keyValue").value.trim();
  if (!key) return notice("Enter an API key first.", true);
  vscode.postMessage({ type: "setKey", providerID: $("keyProvider").value, key });
  $("keyValue").value = "";
};
$("providerFilter").oninput = renderProviders;
$("mcpKind").onchange = () => {
  const local = $("mcpKind").value === "local";
  $("mcpCommandRow").classList.toggle("hidden", !local);
  $("mcpUrlRow").classList.toggle("hidden", local);
};
$("mcpAdd").onclick = () => {
  const name = $("mcpName").value.trim();
  const kind = $("mcpKind").value;
  const command = $("mcpCommand").value.trim();
  const url = $("mcpUrl").value.trim();
  if (!/^[\\w.-]+$/.test(name)) return notice("Give the server a name using letters, numbers, dots or dashes.", true);
  if (kind === "local" && !command) return notice("Enter the command that starts the server.", true);
  if (kind === "remote" && !/^https?:\\/\\//.test(url)) return notice("Enter the server's http(s) URL.", true);
  vscode.postMessage({ type: "mcpAdd", name, kind, command, url, persist: $("mcpPersist").checked });
};
$("extSettings").onclick = () => vscode.postMessage({ type: "openExtensionSettings" });
$("restart").onclick = () => vscode.postMessage({ type: "restart" });

window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (msg.type === "state") { state = msg; renderProviders(); renderMcp(); }
  if (msg.type === "notice") notice(msg.message, false, msg.restart);
  if (msg.type === "error") notice(msg.message, true);
});
vscode.postMessage({ type: "ready" });
`;
