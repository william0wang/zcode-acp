# Remote Access

With `ZCODE_ACP_REMOTE=1` the bridge additionally accepts ACP connections over
WebSocket, so a phone or browser can watch and drive the **same sessions** as
your editor. Zed (or any ACP editor over stdio) remains the primary client and
owns the process: when the editor disconnects, the bridge — and every remote
attachment — exits with it.

A ready-made client — Android APK plus a self-hostable web build — lives at
[william0wang/zcode-acp-remote](https://github.com/william0wang/zcode-acp-remote).

```text
phone / browser ──WS── tunnel ── hub (127.0.0.1:8377, single entry)
                                   │ byte-level proxy
                                   ▼
                     bridge ACP endpoint (127.0.0.1:8378+n)
                                   │ same AgentApp as stdio
Zed ──────── stdio ────────────────┘
```

Enable it per-agent in Zed's settings (Zed merges these into the agent's
environment):

```json
"agents": {
  "ZCode": {
    "command": "zcode-acp-server",
    "env": {
      "ZCODE_ACP_REMOTE": "1",
      "ZCODE_ACP_REMOTE_TOKEN": "<a-long-random-secret>"
    }
  }
}
```

**Hub.** The first bridge with remote enabled spawns the hub daemon as a
detached, machine-level singleton on `ZCODE_ACP_HUB_PORT` (it can also be run
manually). It does three things only: token auth, instance discovery, and
byte-level proxying (ACP WebSocket plus read-only session files) — no session
state, no path semantics. It exits after ~10 idle minutes and is re-spawned
on demand. Each bridge registers every 10s as a heartbeat and drops out of
discovery ~30s after it stops.

**Discovery API** (for client authors; fields are additive-only):

```text
GET /api/instances              → [{"id","port","pid","startedAt","workspace",
                                    "origin","sessions":[{"sessionId","title?","updatedAt"}]}]
GET /api/instances?probe=1      → same list, but unreachable bridges are pruned first
WS   /acp?instance=<id>         → proxied to that bridge's endpoint
GET /api/instances/{id}/fs/…    → read-only session files (list + raw bytes, ADR-0004)
```

`origin` labels how an instance was started: `"editor"` (a bridge an editor
spawned over stdio) or `"serve"` (a headless bridge created remotely, see
below).

**Remote session-create** (ADR-0014). A remote client can start a NEW agent
session in any of the machine's known projects — no editor required:

```text
GET  /api/projects              → [{"workspacePath","sessions","lastActive"}]
POST /api/instances {workspacePath} → {"id","reused"}
```

`/api/projects` aggregates the App's tasks index: every workspace that ever
ran a session (system temp trees, `~/.zcode` itself, and vanished
directories filtered out), newest activity first. The list gates the POST —
paths outside it get 403 (a convenience bound, not a security boundary: a
token holder can already drive an editor-bridge session in any cwd; the
trust boundary is the token). On create the hub
spawns `zcode-acp serve` — a headless bridge — in the project's cwd; it
registers back within seconds and is reachable like any other instance. A
live serve instance for the same workspace is reused instead of re-spawned
(`reused:true`). The serve bridge lives for remote interest only: it exits
~10 minutes after the last client detaches and the last turn finishes, and
its `session/new` always uses the project cwd regardless of what a client
sends.

`sessions` lists the project's **currently running** conversations (live
editor tabs and remote attachments) under the same ACP session ids the
editor uses — attaching by id joins the conversation's live notification
stream, and the hub dedupes sessions shared by several bridges of the same
project.

Auth is `Authorization: Bearer <token>` or `?token=` (browsers cannot set WS
headers); `/api/*` sends `Access-Control-Allow-Origin: *` — the token is the
security boundary. A proxied connection stays bound to one instance; switching
instances means reconnecting. Remote clients can also pull plan quota via the
non-standard `account/usage_stats` ACP method (no session required), and
browse/download the files of a session's project through the `/fs` routes
above. During replay, compaction summaries and rewritten tool calls arrive as
collapsed `tool_call` updates instead of walls of text
([REPLAY-GUIDE.md](REPLAY-GUIDE.md)).

Building a remote client — web, mobile, or CLI? The full integration contract
(endpoints, framing, lifecycle timings, failure recovery, platform notes)
lives in [REMOTE-CLIENTS.md](REMOTE-CLIENTS.md).

**Semantics.** All agent notifications are broadcast to every client.
Permission / elicitation requests go to every client and the **first answer
wins**; losing clients receive `$/cancel_request` so their dialogs close.
Concurrent prompts for one session are serialized exactly as they are for a
single editor. Capabilities declared by any client are OR-merged.

**Tunnels.** Designed for one-port tunnels (Cloudflare Tunnel, frp): map the
hub port only. frp's `tcp` mode passes WebSocket as-is; Cloudflare Tunnel
drops idle WebSocket connections, so the hub sends 30s keepalive pings on both
legs. The bridge endpoint itself is loopback-only and never exposed.

**Binding beyond loopback.** The hub speaks plain HTTP/WS — the token travels
and authorizes in cleartext, so `ZCODE_ACP_HUB_HOST=0.0.0.0` (needed only when
the tunnel agent runs in its own container) is exactly as safe as the network
it lands on. Keep the bind loopback unless that interface is private to the
tunnel agent, and put TLS in front before mapping it anywhere untrusted.
