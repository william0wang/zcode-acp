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
│   ├── user-config.ts      Global user config (~/.config/zcode-acp/config.json)
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
│                         (bare invocation → Martty TUI) (ADR-0007, ADR-0020)
├── tui.ts                Martty launcher: spawn `martty --agent node
│                         --agent-arg <dist/index.js>` (npm dep `martty`,
│                         bundled per-platform Rust TUI); `tui --check`
│                         wraps `martty --check-runtime` for CI smoke
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
- **The backend ignores `session/stop`** (verified against app-server 0.16.5 —
  the model stream runs to its natural end no matter what). Cancel is therefore
  bridge-side only: the turn loop returns `cancelled` at once, and the next
  prompt's turn-attribution gate (armed on a recent cancel) drops the abandoned
  turn's leftover stream. Never "wait for the backend terminal event" after a
  cancel — that made ESC feel dead for the whole remaining generation.
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
- **User remote prefs live in `~/.config/zcode-acp/config.json`, NOT env**:
  the hub is a detached daemon that idle-exits (~10 min) and is re-spawned by
  whichever bridge needs it next, so its birth env rotates between
  GUI-launched editors (no shell vars) and interactive shells — env-carried
  preferences (terminal app!) drifted with every hub rebirth. Precedence per
  field: config file (`remote.*`, XDG aware) → env var → default; env stays a
  full fallback so existing setups keep working. Terminal prefs are re-read
  LIVE at every incubation (`remoteTerminalPrefs`); token/ports apply when the
  hub is next (re)born. Per-process plumbing (`ZCODE_ACP_REMOTE_ORIGIN`,
  `_PIN_CWD`, `ZCODE_ACP_RESUME_SESSION`) is deliberately env-only — per-role
  state, never file-configurable. The TUI script's env embedding is still
  load-bearing for file-less setups (the .command shell sources no rc).
- **Warp CAN be driven programmatically — don't regress it to "unsupported"**:
  it refuses `.command` files (warpdotdev/warp#1917) and its `warp` CLI is
  agent-only, but its URI scheme EXECUTES a script: `open -a Warp
"warp://action/new_tab?path=<script>"` opens the script as a new tab in
  Warp's default mode and runs it (source: warp's open-source
  app/src/uri/mod.rs → open_file; verified on 0.2026.09.02). That is the
  `warpUri` launcher in hub-server.ts; Preview = `warppreview://` + the
  "Warp Preview" bundle. #1917/#3959 describe only the missing .command/CLI
  paths, which made Warp look impossible for a long time.
- **The interactive CLI is Martty, a dependency — never hand-roll UI here**
  (ADR-0020): bare `zcode-acp` spawns `martty --agent node --agent-arg
<dist/index.js>` (src/tui.ts); the in-house Ink REPL was deleted wholesale.
  Martty folds chunk-delta replay (`user_message_chunk`/`agent_message_chunk`)
  only when the updates arrive AFTER the response on a load/resume path it
  initiated (complete user_message/agent_message updates never fold — verified
  0.2.35; this holds for the boot `session/new` interception too — chunks
  post-response DO fold). Martty's welcome banner, however, paints INSTEAD of
  the transcript (`ui.rs draw_chat`) and only dives on submitted text, so a
  boot-resumed TUI showed its replayed history only after the user's first
  message. Fix (bridge-side, no upstream dependency): the hub incubates resume
  TUIs with `DSH_TUI_AUTOPROMPT=BOOT_RESUME_TRIGGER` ("resume session" — plain
  text on purpose: `/` would hit martty's slash dispatch before agent caps are
  known, `!` runs a local shell). Martty auto-submits it at boot — banner dives
  immediately, the text queues until the bind — and `runPrompt` answers it with
  a one-line ack and `end_turn` (no model turn). The one-shot is scoped to the
  booting CONNECTION (`connectionContext` identity, like the prompt-echo
  exclusion): a phone app attached to the same bridge during the boot window
  and prompting first must not spend or disarm it — a global "first prompt"
  flag let the app's prompt race ahead and the trigger LEAKED TO THE MODEL as
  a real prompt (observed live; the backend record showed both "hi" and
  "resume session" as user messages). Only the same connection submitting
  something else first disarms (the auto-submit was lost). `marttyClientSeen`
  (sticky) replaces clientName for martty gating — clientName is
  last-write-wins across multi-client attaches and an app's initialize can
  land between the TUI's initialize and its session/new. Its `/resume` prefers
  session/resume (no replay by ACP design), so `resumeSession` pushes a 200-message turn-aligned chunk tail
  deferred past the response via `setImmediate`, gated on
  `clientInfo.name` ≈ martty — editors replay via session/load themselves and
  would double-render. Martty passes its full env to the spawned agent, which
  is how ZCODE_ACP_RESUME_SESSION reaches the bridge. `zcode-acp tui --check`
  (= `martty --check-runtime` over the built bridge) is the CI smoke.
- **Aug-28 app-server build (still "0.16.5") ignores `session/stop`**: the
  RPC returns `{}` but the model stream runs to its natural end (verified by
  raw-backend probe; the backend's own log records `hadActivePrompt: false` —
  the in-flight generation's abort controller is never registered). The
  official desktop app never hits that path: its stop button sends a
  `v4/command` RPC of type `stop` (`payload.expectedForegroundExecutionId`
  optional), which asks the runtime to stop the active foreground execution
  — found by grepping the app bundle. stopBackendTurn sends both: the
  session/stop formality plus the v4 stop, which kills the generation
  instantly (verified: `turn.completed` in 0.0s). Cancel is otherwise
  bridge-side: the turn loop returns `stopReason: "cancelled"` on the flag,
  and a send after a recent cancel settles the backend first (drain gate:
  poll-until-idle, with a `session/close` escalation after a 5s grace if a
  generation somehow survives both stops — a mid-generation send is accepted
  as steer input and silently dropped when the old turn ends; the
  `turn.steerQueued` event proves the swallow and the bridge reports it at
  once instead of hanging). After a close-escalation reload the drain gate
  must resubscribe the event stream (the reload revives the session but not
  its push — the next turn would run deaf) and re-baseline the projection
  differ (the abandoned turn committed messages while waiting — a stale
  baseline replays that residue as the next reply).
- **Prompt lock ≠ turn liveness** (raw-backend verified, Aug-28 app-server):
  `session/goal show` succeeds mid-turn (never reports the 1308 lock), and a
  probe `session/send` is ACCEPTED while the turn runs — it is queued as
  steer input. The 1308 lock only exists during turn finalisation, so "lock
  released" proves nothing about whether a turn is alive. Killing a silently
  running turn on a lock probe murdered live sub-agent turns behind quiet
  event streams (PR #85 did exactly this for a day). The honest liveness
  signal is the `session/read` projection watermark
  (contextUsed/totalTokenCount/turnCount/currentTurnId): a sub-agent turn
  advances it for minutes with zero stream events. `runEventTurn` therefore
  defers the terminal decision while the watermark moves and only ends a
  turn after the watermark has been frozen for STALE_FREEZE_MS (10 min) —
  reply-fetch first, bounded stop as the last resort.
- **The backend rejects JSON-RPC frames carrying a `jsonrpc` field** (strict
  zod: "Unrecognized key: jsonrpc", code -32600). The bridge's backend
  client never sends one — keep it that way when hand-probing
  `zcode app-server --stdio` (frames are bare `{id, method, params}`).
- **SBPL (Seatbelt) resolves overlapping rules by LAST match, not by
  deny-priority** — an `allow` emitted after a `deny` re-permits the write
  (verified via scripts/verify-sandbox.sh; the deny-island test failed until
  the denies were moved to the end). `buildSandboxProfile` therefore emits
  base deny-all → all allows → island/strictGit denies LAST. Also:
  subpath filters match REAL paths — every path (roots, allows, $TMPDIR)
  must go through `resolveReal`, or a symlinked prefix (/tmp →
  /private/tmp, $TMPDIR under /var/folders) silently fails to match. The
  sandbox design lives in ADR-0011 (`.zcode/docs/adr/`): writes-only model,
  per-project config in `.zcode/acp/sandbox.json` (deny island — only the
  bridge may write it), dynamic allow = ask → persist → BATCHED backend
  restart (3s window: grants collect, then one cancel-wave + continuation
  - close — a per-approval restart killed sibling popups still pending on
    other denied paths; the flush sets a continuation ONLY for sessions with
    a turn still in flight, orphans would hijack a later cancelled prompt).
    Ask debounce marks are timestamps: a user decision (or a structural
    hint) pins forever; a FAILED ask (timeout / killed by another grant's
    restart / instantly-rejecting client) cools down 60s and may re-ask —
    the old permanent mute left the model on a bare EPERM with no way out. Well-known system temp trees (/tmp → /private/tmp,
    /var/tmp, /private/var/folders) are DEFAULT-ALLOWED — tools hardcode /tmp
    and $TMPDIR names only the per-user /var/folders leaf; don't "tighten"
  them back into popup storms (verify-sandbox.sh fixtures moved to HOME for
  the same reason). Arming is dual-switch: `ZCODE_ACP_SANDBOX=1` globally
  or `enabled: true` in that config per project (auto-created template ships
  `false`; a malformed or non-object config reads as enabled — fail closed,
  never rewrite the user's bytes). `server.backendSandboxed` is the process
  fact the EPERM flow gates on — not `sandboxActive()`, which is the config
  wish re-checked per call (a mid-run flip to `true` is applied by
  `applySandboxFlip()` at prompt entry; flipping back only drops the wrap on
  the next respawn). Hardening invariants from adversarial review — do not
  regress: profiles go through `armSandboxArgv()` (fresh mkdtemp dir under
  HOME + O_EXCL + the profile denies its own dir last; the HOME base is the
  point — every agent-writable path is writable by prior sandboxed
  generations too, so a $TMPDIR profile is raceable across generations), and
    the config must pass the integrity check before the bridge persists
    through it (symlink/hardlink pierces the deny island; a config read as
    armed then EACCES/ENOTDIR/vanished also reads as armed — falling back to
    the template would silently disarm). `/dev/null` must stay write-allowed
    or every `git commit` breaks. `openpty` (`/dev/ptmx` + the granted
    `/dev/ttysNNN`, both `O_RDWR`) needs its two explicit write allows or
    `script`/`expect`/TUI binaries die with a bare `openpty: Operation not
permitted` (#127); the slave allow is extension-gated (`require-all` +
    `com.apple.sandbox.pty`, Apple `application.sb` form) so only this
    sandbox's own pty slaves become writable — never widen it to a bare ttys
    regex. The `pseudo-tty`/read/ioctl operations are already covered by
    `(allow default)`. When diagnosing ANY bare `Operation not permitted`
    inside an armed sandbox, suspect the sandbox FIRST — syscall-level denials
    have no ask popup and tools misreport them as their own bug; the bridge
    warns once per process on the first failed tool output containing the
    phrase (`hintSandboxEperm` in dispatch.ts).
- **A hub born inside the Seatbelt wrap silently breaks session-create**:
  macOS TCC attributes the hub's `open -a Terminal` to the requester identity
  "Sandbox" and Terminal refuses the document — while `open` itself exits 0,
  so `spawnTerminalTui` reads success, the incubation burns its 20s budget,
  and every remote create 502s. Seatbelt cannot be escaped from within, so
  the fix is launchd (it lives outside): every sandboxed backend spawn is
  birth-marked `ZCODE_ACP_SANDBOX_ACTIVE` (server.ts ensureBackend — NOT the
  same signal as `ZCODE_ACP_SANDBOX`, which a user may legitimately set
  globally), and the hub boot-checks the marker and relaunches itself via
  `launchctl bootstrap gui/$UID` + kickstart before binding
  (src/remote/hub-sandbox.ts; plist in a temp mkdtemp, launchd reads the path
  itself). Don't reconnect this through `open` retries or TCC prompts — the
  attribution is the problem, not a missing permission. The launchd escape
  itself FAILS when the hub was spawned from an agent session's own Seatbelt
  (launchctl is sandboxed there too — observed 2026-09: a nohup'd hub degraded
  and its serve bridges 502'd every /api/projects/sessions); the only working
  restart channel from inside such a session is an `open` one (e.g. Warp's
  `warp://action/new_tab?path=<restart.command>`), which hands execution to a
  clean user shell.
- **Start Plan providers are desktop-only — do NOT "fix" this with an
  unofficial provider client**: `zcode-plan` requests need an Aliyun captcha
  session only the desktop renderer can provide; the bridge answers
  `interaction/requestProviderRuntimeHeaders` with `headersApplied:false` +
  an actionable error (PR #128). Impersonating the desktop client, bypassing
  the captcha/signing anti-abuse measures, or copying from the unlicensed
  third-party proxies that do this are legal no-gos for a distributed tool
  (ADR-0019) — decline the feature request and point users at GLM Coding
  Plan or the desktop app.
- **ACP wire method names are snake_case** (`session/request_permission`,
  not `session/requestPermission`) — the camelCase spelling is silently
  method-not-found (-32601) on real clients, and an `as never` param cast
  hides it from tsc. Always mirror the SDK's method map or an already-working
  call site (see `handlers/server-requests.ts`) when sending server→client
  requests; the SDK types also require the `toolCall` field on permission
  requests (Zed renders the popup against it).
- **Releases are fully automated** (release-please + npm OIDC trusted
  publishing, zero npm secrets): land conventional commits on `main`, merge
  the `chore(main): release X.Y.Z` PR, and tag + GitHub Release + npm publish
  happen by themselves. Never hand-bump `package.json` version. A publish
  failure with 404 on PUT is an npm-side trusted-publisher mismatch, not the
  workflow. Public doc: `docs/RELEASING.md`; setup + troubleshooting runbook:
  `.zcode/docs/releasing-runbook.md` (gitignored).

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
