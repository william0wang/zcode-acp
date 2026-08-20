# Protocol Backlog

Backend RPC methods and event types exposed by the ZCode CLI (`zcode app-server`)
that are **not yet wired into the bridge**, tracked for potential future support.

Last audited against **app-server 0.16.3** (bundled in ZCode desktop 3.8.1,
2026-08-09). Method names were extracted from the bundled `zcode.cjs` dispatch
switch and verified with live RPC calls.

## Removed upstream in 0.16 (verified live: `-32601`)

| Method                  | Replacement                                          | Bridge action                                       |
| ----------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `session/steer`         | v4 command/conversation API                          | Dropped the ACP extension + `/steer` slash command  |
| `session/rewind`        | `v4/conversation/fileRewindPreview` + v4 rewind flow | Dropped the ACP extension + `/rewind` slash command |
| `session/rewindCascade` | v4 rewind flow                                       | Dropped the ACP extension                           |

`session/fork` (branch from checkpoint) is the remaining v3 alternative for
rewind-like UX. The backend still emits `rewind.triggered` /
`checkpoint.created` events, so a client can observe rewinds initiated
elsewhere.

## Candidate methods (optional enhancements)

Available in the backend but with no ACP-side counterpart yet. Pick them up
when a concrete ACP/editor need appears.

| Method                                                                          | Purpose                                                     | Current bridge behavior                                                                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `session/subagents`                                                             | Query the list of sub-agents for a session                  | Sub-agent info is parsed from the `Agent` tool result (`_meta.subagent`); sufficient for now                           |
| `session/events`                                                                | Pull-mode event history (complement to `session/subscribe`) | Not used; could support event replay/gap-fill                                                                          |
| `session/usage`                                                                 | Per-session token usage                                     | Context bar uses `session.updated` usage payload instead                                                               |
| `workspace/hooks/trustGrant`                                                    | Server→client request: approve hook trust                   | Auto-errored by the unknown-request fallback (`server-requests.ts` `handleOne`) during turns; `session/send` carries a 15s timeout so nothing hangs. If hook trust ever needs real UX, map it onto ACP `session/request_permission` |
| `interaction/browserList` / `interaction/browserExecute`                        | Server→client requests: browser automation via the client   | Auto-errored by the fallback above; only meaningful once an ACP client has a browser surface                                                 |
| `interaction/requestProviderRuntimeHeaders`                                     | Server→client request: provider runtime headers             | Auto-errored by the fallback above                                                                                     |
| `workspace/updateInteractionPreferences` / `workspace/updateModelIoPreferences` | Client preference updates                                   | Not used                                                                                                               |

### New `session/send` params (0.16+)

`attachments` is already wired: ACP image content blocks are extracted
(`extractAttachments`) and forwarded as `kind:"image"` entries (`localPath`
for `file://` uris, `dataBase64` otherwise). The remaining fields are not
forwarded:

- `toolDenylist` — per-message tool deny list
- `runtimeModel` — per-message model override (redundant with the bridge's
  `session/setModel` / config-option switching)
- `browserAmbientContext` — browser context for the turn
- `expectedRevision` / `expectedProviderRevision` / `expectedModelRuntimeRevision`
  — optimistic concurrency guards
- `automationId` / `offPeakTaskId` / `offPeakRunType` — scheduled/off-peak tasks

### New event types (undocumented in PROTOCOL.md)

| Event                                    | Notes                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `checkpoint.created`                     | Checkpoint lifecycle; pairs with `rewind.triggered`                        |
| `rewind.triggered`                       | A rewind happened (e.g. initiated elsewhere)                               |
| `streamRecovery.updated`                 | Stream recovery progress — potentially useful for the replay/gap-fill path |
| `turn.attachments.resolved`              | Attachment resolution telemetry                                            |
| `usage.delta`                            | Streaming usage updates                                                    |
| `turn.steerQueued` / `turn.steerDrained` | Steer lifecycle (queue/drain of steered inputs)                            |
| `turn.terminal`                          | Terminal turn lifecycle; bridge relies on `turn.completed`/`turn.failed`   |

## v4 protocol family (strategic)

0.16 ships a parallel **v4** API used by the desktop client, alongside the v3
`session/*` surface this bridge speaks:

`v4/connection/flow`, `v4/controller/{subscribe,resync,unsubscribe}`,
`v4/conversation/{subscribe,resync,unsubscribe,rowsRange,plans,fileChanges,
fileRewindPreview,usage}`, `v4/attachment/{begin,chunk,commit,abort,read}`,
`v4/usage/stats`, `v4/commands/query`, `v4/command`.

Steer/rewind now live here. If the bridge ever needs them back, implementing
the minimal v4 conversation subset (or `v4/command`) is the path; expect the
v3 surface to stay in maintenance mode.

## Not planned (client/config layer)

These methods belong to the desktop client or workspace configuration layer and
have no ACP equivalent. Listed for completeness only — the bridge does not
intend to surface them.

`automation/*` (scheduled tasks), `usage/stats` (token analytics; the
account-level plan quota it does NOT cover is exposed via the bridge's own
`account/usage_stats` — see Proposal 0002), `workspace/readState`,
`workspace/upsertModelProvider`, `workspace/removeModelProvider`,
`workspace/updateProviderRegistry`, `workspace/setDefaultModel`,
`workspace/setDefaultThoughtLevel`, `workspace/setDefaultMode`,
`workspace/generateText`, `workspace/cancelGenerateText`, `mcp/list`,
`plugins/*` (the bridge reads plugin commands from disk instead).

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
missing dispatch case plus a live `-32601` is the proof.
