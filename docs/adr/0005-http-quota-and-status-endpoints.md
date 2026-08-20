# Plain-HTTP quota and session-status endpoints

Remote clients (the mobile app) needed two things that forced a full ACP
WebSocket round-trip — connect, `initialize`, request, disconnect: account
quota and per-session running status. Both are poor fits for the session
protocol: quota is account-level (it belongs to the machine's configured
credentials, not to any session or bridge instance), and running status is a
polling concern, not a stream. We decided to expose both as plain HTTP on the
hub (ADR-0002's auth + discovery surface), leaving ACP for what it is good at
— driving turns and streaming updates.

`GET /api/quota` breaks ADR-0002's "the hub understands no business" rule
deliberately and narrowly: the hub imports `accountUsageStats()` (the same
function behind the `/quota` command and the `account/usage_stats` ACP method)
and queries the usage APIs itself, with a ~30s TTL cache plus a single
in-flight slot so polling clients cannot hammer the upstream. The alternative
— proxying some bridge's `/quota` loopback route — was rejected because quota
is machine-level, not instance-level: it must answer when every editor is
closed (the hub outlives bridges until its idle exit), and making the client
first pick a live instance to ask an account-level question is ceremony.
Version drift is covered by the existing self-upgrade handshake: a hub older
than a registering bridge restarts into the new code, so the direct query
cannot go stale relative to the bridges it serves.

Session status stays bridge-owned, on the pattern ADR-0004 set for `/fs`:
the bridge serves `GET /status` on its loopback server — pure in-memory
assembly (`sessionSummaries` membership + `pendingTurns` derivation, the same
`turnActive` logic `session/load` uses, no backend RPC) — and the hub
byte-proxies it at `GET /api/instances/{id}/status`. A coarse
`sessions[].status` also rides the heartbeat so `/api/instances` renders a
running indicator for free, at up to 10s staleness; the proxied endpoint is
the fresh one. Both layers are additive: an older hub drops the heartbeat
field, an older bridge just omits it.

Deliberately out of scope for now: a `waiting_permission` status (the backend
holds pending permission/AskUserQuestion requests, but not per-session
indexed) and background-task details (the bridge tracks them per session for
card rendering). Either can be added as a field on `/status` without a breaking
change — clients are told to ignore unknown fields.
