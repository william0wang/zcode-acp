# Remote file access: session-scoped, read-only, over hub-proxied HTTP

Remote clients could see session diffs and tool-call text but had no way to
browse or download files of the project a session lives in. We decided to give
the bridge a read-only file endpoint on its existing loopback HTTP server
(`GET /fs/list`, `GET /fs/file`), proxied byte-for-byte by the hub at
`GET /api/instances/{id}/fs/*` — the same proxy pattern as `/acp`. The hub
still touches no filesystem and understands no path semantics (ADR-0002
holds); scope checks and reads happen in the bridge, against its own
`sessionCwds` map: a request names a `sessionId`, and the path (after
`path.resolve` + `realpath`, defeating `..` and symlink escapes) must stay
inside that session's root cwd. Newly created sessions are readable
immediately because the bridge consults the in-process map, not a heartbeat
replica.

Read-only is deliberate: token holders can already drive the agent to write
files through the permission flow, but a direct write path would widen
token-theft damage from "control sessions" to "arbitrary filesystem writes",
with no consistency protection against running turns. The loopback endpoint
itself is unauthenticated, exactly like the ACP WebSocket next to it — only
the hub (the sole public entry) enforces the token. Responses stream
(`createReadStream` + `Content-Length`), so there is no per-request size cap;
`offset`/`length` and `line`/`limit` (mutually exclusive) serve binary
chunking and text windowing. `agentCapabilities._meta.zcode.fs` advertises the
capability to clients.

We rejected three alternatives. ACP extension methods (`_zcode/fs/*`) with
base64 bodies: the SDK's WS server drops non-text frames, so a binary channel
means bypassing the SDK transport; base64 adds 33%; and — decisively — a
multi-MB response blocks every `session/update` behind it on the same
WebSocket (head-of-line blocking), while HTTP gives downloads, `<img src>`,
caching, and future `Range` support for free. The hub reading files itself:
security-wise equivalent (the token already grants full session control), but
the hub's registry only knows activity-gated sessions, so a fresh
`session/new` session would have no cwd until its first turn — fixing that
would turn the heartbeat payload from a display summary into an authoritative
session→directory map, a second implementation of the session semantics
ADR-0002 keeps out of the hub. External tools (filebrowser, `rclone serve`):
separate token, port, and lifetime, with no link to sessions.
