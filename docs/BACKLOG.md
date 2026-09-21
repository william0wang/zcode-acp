# Protocol Backlog

Backend RPC methods and event types exposed by the ZCode CLI (`zcode app-server`)
that are **not yet wired into the bridge**, tracked for potential future support.

Last audited against **app-server 0.16.5 bundled in ZCode desktop 3.12.3**
(2026-09-18; the CLI still self-reports "0.16.5" across desktop versions —
the app version, not the CLI string, dates a bundle). Method names were
extracted from the `zcode.cjs` method-name enum (`session/create` → 65
entries) and the v4 enum; event types from the zod event-envelope union.

**Source of truth (2026-09-21)**: ZCode open-sourced — local checkout at
`~/Develop/NoBackup/ZCode` (remote `github.com/zai-org/ZCode`; desktop 3.14.0 =
app-server `apps/zcode-cli` 0.16.9, the exact binary the bridge runs). The
protocol enum and zod schemas live unminified at
`packages/shared/src/zcode-protocol/index.ts`; the protocol server dispatch at
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/` (server.ts,
server-operations.ts); the agent runtime at `apps/zcode-cli/packages/core/`
(`packages/zcode-server-cli` is only a thin CLI shell). Prefer reading source
over the bundle-extraction method in "Verification method" (kept for released
versions newer than the checkout — pull the checkout before auditing a new
version). Full audit detail with `file:line` evidence:
`.zcode/scratch/alignment-protocol.md` (protocol surface) and
`.zcode/scratch/alignment-hacks.md` (Gotchas verification).

**3.14.0 audit (2026-09-20, app-server 0.16.9 — live-probed end to end)**: the
dynamic-workflow family (ten model tools led by `CreateWorkflow`) is OFF by
default headless and enabled per PROCESS via
`workspace/updateDynamicWorkflowPolicy` — the flag is process-global (the
`workspace` param is echoed, never used for lookup), has no persistence, and
mid-session flips do not reach live sessions. The
`session/requestRuntimePreferences` response schema is `.strict()` and cannot
carry the flag; `session/create` / `session/resume` accept a
`dynamicWorkflowEnabled` param that ORs with the global. (Source-confirmed
2026-09-21: the in-agent gate defaults ON — only an explicit `false` removes
the tools — so the fail-closed default lives only at the protocol layer and
the per-session create param is sufficient; closing the gate also removes the
`dynamic-workflows` skill and `/workflow` command,
`core/src/tool/handlers/index.ts:177-183`, `bootstrap/src/app/create-app.ts:755-807`.)
Run observability lives OUTSIDE the `session/event` stream:
`workflow.lifecycle` (phases are exactly `actor-spawned` / `run-settled`)
arrives on `v4/telemetry/event`, and `sess_dwf-*` child sessions push their
turn/tool events on `computer-use/operation-event`. Bridge wiring (opt-in
enable + narrow observability tap) is designed in ADR-0024, not yet
implemented.

## Removed upstream in 0.16 (verified live: `-32601`)

| Method                  | Replacement                                          | Bridge action                                       |
| ----------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `session/steer`         | v4 command/conversation API                          | Dropped the ACP extension + `/steer` slash command  |
| `session/rewind`        | `v4/conversation/fileRewindPreview` + v4 rewind flow | Dropped the ACP extension + `/rewind` slash command |
| `session/rewindCascade` | v4 rewind flow                                       | Dropped the ACP extension                           |

Also absent from the 0.16.9 method enum (source-verified 2026-09-21 — bundle
audit had kept them as candidates or "not planned"): the whole
workspace-defaults/provider cluster — `workspace/readState`,
`workspace/setDefaultMode`, `workspace/setDefaultModel`,
`workspace/setDefaultThoughtLevel`, `workspace/upsertModelProvider`,
`workspace/removeModelProvider`, `workspace/updateProviderRegistry`. The only
`workspace/*` methods left: `readPresentation`, `hooks/trustGrant`,
`updateInteractionPreferences`, `updateModelIoPreferences`,
`updateOffPeakToolPolicy`, `updateDynamicWorkflowPolicy`, `generateText`,
`cancelGenerateText` (`index.ts:3597-3611`).

`session/fork` (branch from checkpoint) is the remaining v3 alternative for
rewind-like UX. The backend still emits `rewind.triggered` /
`checkpoint.created` events, so a client can observe rewinds initiated
elsewhere.

## Deprecated in source (0.16.9 enum comments, wire cases kept)

The protocol enum now labels these `@deprecated` (`index.ts:3573-3645`); wire
cases remain, so calls still work, but plan for the v4 successors:

| Method                         | Source note                                                                                         | Bridge call site                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `session/send`                 | Main path converged on v4 `sendText`; only the adapter-attachment fallback branch still consumes    | the turn loop (fine until v4 lands) |
| `session/stop`                 | Host client method deleted (stop converged on the v4 stop command)                                  | `stopBackendTurn` (dual-send)       |
| `session/cancelBackgroundTask` | Replacement: v4 `cancelBackgroundWork`                                                              | `handlers/extensions.ts`            |
| `session/fork`                 | Desktop host client chain deleted; v4 `forkAssistant` (via `forkSessionAtMessage`) is the successor | `handlers/extensions.ts`            |
| `usage/stats`                  | Host consumption moved to `v4/usage/stats`; wire-compat case only                                   | not used                            |
| `session/usage`                | Host moved to `v4/conversation/usage`; slated for removal with `usage/stats`                        | candidate only                      |

## Candidate methods (optional enhancements)

Available in the backend but with no ACP-side counterpart yet. Pick them up
when a concrete ACP/editor need appears. Ranked shortlist in
"Alignment opportunities" below.

| Method                                                                                                                                                                                                                                                                                                                                                          | Purpose                                                                                                                                                   | Current bridge behavior                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/subagents` (`index.ts:1520-1618`)                                                                                                                                                                                                                                                                                                                      | Sub-agent states: `running{status: running\|waiting\|blocked}`, `ended{total, items[{status: success\|failed\|cancelled\|lost}], nextCursor}`             | Sub-agent info is parsed from the `Agent` tool result (`_meta.subagent`); the RPC adds waiting/blocked/lost states for stuck-subagent detection (pairs with the watermark liveness logic in `runEventTurn`)                                                                                                     |
| `session/events` (`{sessionId, afterSeq?, limit?}`, `index.ts:1667-1674`)                                                                                                                                                                                                                                                                                       | Pull-mode event history                                                                                                                                   | Not used; gap-fill after the drain gate's close-escalation reload (re-subscribe + replay only the missed window), durable audit for `/debug`                                                                                                                                                                    |
| `session/subscribe` `afterSeq` + `includeSnapshot` (`index.ts:1496-1513`)                                                                                                                                                                                                                                                                                       | Resume the event stream from a seq watermark, optionally with a full state snapshot                                                                       | Not used; crash-safe resubscribe instead of full replay                                                                                                                                                                                                                                                         |
| `session/usage` / `v4/conversation/usage`                                                                                                                                                                                                                                                                                                                       | Per-session cumulative usage: input/output/reasoning/cache tokens, `modelRequestCount`, `modelErrorCount` (`index.ts:1627-1646`)                          | Per-turn billing usage is now carried on the ACP `session/prompt` result (`usage` + `_meta.zcode.usage`), sourced from `turn.completed`; this RPC remains a candidate for session-cumulative reconciliation (deprecated upstream, see table above)                                                              |
| `session/compact` `instructions` + `result.compact` (`index.ts:1829-1853`)                                                                                                                                                                                                                                                                                      | Custom compact instructions; result acks `{state: accepted\|already_running, inputId?, operationId?}`                                                     | Not forwarded — `/compact <focus>` could pass instructions; the backend's own `already_running` ack can backstop the bridge's `autoCompactInFlight` single-flight                                                                                                                                               |
| `session/debug` (`index.ts:3571`, `bootstrap/src/zcode-protocol/session-debug.ts`)                                                                                                                                                                                                                                                                              | Per-session debug snapshot accumulated from the live event stream                                                                                         | Not used; `zcode-acp` diagnostics command / `/debug` extension                                                                                                                                                                                                                                                  |
| `session/list` rich params (`sessionIds` incl. hidden, `includeArchived`, `limit`, `index.ts:1600-1609`)                                                                                                                                                                                                                                                        | Explicit identity lookup, archived sessions                                                                                                               | Not used                                                                                                                                                                                                                                                                                                        |
| `session/create` extras: `toolAllowlist`/`toolDenylist` (per-session tool face — could move Cron* hiding off process-wide `--disallowed-tools`), `importedHistory` (claudeCode / sharedContext+sha256 provenance), `persistence:"immediate"\|"deferred"`, `titleGenerationEnabled:false` (bridge sets its own titles), `parentSessionId` (`index.ts:1558-1580`) | Session-creation knobs                                                                                                                                    | Not forwarded; `session/resume` also takes `toolAllowlist`/`toolDenylist` — a resume WITHOUT them drops the tool face on cold recovery (`index.ts:1589-1595`)                                                                                                                                                   |
| `mcp/list` `mode:"status"` (`index.ts:686-723`)                                                                                                                                                                                                                                                                                                                 | Status without connecting: per-server `{status, transport, toolCount, failureKind(19-value enum), authorization{authorizationUrl}}`                       | Not used; editor MCP health panel + OAuth start URL without new transport                                                                                                                                                                                                                                       |
| `process/childProcesses` (3.12.3)                                                                                                                                                                                                                                                                                                                               | List a session's child processes (`{pid, serverName, mcpSource, pluginName?}`, pure memory)                                                               | Not used; potentially useful for background-task diagnostics                                                                                                                                                                                                                                                    |
| `skills/referenceCatalog`, `plugins/referenceCatalog[WithCategory]` (categorized variant new in 0.16.9)                                                                                                                                                                                                                                                         | Session-scoped FROZEN catalogs — the authoritative per-session view vs the bridge's live disk reads                                                       | Not used; fixes the stale-catalog class of bug (backend freezes discovery at session start)                                                                                                                                                                                                                     |
| `workspace/readPresentation` (3.12.3)                                                                                                                                                                                                                                                                                                                           | The backend's own view of workspace mode + slash-command list                                                                                             | Not used; cross-check the bridge's disk-based slash discovery for drift                                                                                                                                                                                                                                         |
| `workflows/*` family (NEW 0.16.9: `list/get/updateMeta/delete/runs/move`, `index.ts:2685-2937, 3618-3625`)                                                                                                                                                                                                                                                      | Session-less management of saved dynamic workflows (`<cwd>/.zcode/workflows/`, project+global scopes), run history with `artifacts`, cross-cwd runs query | Not used; pairs with v4 commands `startSavedWorkflow` / `resumeWorkflowRun`                                                                                                                                                                                                                                     |
| `provider/testModelConnectivity` (3.12.3)                                                                                                                                                                                                                                                                                                                       | Probe a provider/model endpoint                                                                                                                           | Not used; model availability comes from the `session/create` response                                                                                                                                                                                                                                           |
| `runtime/capabilities` (3.12.3; returns `{independentPlanState:true}`)                                                                                                                                                                                                                                                                                          | Trivial capability handshake                                                                                                                              | Not used; cheap preflight for a `zcode-acp doctor` command                                                                                                                                                                                                                                                      |
| `interaction/providerRuntimeHeadersCancelled` notification (`index.ts:336, 2396-2406`)                                                                                                                                                                                                                                                                          | Backend cancels a pending runtime-headers refresh (workspace/session/requestId scoped)                                                                    | Not handled; drop pending answerers immediately on turn cancel instead of waiting them out                                                                                                                                                                                                                      |
| `workspace/generateText` / `workspace/cancelGenerateText` (0.16.5)                                                                                                                                                                                                                                                                                              | Workspace-scoped one-shot text generation                                                                                                                 | Not used; no ACP counterpart                                                                                                                                                                                                                                                                                    |
| `workspace/updateInteractionPreferences` / `workspace/updateModelIoPreferences`                                                                                                                                                                                                                                                                                 | Client preference updates                                                                                                                                 | Not used                                                                                                                                                                                                                                                                                                        |
| `offPeak/{create,list}`, `workspace/updateOffPeakToolPolicy` (3.12.3)                                                                                                                                                                                                                                                                                           | Off-peak (discounted-hours) task family                                                                                                                   | Not used; `session/send` carries the matching `offPeakTaskId`/`offPeakRunType` params — candidate if a client wants to schedule discounted-hours runs. Off-peak tools are fail-closed at the protocol layer with three unlock channels (per-session param OR'd, process policy method, `offPeakPort` injection) |
| `automation/{create,update,list,delete,checkTaskBinding}` (3.12.3)                                                                                                                                                                                                                                                                                              | Scheduled (cron) task family — served by the host over `automation/*` requests                                                                            | Not planned (see below)                                                                                                                                                                                                                                                                                         |
| `plugins/{list,setEnabled,overview,install,uninstall,update,cancelOperation,restoreBuiltin,configure,resetConfig,validate,describe}` + `plugins/marketplace/{add,remove,update}` (3.12.3)                                                                                                                                                                       | Full plugin management + marketplace family                                                                                                               | Not used — **compat watchpoint**: if upstream moves plugin distribution to the marketplace, the bridge's disk-based discovery (`config/plugin-commands.ts`) may go stale                                                                                                                                        |

### `session/send` params (0.16.9-verified, `index.ts:1730-1768`)

Actual field list: `sessionId, modelSelection, modelExecution, inputId, queryId,
content, attachments, browserAmbientContext, expectedRevision,
expectedProviderRevision, automationId, offPeakTaskId, offPeakRunType,
toolDenylist`. Not forwarded by the bridge today:

- `modelSelection` — per-message model override `{providerId, modelId,
options:{reasoningLevel?}}` (`packages/shared/src/model-selection.ts`); the
  previously-listed `runtimeModel` does NOT exist in 0.16.9 (bundle-audit
  error). Enables per-turn model switching without a `session/setModel`
  round-trip.
- `modelExecution` — requires `modelSelection` (superRefine); carries per-turn
  credentials `requestAuth:{apiKey?, headers?}` plus sub-agent policy
  (`subagents:{foregroundModel, background}`) and
  `memoryExtraction:"skip"`. Complements `answerProviderRuntimeHeaders`.
- `toolDenylist` — per-message tool deny list.
- `browserAmbientContext` — browser context for the turn.
- `expectedRevision` / `expectedProviderRevision` — optimistic concurrency
  guards. (`expectedModelRuntimeRevision`, previously listed, does not exist.)
- `automationId` / `offPeakTaskId` / `offPeakRunType` — scheduled/off-peak tasks.

### Event vocabulary (0.16.9 envelope union — exactly 25 types, `index.ts:1100-1126`)

`session.created`, `session.resumed`, `session.updated`, `session.titleUpdated`,
`session.closed`, `turn.started`, `turn.steerQueued`, `turn.steerDrained`,
`turn.completed`, `turn.failed`, `message.upserted`, `message.removed`,
`part.started`, `part.delta`, `part.upserted`, `part.removed`,
`model.streaming`, `tool.updated`, `permission.requested`,
`permission.resolved`, `userInput.requested`, `userInput.resolved`,
`checkpoint.created`, `rewind.triggered`, `streamRecovery.updated`.

Notes per type (the ones with known bridge relevance):

| Event                                                                    | Notes                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.titleUpdated`                                                   | **Wired** — `SessionTitleListener` adopts `generated`/`custom` pushes                                                                                                                                                                                                                             |
| `message.upserted` / `message.removed`                                   | Message-granular upsert/remove; the projection differ reconciles instead                                                                                                                                                                                                                          |
| `part.started` / `part.delta` / `part.upserted` / `part.removed`         | Message-PART granular streaming (the v4 conversation model on the v3 envelope)                                                                                                                                                                                                                    |
| `permission.requested` / `permission.resolved`                           | Interaction lifecycle OBSERVER events; the bridge serves the request methods                                                                                                                                                                                                                      |
| `userInput.requested` / `userInput.resolved`                             | Same, for user-input interactions                                                                                                                                                                                                                                                                 |
| `checkpoint.created` / `rewind.triggered`                                | Checkpoint + rewind lifecycle (rewinds initiated elsewhere are observable)                                                                                                                                                                                                                        |
| `streamRecovery.updated`                                                 | Stream recovery progress — payload is an untyped `jsonObjectSchema` upstream; useful for the replay/gap-fill path                                                                                                                                                                                 |
| `turn.started` payload extras (`index.ts:1168-1186`)                     | `executionKind:"agent"\|"controlOnly"` (controlOnly = no model turn — the bridge's own boot-resume ack could be classified by this instead of text-matching), `foregroundExecutionId` (feeds the precise v4 stop), `backgroundSource`, `intent`, `originMeta`                                     |
| `turn.steerQueued` / `turn.steerDrained` payloads (`index.ts:1191-1229`) | Queue length, `commandKind`, `delivery`, `targetTurnId`, drained `injectedMessageIds` — enough to render a proper "queued behind running turn" ACP update. Steer is only reachable via v4 delivery semantics (see Gotchas) — a steer caused by ANOTHER client on the same backend is visible here |
| `turn.completed` `resultType` + `cacheStats` (`index.ts:1230-1261`)      | `resultType: success\|cancelled\|error_max_turns\|error_max_budget\|error_during_execution\|error_max_tool_calls`; `cacheStats{totalMessages, cachedMessages, lastCacheHit, cacheReadTokens?}` — rich terminal lines + cache-health visibility                                                    |
| `turn.failed` `turnPhase` (`index.ts:1262-1269`)                         | Failure phase string for better triage                                                                                                                                                                                                                                                            |
| `model.streaming` kinds (`index.ts:987-1014`)                            | 13 kinds incl. `reasoning_*` deltas — relevant if thinking streams are ever surfaced directly                                                                                                                                                                                                     |
| `session.updated` with `state.updated` mutation reasons                  | Compact terminal state IS observable here: `session_compacted` / `session_compact_cancelled` / `session_compact_failed` (source: `server-operations.ts:2082-2119`) — the bridge can report real compact failures instead of assuming success from the RPC ack                                     |

**Corrected 2026-09-21 (source)**: `rewind.started` / `rewind.failed` /
`rewind.completed`, `turn.attachments.resolved`, `usage.delta`, and
`turn.terminal` are NOT in the 0.16.9 union — bundle-audit false positives;
rows removed.

Unknown event types fall through the translator's else-chain untranslated and
silently — new backend events never produce noise or errors, so additions
here are informational, not blocking.

Not on this stream (verified live 2026-09-20, 3.14.0): `workflow.lifecycle`
arrives on `v4/telemetry/event`, and `sess_dwf-*` workflow child sessions push
their own turn/tool events on `computer-use/operation-event`; neither is a
`session/event` type. The bridge ignores both channels today — the workflow
observability design (ADR-0024) taps them narrowly and re-attributes child
events to the parent session.

### CLI→host notifications (bridge IS the host — currently ignored)

`startup/storageState` (DB phases checking/waiting_for_lock/migrating/
committing/ready/failed — could drive a real "backend starting" indicator;
control frames `startup/storagePath|storagePrepared|storagePathReady`),
`process/mcpTelemetry` (process_start/process_crash/session_startup/memory),
`process/mcpResourceSamples` (5-min MCP RSS/CPU), `process/toolExecResource`
(bash completion facts), `process/resourceSample`,
`plugins/operationProgress` (`index.ts:334-451, 3696-3713`).

## v4 protocol family (strategic)

0.16 ships a parallel **v4** API used by the desktop client, alongside the v3
`session/*` surface this bridge speaks. Full method table:
`packages/shared/src/zcode-protocol-v4/transport.ts:307-359` (larger than the
list below — see source for the authoritative set).

`v4/connection/flow`, `v4/controller/{subscribe,resync,unsubscribe}`,
`v4/conversation/{subscribe,resync,unsubscribe,rowsRange,plans,fileChanges,
fileRewindPreview,usage,attachmentRead,attachmentStat,frame,backgroundBashOutput,
workflowRunEvents,workflowRuns,workflowRunArtifacts,workflowRunArtifactData,
workflowRunArtifactRead,workflowRunWorkspace,workflowRunNodeResult}`,
`v4/attachment/{begin,chunk,commit,abort,read,previewSource}` (≤512KiB
chunks), `v4/usage/stats`, `v4/conversation/usage`, `v4/commands/query`
(idempotency probe), `v4/command`, `v4/command_fact`,
`v4/shared_context_import`, `v4/telemetry/event`, `v4/telemetry/local-ttft`,
`v4/cua/permission-observation`, `v4/fork_start_failure`.

Topic model (`transport.ts:83-161`): subscribe with
`{topic, base:{logEpoch, seq}, visibility}` → ACK
`{subscriptionId, mode: snapshot|resume, logEpoch}`; frames are `(fromSeq,
toSeq]` deltas — the watermark/CAS vocabulary row-targeting commands require
(`baseRevision` + `baseLogEpoch`, `command.ts:293-317`).

The bridge already speaks `v4/command` (the dual stop). Its payload union
(`command.ts:43-244`) is a single-method stepping stone to
rewind/edit-turn/feedback/queue UX over ACP without implementing the v4
subscription mesh: `sendText (requestedDelivery startNow|queue|guide,
heldQueueDisposition)`, `stop (expectedForegroundExecutionId — obtainable
from `turn.started`; the CLI uses it to reject late stops that would kill a
newer unrelated execution)`, `compact`, `forkAssistant`, `applyFileRewind`,
`editUserQuery`, `retryTurn`, `setAssistantFeedback`, queue ops
(`sendQueuedNow`, `editQueueItem`, `reorderQueueItem`, `deleteQueueItem`,
`setAutoDrain`), `resolveInteraction`, `snoozeInteractionAutoResolution`,
`switchModelConfig`, `switchCollaborationMode (build|edit|plan|yolo)`,
`pauseGoal`/`resumeGoal`, `cancelBackgroundWork`, workflow ops
(`startSavedWorkflow`, `resumeWorkflowRun`, `amendWorkflowRunSettings`),
`renameSession`, `deleteSession`, `discardSharedContext`.

Hook trust is also v4 now: `respondWorkspaceHookReview` /
`toggleWorkspaceHookReviewItem` / `revokeWorkspaceHookTrust` /
`requestWorkspaceHookReview` (`command.ts:186-200`). The v3
`workspace/hooks/trustGrant` is CLI-HOSTED (host→CLI; the CLI's dispatch
handles it — `bootstrap/src/zcode-protocol/server.ts:607-625`), so the bridge
will never RECEIVE it (previous BACKLOG framing was wrong).

## Not planned (client/config layer)

These methods belong to the desktop client or workspace configuration layer and
have no ACP equivalent. Listed for completeness only — the bridge does not
intend to surface them.

`automation/*` (scheduled tasks), `usage/stats`, `workspace/generateText`,
`workspace/cancelGenerateText`, `mcp/list` (connect mode), `plugins/*` (the
bridge reads plugin commands from disk instead).

**Automation tool gating, corrected against source (2026-09-21)**: there is NO
backend env gate — `ZCODE_ENABLE_AUTOMATION_TOOLS` exists only in the bridge
(`src/backend/resolve.ts`). The backend registers `CronCreate/CronList/
CronUpdate/CronDelete` whenever an `automationPort` is injected
(`core/src/runtime/helpers/runtime-tools.ts:66`), and the legacy protocol
server injects one for every session create
(`server-operations.ts:3370`) — so the backend ALWAYS registers them in
app-server mode. Opting out is entirely the bridge's `--disallowed-tools`
(or per-session `toolDenylist`). Bonus:
`AUTOMATION_MUTATION_TOOL_NAMES = [CronCreate, CronUpdate, CronDelete]` gets
special turn-loop treatment (`turn-loop-state.ts:23`).

## Alignment opportunities (2026-09-21, source-verified — ranked)

Status markers updated after the 2026-09-21 implementation pass. Details and
`file:line` in `.zcode/scratch/alignment-protocol.md`.

1. ~~**Precise ESC**~~ **WIRED (already present)** — `stopBackendTurn`
   already captures `foregroundExecutionId` from `turn.started` and sends it
   in the v4 stop, with a compaction guard for never-started turns; the
   source pass only corrected the outdated comment.
2. ~~**`/compact <focus>`**~~ **WIRED** — instructions forwarded (trimmed);
   `already_running` ack surfaced; falls through to the same lock wait.
3. ~~**Real compact failure reporting**~~ **WIRED** — `state.updated`
   reasons (`session_compact_failed`/`_cancelled`) recorded via
   `ZcodeBackend.onCompactOutcome` → `server.compactOutcomes`; compact()
   reports `__compactFailed` (slash + auto-compact paths); usage refresh
   suppressed on failure. Regression tests: `tests/compact-outcome.test.ts`.
   Bonus fix from the same source pass: `waitForTurnIdle`'s lock probe now
   matches 0.16.9's "A prompt is already running" wording (previously only
   the 0.16.5 "prompt is running" substring — on 0.16.9 every probe fell to
   the NON-LOCK branch and relied on the 30s grace).
4. ~~**Drain-gate simplification**~~ **WIRED (behavior-adaptive,
   2026-09-21)** — `server.observedSendBusyReject`: once this backend
   process has rejected a send with -32010 "A prompt is already running for
   this session" (code AND message — -32010 is shared by unrelated errors),
   the drain gate's pre-send poll (and its close-escalation) is skipped and
   the send busy-retry loop is the single authority. Parity kept: one-shot
   queued note on busy waits, post-accept differ re-baseline
   (`sendAttempt > 1` ⇒ the abandoned turn unwound during our retries).
   Backends that never showed the rejection keep the full legacy gate.
   Regression tests: `tests/drain-gate-fast-path.test.ts`.
5. ~~**`session/subagents`** + **`session/events` afterSeq**~~ **WIRED
   (2026-09-21)** — sub-agent status text lines during silent phases: the
   stall-reconcile probe polls `session/subagents` and surfaces roster
   CHANGES as one-line `agent_message_chunk` updates (running/waiting/blocked
   - a one-shot ended summary with failed/cancelled counts; best-effort,
     -32601 backends are silent). Gap-fill landed via the ALREADY-WIRED
     subscribe channel instead of the pull RPC: `resubscribe` consumes the
     missed window the backend returns IN the subscribe response (`events`,
     seq-ordered, deduped against the watermark), and the initial `subscribe`
     now OMITS `afterSeq` — the old explicit `afterSeq: 0` made the backend
     materialize the FULL event log into a response the bridge discarded,
     every turn. `session/events` itself stays a `/debug`-only candidate.
     Regression tests: `tests/subagent-status.test.ts`,
     `tests/resubscribe-gap-fill.test.ts`.
6. ~~**`mcp/list mode:"status"`**~~ **WIRED (2026-09-21)** — `/mcp` upgraded
   to a live health panel (per-server `name · status · N tools ·
failureKind`, OAuth `authorizationUrl` indented beneath its server; any
   RPC failure falls back to the local-discovery card). Regression tests:
   `tests/mcp-health.test.ts`.
7. ~~**Retire `session/updateRuntimeModelConfig`**~~ **DONE** — the ACP
   extension method and handler were removed (absent from the 0.16.9 enum,
   every call answered -32601); `setModel` + `applyModelSwitch` cover the
   path on all builds.
8. ~~**Cancel stale header answerers**~~ **DONE (minimal)** — the responder
   answers at frame arrival, so nothing is ever pending;
   `interaction/providerRuntimeHeadersCancelled` is now logged-and-acked
   instead of silently ignored.
9. ~~**`turn.completed` `resultType`/`cacheStats`**~~ **WIRED (2026-09-21)** —
   one turn-end status line per reply (agent_message_chunk, distinct
   messageId): success renders prompt-cache stats (`cache N/M messages ·
cache-read tokens`), non-success resultTypes surface verbatim as a
   warning line. Regression tests: `tests/turn-info-line.test.ts`.
10. **Per-session `toolDenylist` at create/resume** — move Cron* hiding off
    process-wide `--disallowed-tools`; note a resume WITHOUT the lists drops
    the tool face on cold recovery. PENDING.
11. **v4/command channel** as the single implementation surface for
    rewind/edit/feedback/queue UX later. PENDING.

## Verification method

The bundled CLI is minified, so a literal `grep "session/rewind"` returns 0
hits even when the method is fully supported — and vice versa, string absence
proves nothing. To audit reliably:

```sh
cd /Applications/ZCode.app/Contents/Resources/glm
# 1. Extract the RPC dispatch switch (all `case XX.method:` labels).
#    The `default:` branch throws -32601, so a method with no case is gone.
python3 - <<'EOF'
import re
src = open('zcode.cjs', encoding='utf-8', errors='replace').read()
i = src.find('case rr.sessionCreate')
start = src.rfind('switch', 0, i)
cases = re.findall(r'case (?:rr|Pc)\.([a-zA-Z]+)', src[start:start+20000])
print(' '.join(dict.fromkeys(cases)))
EOF
# 2. Confirm with a live call — the envelope has NO `jsonrpc` field:
#    {"id":1,"method":"session/steer","params":{...}} → -32601 means removed.
```

Never conclude a method was removed from a single string-literal search; a
missing dispatch case plus a live `-32601` is the proof. With the open-source
checkout available, prefer reading `packages/shared/src/zcode-protocol/index.ts`

- the dispatch switch in
  `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts` first; fall
  back to this method only for released versions newer than the checkout.
