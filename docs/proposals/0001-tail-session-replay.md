# Proposal 0001 — Tail session replay with incremental history fetch

Status: implemented (2026-08-17; decisions in ADR-0003, contract documented in
REMOTE-CLIENTS.md "Tail replay and history pagination") · Date: 2026-08-17 ·
Affects: ACP endpoint (`session/load`), remote clients

## Problem

`session/load` replays the **entire** conversation as `session/update`
notifications. This is the attach path AND the reconnect catch-up path
(REMOTE-CLIENTS.md: "history replay is the recovery mechanism"), so its cost is
paid on every attach and every reconnect. For long-lived sessions the cost is
unbounded:

- A real working session measured today replays **2,000+ update chunks**
  (user/agent/thought/tool) per attach. The mobile client (zcode-acp-app)
  saturated its main thread for tens of seconds even after shipping windowed
  rendering — every chunk used to trigger a full React commit. The client now
  batches replay into single store writes, which fixes rendering, but the
  **wire transfer, JSON parse, and state application remain O(full history)**
  on every attach. That part is irreducible client-side.
- Mobile clients reconnect often (background suspension kills the socket), so
  the most latency-sensitive clients pay the largest cost, repeatedly.
- Recovery after a network flap should be fast; instead it grows with session
  age. The catch-up path degrades exactly when the session is most valuable.

Clients render only the tail (the app renders the last ~30 messages and loads
older on scroll-up), yet the protocol forces them to receive and process all
of it up front.

## Transport constraint (verified against SDK 1.3.0)

The SDK registers spec methods with zod `z.object` params schemas; zod's
default `.parse()` **strips unknown top-level keys**. A top-level `limit` on
`session/load` would never reach the handler. `_meta` is the preserved
extension channel, so all bridge extension parameters on spec methods ride in
`_meta.zcode`. Response fields are unaffected (the SDK's response mapping is a
passthrough), so `replayMeta` rides top-level in the result. Our own method
`session/load_earlier` takes a bridge-provided parser, so its params stay
top-level.

## Proposed API

Additive and backward compatible — omitting the new fields keeps today's
full-replay behavior byte-identical (Zed sends neither, and is unaffected).

### 1. `session/load` gains an optional tail limit (in `_meta.zcode`)

```json
{ "sessionId": "…", "cwd": "…", "mcpServers": [], "_meta": { "zcode": { "limit": 30 } } }
```

- Replays at most the **last `limit` messages, aligned back to the start of
  the turn containing the oldest one** — never a mid-turn cut, never an
  orphaned tool_call. A turn spans from a user message to the next; leading
  non-user messages belong to the first turn.
- `limit: 0` attaches with **metadata only** (no replay) — for clients that
  build the connection first and page history on demand.
- Clamped to `[0, 500]`; invalid values clamp, never error.
- Result gains replay metadata:

```json
{
  "replayMeta": {
    "cursor": "…",
    "hasMore": true,
    "replayedMessages": 47,
    "replayedTurns": 12,
    "totalMessages": 1893,
    "totalTurns": 412
  }
}
```

`cursor` is an opaque bridge-chosen handle identifying the oldest replayed
turn (clients never interpret it). Both `session/load` and
`session/load_earlier` results use this same shape.

### 2. New request `session/load_earlier` (params top-level)

```json
{ "sessionId": "…", "before": "…", "limit": 50 }
```

- Delivers updates strictly older than `before` as `session/update`
  notifications — the same delivery mechanism as replay, so clients reuse
  their existing apply path. Within a batch, updates arrive oldest → newest;
  the client prepends at the head of its history.
- Requires the session to already be registered in this bridge (attached via
  `session/load`); unknown sessions error — pagination never triggers an
  implicit backend resume.
- `hasMore: false` ends pagination. A cursor only expires when the history
  shrank (session compacted/truncated, no longer matching the cursor's
  anchor); appended turns keep it valid. An expired or unknown cursor returns
  a fixed `"cursor expired"` error the client maps to a full re-
  `session/load`.

## Semantics & edge cases

- **Cursor representation** (bridge-internal): opaque base64 of
  `{ id?, index, totalTurns }`. Valid only while `index` is in range AND the
  history it points into is unchanged; stable backend message ids are used
  when present, with index/total as the consistency check otherwise.
- **Concurrent live turn.** A turn may stream while replay or pagination runs.
  A per-session replay lock (patterned on `preemptLocks`) is held for the
  duration of each replay batch, and live-turn dispatch for the same session
  acquires the same lock — batches are atomic and never interleave with live
  forwards. Concurrent `load_earlier` calls serialize naturally.
- **Bridge-side slicing.** The backend `session/messages` RPC has no
  pagination; the bridge fetches full history (local stdio IPC, cheap) and
  slices in memory — the wire to the client carries only the tail. A future
  backend limit parameter can slot in without contract change.
- **Editor/stdio clients are unaffected** — no `_meta.zcode` ⇒ today's
  behavior.

## Alternatives considered

- **Top-level `limit` on `session/load`**: rejected — the SDK's zod params
  parsing strips unknown top-level keys; it cannot work.
- **Turn-count limit**: rejected — tool-heavy turns make turn budgets
  unpredictable for UI; message count with turn alignment serves both.
- **`limit` only, no `load_earlier`**: simpler, but "scroll up for older" then
  forces a full re-load — the exact cost this proposal removes.
- **Client-side windowing alone** (shipped in zcode-acp-app today): bounds
  rendering but not wire/parse/apply; reconnect cost still grows unboundedly.
- **Push-only history with gap-fill by update id**: requires the bridge to
  retain an update log keyed by id and clients to track continuity — heavier
  than cursor pagination for the same result.

## Rollout

1. `_meta.zcode.limit` on `session/load` + `replayMeta` + replay lock
   (unblocks fast mobile attach).
2. `session/load_earlier` (unblocks infinite-scroll into history).

REMOTE-CLIENTS.md gains the two parameters once implemented.
