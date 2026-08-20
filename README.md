# zcode-acp-server

[![CI](https://github.com/william0wang/zcode-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/william0wang/zcode-acp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

English | **[简体中文](README.zh-CN.md)**

A standalone [Agent Client Protocol](https://agentclientprotocol.com/) (ACP) server that bridges the headless **ZCode** app-server to ACP-compatible editors such as [Zed](https://zed.dev) and JetBrains IDEs.

The server launches the ZCode headless app-server (`zcode app-server --stdio`) as a subprocess, translates its internal event stream into ACP `session/update` notifications, and bridges ZCode's interaction channel to ACP — preferring `elicitation/create` when the client supports it, and falling back to `session/request_permission` otherwise — so an editor gets a first-class, native coding-agent experience.

## Status

In active development. Core bridging, slash commands and ZCode extensions,
auto-compaction, remote access for mobile/web clients, and the quota APIs are
in place; see the project board for what's next.

## Requirements

- **Node.js ≥ 22** (the bridge uses `node:sqlite` for tasks-index sync; the
  ZCode CLI runtime also requires Node ≥ 22)
- The `zcode` CLI installed and on `PATH` (or pointed at via `ZCODE_BIN`)
- ZCode credentials at `~/.zcode/v2/config.json` (created by the ZCode app)

## Install

```bash
git clone <repo-url>
cd zcode-acp-server
pnpm install
pnpm build
```

The compiled entry point is `dist/index.js` (also exposed as the
`zcode-acp-server` bin). Configure your ACP client to launch it — see
**Configure Zed** below or your editor's ACP docs.

## Configure Zed

Add the server to Zed as a custom agent server. In `~/.config/zed/settings.json`
(`%APPDATA%\Zed\settings.json` on Windows):

```jsonc
{
  "agent_servers": {
    "ZCode": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/zcode-acp-server/dist/index.js"],
      "env": {
        // Point at the ZCode CLI bundled inside the desktop app (not on PATH by default).
        // See the platform-specific path below.
        "ZCODE_BIN": "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      },
    },
  },
}
```

Restart Zed and pick **ZCode** from the agent dropdown.

### `ZCODE_BIN` per platform

The ZCode CLI ships inside the desktop app and is not added to `PATH`
automatically. Point `ZCODE_BIN` at the bundled `zcode.cjs`:

| Platform    | `ZCODE_BIN` path                                                            |
| ----------- | --------------------------------------------------------------------------- |
| **macOS**   | `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`                  |
| **Windows** | `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`                     |
| **Linux**   | Inside the extracted app directory: `<install-dir>/resources/glm/zcode.cjs` |

> If the path doesn't match your install, locate it with:
>
> ```bash
> # macOS / Linux
> find / -name zcode.cjs -path '*resources/glm*' 2>/dev/null
> # Windows (PowerShell)
> Get-ChildItem -Path $env:LOCALAPPDATA,$env:APPDATA,'C:\Program Files' -Recurse -Filter zcode.cjs -ErrorAction SilentlyContinue
> ```

## Environment variables

| Variable                           | Default         | Purpose                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZCODE_BIN`                        | `zcode`         | Path to the ZCode CLI binary or its `.cjs` entry                                                                                                                                                                                                                                                                                                                                             |
| `ZCODE_NODE`                       | _(discovered)_  | Explicit Node binary to run `ZCODE_BIN` with (must support `node:sqlite`)                                                                                                                                                                                                                                                                                                                    |
| `ZCODE_MODEL`                      | _(from config)_ | Override the active model id                                                                                                                                                                                                                                                                                                                                                                 |
| `ZCODE_BASE_URL`                   | _(from config)_ | Override the provider base URL                                                                                                                                                                                                                                                                                                                                                               |
| `ZCODE_ACP_AUTO_COMPACT_THRESHOLD` | _(unset)_       | Absolute token count that triggers automatic context compaction. After each successful turn (`end_turn`), if `contextUsed >= threshold`, the server invokes `session/compact` to free up context before the next prompt. Set to `0` or leave unset to disable (default). Example: `240000` triggers compaction at 240K tokens. The compaction target itself is decided by the ZCode backend. |
| `ZCODE_ACP_DEBUG`                  | _(unset)_       | Set to `1` to enable verbose diagnostic logs (event flow, probe loops, status updates). Default is quiet — only warnings (backend pipe errors, command/permission failures, lock timeouts) are emitted. Enable this when diagnosing bridge issues; the logs appear in `Zed.log` prefixed with `[zcode-acp]`.                                                                                 |
| `ZCODE_ACP_REMOTE`                 | _(unset)_       | Set to `1` to enable [remote access](#remote-access) — serve the same sessions to additional ACP clients over WebSocket.                                                                                                                                                                                                                                                                     |
| `ZCODE_ACP_REMOTE_TOKEN`           | _(unset)_       | Auth token for remote access. **Mandatory** when `ZCODE_ACP_REMOTE=1`; remote stays disabled without it.                                                                                                                                                                                                                                                                                     |
| `ZCODE_ACP_HUB_PORT`               | `8377`          | Port of the machine-level `zcode-acp-hub`. Map exactly this one port in your tunnel.                                                                                                                                                                                                                                                                                                         |
| `ZCODE_ACP_HUB_HOST`               | `127.0.0.1`     | Hub bind address. `0.0.0.0` exposes a token-only, unencrypted surface — only for a containerized tunnel agent on a private interface (see [Remote Access](#remote-access)).                                                                                                                                                                                                                  |
| `ZCODE_ACP_REMOTE_PORT`            | `8378`          | First loopback port for the bridge's ACP endpoint. Each bridge (each editor window) auto-increments to the next free port.                                                                                                                                                                                                                                                                   |

## Remote Access

With `ZCODE_ACP_REMOTE=1` the bridge additionally accepts ACP connections over
WebSocket, so a phone or browser can watch and drive the **same sessions** as
your editor. Zed (or any ACP editor over stdio) remains the primary client and
owns the process: when the editor disconnects, the bridge — and every remote
attachment — exits with it.

```text
phone / browser ──WS── tunnel ── hub (127.0.0.1:8377, single entry)
                                   │ byte-level proxy
                                   ▼
                     bridge ACP endpoint (127.0.0.1:8378+n)
                                   │ same AgentApp as stdio
Zed ──────── stdio ────────────────┘
```

Enable it per-agent in Zed's settings (Zed merges these into the agent's
environment):

```json
"agents": {
  "ZCode": {
    "command": "zcode-acp-server",
    "env": {
      "ZCODE_ACP_REMOTE": "1",
      "ZCODE_ACP_REMOTE_TOKEN": "<a-long-random-secret>"
    }
  }
}
```

**Hub.** The first bridge with remote enabled spawns `zcode-acp-hub` as a
detached, machine-level singleton on `ZCODE_ACP_HUB_PORT` (it can also be run
manually). It does three things only: token auth, instance discovery, and
byte-level proxying (ACP WebSocket plus read-only session files) — no session
state, no path semantics. It exits after ~10 idle minutes and is re-spawned
on demand. Each bridge registers every 10s as a heartbeat and drops out of
discovery ~30s after it stops.

**Discovery API** (for client authors; fields are additive-only):

```text
GET /api/instances              → [{"id","port","pid","startedAt","workspace",
                                    "sessions":[{"sessionId","title?","updatedAt"}]}]
GET /api/instances?probe=1      → same list, but unreachable bridges are pruned first
WS   /acp?instance=<id>         → proxied to that bridge's endpoint
GET /api/instances/{id}/fs/…    → read-only session files (list + raw bytes, ADR-0004)
```

`sessions` lists the project's **currently running** conversations (live
editor tabs and remote attachments) under the same ACP session ids the
editor uses — attaching by id joins the conversation's live notification
stream, and the hub dedupes sessions shared by several bridges of the same
project.

Auth is `Authorization: Bearer <token>` or `?token=` (browsers cannot set WS
headers); `/api/*` sends `Access-Control-Allow-Origin: *` — the token is the
security boundary. A proxied connection stays bound to one instance; switching
instances means reconnecting. Remote clients can also pull plan quota via the
non-standard `account/usage_stats` ACP method (no session required), and
browse/download the files of a session's project through the `/fs` routes
above. During replay, compaction summaries and rewritten tool calls arrive as
collapsed `tool_call` updates instead of walls of text
(`docs/REPLAY-GUIDE.md`).

Building a remote client — web, mobile, or CLI? The full integration contract
(endpoints, framing, lifecycle timings, failure recovery, platform notes)
lives in [docs/REMOTE-CLIENTS.md](docs/REMOTE-CLIENTS.md).

**Semantics.** All agent notifications are broadcast to every client.
Permission / elicitation requests go to every client and the **first answer
wins**; losing clients receive `$/cancel_request` so their dialogs close.
Concurrent prompts for one session are serialized exactly as they are for a
single editor. Capabilities declared by any client are OR-merged.

**Tunnels.** Designed for one-port tunnels (Cloudflare Tunnel, frp): map the
hub port only. frp's `tcp` mode passes WebSocket as-is; Cloudflare Tunnel
drops idle WebSocket connections, so the hub sends 30s keepalive pings on both
legs. The bridge endpoint itself is loopback-only and never exposed.

**Binding beyond loopback.** The hub speaks plain HTTP/WS — the token travels
and authorizes in cleartext, so `ZCODE_ACP_HUB_HOST=0.0.0.0` (needed only when
the tunnel agent runs in its own container) is exactly as safe as the network
it lands on. Keep the bind loopback unless that interface is private to the
tunnel agent, and put TLS in front before mapping it anywhere untrusted.

## Standalone Quota CLI

Besides the ACP server, the package ships a `zcode-quota` bin that queries
your usage **from the terminal** — no editor or running server needed. By
default it shows both **GLM Coding Plan** and **Opencode Go** in one card;
pass a provider to focus on one.

GLM credentials are read from `~/.zcode/v2/config.json`. Opencode Go
credentials come from environment variables (the dashboard needs a browser
cookie — see [Opencode Go setup](#opencode-go-setup) below).

```bash
# Both providers (default): GLM + Opencode Go in one card
zcode-quota

# Focus on one provider
zcode-quota glm            # GLM Coding Plan only
zcode-quota go             # Opencode Go only (rolling + weekly + monthly)

# Live monitor: clear the screen and refresh every 30s (default)
zcode-quota -w
zcode-quota go -w          # watch Opencode Go only

# Refresh at a custom interval (seconds; minimum 10)
zcode-quota --watch --interval 60

# Plain monochrome bars (color is the default on a terminal)
zcode-quota --plain
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
node dist/bin/quota.js -w
```

### Opencode Go setup

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
(no error). Running `zcode-quota go` without credentials prints a setup hint.

## ACP Registry

This server is compatible with the [ACP Registry](https://agentclientprotocol.com/get-started/registry). It advertises a single `agent`-type auth method at `initialize` time — the GLM API key is read from `~/.zcode/v2/config.json` by the ZCode backend, so **no editor-side credentials are required**.

The registry submission assets live under [`registry/zcode-acp-server/`](registry/zcode-acp-server/) (`agent.json` + `icon.svg`). Once the package is published to npm, copy that directory into a fork of [`agentclientprotocol/registry`](https://github.com/agentclientprotocol/registry) and open a PR — the CI validates the `agent.json` schema, icon, and that `initialize` returns a non-empty `authMethods`.

## Develop

```bash
pnpm install
pnpm build       # tsc → dist/
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint (warnings advisory; errors fail CI)
pnpm test        # vitest
pnpm format      # prettier on src/
```

CI runs `typecheck`, `lint`, `build`, and `test` on every push and pull
request — run them locally before pushing (see [CONTRIBUTING.md](CONTRIBUTING.md)).

> **Tip (Node version)**: this repo pins Node 22 via a root `.node-version`
> file. Pair it with [fnm](https://github.com/Schniz/fnm) or
> [nvm](https://github.com/nvm-sh/nvm) to auto-switch on `cd`. pnpm itself is
> managed by your local environment (corepack).

## Architecture

The server is organised in layers that mirror the ACP protocol:

- `backend/` — ZCode subprocess client: spawn, reader-loop multiplexer, event-stream listener, sync request/response
- `translators/` — turn ZCode events into ACP `session/update` notifications (event streaming + snapshot diff)
- `interaction/` — bridge ZCode `interaction/*` server requests to ACP, preferring `elicitation/create` and falling back to `session/request_permission` (tool auth, ExitPlanMode, AskUserQuestion)
- `handlers/` — ACP method handlers (`session/new`, `session/prompt`, ...) and the turn engine
- `config/` — model / mode / thought-level configOptions and runtime model switching
- `remote/` — opt-in remote access: loopback ACP endpoint, multi-client broadcast, `zcode-acp-hub` registration
- `quota/` — GLM Coding Plan / Opencode Go usage API client (`/quota` command, `zcode-quota` bin)
- `server.ts` — shared state and handler registration
- `index.ts` — stdio wiring via the ACP SDK

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture documentation.

## Version Compatibility

| ZCode CLI version |   Support    | Notes                                                                                                                                                                                                 |
| :---------------: | :----------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   **>= 0.16.0**   |     Full     | Steer/rewind removed upstream (moved to the v4 conversation API); bridge dropped the `session/steer`, `session/rewind`, `session/rewindCascade` extensions and the `/steer`, `/rewind` slash commands |
|   **>= 0.15.0**   |     Full     | All extension methods available                                                                                                                                                                       |
|   **>= 0.14.8**   |     Full     | Event-stream push, all extension methods                                                                                                                                                              |
|   **< 0.14.8**    | Incompatible | Event-stream subscription unavailable                                                                                                                                                                 |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — event stream, dual-path deduplication, module responsibilities
- [Protocol](docs/PROTOCOL.md) — ZCode JSON-RPC protocol details
- [Remote Clients](docs/REMOTE-CLIENTS.md) — remote access integration contract (discovery, transport, recovery)
- [Replay Guide](docs/REPLAY-GUIDE.md) — building a client UI on tail replay
- [Development](docs/DEVELOPMENT.md) — local development, debugging, adding extension methods
- [Troubleshooting](docs/TROUBLESHOOTING.md) — common-issue troubleshooting

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
code style, commit conventions, and the PR checklist. Notable changes are
recorded in [CHANGELOG.md](CHANGELOG.md).

## Related Projects

- [zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge) — a community Python implementation that bridges ZCode to the MCP/ACP ecosystem. The design of this server references its bridge architecture and several handling strategies.

## Acknowledgements

- [Agent Client Protocol](https://agentclientprotocol.com/) (Apache-2.0) — the ACP specification
- [ZCode](https://zcode.z.ai) / [Zhipu Z.AI](https://z.ai) — the GLM model and ZCode CLI
- [zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge) — reference implementation that informed this server's design

## Privacy

**No telemetry or tracking** — the server reports nothing to anyone. The only
runtime dependency beyond the ACP SDK is `zod`.

Your prompts, code, and file contents are relayed between the editor and the
ZCode backend over **local pipes**; that data reaches the GLM cloud API only
because the ZCode backend itself sends it there for inference — this server
adds no extra destinations.

| Concern     | What & why                                                                                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network     | Only one outbound request in the whole codebase: the quota GET (`open.bigmodel.cn` / `api.z.ai`), carrying just your API key — needed to fetch your usage numbers, sends no user content                                          |
| Credentials | API key read from `~/.zcode/v2/config.json` to authenticate the ZCode subprocess and quota request. Never logged, never written elsewhere. OAuth handled entirely by the ZCode subprocess                                         |
| Disk        | No new files created. Writes only to the existing `~/.zcode/v2/tasks-index.sqlite` — this **syncs sessions to the ZCode app** so they appear in its history list and full-text search (stores the session title and first prompt) |
| Logging     | Diagnostics to stderr for troubleshooting bridge issues. Even with `ZCODE_ACP_DEBUG=1`, no prompts/code/keys are ever logged                                                                                                      |

## License

Apache-2.0. This project follows the same license as the upstream ACP specification.

## Disclaimer

This is an independent community project and is not affiliated with, endorsed
by, or sponsored by Zhipu Z.AI. ZCode is a product of Zhipu Z.AI.
