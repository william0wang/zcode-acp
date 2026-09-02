# zcode-acp-server

[![CI](https://github.com/william0wang/zcode-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/william0wang/zcode-acp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

English | **[简体中文](README.zh-CN.md)**

A standalone [Agent Client Protocol](https://agentclientprotocol.com/) (ACP) server that bridges the headless **ZCode** app-server to ACP-compatible editors such as [Zed](https://zed.dev) and JetBrains IDEs.

The server launches the ZCode headless app-server (`zcode app-server --stdio`) as a subprocess, translates its internal event stream into ACP `session/update` notifications, and bridges ZCode's interaction channel to ACP — preferring `elicitation/create` when the client supports it, and falling back to `session/request_permission` otherwise — so an editor gets a first-class, native coding-agent experience.

## Why zcode-acp

- **Native editor experience** — streaming diffs, permission prompts and plan mode in Zed / JetBrains' own agent panel. No side-by-side terminal.
- **The official harness, not a reimplementation** — drives the real `zcode app-server`: native tools, skills, MCP and slash commands, auto-compaction, session resume/fork.
- **Beyond the editor** — a full bilingual terminal REPL (`zcode-acp`, English/中文, works over SSH), phone/web access to the same sessions (`zcode-acp-remote`), opt-in writes-only sandbox. Credentials stay in `~/.zcode`.

Because it drives the real ZCode client, your GLM Coding Plan comes along untouched — current perks (the 150% quota bonus, priority routing over raw API) and the plan's flat-rate economics apply exactly as in the official app. No API keys in editor settings.

## Status

In active development. Core bridging, slash commands and ZCode extensions,
auto-compaction, remote access for mobile/web clients, and the quota APIs are
in place; see the project board for what's next.

## Requirements

- **Node.js ≥ 22** (the bridge uses `node:sqlite` for tasks-index sync; the
  ZCode CLI runtime also requires Node ≥ 22)
- The ZCode CLI: auto-discovered from the desktop app bundle, or on `PATH`,
  or pointed at via `ZCODE_BIN` (see below)
- ZCode credentials at `~/.zcode/v2/config.json` (created by the ZCode app)

## Install

```bash
npm install -g zcode-acp-server
```

This installs both bins: `zcode-acp-server` (what your editor launches) and
`zcode-acp` (the unified CLI). Configure your ACP client to launch it — see
**Configure Zed** below or your editor's ACP docs.

<details>
<summary>Install from source instead</summary>

```bash
git clone https://github.com/william0wang/zcode-acp.git
cd zcode-acp-server
pnpm install
pnpm build
```

The compiled entry point is `dist/index.js` (also exposed as the
`zcode-acp-server` bin).

</details>

## Configure Zed

Add the server to Zed as a custom agent server. In `~/.config/zed/settings.json`
(`%APPDATA%\Zed\settings.json` on Windows):

```jsonc
{
  "agent_servers": {
    "ZCode": {
      "type": "custom",
      "command": "zcode-acp-server",
      "env": {
        // Only needed for custom installs — the CLI is auto-discovered from
        // the desktop app bundle or PATH (see the table below).
        "ZCODE_BIN": "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      },
    },
  },
}
```

Running from source instead? Use `"command": "node"` with
`"args": ["/absolute/path/to/zcode-acp-server/dist/index.js"]`.

Restart Zed and pick **ZCode** from the agent dropdown.

### `ZCODE_BIN` per platform

The CLI is resolved in this order: `ZCODE_BIN` → a `zcode` found on `PATH` →
the `zcode.cjs` bundled inside the ZCode desktop app (the app does not add it
to `PATH`). The auto-discovery covers the standard install locations below, so
most setups need no `ZCODE_BIN` at all — set it only for custom installs:

| Platform    | bundled `zcode.cjs` path                                                    |
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

| Variable                           | Default             | Purpose                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZCODE_BIN`                        | _(auto-discovered)_ | Path to the ZCode CLI binary or its `.cjs` entry. Resolution order: this variable → `zcode` on `PATH` → the desktop-app bundle                                                                                                                                                                                                                                                               |
| `ZCODE_NODE`                       | _(discovered)_      | Explicit Node binary to run `ZCODE_BIN` with (must support `node:sqlite`)                                                                                                                                                                                                                                                                                                                    |
| `ZCODE_MODEL`                      | _(from config)_     | Override the active model id                                                                                                                                                                                                                                                                                                                                                                 |
| `ZCODE_BASE_URL`                   | _(from config)_     | Override the provider base URL                                                                                                                                                                                                                                                                                                                                                               |
| `ZCODE_ACP_AUTO_COMPACT_THRESHOLD` | _(unset)_           | Absolute token count that triggers automatic context compaction. After each successful turn (`end_turn`), if `contextUsed >= threshold`, the server invokes `session/compact` to free up context before the next prompt. Set to `0` or leave unset to disable (default). Example: `240000` triggers compaction at 240K tokens. The compaction target itself is decided by the ZCode backend. |
| `ZCODE_ACP_DEBUG`                  | _(unset)_           | Set to `1` to enable verbose diagnostic logs (event flow, probe loops, status updates). Default is quiet — only warnings (backend pipe errors, command/permission failures, lock timeouts) are emitted. Enable this when diagnosing bridge issues; the logs appear in `Zed.log` prefixed with `[zcode-acp]`.                                                                                 |
| `ZCODE_ACP_REMOTE`                 | _(unset)_           | Set to `1` to enable [remote access](#remote-access) — serve the same sessions to additional ACP clients over WebSocket.                                                                                                                                                                                                                                                                     |
| `ZCODE_ACP_REMOTE_TOKEN`           | _(unset)_           | Auth token for remote access. **Mandatory** when `ZCODE_ACP_REMOTE=1`; remote stays disabled without it.                                                                                                                                                                                                                                                                                     |
| `ZCODE_ACP_HUB_PORT`               | `8377`              | Port of the machine-level hub daemon. Map exactly this one port in your tunnel.                                                                                                                                                                                                                                                                                                              |
| `ZCODE_ACP_HUB_HOST`               | `127.0.0.1`         | Hub bind address. `0.0.0.0` exposes a token-only, unencrypted surface — only for a containerized tunnel agent on a private interface (see [Remote Access](#remote-access)).                                                                                                                                                                                                                  |
| `ZCODE_ACP_REMOTE_PORT`            | `8378`              | First loopback port for the bridge's ACP endpoint. Each bridge (each editor window) auto-increments to the next free port.                                                                                                                                                                                                                                                                   |
| `ZCODE_ACP_SANDBOX`                | _(unset)_           | Set to `1` to confine the agent's file writes with a macOS Seatbelt sandbox globally; per-project, set `"enabled": true` in `<workspace>/.zcode/acp/sandbox.json` instead (see [Sandbox](#sandbox)).                                                                                                                                                                                         |
| `ZCODE_ACP_LANG`                   | _(inherited)_       | Language of the bridge's user-facing strings (popups, status/hint lines, command menu descriptions): `zh` or `en`. When unset, the bridge inherits the ZCode app's language (`localePreference`/`locale` in `~/.zcode/v2/setting.json`), then falls back to the `LC_ALL`/`LC_MESSAGES`/`LANG` locale, defaulting to English.                                                                 |

## Sandbox

Optional macOS Seatbelt confinement for everything the agent writes: dual
switch (`ZCODE_ACP_SANDBOX=1` globally, or `"enabled": true` in the
auto-created `<workspace>/.zcode/acp/sandbox.json` per project), allow/reject
popups for out-of-whitelist writes persisted visibly in that config, and
automatic backend restart + task continuation after an allow. Full manual:
[docs/SANDBOX.md](docs/SANDBOX.md).

## Remote Access

With `ZCODE_ACP_REMOTE=1` the bridge additionally serves the **same sessions**
over WebSocket through a machine-level hub daemon — a phone or browser can
watch, drive, and even create sessions in any known project while Zed stays
the primary client. Discovery API, tunnels, auth, and semantics:
[docs/REMOTE.md](docs/REMOTE.md); the client integration contract:
[docs/REMOTE-CLIENTS.md](docs/REMOTE-CLIENTS.md).

## Unified CLI (`zcode-acp`)

One command for every surface: an interactive terminal chat REPL with native
scrollback (`zcode-acp`), plan quota cards (`zcode-acp quota`, GLM + Opencode
Go), the remote hub daemon (`zcode-acp hub`), and the stdio server editors
invoke (`zcode-acp server`). REPL keys, completion, history, and quota setup:
[docs/CLI.md](docs/CLI.md).

## ACP Registry

This server is compatible with the [ACP Registry](https://agentclientprotocol.com/get-started/registry). It advertises a single `agent`-type auth method at `initialize` time — the GLM API key is read from `~/.zcode/v2/config.json` by the ZCode backend, so **no editor-side credentials are required**.

The registry submission assets live under [`registry/zcode-acp/`](registry/zcode-acp/) (`agent.json` + `icon.svg`). Once the package is published to npm, copy that directory into a fork of [`agentclientprotocol/registry`](https://github.com/agentclientprotocol/registry) and open a PR — the CI validates the `agent.json` schema, icon, and that `initialize` returns a non-empty `authMethods`.

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
- `remote/` — opt-in remote access: loopback ACP endpoint, multi-client broadcast, hub registration
- `quota/` — GLM Coding Plan / Opencode Go usage API client (`/quota` command, `zcode-acp quota` subcommand)
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
- [Sandbox](docs/SANDBOX.md) — full sandbox manual (switches, whitelist, popups, verification)
- [Remote Access](docs/REMOTE.md) — hub, discovery API, tunnels, remote session-create
- [Unified CLI](docs/CLI.md) — REPL, quota cards, hub/server subcommands
- [Remote Clients](docs/REMOTE-CLIENTS.md) — remote access integration contract (discovery, transport, recovery)
- [Replay Guide](docs/REPLAY-GUIDE.md) — building a client UI on tail replay
- [Development](docs/DEVELOPMENT.md) — local development, debugging, adding extension methods
- [Troubleshooting](docs/TROUBLESHOOTING.md) — common-issue troubleshooting

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
code style, commit conventions, and the PR checklist. Notable changes are
recorded in [CHANGELOG.md](CHANGELOG.md).

Thanks to everyone who has contributed (updated automatically from the
[contributors graph](https://github.com/william0wang/zcode-acp/graphs/contributors)):

<a href="https://github.com/william0wang/zcode-acp/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=william0wang/zcode-acp" alt="Contributors" />
</a>

## Related Projects

- [glm-acp-agent](https://github.com/stefandevo/glm-acp-agent) — a self-contained ACP agent that calls the GLM API directly; zcode-acp instead bridges the real `zcode app-server`, inheriting its full official harness.
- [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) / [codex-acp](https://github.com/agentclientprotocol/codex-acp) — official ACP adapters for the Claude and Codex CLIs; zcode-acp is the same idea for the ZCode CLI.
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
