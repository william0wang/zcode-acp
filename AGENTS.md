# Agent Instructions

## Project overview

**zcode-acp-server** — a Node.js bridge that connects the ZCode agent backend
(`zcode app-server --stdio`) to any ACP-compatible editor (Zed, JetBrains, …)
via JSON-RPC over stdio. Translates ACP protocol requests into ZCode session
methods and streams events back as ACP `session/update` notifications.

## Commands

| Task                        | Command                               |
| --------------------------- | ------------------------------------- |
| Build                       | `pnpm build`                          |
| Typecheck                   | `pnpm typecheck`                      |
| Test (all)                  | `pnpm test`                           |
| Test (single file)          | `npx vitest run tests/<file>.test.ts` |
| Lint                        | `pnpm lint`                           |
| Format (changed files only) | `pnpm prettier --write <path>`        |
| Smoke test                  | `pnpm smoke`                          |

**Package manager**: pnpm. **Node**: >=22. **Module system**: ESM (`"type": "module"`).

## Architecture

```
src/
├── index.ts              Entry point — wires server to stdio ACP stream
├── server.ts             ZcodeAcpServer — shared state + handler registration
├── backend/              ZCode subprocess client (JSON-RPC over stdio)
│   ├── client.ts         Spawns + communicates with zcode app-server
│   ├── credentials.ts    Reads ~/.zcode/v2/config.json for GLM API key
│   ├── listener.ts       EventStreamListener — subscribes to session/events
│   └── types.ts          ZCode protocol types
├── handlers/             ACP method handlers
│   ├── session.ts        session/new, session/prompt (turn loop), load, resume
│   ├── slash.ts          Slash-command interception (/compact, /mcp, etc.)
│   ├── account.ts        account/usage_stats — plan quota for remote clients
│   ├── extensions.ts     ZCode extensions (fork, compact, goal, model, mode, …)
│   ├── dispatch.ts       InternalEvent → ACP session/update dispatch
│   ├── replay.ts         Tail replay: load limit, load_earlier pagination
│   ├── io.ts             Client notification helpers
│   └── server-requests.ts  Server→client requests (permission, elicitation)
├── config/               Discovery + runtime config
│   ├── plugin-commands.ts  Load plugin commands from ~/.zcode/cli/
│   ├── skill-discovery.ts  Discover Skills from filesystem
│   ├── mcp-discovery.ts    Discover MCP servers from config + plugins
│   ├── auto-compact.ts     Threshold-based auto-compaction
│   ├── options.ts          Config options (model/mode/thought dropdowns)
│   └── runtime-model.ts    Model switching overlay
├── translators/          ZCode event → ACP translation
│   ├── event-translator.ts  Stream event → InternalEvent
│   ├── projection-differ.ts  Snapshot diff for turn-completion reconciliation
│   └── tool-helpers.ts       Diff builder, location extractor
├── interaction/          Permission, ExitPlanMode, AskUserQuestion handling
├── remote/               Remote access (opt-in via ZCODE_ACP_REMOTE=1)
│   ├── broadcast.ts      ClientRegistry + broadcast proxy (notify fan-out, request first-wins)
│   ├── config.ts         ENV parsing (gate, mandatory token, hub/bridge ports)
│   ├── endpoint.ts       Loopback ACP endpoint + hub registration heartbeat
│   ├── file-endpoint.ts  Read-only /fs/list + /fs/file, session-root scoped (ADR-0004)
│   └── hub-server.ts     Hub daemon: auth, discovery, byte-level proxy (ACP WS + /fs files), ?probe=1 liveness
├── quota/                GLM Coding Plan usage API client (/quota command)
├── cli.ts                Unified CLI entry (`zcode-acp`): subcommand dispatch
│                         (bare invocation → REPL) (ADR-0007)
├── repl/                 Interactive REPL (bare `zcode-acp`): Ink UI + ACP client
│   ├── model.ts          Pure turn state machine + idle status fold (commands,
│   │                     model/mode/thought selects, completion candidates,
│   │                     editor wrap/caret math, local /help & listings)
│   ├── App.tsx           Ink components — native-scrollback transcript
│   │                     (<Static>, Claude Code model) + compact dynamic
│   │                     footer (live-turn tail, queue panel, permission/
│   │                     question/session pickers, completion menu, wrapped
│   │                     input box). No alternate screen, no wheel capture.
│   ├── input-buffer.ts   Pure caret-editing line editor (code-point caret,
│   │                     Ctrl-B/F/A/E/U chords) — no React, testable
│   └── run.ts            Orchestration: spawn bridge, pump updates
└── bin/
    ├── hub.ts            Hub daemon entry (`zcode-acp hub`; spawned by absolute path)
    └── quota.ts          Quota cards entry (`zcode-acp quota`)
```

**Key boundary**: `backend/` talks to the ZCode subprocess. `handlers/` talks to
the ACP client (editor). `translators/` bridges the two event models. Never mix
ZCode protocol types into ACP notifications directly — always translate.

## Conventions

- **Logging**: use `log()` / `warn()` from `src/utils.ts`. Both write to stderr.
  **Never use `console.log`** — stdout is the ACP JSON-RPC stream and any stray
  output corrupts the protocol.
- **Debug logs**: `log()` is gated behind `ZCODE_ACP_DEBUG=1`. Use it for
  verbose diagnostics. `warn()` is always emitted.
- **Formatting**: double quotes, semicolons, trailing commas, 100 char width.
- **Imports**: use `.js` extensions in relative imports (NodeNext resolution).
  Sort imports alphabetically (ESLint `sort-imports` rule).
- **Error handling**: best-effort in event handlers — failures are logged via
  `warn()`, never thrown into the event loop (would crash the bridge).
- **Tests**: mock `node:fs` with `vi.mock` and Map/Set-based fake filesystem.
  See `tests/plugin-commands.test.ts` for the pattern.

## Gotchas

- **ZCode backend version drift**: the backend may change event payloads between
  releases. When diff display or event handling breaks, check the raw backend
  event with `ZCODE_ACP_DEBUG=1` before changing translator code.
- **`session/prompt` ordering**: subscribe to events BEFORE calling `session/send`
  — short turns can complete before a late subscribe catches them.
- **Preempt lock**: concurrent prompts for the same session are serialized via
  `withPreemptLock`. Don't bypass it — two simultaneous turns corrupt the listener.
- **AGENTS.md is workspace-scoped**: the global `~/.zcode/AGENTS.md` also exists;
  this file takes precedence for this repo.
- **WS proxy frame type**: the SDK's WS server drops non-text frames, and
  `ws.send(buffer)` defaults to a BINARY frame. The hub proxy must forward with
  `{ binary: isBinary }` — losing the flag silently eats every proxied message.
- **Broadcast loser promises settle late**: after first-response-wins, aborted
  loser requests resolve/reject only when the peer answers the cancellation.
  Every raced promise needs a no-op `.catch` or Node crashes on
  unhandledRejection. See `src/remote/broadcast.ts`.
- **Remote failures never touch stdio**: any remote-side failure (port, hub,
  token) must warn and disable remote only — the editor link stays up.
- **REPL renders via native scrollback**: completed entries go through ink
  `<Static>` once and belong to the terminal (scroll/selection/search all
  native; history survives exit). Only the dynamic footer rerenders. Do NOT
  reintroduce alt-screen viewports, wheel capture, or in-app scroll offsets —
  that model was removed for being unfixably fragile.
- **Height estimates ≠ ink layout**: ink wraps `<Text>` at word boundaries;
  `estimateLines()` hard-cuts at column width. Never trust the numbers alone —
  dynamic blocks (live-turn tail, queue panel) are contained by bottom-anchored
  `overflow:hidden` boxes sized to the estimate so drift crops invisibly
  inside instead of stretching the footer past the fold.
- **REPL render state lives in run.ts, not React**: App re-renders from fresh
  snapshots; anything that must persist across them (prompt-line editor,
  queue, entries) belongs to run.ts's external store passed via snapshot props.

## Docs to read before sensitive changes

- `docs/ARCHITECTURE.md` — full architecture writeup
- `docs/PROTOCOL.md` — ACP + ZCode protocol mapping
- `docs/DEVELOPMENT.md` — dev setup and debugging guide
- `docs/TROUBLESHOOTING.md` — common issues and diagnostics

## Agent skills

### Issue tracker

GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (`CONTEXT.md` + `docs/adr/`). See `docs/agents/domain.md`.
