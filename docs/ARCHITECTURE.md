# zcode-acp-server Architecture

## Overview

`zcode-acp-server` bridges the headless ZCode CLI (`zcode app-server --stdio`) to
ACP (Agent Client Protocol) compatible editors. It is the translation layer
between ZCode's internal JSON-RPC event stream and the standard ACP protocol.

## Layered Architecture

```
application-client (Zed / JetBrains)
  session/update
       |
       v
zcode-acp-server (stdio JSON-RPC ACP)
  |-- handlers/     session, extensions, dispatch, server-requests, io, slash
  |-- translators/    event-translator, projection-differ, tool-helpers
  |-- interaction/    adapter
  |-- config/         options, runtime-model, model-cache
  |-- backend/        client, listener, types
  |-- server.ts       ZcodeAcpServer
       |
       v
zcode app-server --stdio (line-delimited JSON)
```

## ACP Handshake

The `initialize` request (`server.ts`) negotiates the protocol version and
declares the agent's shape to the editor:

- **`protocolVersion`** — pinned to `PROTOCOL_VERSION` (currently 1).
- **`agentInfo`** — name/title/version from `AGENT_INFO` in `utils.ts`.
- **`agentCapabilities`** — `loadSession`, plus `sessionCapabilities.list /
resume / fork`. The prompt capabilities (image/audio/embeddedContext) and
  MCP capabilities are all off.
- **`authMethods`** — a single agent-type entry (`zcode-credentials`). The
  bridge reads the GLM API key itself from `~/.zcode/v2/config.json` and
  forwards it to the ZCode subprocess via `ANTHROPIC_API_KEY`; the editor
  never supplies credentials. Omitting the `type` field defaults to `"agent"`,
  which the ACP registry's auth-check accepts as "agent self-handles auth".

`initialize` does **not** spawn the backend. The backend is lazily created on
the first `session/new` (via `ensureBackend()`), so the handshake succeeds
even in an environment without `~/.zcode/v2/config.json` (e.g. the registry
CI runs `initialize` with an isolated `HOME`).

Client capabilities advertised at `initialize` are recorded on the server
(`clientCapabilities`) and drive later behaviour: `supportsElicitationForm()`
gates form-based elicitation, and `supportsTerminalOutput()` gates Zed's Bash
terminal UI.

## Core Data Flow

### 1. Session lifecycle

```
session/new → session/create → register EventListener
     |
prompt request → session/send → EventTranslator translates → dispatchEvent
     |                                  |
  end_turn / cancelled         session/update notification
```

### 2. Event stream subscription

```
EventStreamListener.subscribe()
  |
session/subscribe (deliveryKind: "desktop-continuous")
  |
ZCode pushes session/event → handleEvent()
  |
pollEvent() consumes → EventTranslator.translate()
```

### 3. Dual-path event handling

#### Real-time path (EventTranslator)

- Listens to zcode `session/event` pushes
- Translates each event to an ACP `session/update` in real time
- Maintains `seenToolIds` to avoid duplicates

#### Snapshot path (ProjectionDiffer)

- On turn completion, builds a snapshot from `session/messages` + `session/read`
- Diffs two snapshots to produce new events (PlanUpdate / TextDelta / ToolCallNew, etc.)
- Used for turn-completion triage and stall recovery

### 4. Dual-path deduplication

```
EventTranslator (real-time path)
  ├── seenToolIds: Set<string>
  └── turnDone: boolean
         |
         v
ProjectionDiffer (snapshot path)
  ├── seenToolIds: Set<string>
  ├── lastToolStatus: Map<string, string>
  └── seenMessageIds: Set<string>
         |
         v
    dispatchEvent (single exit point)
```

Key: **`seenToolIds` synchronization**

In `session.ts:629`, after the event path finishes processing, the state is
synced to the differ:

```typescript
for (const seenId of translator.seenToolIds) {
  differ.markToolSeen(seenId);
}
```

This ensures the snapshot diff does not re-emit tools already handled by the
event path, preventing Bash terminal output from being overwritten by a
content-less ToolCallNew.

## Data & Privacy

**No telemetry, no analytics, no third-party network calls.** The server is a
local relay: prompts, code, and tool outputs pass through process memory on
their way between the editor and the ZCode subprocess, but reach the GLM cloud
API only because the ZCode backend itself sends them for inference.

| Concern | Detail |
| ------- | ------ |
| Network | One outbound request in the whole codebase — `src/quota/client.ts` GET to the quota API, Bearer token only, no body |
| Credentials | API key from `~/.zcode/v2/config.json` (authenticates the subprocess + quota request), never logged. OAuth handled by the ZCode subprocess, not this server |
| Disk | No new files. Writes only to the existing `~/.zcode/v2/tasks-index.sqlite` — syncs sessions into the ZCode app's history & search (session title + first prompt) |
| Logging | `log()`/`warn()` → stderr only for troubleshooting; even with `ZCODE_ACP_DEBUG=1`, no prompts/code/keys are logged |

## Module Responsibilities

### `backend/` — ZCode process communication

| File          | Responsibility                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `client.ts`   | Spawn/manage the zcode subprocess, reader-loop, request/response multiplexing, process watchdog |
| `listener.ts` | EventStreamListener (subscribe/consume the event stream) and TurnMonitor (snapshot polling)     |
| `types.ts`    | ZCode JSON-RPC message type definitions                                                         |

### `translators/` — Event translation

| File                   | Responsibility                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `event-translator.ts`  | Translate zcode events to InternalEvent (real-time path)                                           |
| `projection-differ.ts` | Diff two snapshots to produce InternalEvent (snapshot path)                                        |
| `tool-helpers.ts`      | Tool-related pure functions: title generation, output rendering, diff parsing, location extraction |
| `types.ts`             | InternalEvent union type and plan entry builders                                                   |

### `handlers/` — ACP method handling

| File                 | Responsibility                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `session.ts`         | session/new/list/resume/load/prompt/set_config_option/cancel                                                 |
| `extensions.ts`      | fork/rewind/rewindCascade/goal/compact/steer/cancelBackgroundTask/setModel/setMode/setThoughtLevel           |
| `dispatch.ts`        | dispatchEvent single exit point: InternalEvent → ACP session/update                                          |
| `server-requests.ts` | Handle zcode interaction/* requests (tool auth, ExitPlanMode, AskUserQuestion), protocol negotiation routing |
| `io.ts`              | ACP notification helpers (including `sendAvailableCommandsDeferred` deferred notification)                   |
| `slash.ts`           | Interception of `/`-prefixed commands (/compact /goal /fork /rewind /steer /model /mode /thought)            |

### `interaction/` — Interaction bridging

| File         | Responsibility                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `adapter.ts` | Conversion adapter from zcode interaction requests to ACP (requestPermission + elicitation form) |

### `config/` — Configuration management

| File               | Responsibility                                                 |
| ------------------ | -------------------------------------------------------------- |
| `options.ts`       | configOptions / modes construction, set_config_option dispatch |
| `runtime-model.ts` | runtimeModel overlay construction and application              |
| `model-cache.ts`   | Model ID cache and usage initialization                        |

## Key State Machines

### Turn state

```
          subscribe
              |
         turn.started
              |
    +---------------------+
    | model.streaming     |
    | tool.updated        |
    | session.updated     |
    +---------------------+
              |
    +---------------------+
    | turn.completed      | -> end_turn
    | turn.failed         | -> error
    | turn.cancelled      | -> cancelled
    | timeout (120s)      | -> max_turn_requests
    | manual cancel       | -> cancelled
    +---------------------+
```

### Tool lifecycle

```
scheduled  ->  started  ->  progress  ->  result/error
   |            |            |
ToolCallNew  status=in_progress  output (stdoutTail)
   |
(seenToolIds.add)
```

## Interaction Protocol Negotiation

ZCode `interaction/*` requests are routed to different ACP client interaction
mechanisms via protocol negotiation:

```
zcode interaction request received
  │
  ├─ Tool auth (interaction/requestPermission)
  │     └─ Always uses session/request_permission (its native purpose)
  │
  ├─ ExitPlanMode (interaction/requestUserInput + plan_approval)
  │     ├─ Client supports elicitation.form → elicitation/create (approve/reject form)
  │     └─ Otherwise → session/request_permission (fallback)
  │
  └─ AskUserQuestion (interaction/requestUserInput)
        ├─ Client supports elicitation.form → elicitation/create (single form)
        └─ Otherwise → per-question session/request_permission (fallback)
```

**Key**: `server.supportsElicitationForm()` is detected at `initialize` time from
`clientCapabilities.elicitation.form`. Tool auth always goes through
request_permission, since that is its native purpose.

## Deferred Notification Mechanism

The `available_commands_update` notification must be sent **after** the session
response; otherwise the client's session state machine is not yet ready and
drops the notification, leaving the `/` completion menu empty.

```
session/new|resume|load handler
  │
  ├─ call newSession()/resumeSession()/loadSession()
  │
  ├─ sendAvailableCommandsDeferred(cx, sid, SLASH_COMMANDS)
  │     └─ enqueue, send after 50ms (fire-and-forget)
  │
  └─ return response
       │
       └─ after the response is written to stdout, the 50ms timer fires sendAvailableCommands
```

`sendAvailableCommandsDeferred` (`io.ts`) encapsulates the 50ms delay logic,
mirroring the Python bridge's `_pending_post_notifs` queue +
`_drain_post_notifs` mechanism.

## Mode Reconciliation

The session mode can change through four entry points, all of which must
notify the editor UI:

| Trigger                                | Path                                                           | Notifies UI |
| -------------------------------------- | -------------------------------------------------------------- | :---------: |
| `session/setMode` request              | `extensions.ts:setMode`                                        |     yes     |
| `session/set_config_option` (mode)     | `session.ts:setConfigOptionHandler` → `emitConfigOptionUpdate` |     yes     |
| `/mode` slash command                  | `slash.ts` → `emitConfigOptionUpdate`                          |     yes     |
| In-turn `EnterPlanMode`/`ExitPlanMode` | reconciled at turn completion                                  |     yes     |

The in-turn path bypasses the bridge entirely, so `prompt()` runs
`emitModeIfChanged` (`session.ts`) at turn completion: it re-reads the
authoritative mode via `buildModes`, compares against `server.lastMode`
(the value last advertised to the client), and emits
`current_mode_update` + `config_option_update` when they differ. Failures are
swallowed so they cannot break the turn-completion path.

## Prompt-Lock Release on Stop

`session/stop` is fire-and-forget, but ZCode has a startup delay: when stop
arrives before the turn truly holds the lock the backend ignores it, the turn
runs on, and the lock leaks (next `session/send` fails with
"A prompt is already running").

`ensureTurnStopped` (`session.ts`) closes this gap. It mirrors the
`expectLock:true` strategy from `waitForTurnIdle` (`extensions.ts`):

1. send `session/stop`
2. poll `session/goal show`; first REQUIRE seeing "prompt is running" once
   (proves the turn started), then wait for it to clear
3. if an 8s grace window elapses without ever seeing the lock, the turn never
   started (stop caught it in time) or already ended → treat as released
4. hard timeout 30s

It is used at every stop site: the cancel check, the stall no-output path,
the turn cancelled/failed result, the 120s no-progress timeout, and the
`session/send` error path. Never throws (failures only log) so it cannot
break the cancel path.

## Process Watchdog

`close()` reaps the zcode process group via `process.kill(-pid)`, but only
when the bridge exits cleanly enough for its signal handlers to fire
(SIGTERM/SIGINT). If the bridge is SIGKILLed (Zed force-kill on reconnect,
crash, OOM), the handler never runs and the zcode subprocess group is
orphaned.

The watchdog (`backend/client.ts:startWatchdog`) closes that gap. It is a tiny
detached child that polls the bridge pid every 2s and, once the bridge is
gone, sends SIGKILL to the zcode process group, then exits. It is its own
process-group leader and `unref`'d, so it never holds the event loop open and
is not part of the zcode group it kills. It self-terminates as soon as the
zcode process exits, so a normal shutdown leaves no lingering watchdog.

## Design Decisions

### Why a dual path?

| Scenario               | Real-time path | Snapshot path                   |
| ---------------------- | -------------- | ------------------------------- |
| Normal streaming       | Low latency    | Must wait for turn end          |
| Lost events            | Loses data     | Recovers from snapshot          |
| Deduplication          | seenToolIds    | seenMessageIds + markToolSeen() |
| Turn-completion triage | Not triggered  | PlanUpdate / usage_update       |

### Why no polling fallback?

ZCode CLI 0.14.5 ~ 0.14.7 used `session/read` polling to emulate streaming.
0.14.8+ introduced `session/subscribe` event push, which has lower latency and
is more reliable. This project supports only 0.14.8+ and has removed the
polling fallback code.

### Why does ProjectionDiffer need to persist across turns?

- `seenMessageIds`: prevents historical messages from being re-emitted after resume
- `lastToolStatus` + `seenToolIds`: ensures tool state is not lost across turns
- `lastUsage`: avoids duplicate usage_update pushes
- `lastPlanSig`: emits only when the plan changes
