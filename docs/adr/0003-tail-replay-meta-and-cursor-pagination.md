# Tail replay: extension params ride in _meta, history pages by cursor

`session/load` replays full history to attaching clients, so attach and
reconnect cost grow with session age (Proposal 0001). Extending the protocol
for tail replay required three decisions that are now wire contract and hard
to reverse.

**Extension parameters on spec methods ride in `_meta.zcode`, not top-level.**
The ACP SDK registers spec methods like `session/load` with a zod
`z.object` params schema (`zLoadSessionRequest`), and zod's default behavior
strips unknown keys during `.parse()` — a top-level `limit` would be silently
removed before our handler ever sees it. `_meta` is the one channel the schema
preserves (`record(string, unknown)`), and it is also where the ACP spec
points extension payloads. Responses need no escape hatch: the SDK's response
mapping for `session/load` is a passthrough, so `replayMeta` rides top-level
in the result. Our own non-standard method `session/load_earlier` takes a
bridge-provided parser, so its params stay top-level — the asymmetry is
intentional and documented in REMOTE-CLIENTS.md.

**`limit` counts messages, aligned back to turn boundaries.** Clients render
messages (the app shows the last ~30), but turns are the atomic semantic unit
(a cut must not orphan a tool_call from its updates). The bridge replays at
most the last `limit` messages, extended backwards to the start of the turn
containing the oldest one; `limit: 0` attaches with metadata only. A turn
spans from a user message to the next; leading non-user messages belong to the
first turn. We rejected turn-count limits — tool-heavy turns make them
unpredictable for UI budgets.

**Cursor pagination over a full fetch, with expiry.** The backend's
`session/messages` has no pagination, but the fetch is local stdio IPC — the
expensive part is the wire to the client, so the bridge fetches all, slices in
memory, and ships only the tail. The cursor is an opaque base64 of
`{ id?, index, totalTurns }`: it validates only while the history it points
into is unchanged (compaction/truncation expires it). An expired or unknown
cursor returns a fixed `"cursor expired"` error the client maps to a full
re-`session/load` — we rejected a push-only update log with id-gap fill as
heavier machinery for the same result. During any replay batch the bridge
holds a per-session replay lock (patterned on `preemptLocks`) that live-turn
dispatch for the same session also acquires, so a batch is never interleaved
with live updates.
