# Unified CLI (`zcode-acp`)

Every surface of this package is available under one command — `zcode-acp` —
installed alongside the `zcode-acp-server` bin your editor configures.

## Interactive REPL

Bare `zcode-acp` opens an interactive terminal chat against this same bridge
(built with [Ink](https://github.com/vadimdemedes/ink), the same renderer
Claude Code and Gemini CLI use). Completed messages print once into the
terminal's **native scrollback** — smooth wheel scrolling, text selection,
search, and history that survives exit are all just your terminal, unchanged.
Only a compact dynamic footer ever repaints: the live-turn tail (capped at
half the screen), queued-prompt panel, completion menu, and the prompt box.

```bash
zcode-acp            # chat in this directory
```

A startup welcome panel (version, session directory, seeded config, key
hints) lands in scrollback first. Streaming output has code-fence coloring,
dim thinking lines, and live tool rows. The prompt line wraps across rows
with a CJK-aware block cursor — `←`/`→` (or Ctrl-B/Ctrl-F) move inside the
typed text, Backspace/Delete edit at the caret, Ctrl-A/Ctrl-E jump to the
line's ends, Ctrl-U clears the line; completion keeps precedence while its
menu is open. The status row carries a compact plan-quota readout
(`5h 16% · wk 4%`) refreshed every 10 minutes — `/quota` prints the full
card. Pasted or dragged-in content (error logs, file drops) is sanitized and
size-capped before it reaches the editor, so long pastes batch cleanly.
`esc` interrupts a running turn (immediately — the bridge resolves the prompt
as cancelled without waiting for the backend); `Ctrl-C` also interrupts, and
while idle press it twice to quit. `/exit` (or a bare `exit`, shell-style)
leaves; the session itself persists
in the ZCode backend and is available to your editor.

Sending a follow-up right after an interrupt waits for the backend to finish
the cancelled generation first — a `[上一个回复仍在生成，等待结束后发送…]`
note explains the pause (the Aug-28 app-server accepts mid-generation sends
as steer input but drops them when the old turn ends; the bridge polls until
the session is idle, up to 90s, so the message actually runs).

Messages typed while a turn is running (or the session is still starting) are
queued, not lost: each shows up in the transcript immediately and a `⏸ queued`
panel above the prompt box lists everything waiting to run. When the current
turn ends the queue drains one prompt at a time — through the same command
parsing as direct submits, so queued `/help` and `/exit` still work.

`/sessions` lists this project's previous conversations in an 8-row sliding
window (position counter, plus "N newer above / N older below" hints); arrow
keys move over the full list even though only part of it renders. Resuming
loads the most recent tail of the conversation (last 50 messages, turn-aligned)
instead of dumping thousands of lines at once — when older history exists the
note says exactly what was loaded:
`resumed "<title>" — showing last 50 of 1234 messages`.

The full-width prompt box mirrors the editor's dropdowns: its bottom row shows
the current `model · mode · thought level`, and typing `/` opens an interactive
completion menu — `↑`/`↓` move, `enter` picks the highlighted entry (or `tab` /
`→`; typing the exact form already sends), `esc` dismisses. After picking
`/model`, `/mode`, or `/thought` the same menu lists the config options (the
current one marked `●`) and **enter on a row switches immediately** — no second
confirmation. Argument-free commands (`/exit`, `/help`, `/sessions`, `/new`,
`/compact`, `/mcp`, `/quota`) run on pick as well; every other completion
(skills, plugins) only fills the line, since those usually expect arguments.
The arg-less forms still print a static listing over the same slash-command
path the editor uses. `/help` lists every command the bridge advertises,
including plugin commands. `/new` swaps in a fresh session without leaving
the terminal (the old conversation stays in `/sessions` and in scrollback).

Submitted prompts are history: `↑`/`↓` (with the completion menu closed)
recall them per project across restarts — the first `↑` stashes the draft
and `↓` past the newest entry restores it. Pasted text folds to a single
line (newlines and tabs become spaces), so a multi-paragraph paste lands in
the box as one prompt instead of firing line-by-line. While a reply streams,
the footer shows a live status row — `⠋ working… (12s · esc to interrupt)` —
so stretches with no streamed output (long tool calls) still visibly tick.

Unexpected internal errors never take the REPL down silently: they print to
stderr and surface as an `-- error absorbed: …` note in the transcript while
everything keeps running. Only repeated failures within ten seconds trip a
breaker that shuts the UI down cleanly.

While remote access is enabled, turns started from other clients (the mobile
app, a second editor) render live in the REPL too, and questions or permission
requests answered elsewhere dismiss the local picker automatically.

Without a TTY (pipes, Windows editor shims — where the bin name is lost from
`argv`), bare `zcode-acp` falls back to the stdio server, so editor configs
pointing at either bin name keep working. Ask for the REPL explicitly with
`zcode-acp repl`; without a TTY that errors instead of falling back.

## Quota cards

Check plan usage from the terminal — no editor or running server needed. By
default it shows both **GLM Coding Plan** and **Opencode Go** in one card;
pass a provider to focus on one.

GLM credentials are read from `~/.zcode/v2/config.json`. Opencode Go
credentials come from environment variables (the dashboard needs a browser
cookie — see [Opencode Go setup](#opencode-go-setup) below).

```bash
# Both providers (default): GLM + Opencode Go in one card
zcode-acp quota

# Focus on one provider
zcode-acp quota glm        # GLM Coding Plan only
zcode-acp quota go         # Opencode Go only (rolling + weekly + monthly)

# Live monitor: clear the screen and refresh every 30s (default)
zcode-acp quota -w
zcode-acp quota go -w      # watch Opencode Go only

# Refresh at a custom interval (seconds; minimum 10)
zcode-acp quota --watch --interval 60

# Plain monochrome bars (color is the default on a terminal)
zcode-acp quota --plain
```

By default the CLI renders heat-colored (green→yellow→red) progress bars with
the usage numbers overlaid inside the bar, so each line stays short. Pass
`--plain` (or `-p`) for the classic monochrome `█`/`░` layout. Color is also
disabled automatically when stdout is piped or redirected, so captured output
stays clean.

The watch mode clears and redraws the card in place, like `top`/`htop`. Press
`Ctrl-C` to exit. The 10s minimum exists because the quota API is cached for
10s internally — a shorter interval would just keep returning the stale cached
value.

When the package isn't globally installed, run the built file directly:

```bash
node dist/cli.js quota -w
```

## Opencode Go setup

Opencode Go has no JSON API for subscription usage — the CLI scrapes the
authenticated dashboard at `opencode.ai/workspace/<id>/go`, so it needs your
browser `auth` cookie. Credentials are read from two sources, **merged
field-by-field with environment variables taking precedence** over the config
file:

- **Config file**: `~/.pi/agent/opencode-go.json` — same convention as the
  `@beyona/pi-zai-usage` Pi extension, so if you already configured it there
  you're done.
  ```json
  { "workspaceId": "wrk_your_workspace_id", "authCookie": "Fe26.2**your_cookie_value" }
  ```
- **Environment variables** (override the matching file field):
  ```bash
  export OPENCODE_GO_WORKSPACE_ID="wrk_your_workspace_id"
  export OPENCODE_GO_AUTH_COOKIE="Fe26.2**your_cookie_value"
  ```

How to get the values:

1. **Workspace ID** — open `https://opencode.ai`, navigate to your Go
   workspace, and copy the `wrk_…` id from the URL
   (`https://opencode.ai/workspace/<wrk_…>/go`).
2. **Auth cookie** — open browser DevTools (F12) → Application → Cookies →
   `opencode.ai` → copy the value of the cookie named `auth` (it starts with
   `Fe26.2**`).

Without credentials, the default dual-provider mode silently shows GLM only
(no error). Running `zcode-acp quota go` without credentials prints a setup hint.

## Hub and server subcommands

`zcode-acp hub` runs the remote-access hub daemon manually (normally
auto-spawned by bridges — see [Remote Access](REMOTE.md)). `zcode-acp
server` speaks ACP on stdio — that is what editors invoke through the
`zcode-acp-server` bin; you rarely need it by hand.

## Upgrading from 0.11

0.12.0 folds the old standalone bins into the unified CLI (see
[ADR-0007](adr/0007-unified-cli-entry-and-bin-pruning.md)):

| Old (≤0.11)          | New (0.12)                            |
| -------------------- | ------------------------------------- |
| `zcode-acp-server`   | unchanged (kept for editor configs)   |
| `zcode-quota [args]` | `zcode-acp quota [args]` (same flags) |
| `zcode-acp-hub`      | `zcode-acp hub`                       |

Editor configs referencing `zcode-acp-server` keep working unchanged.
