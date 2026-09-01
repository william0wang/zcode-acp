# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.17.0] - 2026-09-01

### Added

Remote session-create (ADR-0014): a remote client can start a NEW agent
session in any of the machine's known projects, no editor required.

- `GET /api/projects` (hub, token auth): the known-project list aggregated
  from the App's `tasks-index.sqlite` — every workspace that ever ran a
  session, filtered (system temp trees, `~/.zcode` itself, vanished
  directories) and sorted by last activity.
- `POST /api/instances {workspacePath}` (hub, token auth): spawns
  `zcode-acp serve` — a headless bridge — detached in the project cwd,
  waits for its heartbeat registration, and returns `{id, reused}`. The
  project list gates the create: paths outside it get 403 (a convenience
  bound, not a security boundary — the trust boundary is the token). A live
  serve instance for the same workspace is reused instead of re-spawned.
- `zcode-acp serve` CLI subcommand: the same ACP surface as the stdio
  server minus the editor — spawned by the hub with remote ENV, it
  registers back, serves remote WS clients, and exits after 10 idle
  minutes with no clients and no running turns (ADR-0001's headless
  counterpart). In serve mode `session/new` ignores client cwds and always
  uses the process cwd, pinning the session cwd end to end.
- Registration heartbeats and `/api/instances` now carry an `origin`
  field (`"editor"` or `"serve"`, older bridges default to `"editor"`)
  so remote UIs can label CLI-started instances and the hub can dedupe
  them per workspace.

### Fixed

- A bridge rejected by the hub (401, typically a token rotation it did
  not observe) permanently stopped registering — its sessions vanished
  from remote until the editor window was manually restarted. 401 no
  longer poisons the heartbeat: the bridge keeps retrying every 10s and
  spawns a replacement hub carrying its own token, with exponential
  backoff (60s doubling to a 10min cap) so a mixed-token fleet that
  keeps the stale hub alive cannot churn spawn attempts forever. Once
  the stale hub exits — immediately if the port is free, or via its
  zero-instance idle-exit — the next spawn installs a hub that accepts
  the bridge and everything converges without manual restarts.
- Hardening from an adversarial review of the new remote surfaces:
  - serve-mode cwd pinning now covers EVERY cwd entry point, not just
    `session/new`: a durable lazy-session alias minted with an arbitrary
    cwd on an editor bridge can no longer be resumed on a serve bridge to
    drag it into a foreign workspace (foreign-cwd records read as unknown
    ids; resume/load pin the root and never adopt the backend's returned
    workspace — the value the `/fs` file endpoint scopes to).
  - `POST /api/instances` keeps one in-flight spawn per workspace:
    concurrent creates join the same incubation instead of racing a
    duplicate detached process past the live-instance check.
  - Registration answers that are neither 2xx nor 401 (e.g. the port
    held by a non-hub service) now warn once per stretch instead of
    silently disabling remote discovery.
  - `listKnownWorkspaces(dbPath)` actually opens the injected path —
    `withSqliteRetry` used to hardcode the default tasks index, so the
    parameter only gated the existence check.
  - The known-project list is documented as a convenience bound, not a
    security boundary: bridge-side session materialization also writes
    list rows, so the real trust boundary is the token itself.
- Second adversarial round over the branch:
  - Serve-instance dedupe (and every serve-side workspace comparison)
    now canonicalizes paths via realpath: a whitelist row or registration
    carrying a symlinked spelling previously never matched the serve
    child's resolved process cwd — every create 502'd after 10s and each
    retry spawned another duplicate serve bridge.
  - serve mode also pins `session/list` to the project cwd (a client cwd
    could enumerate sessions in other projects) and refuses to resume or
    load a raw backend session id that lives in another workspace.
  - 401 recovery resets the whole replacement-hub schedule, so a second
    token rotation self-heals at full speed instead of inheriting the
    previous stretch's backoff timestamp.
  - The serve spawn forwards `ZCODE_ACP_HUB_HOST` (parity with
    bridge-side hub spawns) and fails fast on async spawn errors instead
    of burning the 10s registration budget.

## [0.16.2] - 2026-09-01

### Fixed

Second dual Review + Adversary pass over the 0.16.1 commit (pre-publish gate):

- `setting.json` with an empty-string `localePreference` (`""`) read as a
  real preference and masked a valid `locale`; the empty string now reads
  as unset and the effective locale wins.
- A UTF-8 BOM prefix in `setting.json` made `JSON.parse` throw and the
  bridge silently fell back to English; the BOM is stripped before parsing.
- Two more suites asserted English output without pinning
  `ZCODE_ACP_LANG` (`tests/auto-compact.test.ts`,
  `tests/background-tasks.test.ts`) — the same zh-machine redness 0.16.1
  fixed for `mcp-list.test.ts` (6 cases went red per run). Both are now
  pinned to `en`.
- `tests/i18n.test.ts`'s crash-guard loop reused one module instance for
  all five malformed locale values, so memoization short-circuited four of
  them; each value now parses through a fresh module.
- Removed a dead `?? ""` on `resp.error.message` (non-optional) in
  `src/handlers/slash.ts`, and corrected 0.16.1's overstated "import order
  normalized" claim below.

## [0.16.1] - 2026-09-01

### Fixed

Cross-review follow-ups to 0.16.0 (found by a dual Review + Adversary pass):

- Startup crash: a `setting.json` carrying a non-string `locale` (number,
  bool, array, object) threw `TypeError` inside `pick()` — the bridge died
  at `buildAllCommands()` before serving anything. `pick()` now narrows to
  strings, and the settings parse validates both keys.
- The app-locale cache used a null sentinel that a literal `"locale": null`
  punched through — every `messages()` call then re-read and re-parsed the
  settings file synchronously (~6ms each on a large file). Replaced with an
  explicit read-once flag.
- `tests/mcp-list.test.ts` asserted the English `/mcp` card without pinning
  `ZCODE_ACP_LANG`, and its fs mock falls through to the real fs — so the
  suite read the developer's real `~/.zcode/v2/setting.json` and failed 6
  cases on any zh-locale machine. Now pinned to `en`.
- Localized the strings the first pass missed: auto-compact status lines,
  the pre-popup tool_call titles ("Ready to code?", "tool permission (…)",
  "interaction"), the replay "tool call" fallback, background-task card
  titles, and the slash-command error messages (which previously stayed
  English next to localized success feedback).
- `tests/i18n.test.ts` now asserts the nested `slashCommandDescriptions`
  key sets match across languages and cover every static command.
- CHANGELOG wording: 0.16.0's "covers every string" overstated — token-form
  feedback (`✓ /mode = yolo`) and argument hints intentionally stay
  as-is (language-neutral).

## [0.16.0] - 2026-09-01

### Added

- Bilingual user-facing strings (zh/en) with `ZCODE_ACP_LANG` (`zh`/`en`).
  When unset, the bridge inherits the ZCode app's language choice
  (`localePreference`/`locale` in `~/.zcode/v2/setting.json`), then falls
  back to the `LC_ALL`/`LC_MESSAGES`/`LANG` locale, defaulting to English.
  Covers every string the bridge renders to the user in the editor: the
  sandbox permission popup, ExitPlanMode and AskUserQuestion popup labels
  ("Skip", "Skip this question", Include/Skip per option), slash-command
  feedback lines, status/hint lines, the post-allow continuation prompt,
  the changed-files card, the `/mcp` server listing, and the collapsed
  titles built during session/load replay — previously a mix of hardcoded
  Chinese and English. Developer-facing `log()`/`warn()` diagnostics stay
  English; the standalone REPL TUI and the `/quota` card formatter remain
  English-only for now.

## [0.15.0] - 2026-09-01

### Added

- Opt-in Seatbelt sandbox (`ZCODE_ACP_SANDBOX=1`, macOS) confining the
  agent's file writes (ADR-0011): the zcode backend subprocess — and every
  Bash/Edit/Write plus child process it runs — is wrapped in a generated
  `sandbox-exec` profile that denies writes outside the workspace roots,
  `~/.zcode*`, the system temp dir, regenerable tool caches, and the
  per-project allowlist. Reads/execution stay open; deletion is a
  write-class syscall, so `rm` (and every variant of it) is stopped by the
  write denial regardless of the binary performing it. A write outside the
  whitelist surfaces as an `Operation not permitted` in the tool output and
  triggers the editor's permission popup: allow the directory **once**
  (bridge-lifetime) or **always** — persisted by the bridge into
  `<workspace>/.zcode/acp/sandbox.json` (auto-created; the `.zcode/acp/`
  deny island keeps the agent from editing its own allowlist). After an
  allow the backend restarts with the widened profile and the bridge
  auto-continues the interrupted task. `"strictGit": true` in the config
  puts `.git` behind the popup. Verified by `scripts/verify-sandbox.sh`
  (four-state: workspace writable / outside denied / island protected /
  config-allowed honored); two real bugs fell out of that verification —
  SBPL resolves overlapping rules by LAST match (deny carve-outs must be
  emitted after all allows), and every subpath must be realpath-resolved or
  symlinked prefixes (/tmp → /private/tmp) silently fail to match.
- Project-level sandbox switch: `"enabled": true` in
  `<workspace>/.zcode/acp/sandbox.json` arms the sandbox for that project
  without the global env. The template is auto-created with
  `"enabled": false` on first open (discovery without arming); a malformed
  config reads as enabled (fail closed — corruption must not silently
  disarm). A mid-run flip to `true` is applied at the next prompt (the
  unsandboxed backend is killed and respawned; the session reloads via the
  subscribe-recovery path); flipping back drops the wrap on the next natural
  backend respawn.
- Sandbox hardening from adversarial cross-review (all findings reproduced,
  then closed): the profile is generated into a fresh unpredictable dir per
  respawn (O_EXCL) and self-denies its own directory — the previous stable
  $TMPDIR path let a sandboxed agent race the write (full escape), symlink
  it at a victim file, park a FIFO on it (bridge freeze), or occupy it with
  a directory (respawn DoS); symlinked/hardlinked sandbox.json now reads as
  armed with persistence disabled (writing the link target inside the
  workspace pierced the deny island and let the agent edit its own
  allowlist); `/dev/null` is allow-listed (git commit and every
  `2>/dev/null` failed without it); island/strictGit paths get an
  explanatory hint instead of a popup that could never override the
  last-match deny; killing the backend now cancels all in-flight turns
  (other sessions hung up to ~10min on the dead reader); the allow popup
  uses the correct `session/request_permission` wire name with the source
  `toolCall` (the camelCase form was method-not-found on every real
  client, silently disabling the whole dynamic-allow flow); non-object JSON
  configs fail closed; relative `allow` entries are dropped.
- Second-round hardening (re-review found a regression and a fail-open gap,
  both reproduced): the profile dir moved from $TMPDIR to a home-based
  `~/.zcode-acp-sbx-*` mkdtemp — prior sandboxed generations (setsid
  survivors) keep their old allows and could race the write→exec window of a
  TMPDIR-placed profile regardless of name freshness (38–80% full escape);
  a config previously read as armed that then turns unreadable (EACCES,
  ENOTDIR) or vanishes now reads as armed instead of silently disarming via
  the auto-created template; protected-path matching folds case on macOS
  (`.ZCODE/ACP` variants no longer get a doomed popup).

### Fixed

- The dynamic-allow popup never fired for the most common denial shapes
  (found by live testing right after arming): zsh prints redirect denials as
  `zsh:2: operation not permitted: /path` — lowercase with the path AFTER the
  phrase — which the extractor's `path: Operation not permitted` pattern and
  the case-sensitive gate both missed, so `echo > /outside/f` (the standard
  agent write) silently got no ask at all. The extractor now handles the zsh
  redirect form, the Node fs form (`EPERM: operation not permitted, open
'/path'` — quoted paths keep spaces, any libuv syscall name matches, and a
  truncated apostrophe-in-path match is refused rather than allowed to
  persist an over-broad directory), and explicit `./`/`../` relative
  paths, which the handler resolves against the session cwd instead of the
  bridge's own cwd (they differ for remote/hub clients); the gate is
  case-insensitive; read-only tools (Read/Grep/Glob/... — their output
  merely echoes text) are excluded from the scan to avoid phantom asks, and
  asks resolving to $HOME or an ancestor are refused outright.
- Backend respawn (sandbox allow-restart, idle-eviction recovery) restored
  the session via a bare `session/resume`, skipping the provider-registry
  sync and the stale-model repair that the ACP resume/load handlers
  perform — the session history references a model whose provider the
  fresh backend never registered, so every send failed persistently with
  the backend's "历史任务使用的模型已不可用" error (auto-continuation
  after an allow died silently; user messages hung on the send retry).
  `reloadBackendSession` now performs the same sync → resume → repair
  sequence as the ACP paths.
- The post-allow continuation ran as a detached bridge-internal prompt: the
  editor had no pending request behind it, so it showed no running state —
  the respawn+reload window (~7s) read as "it just stopped", any message
  typed there preempted the continuation for real, and only the session/load
  replay later surfaced the orphaned continuation bubble. The continuation
  now chains INSIDE the original `session/prompt` request (wrapper in
  `prompt()`), so the editor's spinner spans the restart and the resumed
  work renders as the same turn; preempt/ESC during the continuation still
  cancels it. The continuation round also emits a status line
  ("[沙箱后端已重启,会话已恢复,自动继续刚才的任务…]") at send-accept, so the
  respawn+reload window no longer ends in an unexplained thinking block.
- Rejection is explicit config, not hidden memory: the popup now offers all
  four ACP kinds — 始终允许 / 仅此一次 / 拒绝一次 / 始终拒绝. "始终拒绝"
  persists the path into the project config's `deny` list (the same ask
  never resurfaces; review or undo by editing the file); "拒绝一次" and
  timeouts/dismissals persist nothing and will ask again — no rejection is
  remembered anywhere but the config.

## [0.14.3] - 2026-09-01

### Fixed

- Turns running silently behind a sub-agent (or any long quiet operation) are
  no longer killed after 120 seconds of stream silence. 0.14.2's deadline
  check probed the prompt lock via `session/goal show` and killed the turn on
  a released or indeterminate lock — but raw-backend probes against the
  Aug-28 app-server proved the prompt lock is not a liveness signal:
  `session/goal show` succeeds mid-turn, and a probe `session/send` is
  accepted (queued as steer input) while the turn runs, because the lock is
  only held during turn finalisation. The deadline now keys on the
  `session/read` projection watermark (contextUsed / totalTokenCount /
  turnCount / currentTurnId), refreshed by the 15-second stall reconcile: an
  advancing watermark proves the backend is still making progress and defers
  the terminal decision indefinitely, and only a watermark frozen for ten
  minutes (STALE_FREEZE_MS) ends the turn — reply fetch first, bounded stop
  as the last resort.

## [0.14.2] - 2026-08-31

### Fixed

- The turn loop's 120-second no-progress watchdog can no longer be kept
  alive indefinitely by a stale backend projection stuck at
  `status: "running"`: projection probes no longer refresh the deadline.
  At the deadline the bridge now probes the authoritative prompt lock via
  `session/goal show` (lock-busy matched by error code 1308, message text
  as fallback). A held lock defers the terminal decision by another 120
  seconds — protecting legitimately long model/tool operations — while a
  released or indeterminate lock ends the turn with the existing bounded
  `max_turn_requests` outcome. Queued events are consumed before a
  deadline decision. (Originally by GuanBear in #83; rebased and adapted
  to the post-#84 cancel machinery in #85.)

## [0.14.1] - 2026-08-31

### Fixed

- REPL live turn: streamed prose now interleaves with thinking and tool
  entries in stream order. Prose segments are flushed as entries whenever
  thinking resumes, a fresh tool row starts, or a plan note arrives —
  previously the whole reply accumulated in a single buffer pinned to the
  bottom of the live-turn tail until the turn ended, rendering later
  thinking/tool entries above earlier prose and letting long replies crowd
  the tail. Whitespace-only thought chunks are ignored as segment
  transitions so they cannot shred prose.

## [0.14.0] - 2026-08-31

### Added

- REPL prompt history: every submit is recorded per project
  (`~/.zcode/acp/repl-history/<sha1(cwd)>.jsonl`, newest 500 kept, runs of
  duplicates collapsed) and recalled across restarts with `↑`/`↓` while the
  completion menu is closed — the first `↑` stashes the live draft and `↓`
  past the newest entry restores it.
- Pasted text is folded to a single line before it reaches the prompt:
  bracketed-paste mode (`?2004`) is armed so ink delivers pastes as one
  chunk, and newlines/tabs inside them (or any multi-character chunk
  carrying a newline, for terminals without `?2004`) become single spaces.
  Previously every newline in a paste submitted mid-paste, firing a
  multi-paragraph paste line-by-line as separate prompts.
- REPL `/new` starts a fresh session without leaving the terminal: the live
  session is swapped client-side for a new `session/new` placeholder
  (config selects reseeded from the response), a divider note marks the
  boundary, and the prompt draft is cleared. A running turn refuses it
  (`esc` interrupts first); it is registered as a one-shot command, so
  picking it in the completion menu executes immediately.
- A live status row while a turn runs — `⠋ working… (12s · esc to interrupt)`,
  phase-labeled thinking/writing/working — re-rendering every second so
  stretches with no streamed output (long tool calls) are visibly alive; the
  old dim "ctrl-c to cancel" line carried no liveness signal. Help lines and
  the input-box hint now advertise `esc` as the interrupt (ctrl-c is quit).
- Interactive REPL (bare `zcode-acp`): an Ink terminal chat over the same
  bridge the editor uses, including slash-command completion with an
  interactive menu, a caret-aware prompt line (arrows/Ctrl-B/F/A/E/U),
  argument-free commands running on pick, and a welcome panel.
- REPL renders via **native scrollback**: completed messages print once
  through ink `<Static>` and belong to the terminal — native smooth
  scrolling, selection/copy, and search work unchanged and history survives
  exit. Only a compact dynamic footer repaints: live-turn tail (capped at
  half the screen), queued-prompt panel, completion menu, prompt box.
- The prompt line wraps across rows with CJK-aware caret placement
  (`wrapEditorLine` + `locateCaret`); input-box growth is reserved in the
  layout so the frame never overflows the terminal.
- `/sessions` picker slides an 8-row window over the full session list
  (position counter plus "N newer above / older below" hints) instead of
  printing every entry; arrows move across the complete list either way.
- Resuming a session replays only its recent tail — last 50 messages,
  turn-aligned via ADR-0003 `_meta.zcode.limit` tail replay — instead of
  dumping full history into scrollback; when truncated, the resume note says
  exactly what was loaded (`showing last 50 of 1234 messages`).
- Pasted or dragged-in content is handled safely: contiguous printable runs
  apply as ONE editor op (`planChunkOps`), control/escape junk is stripped
  before it reaches editor state (`sanitizeInputChunk`), prompts cap at
  20k chars, and unexpected internal errors never kill the UI — they surface
  as an `error absorbed` note while the REPL keeps running (a 5-in-10s
  circuit breaker shuts down only if errors fire every frame).
- Remote turns render live in the REPL (`$/zcode/turnState`), permission and
  question requests answered elsewhere dismiss the local picker via the SDK
  abort signal, AskUserQuestion renders as a structured form picker, and
  ExitPlanMode heads as "plan approval" with the plan text inline.
- The prompt-line status row carries a compact plan-quota readout
  (`5h NN% · wk NN%`) refreshed every 10 minutes; failures hide silently.

### Changed

- `esc` interrupts a running turn whether or not prompts are queued (an open
  completion menu still takes precedence); queued follow-ups drain one per
  stop through the same command parsing as direct submits, so a queued
  `/help` or `/exit` keeps working.
- Config argument menus execute on pick ("enter switches now"), one-shot
  commands run on pick ("enter runs it now"); other completions only fill.

### Fixed

- `esc`/stop now takes effect immediately. The Aug-28 app-server build
  (still reporting 0.16.5) accepts `session/stop` but never aborts the
  in-flight model stream — its own log records every stop with
  `hadActivePrompt: false`, i.e. the generation's abort controller is never
  registered, so the stream ran ~10s past the stop to its natural end while
  the turn loop waited for a terminal event. Digging through the desktop
  app's bundle revealed the stop path the official client actually uses: a
  `v4/command` RPC of type `stop` that asks the runtime to stop the active
  foreground execution (not the broken `session/stop`). The bridge now sends
  that v4 stop alongside `session/stop` — verified live: the generation dies
  the instant the command lands (`turn.completed` in 0.0s, vs +39.7s natural
  drift before). The turn loop also returns `stopReason: "cancelled"` at
  once instead of waiting for a terminal event.
- A follow-up prompt sent right after a cancel/preempt is no longer silently
  dropped. The same backend build accepts a mid-generation `session/send`
  as a steer and discards its input when the old turn finishes (verified:
  only one `turn.completed` ever arrives, for the old prompt). The bridge
  now settles the backend before sending: with the v4 stop the probe sees
  idle immediately; on a backend that honours `session/stop` it polls the
  projection until idle; if a generation somehow survives both stops, a
  `session/close` escalation after a 5s grace tears down the runtime (the
  probe then fails into a session reload). A visible
  `[上一个回复仍在生成，等待结束后发送…]` note explains the wait — bounded at
  90s, still interruptible with `esc`, falling back to a direct send on
  timeout or probe failure. Two edge paths found in review are also closed:
  after a close-escalation reload the bridge re-subscribes the event stream
  (the reload revives the session but not its push — without this the next
  turn runs deaf until the watchdog) and re-baselines the projection differ
  so the cancelled turn's residue is never replayed as the next reply; and a
  send that does land mid-generation is reported at once via the backend's
  `turn.steerQueued` event (`[消息被并入仍在生成的回合，将被丢弃，请重新发送]`)
  instead of hanging silently until the 120s watchdog.
- Pressing ↓ with no completion menu open no longer zombifies the whole UI:
  the setState updater dereferenced a null menu during render, unmounting
  React's tree under ink without any crash signal (found by review,
  reproduced over pty).
- Long pastes no longer crash the REPL: each pasted character used to
  trigger a synchronous ink rerender inside one tick, tripping React's
  nested-update limit ("Maximum update depth exceeded") — reproduced via
  pty with the exact stack.
- Cold-start race: picking a `/sessions` entry while the placeholder
  `session/new` handshake was still in flight let the late fresh session
  overwrite the resumed one; the placeholder is now discarded.
- Resume no longer force-pins a session to the first config.json model
  (faithful model preservation, overlay demoted to one-retry fallback).
- Turns driven from another client (mobile app, second editor) now render
  live in the REPL even when the two hold different ACP session ids for the
  same conversation — the common "fresh REPL session, mobile follow-up"
  path previously stayed completely silent (no live turn, no streaming, no
  completion, while the other client saw everything). Session-scoped
  notifications (updates, turnState, prompt echo) are now emitted once per
  attached session alias.
- ESC (and ctrl-c) now interrupts a running turn immediately. The backend
  ignores `session/stop` (verified against app-server 0.16.5 — the model
  stream runs to its natural end regardless), and the turn loop used to wait
  for that terminal event before reporting cancelled, so the reply kept
  streaming for the whole remaining generation (10s+ observed) while the
  status row kept spinning. The loop now returns `cancelled` at once; a
  follow-up prompt sent during the abandoned turn's finalisation arms the
  turn-attribution gate so the residue is dropped instead of bleeding into
  the new reply. REPL hint copy now advertises esc as the interrupt
  ("esc interrupt") instead of ctrl-c.

## [0.13.0] - 2026-08-26

### Added

- REPL interactive completion: typing `/` opens a command menu (↑/↓ move,
  enter or tab picks the highlighted entry, esc dismisses). Picking `/model`,
  `/mode`, or `/thought` opens the config options in the same menu (current
  one marked `●`); the next pick inserts the value and a final enter sends
  the switch — no hand-typed ids. Enter only sends an exact form: a full
  non-config command (`/exit`) or a config command with its exact value.
  REPL-local `/help` and `/exit` stay in the menu (merged with the
  bridge-advertised commands) and in `/help` output.
- REPL startup welcome panel: version, session directory, seeded config, and
  key hints render above the fixed prompt box (agent-CLI style); the first
  prompt pushes the panel into native scrollback.
- zcode CLI auto-discovery: resolution is now `ZCODE_BIN` → `zcode` on `PATH`
  → the `zcode.cjs` bundled inside the ZCode desktop app (standard install
  locations for macOS/Windows/Linux). Bare `zcode-acp` works in a terminal
  without editor-provided env; `ZCODE_BIN` is only needed for custom installs.

### Changed

- REPL prompt renders as a full-width rounded box; the `model · mode ·
thought` status row moved inside the box (bottom), with a right-aligned
  key-hint.

### Fixed

- The bridge no longer crashes with an unhandled `'error'` event when the
  zcode CLI cannot be spawned (ENOENT): the spawn failure now fails requests
  with a JSON-RPC error and logs an actionable hint (install/PATH/`ZCODE_BIN`).
- Rapid double ctrl-c — the two keys can arrive coalesced in one input chunk,
  which ink delivers without `ctrl` set — now exits the idle REPL; a
  multi-line paste submits every line instead of dropping the first (stale
  closure read the pre-chunk value).
- Opencode Go quota percentages keep 0.1 precision (72.6% no longer renders
  as 73%).

## [0.12.0] - 2026-08-25

### Added

- Unified CLI entry `zcode-acp` (ADR-0007): bare invocation opens an
  interactive Ink REPL (streaming output, tool rows, arrow-key permission
  picker, config parity with editor dropdowns); `hub` and `quota` moved under
  it as subcommands. The old standalone `zcode-acp-hub` and `zcode-quota`
  bins were removed. Without a TTY (pipes, Windows editor shims) a bare
  invocation falls back to the stdio ACP server so editor configs keep
  working; `zcode-acp repl` errors instead of silently falling back.

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
  "**none**" sentinel makes diffPlan always emit, while the shared differ's
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
