# Unified CLI (`zcode-acp`)

Every surface of this package is available under one command — `zcode-acp` —
installed alongside the `zcode-acp-server` bin your editor configures.

## Interactive TUI

Bare `zcode-acp` opens an interactive terminal chat against this same bridge,
powered by [Martty](https://github.com/openma-ai/Martty) — a terminal-native
ACP client bundled as a dependency (ADR-0020). The in-house Ink REPL it
replaced was removed entirely; the CLI surface is Martty + this bridge, on
every platform including Windows.

```bash
zcode-acp            # chat in this directory
zcode-acp tui        # same thing, explicit
```

The TUI is a full ACP client: streaming output with markdown rendering, tool
rows that expand/collapse on click, a model picker (`Ctrl-P`), queueing
(`enter` queues, `Ctrl-Enter` steers the running turn), `!` shell escapes,
themes (`Ctrl-T`), and native mouse support (wheel scroll, click-select,
drag-copy). `/resume` lists this project's previous conversations (from the
bridge's `session/list`) and loads one; `/new` starts fresh. Keys: `esc`
interrupts a turn and clears the draft, `Ctrl-C` clears then quits, `↑`
recalls history. `/help` inside the TUI lists everything.

Two Martty behaviors worth knowing:

- **Resumed sessions keep their context but not their on-screen history.**
  Martty rebuilds transcripts from its own local recording, so attaching to
  a session created elsewhere (the editor, the phone app, a previous remote
  window) starts a visually empty transcript — the status line says
  `resumed <id> — previous transcript was not replayed`. The conversation
  itself is live: your next prompt runs with the full history in the
  backend.
- **Sessions persist in the ZCode backend** like every other client of this
  bridge — close the TUI any time; the conversation stays available to your
  editor and to `/resume`.

Without a TTY (pipes, Windows editor shims — where the bin name is lost from
`argv`), bare `zcode-acp` falls back to the stdio server, so editor configs
pointing at either bin name keep working. Ask for the TUI explicitly with
`zcode-acp tui`; without a TTY that errors instead of falling back.
`zcode-acp tui --check` runs a headless wiring check (spawn + initialize
handshake) — that is what CI smoke-tests.

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
