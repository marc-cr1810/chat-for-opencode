# OpenCode for VS Code

[![CI](https://github.com/marc-cr1810/opencode-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/marc-cr1810/opencode-vscode/actions/workflows/ci.yml)

A VS Code chat panel for [OpenCode](https://opencode.ai).

It starts `opencode serve` in your workspace and talks to it over its local HTTP API, so it uses
whatever providers, models, agents and commands you've configured for the opencode CLI.

## Features

- Chat in an editor tab (button in the editor title bar) or in the secondary side bar (right-hand side, next to Copilot / Claude)
- Streaming responses, collapsible reasoning, tool calls with per-tool icons (Read / Edit / Shell …)
- Inline diffs for edits, plus "Open diff" in VS Code's native diff editor
- Permission prompts: **Allow once / Allow always / Reject** with an optional reason (Enter / Esc)
- Agent switcher (build, plan and your custom agents) cycled with **Tab**, plus an approve / auto-approve edits toggle
- Current file / selection shared automatically (eye toggle in the footer)
- `@` file mentions with autocomplete, `@file#L10-20` line ranges, pasted images
- `/` commands: built-ins (`/new`, `/compact`, `/model`, `/history`) plus your OpenCode commands
- Model picker, past conversations (search, resume, delete), task list, Esc to interrupt
- **Undo to here** on any of your messages: rolls the conversation back and restores the files OpenCode changed (with Redo)
- **Changes panel** listing every file the session changed, with +/- counts, native diff view and per-file discard
- **Context meter** showing how full the model's context is and what the session has cost; click to compact
- **Conversation tabs**: run several conversations in parallel; tabs show when one is working or needs approval
- **Edit and resend** any earlier message (undoes from that point, then sends the edited text)
- **Subagent view**: steps run by `explore` / `general` subagents stream in, nested under the task
- **Worktrees**: start a conversation in an isolated git worktree, then apply its changes to your workspace or throw them away
- **Share links** for a conversation (asks first, since the link is public)
- **Clickable file references** like `src/app.ts:42` in replies
- **Fix / Explain with OpenCode** in the lightbulb menu for errors and warnings
- **Right-click menu** in the editor: Explain, Refactor, Write Tests, Add Selection to Prompt
- **Status bar item** showing the agent and model, a spinner while working, and a warning when approval is needed
- **Notifications** when a task finishes or needs approval while the panel is hidden (`opencode.notifications`)
- **Settings screen** (`…` → Providers and MCP servers) to add API keys, connect or add MCP servers, and open config files
- Questions asked by the agent rendered as option cards

## Keybindings

| Key | Action |
| --- | --- |
| `Ctrl+Alt+O` | Open / focus OpenCode |
| `Ctrl+Alt+Shift+O` | Open a new OpenCode tab |
| `Ctrl+Alt+K` | Add the current selection to the prompt |
| `Tab` (in input) | Switch agent |
| `Esc` | Stop |

## Settings

- `opencode.binaryPath` – path to `opencode` (default: `opencode` on PATH)
- `opencode.autoApproveEdits` – apply edits without asking (shell commands always ask)
- `opencode.model` – default `provider/model`
- `opencode.notifications` – notify when a task finishes or needs approval while hidden (default on)
- `opencode.preferredLocation` – `sidebar` (default, the secondary side bar) | `panel` (editor tab)

## Build

```bash
npm install
npm run package   # produces opencode-vscode-<version>.vsix
code --install-extension opencode-vscode-0.3.1.vsix
```

For development, open this folder in VS Code and press F5.

```bash
npm test          # unit tests (event-stream parsing, change reconstruction)
npm run typecheck
```

## Releasing

CI typechecks, tests, builds and packages every push and pull request (the `.vsix` is attached to the run as an artifact).

To publish a release, bump the version and push the tag:

```bash
npm version patch
git push --follow-tags
```

The release workflow checks that the tag matches `package.json`, builds the `.vsix` and attaches it to a
GitHub release with generated notes. To also publish to the VS Code Marketplace or Open VSX, set a real
`publisher` in `package.json` and add a `VSCE_PAT` or `OVSX_PAT` repository secret.
