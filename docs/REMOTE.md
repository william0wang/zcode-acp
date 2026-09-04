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
discovery ~30s after it stops. **Sandbox inheritance is self-healed:** a hub
born inside the Seatbelt wrap (a sandboxed backend spawned it — marked via
`ZCODE_ACP_SANDBOX_ACTIVE`) relaunches itself through launchd, outside the
sandbox, before binding; inside the sandbox macOS would refuse its opening of
the visible session terminal (TCC), breaking remote session-create.

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
trust boundary is the token). On create the hub incubates a VISIBLE
interactive REPL in the machine's terminal (ADR-0016, macOS; headless/SSH or
`ZCODE_ACP_HUB_TERMINAL=0` falls back to the detached headless
`zcode-acp serve`); its bridge registers back within seconds (budget ~20s)
and is reachable like any other instance. The hub itself is a background
process with no terminal, so nothing is auto-detected: the target terminal
resolves as `ZCODE_ACP_HUB_TERMINAL_COMMAND` → `ZCODE_ACP_HUB_TERMINAL_APP`
(built-in launch recipes for Terminal, iTerm, WezTerm, kitty, Alacritty,
Ghostty; other names pass through to `open -a`) → plain Terminal.app. Warp
cannot execute scripts or commands programmatically (warpdotdev/warp#1917,
#3959) and is deliberately unsupported — it degrades to the headless bridge.
A live serve-origin instance for
the same workspace is reused instead of re-spawned (`reused:true`). A
terminal-REPL instance lives while its window lives; the headless fallback
exits ~10 minutes after the last client detaches and the last turn
finishes. Session roots are pinned to the project cwd in both surfaces
regardless of what a client sends.

**Remote session-resume** (ADR-0015). Remote clients can also reopen a
PREVIOUS conversation of a project — including closed ones no bridge
currently advertises (discovery lists only running conversations):

```text
GET /api/projects/sessions?workspacePath=… → {workspacePath, instance, sessions}
```

The listing is the project's full backend session store; the hub incubates
the project's serve bridge on first listing and reuses it after. Resume is
the normal attach flow with `session/load` on a listed backend id. See
`docs/REMOTE-CLIENTS.md` ("Resuming a closed session") for the client contract.

`sessions` lists the project's **currently running** conversations (live
editor tabs and remote attachments) under the same ACP session ids the
editor uses — attaching by id joins the conversation's live notification
stream, and the hub dedupes sessions shared by several bridges of the same
project.

**The local REPL is a hub client too** (ADR-0018). Bare `zcode-acp` in a
shell with the hub env (`ZCODE_ACP_REMOTE_TOKEN` + `ZCODE_ACP_HUB_PORT`)
merges sessions that are live on hub instances into its `/sessions` picker
(marked `live`, `●` while a turn runs) and attaches to them through the hub's
WS proxy as a second ACP client — replay on attach, then live updates, so a
conversation being driven from the phone advances on the desktop in real
time. Without a hub configured or reachable, the picker and resumes behave
exactly as before. Attaching never touches the owning bridge: leaving the
REPL (or `/new`) only detaches this client.

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
