// Stands in for the extension host so the real webview bundle (dist/webview.js) runs in a browser.
// URL parameters: ?scene=<name from scenes.js>&theme=dark|light&settings=<JSON overrides>
//
// window.harness, for tests and the console:
//   sent           messages the webview posted to the host
//   post(msg)      deliver a host → webview message
//   event(type, p) deliver an OpenCode event, as the host forwards them
//   ready          resolves once the scene is loaded
//   scene          the loaded scene (see scenes.js)
import { scenes } from "./scenes.js";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "vscode-light" : "vscode-dark";
document.documentElement.classList.add(theme);
document.body.classList.add(theme);

const models = [
  { providerID: "opencode", providerName: "OpenCode Zen", modelID: "big-pickle", name: "Big Pickle", context: 200_000, variants: ["low", "high", "max"] },
  { providerID: "opencode", providerName: "OpenCode Zen", modelID: "flint-40b", name: "Flint 40B", context: 200_000, variants: ["max", "low", "medium", "high", "xhigh"] },
  { providerID: "lmstudio", providerName: "LM Studio", modelID: "qwen3.8-27b", name: "Qwen 3.8 27B", context: 128_000, variants: [] },
  { providerID: "lmstudio", providerName: "LM Studio", modelID: "tuned-7b", name: "Tuned 7B", context: 32_000, variants: ["fast", "thinking"] },
];
const settings = {
  defaultAgent: "",
  sendKey: "enter",
  includeSelection: true,
  reasoning: "collapsed",
  toolOutput: "auto",
  contextWarningPercent: 75,
  stallWarningSeconds: 30,
  responseTimeoutSeconds: 0,
  ...JSON.parse(params.get("settings") || "{}"),
};

const post = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
const event = (type, properties) => post({ type: "event", event: { type, properties } });
let markReady;
const harness = { sent: [], post, event, ready: new Promise((r) => (markReady = r)) };
window.harness = harness;

const scene = (scenes[params.get("scene") || "empty"] ?? scenes.empty)();
harness.scene = scene;

function onMessage(msg) {
  harness.sent.push(msg);
  switch (msg.type) {
    case "ready":
      return load();
    case "listSessions": {
      const open = (scene.tabs ?? []).map((t) => ({ id: t.sessionID, title: t.title, time: { updated: Date.now() } }));
      const past = (scene.sessions ?? []).map((s) => ({ id: s.id, title: s.title, time: { updated: Date.now() - s.ago * 1000 } }));
      const current = scene.session && !scene.tabs ? [{ ...scene.session, time: { updated: Date.now() } }] : [];
      return post({ type: "sessions", sessions: [...current, ...open, ...past] });
    }
    case "loadChild":
      // A subagent session's steps and text, from the scene's `children`.
      return post({ type: "childParts", sessionID: msg.sessionID, parts: scene.children?.[msg.sessionID] ?? [] });
    case "searchFiles":
      return post({
        type: "fileResults",
        query: msg.query,
        files: ["src/chat.ts", "src/server.ts", "webview/main.js", "explore"].filter((f) => f.includes(msg.query)),
        symbols:
          msg.query.length < 2
            ? []
            : [
                { name: "start", kind: "Method", container: "OpencodeServer", path: "src/server.ts", line: 48 },
                { name: "startingModel", kind: "Method", container: "ChatController", path: "src/chat.ts", line: 398 },
              ].filter((s) => s.name.startsWith(msg.query)),
      });
  }
}
window.acquireVsCodeApi = () => ({ postMessage: onMessage, getState: () => null, setState() {} });

function load() {
  post({ type: "serverStatus", status: "ready" });
  post({
    type: "init",
    cwd: scene.cwd,
    models,
    defaultModel: { providerID: "opencode", modelID: "big-pickle" },
    agents: ["build", "plan"],
    subagents: [
      { name: "explore", description: "Fast agent specialized for exploring codebases" },
      { name: "general", description: "General-purpose agent for multi-step tasks" },
    ],
    readOnlyAgents: ["plan"],
    autoEdit: false,
    autoRead: false,
    commands: [
      { name: "init", description: "create/update AGENTS.md" },
      { name: "review", description: "review changes" },
    ],
  });
  post({ type: "settings", settings });
  if (scene.session) {
    post({ type: "session", session: scene.session, messages: scene.messages ?? [] });
    if (scene.busy) event("session.status", { sessionID: scene.session.id, status: { type: "busy" } });
    if (scene.question) event("question.asked", scene.question);
    if (scene.permission) event("permission.asked", scene.permission);
  }
  const tabs = scene.tabs ?? [{ key: "t1", sessionID: scene.session?.id, title: scene.session?.title ?? "New conversation", status: scene.busy ? "busy" : "idle" }];
  post({ type: "tabs", tabs, active: tabs[0].key });
  markReady();
}

// Load the real bundle only once the stand-in API exists.
const script = document.createElement("script");
script.src = "../dist/webview.js";
document.body.append(script);
