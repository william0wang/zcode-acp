# Remote session close: a write op on the discovery surface

Remote lists accumulated conversations the editor side had long retired: ACP
has no editor→agent "tab closed" notification, so the bridge's in-memory
`sessionSummaries` (the only membership source for both the heartbeat and
`/status`) never loses an entry once it gains activity. Until this decision
the only cleanup was a bridge restart. We decided to expose
`POST /api/instances/{id}/sessions/{sessionId}/close` — the remote HTTP
surface's first WRITE operation — which deletes the session's summary and
nothing else.

The semantics are "close", not "delete": the backend session store, the
editor's conversation storage, and the App's tasks-index are untouched. What
makes this safe where ADR-0004 kept `/fs` read-only: retiring a summary only
changes discovery visibility. Token holders can already drive arbitrary agent
work through the permission flow; a visibility toggle adds no capability.

The requested guard — "only close sessions the editor side no longer has" —
cannot be a precondition check: tab open/closed is unobservable from the
bridge (Zed sends nothing on close). It is instead enforced by the
`hasActivity` gate's natural re-arm: a closed entry loses its summary, and
`markSessionActive` — any prompt, any load with history — recreates it. A
wrongly closed conversation reappears within one heartbeat of the editor
touching it; an editor-side-retired one stays gone. The one observable
in-use signal, a pending turn, is rejected outright (409). A bridge-restart
auto-resume alone does not resurrect a closed session — `registerSession`
writes a summary with `hasActivity` unset.

The hub stays a router (ADR-0002): the POST is forwarded by instance id and
session id only; the running guard and retirement semantics live in the
bridge. One implementation note for future write proxies: aborting the
upstream on the inbound request's `'close'` event resets the bridge socket —
an empty POST body drains and closes before the relayed response finishes
writing, so every proxied close died with ECONNRESET/502. Abort on the
RESPONSE side closing early (`res` `'close'` with `writableEnded` false)
instead.
