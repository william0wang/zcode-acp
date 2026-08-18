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

### Collapsed harness blocks (`_meta.zcode.collapsed`)

Replayed user messages that are harness plumbing rather than user speech may
carry a top-level `_meta` on the `session/update` notification:

```json
{
  "sessionId": "…",
  "update": {
    "sessionUpdate": "user_message_chunk",
    "content": { "type": "text", "text": "This session is being continued …" },
    "messageId": "…"
  },
  "_meta": { "zcode": { "collapsed": true, "kind": "context-handoff" } }
}
```

- `kind: "context-handoff"` — the context-window continuation summary. The
  full text is in the chunk as usual; render it **collapsed behind an expand
  control** (e.g. a one-line label like "前序会话摘要") instead of a wall of
  text attributed to the user.
- Harness noise that carries no value (TodoWrite/Read usage nudges) is
  stripped before replay — you never see it.
- Unknown `kind`s: render collapsed too (or fall back to plain text). Ignoring
  `_meta` entirely is always safe — the text is complete without it.

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
