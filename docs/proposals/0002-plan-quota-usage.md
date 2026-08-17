# Proposal 0002 — Expose plan quota usage to remote clients

Status: implemented (bridge `account/usage_stats`, 2026-08-17) · Date: 2026-08-17 · Affects: bridge (new ACP method), remote clients

## Problem

The mobile client now shows the session **context bar** (`usage_update
{used, size}`) — that part is done. The other "usage" users care about is the
**plan quota**: how much of the current billing window (e.g. a coding plan's
prompt allowance) is consumed and when it resets. The editor shows this; a
remote client has no way to see it.

Today the bridge surfaces nothing for quotas:

- app-server has the RPC (`usageStats: "usage/stats"` in the method enum, plus
  the `zcode quotas` CLI and `v4/usage/stats` backend endpoint), but the
  bridge's BACKLOG lists `usage/stats` under **Not planned** ("desktop client
  / config layer").
- `session/usage` (per-session tokens) is also unwired (BACKLOG candidate
  table) — lower value, the context bar already covers session-level usage.

## Proposed API (minimal, pull-only)

Quota is **account-level**, not session-level, so it does not fit a
`session/update` kind. One request method on the bridge, callable any time
after `initialize` (no session required):

```json
{ "id": 7, "method": "account/usage_stats", "params": {} }
```

Response — shape to mirror whatever app-server's `usage/stats` actually
returns (fields below are the client's expectation, not a hard contract):

```json
{
  "plans": [
    {
      "id": "bigmodel-coding-plan",
      "name": "GLM Coding Plan",
      "used": 42,
      "limit": 120,
      "unit": "prompts",
      "windowHours": 5,
      "resetsAt": 1723812000000
    }
  ]
}
```

Semantics:

- Pull-only v1: the client fetches once after attach and on demand (or every
  few minutes). No push notification needed yet — quota changes are slow.
- Non-standard, additive method name (`account/…`); nothing existing changes.
- Failure should degrade gracefully: error → the client hides the quota UI.

Implementation notes (2026-08-17):

- Data source is the bridge's own `quota/` pipeline (GLM usage API + 10s
  cache, same as `/quota`), NOT the app-server `usage/stats` RPC — inspected
  live, that RPC returns token analytics over a time range (per-day token
  counts, model/tool breakdowns), not billing-window quotas. The wire shape
  above is adapted accordingly: `usedPercent` is always present; `used`/
  `limit` only when the API reports absolute counts; `windowHours` is derived
  from the window id (5h → 5, week → 168).
- Failures map to JSON-RPC `-32003` with the kind in `data.kind`
  (`auth_error` | `rate_limited` | `unavailable`).

## Client UI (once available)

Drawer section under Session config: one row per plan showing
`used/limit` with a small progress bar and a "resets in Xh" hint. Reuse of
the existing context-bar styling.

## Alternatives considered

- **`usage_update` extension**: wrong scope — that kind is per-session and
  replayed on attach; quota is account-wide and would replay stale values.
- **Hub-level `/api/usage`**: violates ADR-0002 (the hub is a stateless byte
  proxy with no backend connection; only bridges talk to app-server).
