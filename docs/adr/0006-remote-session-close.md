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

Amendment (2026-10-20) — force close. The 409 guard protects conversations
from a mere list refresh, but it also blocks the client that MEANT to
terminate: a desktop user pressing "End session" on a running conversation
got the refusal and no path to act on it (observed live: the session kept
generating until the user walked to the hosting CLI window and stopped it
there). A close body `{"force":true}` now opts an explicit gesture through:
the bridge applies ESC semantics without a client connection (flag the
session's in-flight turns cancelled, fire the stop pair), waits a bounded
~3s for them to settle so the stop's terminal event persists partial output,
then proceeds with the eviction regardless — the `session/close` runtime
eviction already documented as the drain gate's kill escalation finishes any
generation that ignored the stop. Plain close keeps the refuse-when-running
contract; nothing changes for clients that send no body.

The hub stays a router (ADR-0002): the POST is forwarded by instance id and
session id only; the running guard and retirement semantics live in the
bridge. One implementation note for future write proxies: aborting the
upstream on the inbound request's `'close'` event resets the bridge socket —
an empty POST body drains and closes before the relayed response finishes
writing, so every proxied close died with ECONNRESET/502. Abort on the
RESPONSE side closing early (`res` `'close'` with `writableEnded` false)
instead.

Amendment (2026-10-24) — no resume guard for closed sessions. A client that
held a closed session under a connection that was DOWN at broadcast time
never receives its `$/zcode/session_closed` copy — the fan-out is live-only,
so no client-side tombstone forms, and the client's revival ladder (three
honest reconnects, then the ADR-0017 resume POST) can reincubate a
conversation another client deliberately closed. This is the one residual of
the resurrection class the desktop's socket-agnostic retirement closed
(2026-10-23) for every holder whose connection was up. Considered and
rejected: a hub-side guard that rejects resume POSTs for recently closed
ids. The conjunction is rare (a remote close landing exactly inside a
holder's disconnect window) and the failure self-heals (a ghost headless
bridge a second close retires cleanly), while every guard shape costs more
than the disease — a time-windowed rejection also refuses the legitimate
close-then-reopen gesture and still misses ladders that fire past the
window, and a complete guard needs clients to flag automated resumes, a
cross-repo contract not worth its surface while the residual stays
theoretical. Revisit with a real reproduction.

Amendment (2026-10-28) — the retirement must outlive the serve bridge. The
retirement stamp (`discoveryRetiredAt`) is in-memory, and a serve-origin
bridge EXITS on its last close — so the hub-incubated successor process has
no retirement memory at all. A reconnect ladder's auto `session/load`
(quoting any spelling) then re-armed discovery on the fresh bridge, the
heartbeat re-advertised the sid, and the hub cleared its close tombstone as
"real use again": the conversation resurrected on every surface, sometimes
with a live turn (observed live 2026-10-28: closed 00:48, resurrected by the
ladder at 01:07 — the intent gate of the same day's fix never engaged
because the fresh process's stamp map was empty). The durable half is the
bridge-owned close record (`~/.zcode/v2/acp-closed-sessions.json`,
`src/closed-sessions.ts`, same temp+rename store discipline as the
lazy-alias store): the close endpoint records EVERY id spelling of the
conversation (editor aliases + backend sess_ id), the auto-load gate in
`loadSession` consults it alongside the in-memory stamp (either spelling
matches), and genuine use — `markSessionActive`: a prompt, a user-intent
load — clears the record, keeping the self-heal contract intact on both
sides of a respawn. Entries expire after 30 days so a desktop-side reopen
that never passed through a bridge cannot keep the App's tab retired
forever. The earlier resume-guard rejection above stands: this amendment
gates the auto LOAD path only, which the intent contract already
distinguishes from a human's reopen.

Amendment (2026-10-29) — instance shutdown retires too.
`POST /api/instances/{id}/shutdown` (the older "close the instance" gesture)
used to kill the pid and nothing else, leaving the hosted conversations with
NO retirement memory anywhere — an auto reconnect ladder re-incubated the
workspace and resurrected them through the same hole. The hub now relays the
bridge's own close route per advertised session (`{force:true}` — cancel an
in-flight turn instead of refusing) BEFORE the kill: discovery retirement,
the durable record, the `session_closed` fan-out, and every id spelling
tombstoned. A wedged or already-dead bridge falls back to hub-side stamps
plus `recordClosedSessionIds` on the advertised spelling alone; a
user-intent resume always reopens (shutdown retires, it never deletes).
