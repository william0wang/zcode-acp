# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-08-17

### Fixed

- Remote discovery no longer lists never-used sessions: an editor restart
  auto-resumes its stored placeholder, materializing an empty backend session
  that was pushed to the hub and opened empty on remote clients. Sessions now
  appear in `/api/instances` only after real interaction (a prompt turn, a
  load with replayable history, or an adopted stored title).
- `session/load` no longer skips the backend resume RPC for a session whose id
  mapping exists but was never loaded into the current backend subprocess
  (re-registered from the durable store, or left behind by a failed resume).
  The backend only serves messages for loaded sessions, so the replay came
  back empty — an older conversation opened blank on a remote client while
  other sessions worked. Liveness is now tracked explicitly
  (`backendLoadedSessions`), and `session/messages` errors are logged instead
  of silently replaying nothing.

## [0.3.0] - 2026-08-17

### Added

- Remote access (opt-in via `ZCODE_ACP_REMOTE=1`): the bridge serves the same
  `AgentApp` on a loopback WebSocket endpoint alongside stdio. A multi-client
  broadcast registry fans notifications out to every attached client; requests
  are first-response-wins with loser cancellation. The bridge's lifetime still
  follows the stdio editor (ADR-0001).
- `zcode-acp-hub` daemon: machine-level singleton providing token auth,
  instance discovery, and byte-level WebSocket proxying — no session state,
  no ACP semantics (ADR-0002). Bridges register every 10s as a heartbeat;
  entries prune after a 30s heartbeat TTL or immediately on
  `GET /api/instances?probe=1` (on-demand liveness). The hub idle-exits after
  10 minutes and is re-spawned on demand; a version handshake restarts a stale
  hub when a newer bridge registers.
- Tail replay: `session/load` accepts `_meta.zcode.limit` and returns
  `replayMeta`; `session/load_earlier` pages backwards with an opaque cursor
  (Proposal 0001 / ADR-0003). Client UI guide: `docs/REPLAY-GUIDE.md`.
- `account/usage_stats` non-standard ACP method exposing plan quota
  (GLM Coding Plan + Opencode Go) to remote clients; failures degrade
  gracefully so clients can hide the quota UI (Proposal 0002).
- Remote client integration contract: `docs/REMOTE-CLIENTS.md`.

### Fixed

- Slash-leading prompts that are not advertised commands (e.g. `/Users/me`)
  are neutralized and sent as plain text instead of hard-failing the backend
  turn and wedging the session.
- Replayed user messages strip harness `<system-reminder>` blocks (and drop
  reminder-only messages), so clients never render them as user input.
- Stored session titles are adopted on load/resume so hub discovery lists the
  backend's titles.

## [0.2.0] - 2026-08-16

### Added

- Auto-compact (`src/config/auto-compact.ts`): when context usage exceeds the
  `ZCODE_ACP_AUTO_COMPACT_THRESHOLD` env var (absolute token count, e.g.
  `240000`), the server automatically invokes `session/compact` after each
  successful `end_turn` to free up context before the next prompt. Disabled by
  default (0/unset). Best-effort — failures are logged but never break the
  prompt response.
- Process watchdog (`backend/client.ts`): a detached child polls the bridge
  pid every 2s and SIGKILLs the zcode process group if the bridge disappears
  without running its signal handlers (Zed force-kill on reconnect, crash,
  OOM). Closes the orphan-zcode gap that `close()` cannot cover on SIGKILL.
- Per-command `input.hint` on `available_commands_update`, so editors can
  pre-fill the slash command input. Skills with an `argument-hint` frontmatter
  are hinted too.
- `server.lastMode` map recording the mode value advertised to the client,
  used by the new mode reconciliation.
- `.node-version` pinning node 22 for fnm.
- ACP Registry compatibility: `initialize` now advertises an agent-type
  `authMethods` entry (`zcode-credentials`) declaring that the bridge reads
  the GLM API key itself from `~/.zcode/v2/config.json` — no editor-side
  credentials are required. The registry CI rejects empty `authMethods`, so
  this is required for submission. Submission assets live under
  `registry/zcode-acp-server/` (`agent.json` + `icon.svg`).
- ZCode extension resources exposed to the editor: skills, init/plugin
  commands, and friendly errors for TUI-only commands (#18).
- Sub-agent and background-task events are synced to the ACP client;
  background Bash tasks render as badge-labelled launch cards (#21, #23).
- TODO/plan updates are pushed on tool completion instead of waiting for the
  turn to end (#20).
- Drag-and-drop attachments (text files and images) are forwarded to the
  backend as `session/send` attachments, including binary drops (#24, #26,
  #39).
- Custom third-party model providers: the provider registry from
  `~/.zcode/v2/config.json` is pushed to the backend, and model switching
  routes per-provider credentials (#27).
- Elicitation forms revamped for free-text input (#30).
- `/quota` slash command plus the standalone `zcode-quota` CLI (watch mode,
  heat-colored progress bars) for GLM Coding Plan usage (#10, #13, #40).

### Fixed

- `/mode` and `/thought` slash commands now emit `current_mode_update` and
  `config_option_update`. Previously they switched the backend mode but never
  notified the editor UI, because slash commands return `end_turn` and bypass
  the turn-completion reconciliation. `/model` UI state syncs after a switch
  too, and `/goal` routes through the extensions path (#36).
- In-turn `EnterPlanMode`/`ExitPlanMode` now trigger mode reconciliation at
  turn completion (`emitModeIfChanged`), since they bypass `session/setMode`
  (#31, #32).
- `session/new` no longer hangs ~15s against ZCode CLI ≥ 0.16: the bridge
  auto-replies to the new `session/requestRuntimePreferences` request during
  `session/create` (#38, closes #41). ACP session creation is also lazy —
  `session/new` returns immediately and the backend session materialises on
  first use — and `session/resume` retries absorb the backend cold-start
  window (#28, #29, #38).
- Cancel-then-send hang: after a stop (or a new prompt preempting one), the
  next `session/send` retries while the backend still reports "prompt is
  running", using the backend's prompt lock as the single readiness signal,
  instead of failing immediately or blocking on bridge-side guesses (#48).
- Cross-turn event contamination: a new prompt no longer consumes the previous
  turn's leftover events (including its `turn.completed`); events observed
  before the new turn's own `turn.started` are gated, and content produced
  while no listener was attached is replayed at turn completion (deduplicated
  per backend message id) (#48).
- Server-request abort storm: interaction racers now tear down their
  timers/listeners once settled, and requests arriving after a cancel are
  declined inline instead of looping forward→abort→re-emit (#48).
- Stop semantics: events the backend produces after a stop that didn't take
  effect are still displayed (the backend is the source of truth within a
  session) rather than silently drained (#37, #48).
- Thought-level vocabulary root cause: the provider registry and the
  `runtimeModel` overlay carry full model definitions (reasoning variants →
  `levels`/`defaultLevel`, context window, label), restoring the real
  max/high/low dropdown on materialised sessions and across resume/switch —
  previously the backend fell back to the apiFormat's 2-state
  enabled/disabled (#48). Pending sessions derive their current model and
  thought level from the enabled provider (#47).
- The spec-spelled `session/set_mode` request is routed alongside the
  camelCase form (#46).
- Client-provided `mcpServers` (ACP `session/new`/resume) are forwarded to the
  backend's session create/resume (#43).
- Server→client requests (permission, elicitation) are routed by sessionId,
  preventing cross-session popup leaks (#12); popups abort cleanly on turn
  cancel or timeout and wait for the user instead of auto-declining (#22,
  #35).
- Transient `turn.failed` responses are retried and degrade gracefully (#33).
- Bash terminal output sends only the stdout delta, preventing replay (#14,
  #15); tasks-index rows and the 3.3.0 protocol stay in sync with the ZCode
  App, and slash-command pushes harden against transient failures (#11, #25).

### Changed

- `SLASH_COMMANDS` rewritten: command names dropped the `/` prefix,
  descriptions reworded.
- `package.json` no longer declares `packageManager`; pnpm is managed via the
  local environment (corepack/fnm).
- Removed the empty `agentCapabilities.auth: {}` from the `initialize`
  response; the auth story is now carried by the new `authMethods` entry.
- Default model fallbacks updated to GLM-5.3 and extracted into shared
  constants; new prompts preempt an in-flight turn without waiting for the old
  turn's loop to exit.

## [0.1.0] - 2026-07-04

Initial release: a standalone TypeScript ACP server bridging the headless
ZCode app-server to ACP-compatible editors (Zed, JetBrains).

### Added

- ZCode subprocess client with reader-loop multiplexing and process-group
  isolation.
- Event-stream listener (`session/subscribe` + `session/event`).
- Event translators + projection differ with dual-path deduplication.
- Bash terminal protocol (2-notification split: `terminal_output` +
  `terminal_exit`).
- Interaction adapter: `requestPermission`, `ExitPlanMode`, `AskUserQuestion`
  — preferring `elicitation/create` (form mode) when the client declares
  `clientCapabilities.elicitation.form`, falling back to per-question
  `session/request_permission`.
- Session lifecycle + extensions: `fork`, `rewind`, `rewindCascade`, `goal`,
  `compact`, `steer`, `cancelBackgroundTask`, `setMode`, `setModel`,
  `setThoughtLevel`, `updateRuntimeModelConfig`.
- Slash command interception (`/compact`, `/goal`, `/fork`, `/rewind`,
  `/steer`, `/model`, `/mode`, `/thought`).
- `configOptions` + runtime model overlay (resumes use the active provider's
  OAuth creds).
- tasks-index sqlite sync (Node ≥ 22 `node:sqlite`, best-effort).
- Slash commands advertised 50ms after the session response so the client
  state machine is ready (`sendAvailableCommandsDeferred`).
- Interaction request timeout (600s) with turn-cancel polling — a user
  pressing stop during a popup no longer waits for the full client-response
  window.
- Initial `usage_update` on `session/resume` and `session/load`.
- ESLint + `lint` script, `typecheck` script, GitHub Actions CI.
- `CONTRIBUTING.md`, `CHANGELOG.md`, full `docs/` (Architecture, Protocol,
  Development, Troubleshooting).

### Fixed

- `buildSnapshot` flattens `todoGroups` as a **list** (it was read as a single
  object); the plan list is no longer empty on `session/load` and
  `PlanUpdate` is correctly emitted at turn completion.
- Cached reannounce replies use `sendReply` (`{id, result}`) instead of
  `notify` (`{method, params}`).
- Shutdown triggers on stdin-close and backend-death (no orphan processes).
- `thought` configOption metadata: category `thought_level`, lowercase options.
- `set_config_option` returns the full `configOptions` array.
- Usage fallback uses `contextUsed || totalTokenCount || 0` (not `??`).
- `pollEvent` no longer delivers events to settled (zombie) waiters.
- Async backend `close()` correctly reaps the process group.
- Turn completion runs `differ.diff()` to emit `PlanUpdate`.
- `Edit`/`Write` structured diffs are dispatched immediately.
- Stable plan signatures (sorted keys) prevent spurious `PlanUpdate`.

### Changed

- `engines.node` is `>=22.0.0` (the bridge requires `node:sqlite`).
- `package.json` declares `files`, `repository`, `keywords`, `types`,
  `packageManager`.
- Deferred command notifications and the cancel poll use `unref()` timers so
  they cannot keep the event loop alive.
