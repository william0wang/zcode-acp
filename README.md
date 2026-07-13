# zcode-acp-server

[![CI](https://github.com/william0wang/zcode-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/william0wang/zcode-acp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

English | **[简体中文](README.zh-CN.md)**

A standalone [Agent Client Protocol](https://agentclientprotocol.com/) (ACP) server that bridges the headless **ZCode** app-server to ACP-compatible editors such as [Zed](https://zed.dev) and JetBrains IDEs.

The server launches the ZCode headless app-server (`zcode app-server --stdio`) as a subprocess, translates its internal event stream into ACP `session/update` notifications, and bridges ZCode's interaction channel to ACP — preferring `elicitation/create` when the client supports it, and falling back to `session/request_permission` otherwise — so an editor gets a first-class, native coding-agent experience.

## Status

Early in-development. Core scaffolding is in place; features are landing incrementally. See the project board for progress.

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

| Variable          | Default         | Purpose                                                                                                                                                                                                                                                                                                      |
| ----------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ZCODE_BIN`       | `zcode`         | Path to the ZCode CLI binary or its `.cjs` entry                                                                                                                                                                                                                                                             |
| `ZCODE_NODE`      | _(discovered)_  | Explicit Node binary to run `ZCODE_BIN` with (must support `node:sqlite`)                                                                                                                                                                                                                                    |
| `ZCODE_MODEL`     | _(from config)_ | Override the active model id                                                                                                                                                                                                                                                                                 |
| `ZCODE_BASE_URL`  | _(from config)_ | Override the provider base URL                                                                                                                                                                                                                                                                               |
| `ZCODE_ACP_AUTO_COMPACT_THRESHOLD` | _(unset)_ | Absolute token count that triggers automatic context compaction. After each successful turn (`end_turn`), if `contextUsed >= threshold`, the server invokes `session/compact` to free up context before the next prompt. Set to `0` or leave unset to disable (default). Example: `240000` triggers compaction at 240K tokens. The compaction target itself is decided by the ZCode backend. |
| `ZCODE_ACP_DEBUG` | _(unset)_       | Set to `1` to enable verbose diagnostic logs (event flow, probe loops, status updates). Default is quiet — only warnings (backend pipe errors, command/permission failures, lock timeouts) are emitted. Enable this when diagnosing bridge issues; the logs appear in `Zed.log` prefixed with `[zcode-acp]`. |

## Standalone Quota CLI

Besides the ACP server, the package ships a `zcode-quota` bin that queries
your GLM Coding Plan usage **from the terminal** — no editor or running server
needed. It reads the same `~/.zcode/v2/config.json` for credentials.

```bash
# One-shot: print the card and exit
zcode-quota

# Live monitor: clear the screen and refresh every 30s (default)
zcode-quota -w

# Refresh at a custom interval (seconds; minimum 10)
zcode-quota --watch --interval 60
```

The watch mode clears and redraws the card in place, like `top`/`htop`. Press
`Ctrl-C` to exit. The 10s minimum exists because the quota API is cached for
10s internally — a shorter interval would just keep returning the stale cached
value.

When the package isn't globally installed, run the built file directly:

```bash
node dist/bin/quota.js -w
```

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
- `server.ts` — shared state and handler registration
- `index.ts` — stdio wiring via the ACP SDK

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture documentation.

## Version Compatibility

| ZCode CLI version |   Support    | Notes                                    |
| :---------------: | :----------: | ---------------------------------------- |
|   **>= 0.15.0**   |     Full     | All extension methods available          |
|   **>= 0.14.8**   |     Full     | Event-stream push, all extension methods |
|   **< 0.14.8**    | Incompatible | Event-stream subscription unavailable    |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — event stream, dual-path deduplication, module responsibilities
- [Protocol](docs/PROTOCOL.md) — ZCode JSON-RPC protocol details
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

| Concern | What & why |
| ------- | ---------- |
| Network | Only one outbound request in the whole codebase: the quota GET (`open.bigmodel.cn` / `api.z.ai`), carrying just your API key — needed to fetch your usage numbers, sends no user content |
| Credentials | API key read from `~/.zcode/v2/config.json` to authenticate the ZCode subprocess and quota request. Never logged, never written elsewhere. OAuth handled entirely by the ZCode subprocess |
| Disk | No new files created. Writes only to the existing `~/.zcode/v2/tasks-index.sqlite` — this **syncs sessions to the ZCode app** so they appear in its history list and full-text search (stores the session title and first prompt) |
| Logging | Diagnostics to stderr for troubleshooting bridge issues. Even with `ZCODE_ACP_DEBUG=1`, no prompts/code/keys are ever logged |

## License

Apache-2.0. This project follows the same license as the upstream ACP specification.

## Disclaimer

This is an independent community project and is not affiliated with, endorsed
by, or sponsored by Zhipu Z.AI. ZCode is a product of Zhipu Z.AI.
