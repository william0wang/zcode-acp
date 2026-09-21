# Agent Instructions

## Project overview

**zcode-acp-server** — a Node.js bridge that connects the ZCode agent backend
(`zcode app-server --stdio`) to any ACP-compatible editor (Zed, JetBrains, …)
via JSON-RPC over stdio. Translates ACP protocol requests into ZCode session
methods and streams events back as ACP `session/update` notifications.

## ZCode upstream source (open-sourced 2026-09)

ZCode went open source (Apache-2.0): a local checkout lives at
`~/Develop/NoBackup/ZCode` (remote `github.com/zai-org/ZCode`; downloaded at
desktop 3.14.0 = app-server/`apps/zcode-cli` 0.16.9 — same version the bridge
runs today). The agent runtime is under `apps/zcode-cli/packages/core/`;
`packages/zcode-server-cli` is only a thin CLI shell. **Read the source BEFORE
probing or reverse-engineering the bundled CLI** — every "verified against
app-server" note in Gotchas below predates it and now has an authoritative
reference. Key map:

- `packages/shared/src/zcode-protocol/index.ts` — the full RPC schema: method
  enums, request/response zod shapes, server→client requests, event union
  (this is what `zcode.cjs` minifies; `docs/BACKLOG.md` audits against it)
- `packages/zcode-server-cli/` — the `zcode app-server` CLI (`src/cli.ts`,
  `src/main.ts`, `src/server-core/`, `src/runtime/`)
- `packages/server/` + `packages/services/` — session/turn/provider runtime
- `packages/client/` — what the official client sends and expects
- `packages/provider/` / `packages/provider-node/` — provider registry &
  entitlement
- `packages/desktop/` — the Electron host (provider env injection, TCC, v4)

**On every backend version bump**: `git -C ~/Develop/NoBackup/ZCode pull` (or
fetch the matching tag), re-read `packages/shared/src/zcode-protocol/index.ts`
for schema drift, and diff the behaviors Gotchas depends on (stop, provider
bootstrap, runtime headers, compact, setModel strictness) against the source
instead of the binary. Update `docs/BACKLOG.md` and the Gotchas bullets from
source evidence (`file:line`), not bundle probes.

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
- **3.12.3+ desktop bundles pass the CLI's provider table via env, not the
  filesystem** (observed 2026-09; the CLI still self-reports "0.16.5"): the
  desktop host resolves `zcode-builtin.json` at `Resources/config/provider/`
  and injects it as `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` (verified in
  app.asar). The CLI's own lookup only knows `<entryDir>/provider/` and a
  five-up `config/` for the dev monorepo tree — which lands on `/` under the
  .app layout — so a bare bundle spawn exits in <1s (the
  "无法定位 CLI ZCode Built-in Provider Config" error, code 1) and stays dead
  after each app update until the CLI's
  `~/.zcode/v2/runtime/provider/<plat>/<ver>/endpoint-<hash>/` sync happens
  to run (itself needing a valid source). `builtinProviderEnv`
  (src/backend/resolve.ts, merged in `ensureBackend`) mirrors the host's
  injection: locate the config next to the CLI entry (sibling `provider/`, or
  `../config/provider/`) and set the env for the spawn. The derived value
  OVERRIDES any inherited ambient copy — the host injects version-keyed
  runtime paths that go stale across app updates. Boot frames are queued, not
  dropped, but a COLD first boot can exceed 20s (provider sync fetch) — a
  one-off request timeout; the next attempt succeeds. The update is otherwise
  compatible: session/create already speaks the `{workspace:{…}}` /
  `result.session.*` shape the bridge uses, `startup/storageState`
  notifications are boot noise, tasks-index.sqlite only grew defaulted
  columns after our INSERT list, and unknown server→client requests
  (`interaction/requestOfficialMcpAuthHeaders`) land safely in the
  unhandled-request error path.
- **3.12+ model switching: account-plan providers are HOST-pushed, and
  `session/setModel` lost its `runtimeModel` overlay.** Two coupled changes
  (both verified 2026-09 against the bare app-server): (1) the registry is
  built from the bundled table + `provider_config.json` + an ACCOUNT snapshot
  the desktop host computes and pushes over `provider/updateAccountConfig`;
  headless launches have no host, so every `account:*` coding-plan provider
  reads `entitled:false`, the GLM models never appear in
  `settings.model.available`, and switches fail with "Provider Registry 中不存在
  Model". The bridge now pushes that snapshot itself (`config/account-provider.ts`,
  called from `syncProviderRegistry` before session/create). The payload's
  `basedOnZCodeBuiltinRevision` MUST be `zcode-builtin:<file.revision>:<sha256(PATH)>`
  — the hash covers the provider-table PATH, not the bytes, and a mismatch
  makes the backend accept the push but silently ignore it; derive it from the
  SAME path `ensureBackend` injects (reading the ambient env first points at a
  version-keyed runtime copy and yields a rejected revision — that failure
  mode is the trap). **Both env vars are load-bearing** — source-confirmed 2026-09-21 as the
  CLI's own verbatim-use fast path (`provider-runtime-env.ts:58-66`; both
  required together, `runtime-paths.ts:20-36`; revision = sha256 of the
  PATH, `zcode-builtin-provider-config-source.ts:41,213`; mismatch silently
  ignored, `registry-service.ts:205-213`; app-server has NO standalone
  account mode — the bridge's host push is the only headless path): the
  CLI's provider bootstrap uses the injected builtin path VERBATIM only when
  `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` is set alongside
  `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`; with the builtin alone it re-syncs the
  table into a version-keyed runtime copy (`~/.zcode/v2/runtime/provider/<plat>/<ver>/…`)
  and rewires its configRevision to THAT copy's path — every account switch
  then answers "Provider Registry 中不存在 Model" while probe environments
  without the re-sync trigger look perfectly healthy (observed 2026-09-17:
  the user's terminal took the re-sync path deterministically, the dev shell
  never did; `builtinProviderEnv` now injects both vars). 3.12 also renamed
  the config-file model spelling to `custom:<urlencoded providerId>:<modelId>`
  (see `~/.zcode/agents/*.md`); `parseModelValue` accepts it. Entitlement
  comes from `coding-plan-cache.json`
  (desktop's resolved availability verdict) → legacy `config.json`
  (`builtin:*` enabled + apiKey); `setting.json`'s
  `modelProviderFamilySelectedKeys` is a _selection_ record, not an
  entitlement — only as a last resort when both are empty. (2) `session/setModel`
  is now strict: `{sessionId, model:{providerId, modelId, options?}, persistAsWorkspaceLastUsed}`,
  NO `runtimeModel` (`Unrecognized key`), and the OBJECT form requires
  `options.reasoningLevel` for level-bearing models ("Reasoning level is
  required for <p>/<m>") — the string form skips that check but carries no
  level. Provider ids must also be translated to the registry's spelling
  (`builtin:bigmodel-coding-plan` → `account:bigmodel-individual-coding-plan`,
  `accountProviderIdFor`). `session/create` is the only response returning the
  FULL `settings.model.available` list (with authoritative `reasoning.defaultLevel`);
  `session/read` answers `"current"` only, so the create snapshot is cached in
  `server.modelAvailability` for switch-time level resolution. `applyModelSwitch`
  tries the modern shape then falls back once to the legacy overlay shape, so the
  same bridge works on both builds. `workspace/updateProviderRegistry` is
  GONE in 3.12+ (method-not-found) — the bridge logs it as a no-op, not a
  failure. Also note `session.model_selection.persist_failed` ("FOREIGN KEY
  constraint failed") fires on EVERY setModel since at least 2026-09-14 —
  including working third-party switches — it is a backend-side persistence
  wart, NOT a switch failure (the following `session.model.updated` event is
  the success signal); don't chase it as a switching bug. **Account turns
  also need runtime headers**: the backend asks its host
  `interaction/requestProviderRuntimeHeaders` before EVERY model request on a
  `zhipu-account` provider and a `headersApplied:false` answer throws -32031
  (every send on a GLM model dies in a retry loop — observed 2026-09-17 after
  switching started working; the switch looked fine, sends never ran). The
  bridge answers `headersApplied:true, requestAuth:{apiKey}` with the plan's
  config.json key for individual coding plans
  (`answerProviderRuntimeHeaders`, server-requests.ts) — the same key the
  pre-3.12 `builtin:` provider used; start-plan stays declined (Aliyun
  captcha, #123). **The answer is wired at frame ARRIVAL**
  (`ZcodeBackend.providerRuntimeHeadersResponder`, set in ensureBackend), not
  just the turn-loop queue: a headers ask that lands while no turn loop is
  polling — compact's internal turn above all — used to sit unanswered until
  the backend's 180s cap killed the generation as "Captcha verification
  request timed out" (observed 2026-09-19: auto-compact "succeeded" per the
  bridge for weeks while never compacting; backend log `~/.zcode/cli/log/`
  carries the truth, `querySource: "compact"`). The backend's own
  "standalone" self-signing channel needs
  an identity credential pair in its ENCRYPTED store
  (`account-provider:…:account:<uid>:api-key` exists but the `…:identity`
  half was never written on the observed machine), so the bridge cannot rely
  on it.
- **Desktop 3.12+ writes user-added models to `provider_config.json` and legacy
  config.json has STOPPED syncing — the dropdown must union both** (observed
  2026-09-20: a model added in the app landed only in
  `~/.zcode/v2/provider_config.json` `modelConfigRules.providerModelRules`,
  config.json's mtime stayed days stale, and the dropdown built from
  `loadAllModels()` never showed it while the backend registry accepted the
  model fine). `loadAllModels` (src/config/options.ts) merges: config.json
  stays authoritative for enablement/credentials; the personal config
  contributes model ids per provider plus WHOLE providers config.json lacks
  (same `providerSelectable` rule applied to the rule's own
  `config.access.apiKey` / `config.api.baseUrl`). Shapes that bite: personal
  rule ids use the REGISTRY spelling (`account:…` — normalize through
  `configProviderIdFor` before matching config.json's `builtin:*` keys), the
  enabled flag nests under `config.enabled` (not top-level), and models carry
  `config.properties.contextWindow` + `optionSpecs.reasoningLevel.values`.
  `modelContextWindow` and `resolveDefaultReasoningLevel` fall back to the
  personal rule too — a model added after session/create is absent from BOTH
  the captured availability snapshot and config.json, and omitting `options`
  hard-fails a level-bearing `session/setModel`.
- **The backend ignores `session/stop`** (verified against app-server 0.16.5 —
  the model stream runs to its natural end no matter what). Cancel is therefore
  bridge-side only: the turn loop returns `cancelled` at once, and the next
  prompt's turn-attribution gate (armed on a recent cancel) drops the abandoned
  turn's leftover stream. Never "wait for the backend terminal event" after a
  cancel — that made ESC feel dead for the whole remaining generation.
- **`session/prompt` ordering**: subscribe to events BEFORE calling `session/send`
  — short turns can complete before a late subscribe catches them.
- **Auto-compact runs DETACHED from the turn that armed it — do not re-couple
  them**: `runOneTurn` arms it on end_turn; the `finally` starts it only AFTER
  `pendingTurns` cleanup + `running:false` (`runAutoCompactDetached`). The old
  blocking shape kept the FINISHED turn registered through the whole
  compaction, so any cancel or follow-up prompt preempted it — stopBackendTurn
  plus the drain gate's close escalation killed the compaction's internal AI
  turn, `waitForTurnIdle` read the dead lock as "released", and the bridge
  reported a FALSE "✓ compressed" while the context never shrank (observed
  from the App 2026-09: compaction "failed" whenever the user stopped or
  resent during the 🔄 window — the reply was done, the spinner wasn't, so
  users ESC'd into the kill chain). The DEEPER cause of "compacts but nothing
  shrinks" was the unanswered runtime-headers ask (see the 3.12 bullet above)
  — 3.12+ `session/compact` submits `/compact` as a background prompt and
  swallows its failure into an event the bridge never saw; both layers are
  now fixed. (Source 2026-09-21: the swallow target is a `state.updated`
  broadcast with mutation reason `session_compacted` /
  `session_compact_cancelled` / `session_compact_failed`,
  `server-operations.ts:2082-2119` — real compact failure is now OBSERVABLE
  on the v3 stream; wiring it into the bridge's success reporting is a
  pending alignment item, see docs/BACKLOG.md.) Invariants that must stay: single-flight per sid
  (`server.autoCompactInFlight`), drain gate exempt while it runs, and a
  prompt landing in the compaction window is REJECTED outright — entry gate
  in runPrompt plus the busy-reject fallback in runOneTurn (notice asks the
  user to resend after the ✓ line) — NEVER queued behind the lock: the
  queued turn's listener is already subscribed and would dispatch the
  compaction's whole internal-turn stream as its own output once the lock
  releases (its turn.completed ends the turn before the real reply starts;
  observed as corrupted follow-up turns). Flows with no user to resend wait
  the compaction out BEFORE subscribing instead
  (`waitForAutoCompactIdle`: goal-loop rounds retry via
  `turn.compactRejected` — the neutral `autoCompactGoalWait` note, never the
  resend notice; a round rejected TWICE throws → `paused-crash`, never
  counted as a completed round — and sandbox continuations wait at prompt
  entry).
- **Preempt lock**: concurrent prompts for the same session are serialized via
  `withPreemptLock`. Don't bypass it — two simultaneous turns corrupt the listener.
- **The lazy-alias store (`~/.zcode/v2/acp-lazy-sessions.json`) is shared by
  EVERY bridge process and must never be written non-atomically**: it maps lazy
  placeholder ids → cwd/backend id and is the only recovery for an idle editor
  thread after a bridge restart. A torn/interleaved whole-file write corrupts
  it, the next reader treats corruption as `{}` and the overwrite wipes all
  aliases — the thread then fails with the backend's cryptic "Session ID
  不存在" (observed 2026-09; a vitest run racing a live Zed bridge did exactly
  this). Writes go through `persist()` (temp file + rename + stale-tmp sweep +
  merge-at-write) — never `writeFileSync` the store path directly. Tests run
  under a hermetic temp HOME (`tests/setup/hermetic-home.ts`, set by direct
  `process.env.HOME` assignment so `vi.unstubAllEnvs()` cannot leak back to
  the real HOME); the same setup DELETES `ZCODE_ACP_REMOTE_ORIGIN` /
  `ZCODE_ACP_TUI_CLI_PID`, because a vitest run started from inside an
  incubated TUI inherits them and the session-close endpoint would signal the
  REAL window's process tree from a test (observed live 2026-09-08 — the run
  killed its own host window). Keep new tests store-safe by default and don't
  bypass the setup file.
- **A store-recovered alias is NOT resident; "Session not found" ≠ "Session is
  not active" (same -32004!)**: after a bridge restart, `ensureRealSession`'s
  durable-store branch runs the SAME eviction guard as in-memory mappings
  (`ensureBackendResident` in handlers/session.ts): resume-before-first-use,
  seeding `sessionCwds` from the record cwd — except via `resolveResumeTarget`
  (`{ensureResident:false}`), because load/resume do their own resume and THAT
  one must carry the client's freshly declared mcpServers (#193). A backend
  that no longer STORES the session answers resume with "Session not found"
  but setModel/setThoughtLevel with "Session is not active" — identical error
  codes, so `isSessionGoneError` matches on the message text; a gone session
  throws the actionable `messages().sessionEvicted` error instead of deferring
  to the misleading wording (observed 2026-09-18: every model/thought switch
  on a deleted thread failed as "Session is not active"). Probed same day:
  3.12+ `session/resume` rejects BOTH `runtimeModel` and `model` keys
  ("Unrecognized key") — the resume overlay fallback is legacy-build-only, a
  not-found resume never retries the overlay, and a schema-rejected overlay
  rethrows the ORIGINAL failure (the old code masked "Session not found"
  behind "Unrecognized key: runtimeModel").
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
- **Martty never sets a terminal title — the bridge does it (OSC 0 via
  /dev/tty)**: martty's binary contains no SetTitle/OSC sequence, so a
  CLI-launched or hub-incubated window otherwise stays named after the command
  ("node"). `src/terminal-title.ts` refreshes the tab at every title lifecycle
  point (session/new fallback = project dir name, first-prompt auto-title,
  adoptStoredTitle on resume/load, remote rename). Do NOT remove the two
  guards: the `marttyClientSeen` gate (a Zed extension host launched from a
  shell HAS a controlling tty — writing there hijacks an unrelated terminal)
  and the `process.env.VITEST` no-op in `ttyTitleIo` (a local vitest run
  shares the developer's real terminal; titles would flash during tests).
- **`session/stop` was IGNORED by the Aug-28 0.16.5 build; 0.16.9 FIXED it —
  keep the dual stop anyway** (source 2026-09-21: `sendPrompt` now registers
  `record.activeAbortController` synchronously at accept,
  `server-operations.ts:1952`, and `stopSession` aborts it — the old
  `hadActivePrompt: false` hole, where the RPC returned `{}` while the
  stream ran to its natural end, is closed). The v4/command stop
  (`payload.expectedForegroundExecutionId` optional — capture it from
  `turn.started` to make ESC precise against a follow-up turn) remains
  strictly stronger: it reaches the runtime-owned foreground execution,
  holds the queue, and pauses the active goal
  (`session-flow.ts:305-368`). stopBackendTurn sends both. Cancel is
  otherwise bridge-side: the turn loop returns `stopReason: "cancelled"` on
  the flag, and a send after a recent cancel settles the backend first
  (drain gate: poll-until-idle, with a `session/close` escalation after a
  5s grace if a generation somehow survives both stops — on 0.16.9 a
  mid-turn send is REJECTED fast with -32010 "A prompt is already running"
  for the whole turn window; the old 0.16.5 "accepted as steer input and
  silently dropped" path is gone, though `turn.steerQueued` can still fire
  from OTHER clients attaching to the same backend via v4 delivery). After a close-escalation reload the drain gate
  must resubscribe the event stream (the reload revives the session but not
  its push — the next turn would run deaf) and re-baseline the projection
  differ (the abandoned turn committed messages while waiting — a stale
  baseline replays that residue as the next reply).
- **Prompt lock ≠ turn liveness** — the conclusion holds, the old framing
  does not (source 2026-09-21: the "1308 lock" does NOT exist in 0.16.9 —
  1308 there is a GLM quota business code; the busy error is -32010 and its
  window is the WHOLE turn, `server-operations.ts:1929-1936`; a mid-turn
  `session/send` now fails fast instead of being queued as steer — steer is
  a v4-only delivery mode). Lock-free probes still prove nothing: quiet
  sub-agent streams advance the `session/read` projection watermark
  (contextUsed/totalTokenCount/turnCount/currentTurnId) for minutes with
  zero stream events — killing a silently running turn on a lock probe
  murdered live sub-agent turns once (PR #85). `runEventTurn` therefore
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
    the managed root `~/.zcode-acp/sandbox/`, pid-encoded `p-<pid>-*`, + O_EXCL
  * the profile denies its own dir AND the whole root last; the root must
    stay off every write-allow list — every agent-writable path is writable by
    prior sandboxed generations too, so a $TMPDIR profile is raceable across
    generations; each arm sweeps dead-pid dirs and legacy `~/.zcode-acp-sbx-*`
    HOME siblings, which the per-bridge chain-cleanup used to leak one per
    restart), and
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
