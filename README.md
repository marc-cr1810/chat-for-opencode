# OpenCode for VS Code

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
- `opencode.preferredLocation` – `sidebar` (default, the secondary side bar) | `panel` (editor tab)

## Build

```bash
npm install
npm run package   # produces opencode-vscode-<version>.vsix
code --install-extension opencode-vscode-0.1.0.vsix
```

For development, open this folder in VS Code and press F5.
