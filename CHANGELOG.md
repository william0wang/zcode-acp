# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.9] - 2026-08-24

### Added

- `POST /api/instances/{id}/sessions/{sessionId}/rename` (body `{"title"}`):
  renames a session from a remote client. The bridge pins the title
  (`title_overridden=1` in the App's tasks-index), updates discovery, and
  broadcasts `session_info_update` so attached editors update live. Proxied
  by the hub alongside the existing close route.

### Changed

- Session titles are now set exactly ONCE, from the first prompt, the moment
  it is sent — instead of on the first `end_turn`. A message interrupting the
  first turn can no longer steal the title (the preempted turn ended
  `cancelled` and never reached the title block). After the one-shot title, no
  automatic path revises a session title; a manual rename is the only later
  modifier. `updateSessionTitle` no longer writes the auto title into
  `meta_json.title` of a user-renamed row (the App may read either field, and
  the write could visually revert the user's rename).

## [0.11.8] - 2026-08-23

### Added

- `?dl=1` on the file byte path switches `Content-Disposition` from `inline`
  to `attachment`, so WebViews that implement a DownloadListener (the Android
  app routes these into the system DownloadManager) download instead of
  navigating to the file.

## [0.11.7] - 2026-08-23

### Added

- `POST /api/upgrade`: a remote client can trigger the hub's own staleness
  check; the hub restarts onto the on-disk code only when it judges that code
  newer than itself (a newer `package.json` version frozen-at-start
  comparison, or any `dist/**/*.js` mtime later than process start — so a
  rebuild without a version bump counts). The client never decides the
  restart. The daemon re-spawns itself from disk before exiting; bridges
  re-register on their next heartbeat, and a respawned hub starts after the
  newest dist mtime so the check cannot loop.

## [0.11.6] - 2026-08-23

### Added

- Remote file downloads carry a `Content-Disposition` filename: the byte
  path's URL basename is always "file" (the real name lives in a query
  param), so browser direct-downloads saved nameless. Responses now send
  `inline; filename="…"; filename*=UTF-8''…` (RFC 6266/5987 — non-ASCII
  names survive via the `filename*` form, the ASCII fallback degrades to
  underscores). Line windows (viewer-internal partial views) stay unnamed.

## [0.11.5] - 2026-08-22

### Fixed

- `session/load` always replays the current todo list: the shared
  per-session differ only fires PlanUpdate on plan CHANGE, so a re-attaching
  client (the mobile app always re-attaches) never learned a plan a previous
  client had already seen. The load path now runs a throwaway differ whose
  "__none__" sentinel makes diffPlan always emit, while the shared differ's
  full diff still runs for its mark-seen side effect (turn completion must
  not re-emit replayed history).
- Regression test in `tests/load-plan-replay.test.ts` (fails without the
  fix: a second load emits no PlanUpdate).

## [0.11.4] - 2026-08-22

### Fixed

- Session file roots are backend-authoritative: `session/load`·`resume` no
  longer adopt the client's cwd as the session root (a remote App derived
  its cwd from the hub instance list and fell back to "/" whenever that list
  was stale, hijacking the /fs file browser to the filesystem root and — via
  `projectCwd()` — poisoning the instance's advertised workspace for every
  later load). The root now comes from what the bridge recorded at creation,
  corrected by the backend's own `session/resume` result
  (`session.workspace.workspacePath`); a client cwd is only consulted at
  `session/new`, and "/" is never accepted as a root anywhere.
- `/fs` defense in depth: a session whose recorded root resolves to "/" is
  refused (403) — a polluted record can never widen remote file access to
  the whole filesystem.
- `projectCwd()` picks the most recently active session's cwd (insertion
  order was arbitrary across load timing) and skips "/" entries entirely.
- Tests: `tests/session-cwd.test.ts` (client-cwd trust boundary, backend
  workspace adoption, polluted-entry healing) + a /fs root-"/" refusal case
  in `tests/remote-file-endpoint.test.ts`.

## [0.11.3] - 2026-08-22

### Fixed

- Sessions evicted from the backend no longer break prompting or load empty:
  the zcode backend evicts idle resident runtimes (~10min idle timeout plus
  an LRU cap), after which every session-scoped RPC fails with
  `Session is not active` (-32004). The bridge now self-heals on every entry
  point — `session/prompt` reloads via `session/resume` and retries the
  subscribe once (re-baselining the differ so turn completion doesn't replay
  history), `session/load`·`resume` stop trusting a stale loaded-verification
  flag (5-minute TTL, `BACKEND_RESIDENT_TTL_MS`), and `ensureRealSession`
  reloads stale mappings for config/slash/extension calls (skipped while a
  turn is in flight, fail-safe on reload failure).
- Tests for the eviction recovery paths in `tests/session-eviction.test.ts`.
- Troubleshooting guide: dedicated `Session is not active` (-32004) entry,
  corrected the subscribe timeout retry numbers.

## [0.11.2] - 2026-08-20

### Fixed

- Plan/todo panel lag: the backend writes the projection's todos
  asynchronously after the tool-result event, so a single read at result-time
  races that write and intermittently sees the stale list.
  `dispatchPlanIfChanged` now re-checks once after a 600 ms delay when the
  todos signature is unchanged, before giving up.
- Tests covering the 0.11.1 audit-fix batch (settle-once, turn-idle grace,
  plan re-check) in `tests/audit-fixes.test.ts`.

## [0.11.1] - 2026-08-20

### Fixed

- Interaction forwards settle exactly once: a throw during the forward
  (adapter on malformed params, a failing notification send) now degrades to
  a decline reply instead of leaving the zcode request unanswered, leaking
  the reannounce-dedup entry, and refreshing the turn loop's no-progress
  timer until the turn hangs. The turn loop also contains
  handleServerRequests throws instead of dying.
- Hub: expose `X-Zcode-First-Line` via `Access-Control-Expose-Headers` so
  cross-origin file viewers can read the line-window header; guard the WS
  upgrade dial window against a client socket that dies mid-dial.
- `dispatchConfigChanged` looks config options up by id instead of array
  index (the build order was a hidden contract).
- `waitForTurnIdle` gains a 30 s lock-watching grace: past it, a successful
  probe counts as released, so a turn finishing between probes or backend
  error-message drift no longer spins the full timeout into a false
  `__lockTimeout`.
- `pendingTurns` keyed `number | string` (JSON-RPC ids); corrected two
  stopSent comments that claimed cross-turn dedup.

## [0.11.0] - 2026-08-20

### Added

- Reconnect resend of undecided interactions: a `session/request_permission` /
  `elicitation/create` fired while a remote client was offline (or dropped
  mid-wait) is re-sent to that client once its `session/load` /
  `session/resume` completes — the reconnect catch-up — after a 300 ms delay
  so the replay renders first. Every interaction wait is now tracked as a
  cross-attempt first-response-wins race: the re-send joins it, and losing
  attempts are aborted (`$/cancel_request`), dismissing leftover dialogs on
  the other clients. A wait interrupted by turn cancel or timeout now also
  dismisses the client's still-open popup. Protocol behaviour documented in
  docs/PROTOCOL.md (interaction routing).

## [0.10.0] - 2026-08-20

### Removed

- `session/steer`, `session/rewind`, `session/rewindCascade` ACP extensions
  and the `/steer`, `/rewind` slash commands. The zcode app-server removed
  these RPC methods in 0.16+ (verified live against 0.16.3: `-32601 Method
not found`); steer/rewind moved to the v4 conversation API, which the
  bridge does not speak. External usage was near zero (no standard ACP client
  calls these non-standard methods), and on 0.16+ they only ever returned
  errors. `session/fork` remains the checkpoint-branching alternative.
  Docs refreshed to a 0.16.3 audit: PROTOCOL.md version table, BACKLOG.md
  (new `session/send` params, `workspace/hooks/trustGrant`,
  `interaction/browser*`, v4 protocol family), README compatibility matrix.

## [0.9.0] - 2026-08-20

### Added

- Remote session close (ADR-0006): `POST /api/instances/{id}/sessions/{sessionId}/close`
  retires a conversation from remote discovery once the editor tab that owned it
  is gone. The hub byte-proxies to the bridge's loopback
  `POST /sessions/{id}/close`, which drops the in-memory summary so the session
  vanishes from `/status` and the next heartbeat. A session with a running turn
  answers `409` (cancel the turn first); an unknown session answers `404`. The
  bridge cannot observe which sessions still exist on the editor side, so close
  is self-healing instead of destructive: any later prompt or `session/load`
  that touches the conversation re-arms the entry and it reappears in discovery
  — an editor-side tab that is actually alive cannot be closed out from under
  it.

## [0.8.0] - 2026-08-20

### Added

- Plain-HTTP endpoints for remote clients, replacing the full ACP WebSocket
  round-trip for account quota and session running status (ADR-0005).
  `GET /api/quota` on the hub queries the usage APIs directly — quota is an
  account-level concern, so it works with zero bridges alive — with a ~30s
  TTL cache and in-flight dedupe; the response body is identical to the
  `account/usage_stats` ACP method, which stays available for attached
  editors. The bridge serves `GET /status` (in-memory `pendingTurns`
  derivation, no backend RPC, safe to poll at 1–2s), byte-proxied by the
  hub at `GET /api/instances/{id}/status`; the heartbeat's `sessions[]`
  also carries a coarse `status: "running" | "idle"` so `/api/instances`
  renders a running indicator for free. Both layers are additive — an
  older hub drops the field, an older bridge omits it.

## [0.7.1] - 2026-08-18

### Fixed

- New sessions appear in remote discovery within one heartbeat of their
  first prompt instead of only after the first turn completes: the turn
  start now marks the session active (previously the activity flag was set
  only in the prompt's finally, so a minutes-long first turn kept the
  conversation invisible in remote lists the whole time). Until the
  backend's auto-title lands, the entry carries a provisional title from
  the first line of the prompt.

## [0.7.0] - 2026-08-18

### Added

- Replayed `<task-notification>` blocks (background task / sub-agent
  completion notices injected by the harness as standalone user messages)
  now arrive as collapsed `tool_call` updates (`_meta.zcode.collapsed` kind
  `task-notification`) with the decoded `<summary>` line as the title,
  instead of a wall of XML pseudo-user text.
- Compaction markers survive replay: on backends that tag compaction
  products with `semantics.kind: "compact_summary"`, the replayed summary
  collapses under the store's own title (`Compact summary`, collapsed kind
  `compact`) instead of the generic `Context handoff` — the bridge's live
  🔄/✓ auto-compact notices never enter backend history, so this card is the
  durable record that a compaction (auto-compact included) happened there.

### Fixed

- A prompt sent from one client now streams to the others as a
  `user_message_chunk` echo (messageId prefixed `uprompt_`, prompting client
  excluded — it renders its own outgoing message locally). Previously a turn
  driven from the editor or a remote attach appeared on the other clients
  without the user message that started it. Verified live: the bridge
  already broadcasts thought/text/tool updates to every attached client,
  both directly and through the hub proxy; the user's prompt text was the
  one piece that never left the prompting client.

- Replayed tool calls now carry their payload: history tool parts hold the
  invocation input and result text under `state`, but the replay only sent
  title/status — expanding a replayed Read/Edit/Bash call in a remote client
  showed an empty body. The tool_call update now attaches input (JSON or raw
  string) and the backend-truncated output as content blocks, and takes the
  title/status from `state` (the previous top-level reads never matched, so
  titles fell back to the bare tool name).
- Replay no longer leaks hidden harness plumbing: synthetic messages the
  backend marks `transcriptVisibility: "hidden"` and that fit no collapse
  shape (plan-file reference reminders and similar) were replayed verbatim
  as `user_message_chunk` walls of text; they are dropped now, matching the
  backend's own transcript visibility.

### Changed

- Remote discovery session entries are now deduped across instances at the
  hub (freshest `updatedAt` wins, then newest instance). Several bridges of
  the same project can hold the same live conversation — a leaked bridge's
  copy can no longer surface as a duplicate entry that opens empty; the
  hub's dedupe picks the bridge actually driving the session. The listing
  keeps two gates: conversations must be currently running (live in the
  advertising bridge) and accessible (resolvable and resumable through it).
  A `session/list` RPC per heartbeat enriches live entries with the store's
  authoritative title and a cross-bridge `updatedAt`, degrading to
  summaries-only on failure. Advertised ids stay the editor-facing ACP
  session ids so a remote attach shares the editor tab's live stream.
- Removed the 0.5.1 heartbeat availability probe (`session-liveness.ts`) and
  the `unavailable` summary flag: live measurements showed the backend
  serves full `session/messages` in 35–120ms (the probe's 3s timeout branch
  never fired in production logs), and taking a session over in a second
  backend does not invalidate the first backend's copy — the probe's premise
  did not hold and its per-heartbeat RPCs were pure overhead. Duplicate
  protection now lives in the hub's cross-instance dedupe.

## [0.6.0] - 2026-08-18

### Added

- Read-only session file access over hub-proxied HTTP (ADR-0004). The bridge's
  loopback endpoint serves `GET /fs/list` and `GET /fs/file`, scoped to each
  session's cwd (`path.resolve` + `realpath`; `..` segments and symlink escapes
  are rejected), and the hub byte-proxies them at `/api/instances/{id}/fs/*`
  behind the existing token — no new port, and the hub still holds no path
  semantics. Files stream with `Content-Length` and an extension-based
  Content-Type; `offset`/`length` serves byte windows (206 + `Content-Range`),
  `line`/`limit` streams text windows (`X-Zcode-First-Line`) with O(limit)
  memory, so arbitrarily large logs are windowable. `initialize` advertises the
  capability as `agentCapabilities._meta.zcode.fs`. Contract:
  `docs/REMOTE-CLIENTS.md`. Also fixes `session/resume`/`session/load` never
  recording the session cwd, which the new endpoint relies on.

### Changed

- Replayed harness plumbing now arrives as collapsed `tool_call` updates
  instead of `user_message_chunk` walls of text: context-handoff summaries
  (title "Context handoff", one per compaction) and resume-rewritten tool
  transcripts ("Called the X tool with the following input…", title
  "X · <first input value>"). `tool_call` is the one ACP update kind every
  editor folds by default, so Zed/JetBrains collapse them with zero client
  opt-in; the full text rides the tool_call's content block and
  `_meta.zcode.collapsed` keeps its `kind` semantics
  (`context-handoff`/`tool-transcript`). Contract: `docs/REPLAY-GUIDE.md`.

## [0.5.1] - 2026-08-18

### Fixed

- Remote discovery no longer lists sessions the bridge cannot serve. When a
  project window restarts, the editor can leak the old bridge process; the new
  bridge takes the session over via the durable alias store, but the leaked one
  kept advertising it in every heartbeat — remote clients saw the same session
  twice, and the stale copy opened empty. Before each 10s heartbeat the bridge
  now probes its idle advertised sessions with a `session/messages` RPC: an
  error or empty answer hides the session from discovery (and clears the stale
  backend-loaded stamp so a later `session/load` re-runs the resume RPC), and a
  non-empty answer restores it. Freshly-active sessions and sessions with an
  in-flight turn are trusted without a probe. List membership now means
  "openable" (`docs/REMOTE-CLIENTS.md`).

## [0.5.0] - 2026-08-18

### Added

- Turn running state for re-attached clients: `session/load`'s `replayMeta`
  now carries `turnActive` (snapshot at attach time), and every prompt emits a
  `$/zcode/turnState` notification (`{ sessionId, running }`) at turn start and
  end (failures included) — so remote clients that did not send the prompt
  (re-attached mobile, second editor) can show and restore the running
  indicator. A preempted turn's exit reports `running: true` while the
  preempting turn is in flight. Clients that ignore the notification (Zed) are
  unaffected. Contract: `docs/REPLAY-GUIDE.md`.

## [0.4.0] - 2026-08-17

### Added

- Replayed context-handoff summaries ("This session is being continued from a
  previous conversation…") now carry `_meta.zcode.collapsed` on the
  `session/update` notification so capable clients can render them folded
  behind an expand control instead of as pseudo-user text. The full text stays
  in the chunk; clients that ignore `_meta` (e.g. Zed) are unaffected.

## [0.3.2] - 2026-08-17

### Fixed

- Replay now also strips harness tool-usage reminders that the backend stores
  WITHOUT `<system-reminder>` tags (TodoWrite/Read nudges followed by the
  todo-list dump) — verified against live `session/messages` payloads, they
  previously replayed verbatim and rendered as user input. Matching anchors on
  the nudge's stable opening signature and closing sentence, so real user text
  before or after the block survives.
- Replay now deduplicates history entries that share a message id — the
  backend can return the same message at multiple non-adjacent positions
  (observed in a live payload: 21 of 42 messages were duplicates), and every
  copy was replayed, rendering identical paragraphs twice. Each id is kept
  once, at its original position with its latest content.

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
