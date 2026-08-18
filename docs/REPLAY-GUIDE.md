# Replay guide — building a client UI on tail replay

Audience: frontend implementors (web, mobile, CLI TUI) of any ACP client for
this bridge. The **wire contract** (field names, errors, framing) lives in
[REMOTE-CLIENTS.md](REMOTE-CLIENTS.md) — this guide does not repeat it; it
shows how to _consume_ it: the UI state model, scroll-up pagination, and
reconnect recovery.

## What changed and why you care

Before tail replay, every `session/load` (initial attach AND every reconnect)
replayed the **entire** history as `session/update` notifications. A measured
280-message session cost ~800 notifications; sessions only grow. With tail
replay the same attach ships only the visible tail and older history arrives
on demand. Live numbers from the reference e2e run (471-message / 82-turn
session, `limit: 30`):

- `session/load` replayed 36 messages (30 requested, aligned to a turn start)
  as 118 notifications, and returned `replayMeta` — projected full replay for
  that session is ~1350 notifications (~91% cut).
- A follow-up `session/load_earlier` page delivered 30 more messages / 10
  turns as 51 notifications.

Everything is additive: omit `_meta.zcode.limit` and you get the old
full-replay behavior unchanged.

One more replay-only behavior: harness-injected `<system-reminder>` blocks
(TodoWrite nudges, context handoffs) that the runtime appends to user turns
are stripped before replay, and user messages that contained nothing else are
dropped entirely. You never receive them as `user_message_chunk`, so there is
nothing to filter client-side — the user's transcript shows only what they
actually typed.

## Attach strategy

Pick the limit from your UI budget, not from the history size:

- `limit: 0` — metadata-only attach. You get `replayMeta`
  (`totalMessages`, `totalTurns`, `hasMore: true`, cursor at the end of
  history) and zero replayed messages. Render an empty/"load older" state.
- `limit: N` — replay at most the last N **messages**, aligned back to the
  start of the turn containing the oldest one. Expect
  `replayedMessages ≥ N` when alignment extends the batch (the e2e run asked
  for 30 and got 36). Never a mid-turn cut: a tool call always arrives with
  its updates.
- No `_meta` — full replay (legacy/Zed path).

The response always carries `replayMeta`. `hasMore: false` means the whole
history is already in front of you — hide the "load older" affordance.

## UI state model

Three id kinds arrive in `session/update` notifications; each kind merges
differently:

| Update kind                                  | Id field     | Merge rule                                                              |
| -------------------------------------------- | ------------ | ----------------------------------------------------------------------- |
| `user_message_chunk` / `agent_message_chunk` | `messageId`  | append text to that message's bubble                                    |
| `agent_thought_chunk`                        | `messageId`  | append; ids carry a `thought_` prefix, so thoughts are their own stream |
| `tool_call` / `tool_call_update`             | `toolCallId` | first `tool_call` creates the card, later updates mutate it             |

- `messageId`s are the backend's stable message ids (the e2e run saw zero
  fallback ids across hundreds of messages) — key your message list by them
  and dedupe on every insert.
- One message = several chunks (text, thoughts, tool calls). Group chunks by
  `messageId`/`toolCallId`, not by arrival order alone.
- Ordering rule: replay batches and `load_earlier` pages arrive **oldest →
  newest and must be prepended**; live-turn updates arrive newest-last and
  append. The bridge serializes a replay batch against the live turn for the
  same session (they never interleave), so you can apply live updates while a
  pagination page is in flight without ordering races.
- `usage_update` / `available_commands_update` are session-level metadata,
  not list items.

### Collapsed harness blocks (tool_call form)

Replayed user messages that are harness plumbing rather than user speech are
delivered as **`tool_call` updates, not `user_message_chunk`** — tool_call is
the one update kind every ACP editor (Zed, JetBrains, …) renders folded by
default, so the collapse works with zero client-side opt-in. The full text
rides in the tool_call's `content` block (expandable); the `kind` rides the
update's `_meta`:

```json
{
  "sessionId": "…",
  "update": {
    "sessionUpdate": "tool_call",
    "toolCallId": "histfold_…",
    "title": "Context handoff",
    "kind": "other",
    "status": "completed",
    "content": [
      {
        "type": "content",
        "content": { "type": "text", "text": "This session is being continued …" }
      }
    ],
    "_meta": { "zcode": { "collapsed": true, "kind": "context-handoff" } }
  }
}
```

- `kind: "context-handoff"` — the context-window continuation summary, one
  per compaction (a long session can carry dozens). Title: `Context handoff`.
- `kind: "compact"` — the same compaction product on backends that tag it
  with `semantics.kind: "compact_summary"` (session/compact, auto-compact,
  and context-window handoff all land here). Title comes from the store's
  own `summary.title` (observed: `Compact summary`) — so a reload shows
  where history was compacted instead of silently missing the bridge's live
  🔄/✓ auto-compact notices, which never enter backend history.
- `kind: "tool-transcript"` — `Called the X tool with the following input:
{…}\nResult of calling…` messages: tool_use/tool_result pairs the harness
  rewrites into text on resume, one per historical tool call. Title is
  `X · <first string value of the input JSON>` (e.g.
  `Read · /src/main.go`), capped at 60 characters; falls back to `X tool`.
- `kind: "task-notification"` — `<task-notification>` blocks the harness
  injects when a background task (build, sub-agent) finishes, delivered as
  standalone user messages. Title is the block's decoded `<summary>` line
  (e.g. `Background command "Build release APK" completed (exit code 0)`),
  capped at 60 characters; falls back to `Background task`.
- Harness noise that carries no value (TodoWrite/Read usage nudges) is
  stripped before replay — you never see it. Synthetic messages the backend
  marks `transcriptVisibility: "hidden"` and that fit no collapse shape
  (plan-file references and similar plumbing) are dropped entirely.
- Render all kinds as an ordinary collapsed tool card keyed by `toolCallId`;
  the text is complete behind the expand. Unknown `kind`s: render collapsed
  too. These updates never collide with live tool_call ids (they carry the
  `histfold_` prefix).

## Turn running state (`replayMeta.turnActive` + `$/zcode/turnState`)

A turn may already be in flight when you attach — started by the editor or
another remote client (the bridge runs it to completion regardless of who
prompted). Two signals cover it:

- **Attach snapshot**: `session/load`'s `replayMeta.turnActive` (boolean) —
  `true` when any turn for this session is running at attach time. Seed your
  spinner/running state from it.
- **Out-of-band updates**: the notification `$/zcode/turnState` with params
  `{ sessionId: string, running: boolean }` — emitted when a turn starts and
  when it ends (including failures, e.g. a failed subscribe). On preemption (a
  new prompt interrupts an in-flight one) the old turn's exit reports
  `running: true`: the preempting turn took over, so the session is still busy.

The client that sent `session/prompt` already knows its own turn via the
request/response; these signals exist for the OTHER attached clients
(re-attached mobile, second editor). Unknown notifications are ignorable —
clients that don't handle `$/zcode/turnState` lose nothing (Zed ignores it).

## Scroll-up pagination

```
state: cursor = attachResult.replayMeta.cursor
       hasMore = attachResult.replayMeta.hasMore

onScrolledNearTop():
  if !hasMore or requestInFlight: return
  res = request("session/load_earlier", { sessionId, before: cursor, limit: 50 })
  prependUpdates(res.deliveredSessionUpdates)   // keep the user's scroll anchor
  cursor  = res.replayMeta.cursor
  hasMore = res.replayMeta.hasMore
```

- `limit` defaults to 50; clamp is `[0, 500]`.
- `hasMore: false` ends the loop. A redundant extra call is harmless: it
  returns an empty page with `hasMore: false`.
- Keep a scroll anchor when prepending, or every page will yank the viewport
  to the top.

## Cursor expiry — the one error to handle

A cursor dies only when the history **shrank** (compaction, truncation):
`session/load_earlier` then fails with `-32602 "cursor expired"`. Turns
**appended** after the cursor was minted (the conversation moved on) keep it
valid — you do NOT need to refresh the cursor after every live turn.

Recovery for `"cursor expired"`: re-run `session/load` with your tail limit
and rebuild the visible list from its `replayMeta`; deeper history comes back
through normal pagination. Treat it as a rare event, not a flow.

Never parse the cursor — it is opaque. (For the curious it round-trips
`{ v, index, totalTurns, id? }`, but the shape may change without notice.)

## Reconnect recipe

1. Re-discover the instance (`/api/instances`) — the bridge pid changes on
   editor restart. Then `initialize` (`protocolVersion`: the number `1`),
   then `session/load { sessionId, cwd, mcpServers: [] }` — `cwd` and
   `mcpServers` are required even when empty.
2. Attach with `limit` = your viewport budget, not what the user had scrolled
   to. Diff against your cached messages by `messageId` (ids are stable
   across restarts of both bridge and backend).
3. Live updates fill the tail from here. If the user scrolls into history you
   no longer have, `load_earlier` from the new cursor refetches just those
   pages — do not try to restore the full old scroll depth on reconnect.

## Checklist

- [ ] `limit` rides in `_meta.zcode.limit` (top-level unknown keys are
      stripped by the SDK schema — silently).
- [ ] `session/load` params include `cwd` and `mcpServers` (even `[]`).
- [ ] Message list keyed/deduped by `messageId`; tool cards by `toolCallId`.
- [ ] Pagination pages prepended, live updates appended.
- [ ] Running state seeded from `replayMeta.turnActive` and updated from
      `$/zcode/turnState` notifications (covers other clients' turns).
- [ ] `"cursor expired"` handled by full re-attach.
- [ ] Cursor stored per session, never parsed, never persisted across app
      runs (it is only meaningful to the bridge that minted it).
