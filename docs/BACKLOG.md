# Protocol Backlog

Backend RPC methods and event types exposed by the ZCode CLI (`zcode app-server`)
that are **not yet wired into the bridge**, tracked for potential future support.

Last audited against **app-server 0.15.2** (bundled in ZCode desktop 3.4.2,
2026-07-22). Method names were extracted from the bundled `zcode.cjs`.

## Candidate methods (optional enhancements)

These are available in the backend but have no ACP-side counterpart yet. Pick
them up when a concrete ACP/editor need appears.

| Method | Purpose | Current bridge behavior |
|--------|---------|-------------------------|
| `session/subagents` | Query the list of sub-agents for a session | Sub-agent info is parsed from the `Agent` tool result (`_meta.subagent`); sufficient for now |
| `session/events` | Pull-mode event history (complement to `session/subscribe`) | Not used; could support event replay/gap-fill |
| `session/usage` | Per-session token usage | Context bar uses `session.updated` usage payload instead |
| `session/close` | Explicitly close a session (vs `session/stop` which ends a turn) | Not used; sessions close on process exit |

### New event types (undocumented in PROTOCOL.md)

| Event | Status field | Notes |
|-------|--------------|-------|
| `turn.steerQueued` | — | Emitted when a `session/steer` is queued behind a running turn. Enhances steer UI feedback |
| `turn.steerDrained` | — | Emitted when queued steer instructions are drained into the turn |
| `turn.terminal` | `status: success \| interrupted \| failed`, `resultType?`, `durationMs`, `...usage` | Terminal turn lifecycle event; currently the bridge relies on `turn.completed`/`turn.failed` |

## Not planned (client/config layer)

These methods belong to the desktop client or workspace configuration layer and
have no ACP equivalent. Listed for completeness only — the bridge does not
intend to surface them.

`automation/create`, `automation/list`, `automation/delete` (scheduled tasks),
`usage/stats` (token analytics; the account-level plan quota it does NOT cover
is exposed via the bridge's own `account/usage_stats` — see Proposal 0002),
`workspace/readState`, `workspace/upsertModelProvider`,
`workspace/removeModelProvider`, `workspace/updateProviderRegistry`,
`workspace/setDefaultModel`, `workspace/setDefaultThoughtLevel`,
`workspace/setDefaultMode`, `workspace/generateText`, `mcp/list`,
`plugins/list`, `plugins/setEnabled`, `plugins/overview`, `plugins/describe`,
`plugins/marketplace/*`.

## Verification method

The bundled CLI is minified, so a literal `grep "session/rewind"` returns 0
hits even when the method is fully supported — method names are split across
variable references. To audit reliably:

```sh
cd /Applications/ZCode.app/Contents/Resources/glm
# Full RPC enum: search for the method-dispatch table (Key:"ns/name" pairs)
python3 -c "import re; ..."   # see commit that added this file
# Word-level presence is more reliable for verifying a method still exists:
grep -oiF "rewind" zcode.cjs | wc -l   # 357 → definitely present
```

Never conclude a method was removed from a single string-literal search.
