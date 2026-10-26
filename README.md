# OpenCode for VS Code

A VS Code chat panel for [OpenCode](https://opencode.ai), modelled on the Claude Code extension.

It starts `opencode serve` in your workspace and talks to it over its local HTTP API, so it uses
whatever providers, models, agents and commands you've configured for the opencode CLI.

## Features

- Chat in an editor tab (spark-style button in the editor title bar) or in the secondary side bar (right-hand side, next to Copilot / Claude)
- Streaming responses, collapsible thinking, tool calls shown as a timeline (Read / Update / Bash …)
- Inline diffs for edits, plus "Open diff" in VS Code's native diff editor
- Permission prompts with **Yes / Yes, don't ask again / No + feedback** (keys 1–3, Esc)
- Three modes, cycled with **Shift+Tab**: Ask before edits · Edit automatically · Plan mode
- Current file / selection shared automatically (eye toggle in the footer)
- `@` file mentions with autocomplete, `@file#L10-20` line ranges, pasted images
- `/` commands: built-ins (`/new`, `/compact`, `/model`, `/history`) plus your OpenCode commands
- Model picker, past conversations (search, resume, delete), task list, Esc to interrupt
- Questions asked by the agent rendered as option cards

## Keybindings

| Key | Action |
| --- | --- |
| `Ctrl+Esc` | Open / focus OpenCode |
| `Ctrl+Shift+Esc` | Open a new OpenCode tab |
| `Alt+K` | Insert an @-mention of the current selection |
| `Shift+Tab` (in input) | Cycle mode |
| `Esc` | Interrupt |

## Settings

- `opencode.binaryPath` – path to `opencode` (default: `opencode` on PATH)
- `opencode.initialMode` – `ask` | `auto` | `plan`
- `opencode.model` – default `provider/model`
- `opencode.preferredLocation` – `sidebar` (default, the secondary side bar) | `panel` (editor tab)

## Build

```bash
npm install
npm run package   # produces opencode-vscode-<version>.vsix
code --install-extension opencode-vscode-0.1.0.vsix
```

For development, open this folder in VS Code and press F5.
