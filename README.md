# session-hub

A Claude Code mod that keeps every running Claude Code session in view. A pane docked beside the chat is split in two:

- **Sessions** (top): every live session on this machine, with its project, a title that follows the conversation, and its status: working (with the tool it is running), needs permission, asks you, your turn, error or interrupted. Under each session, its subagents show with their type, the tool they are running, how many steps they have taken and for how long; a workflow's agents are grouped under the workflow's name with a progress bar of finished agents. "Needs permission" shows only while a permission dialog is actually waiting on you, not when auto mode's classifier settles the call. The selected session is highlighted. Click a session (its name, title or `↗`) to jump to its terminal tab; it is also selected, so its todos show below.
- **Todo** (bottom): the selected session's checklist. Claude's own todo and task lists are copied in as it updates them, with what the active item is doing, each task's description, owner and open blockers, and a done / in progress / to do count. Click an item to tick or untick it, `✕` to remove it, and type in the field at the bottom to add your own.

Reopen the pane with `/sessions`.

## Install

```
/plugin install session-hub --marketplace Ashkan4472/claude-session-hub
```

Or, for a local checkout, start Claude Code with `claude --plugin-dir <path to this folder>`, or put the folder's path in `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of your user `settings.json` so every session, desktop app sessions included, loads it.

The mod has to be loaded in each session you want listed.

## How it works

Each session writes a small JSON record to `<config dir>/session-hub/<session id>.json`, where the config dir is `CLAUDE_CONFIG_DIR` when it is set and `~/.claude` otherwise, so sessions running under different config folders keep separate lists. Every pane reads the folder every 2 seconds. A session removes its record when it ends; a record not refreshed for 90 seconds (a crashed session) is removed by the next pane that sees it.

Titles come from a short Haiku call after each turn that brought a new prompt, using your last few prompts and the open todos. That call is billed to the session's account. Until it answers, the first prompt's line is the title.

## Jumping to a session

| Where the session runs | What clicking a session does |
| --- | --- |
| iTerm2 | Focuses the exact window, tab and split |
| Terminal.app | Focuses the tab, matched by its tty |
| tmux | Switches to the session's pane (and focuses iTerm2 when tmux runs inside it) |
| Ghostty, Warp, VS Code, WezTerm | Brings the app to the front |
| Claude desktop app | Brings the app to the front |

The first jump makes macOS ask whether Claude Code may control iTerm2 or Terminal; allow it once.

## Development

```
claude plugin validate .
claude plugin test .
```

## License

MIT, see [LICENSE](LICENSE).
