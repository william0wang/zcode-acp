# Remote Clients — Integration Guide

How to attach any out-of-editor client — browser SPA, mobile app, CLI, desktop
tool — to bridge sessions over the network. This document IS the contract:
everything here is implemented by `zcode-acp-hub` and the bridge's remote
endpoint; anything not written here is not part of the contract.

ACP method semantics are defined by the [ACP spec](https://agentclientprotocol.com);
this guide covers only the transport, discovery, and the multi-client behaviors
on top of it. For how ACP methods map to the ZCode backend, see
[PROTOCOL.md](PROTOCOL.md).

## Topology

```text
remote client ──WS── tunnel ── hub (single entry, one mapped port)
                                  │ byte-level proxy, no ACP semantics
                                  ▼
                    bridge ACP endpoint (loopback, never exposed)
                                  │ same AgentApp as stdio
ACP editor ────── stdio ──────────┘
```

- The hub is the **only** public entry. It does token auth, instance discovery,
  and byte-level WebSocket proxying — no session state, no ACP semantics
  (ADR-0002). The bridge endpoint is loopback-only; nothing dials it but the
  hub.
- One WS connection is bound to **one bridge instance** for its whole lifetime.
  Switching instances means opening a new connection.
- The bridge process lives and dies with the editor that spawned it (ADR-0001):
  close the editor and every remote attachment drops. There is no standalone
  server that outlives the editor.

## Security model

- One shared bearer token (`ZCODE_ACP_REMOTE_TOKEN`) guards both the discovery
  API and the ACP WebSocket. Possession of the token equals **full control of
  every agent session** — prompting, answering permissions, tool-driven file
  writes. Treat it like a password: long, random, never committed.
- The hub speaks plain HTTP/WS. TLS is expected from the tunnel in front
  (Cloudflare Tunnel terminates it; with frp, terminate TLS in front or keep
  the network trusted). The token on cleartext HTTP over an untrusted network
  is a credential leak.
- `/api/*` responses carry `Access-Control-Allow-Origin: *` — the token is the
  security boundary; there is no origin restriction.

## Discovery API

| Endpoint             | Auth     | Purpose                                                      |
| -------------------- | -------- | ------------------------------------------------------------ |
| `GET /api/health`    | none     | Liveness probe; `200` body `ok`.                             |
| `GET /api/instances` | required | Registered bridge instances. Add `?probe=1` to verify first. |

HTTP auth: `Authorization: Bearer <token>` or `?token=<token>`.

`/api/instances` returns a JSON array (sorted by start time):

```json
[
  {
    "id": "72341",
    "port": 8378,
    "pid": 72341,
    "startedAt": 1723800000000,
    "workspace": "/Users/me/proj",
    "sessions": [{ "sessionId": "5f0c…", "title": "Fix login bug", "updatedAt": 1723800012000 }]
  }
]
```

- `id` is the bridge process id — stable for that editor window's lifetime,
  unique per window.
- **On refresh, call `/api/instances?probe=1`**: the hub TCP-probes each
  registered bridge's loopback port and prunes unreachable ones before
  answering. A plain `GET` returns the heartbeat-based view, which can list a
  hard-killed bridge for up to the 30s heartbeat TTL.
- `sessions[].sessionId` is the ACP session id: pass it to `session/load`
  after connecting. `title` is adopted from the backend for resumed sessions
  and set after a fresh session's first turn — it can still be absent for a
  session that has never completed a turn.
- `sessions` only lists sessions with real interaction. Editors restart into a
  stored placeholder and materialize an empty backend session — those stay
  hidden and appear within one heartbeat (~10s) after their first prompt (or
  a titled resume/load).
- `sessions` is also **availability-verified**: before every heartbeat the
  bridge probes its idle sessions against its own backend, and a session it
  can no longer serve (e.g. the project restarted under a newer bridge while
  the old process leaked) is dropped from the list within one heartbeat
  (~10s) instead of lingering as an entry that opens empty. It reappears if
  the bridge can serve it again. Treat list membership as "openable".
- Poll every 3–5s. There is no push notification for registry changes yet.
- Fields are **additive-only** across releases — ignore fields you don't know.

Lifecycle timings: a bridge re-registers every 10s (the registration doubles as
heartbeat); an instance disappears ~30s after its heartbeats stop; the hub
exits after ~10 idle minutes with no instances and no proxies, and the next
bridge re-spawns it on demand.

## Connecting

```text
ws(s)://<hub-host>/acp?instance=<id>&token=<token>
```

- Native clients may send `Authorization: Bearer <token>` instead of the query
  parameter; browsers cannot set WS headers, which is why `?token=` exists.
  Prefer the header when you can — it keeps the token out of URLs and logs.
- Handshake failures (bad token, unknown instance id) destroy the socket
  before open. Treat any non-open outcome as "re-discover, then retry".
- Framing: one JSON-RPC message per **text** frame. Binary frames are ignored.
- The hub sends WebSocket pings every 30s on both legs (tunnels drop idle
  links). Browser and native WS stacks answer pongs automatically — nothing to
  implement, but don't disable pongs.

## ACP session flow

1. `initialize` — `protocolVersion` MUST be the **number** `1` (a string is
   rejected). Nothing else may be sent before it.
2. Attach or create:
   - `session/load { sessionId, cwd, mcpServers }` with an id from discovery —
     replays the conversation history (text + tool summaries) as
     `session/update`s, so a freshly attached client can render the full
     story. `cwd` and `mcpServers` (even `[]`) are required — the SDK's params
     schema rejects the request without them.
   - `session/new { cwd? }` — a new session on that bridge.
   - `session/list` enumerates the bridge's known sessions.
3. Drive: `session/prompt`, `session/cancel`, `session/set_config_option`
   (model / mode / thought level), slash commands in the prompt text —
   see [PROTOCOL.md](PROTOCOL.md).

## Account quota (`account/usage_stats`)

Non-standard, additive (Proposal 0002). Plan quota is **account-level**, so it
is a pull-only request — callable any time after `initialize`, no session
required. Fetch once after attach and on demand; quota changes are slow, there
is no push.

The response mirrors the `zcode-quota` CLI card's data model — one GLM section
plus one Opencode Go section — so clients can reproduce the CLI layout
exactly:

```json
→ { "id": 7, "method": "account/usage_stats", "params": {} }
← { "id": 7, "result": {
      "glm": {
        "kind": "success",
        "level": "pro",
        "items": [
          { "key": "token_5h", "label": "5h", "usedPercent": 35,
            "nextResetTime": 1723812000000 },
          { "key": "mcp", "label": "MCP", "usedPercent": 10, "usedCount": 3,
            "totalCount": 30, "nextResetTime": 1723812000000,
            "detail": [{ "modelCode": "search-prime", "usage": 2 }] }
        ]
      },
      "opencode": {
        "kind": "success",
        "windows": [
          { "key": "rolling", "label": "5h", "usagePercent": 5,
            "resetsAt": 1723812000000 },
          { "key": "weekly", "label": "Week", "usagePercent": 25,
            "resetsAt": 1724071200000 }
        ]
      }
    } }
```

- `glm` (`kind`: `success` | `auth_error` | `rate_limited` | `unavailable`):
  on success, `level` is the plan level and `items` carries one entry per
  window (`5h` / `Week` / `MCP`) with `usedPercent` (0–100) always present;
  `usedCount`/`totalCount`/`nextResetTime` (epoch ms) and the per-model
  `detail` breakdown only when the API reports them.
- `opencode` (`kind`: `success` | `not_configured` | `auth_error` |
  `unavailable`): on success, `windows` carries the rolling (`5h`) / weekly
  (`Week`) / monthly (`Month`, when exposed) windows; the dashboard's relative
  countdown is resolved to an absolute `resetsAt` (epoch ms). `not_configured`
  means the user never set OpenCode Go credentials — omit the section, like
  the CLI does.
- Provider failures are per-section `kind` strings, not JSON-RPC errors —
  render the same status line the CLI would (e.g. auth expired) and retry
  later. Only transport-level failures reject the request.
- Cached ~10s server-side (same caches as the `/quota` command).

## Slash-command handling

Only the commands the bridge advertises via `available_commands_update` (plus
`skill`/`init` and `$`-skills) are treated as commands. Any other `/`-leading
prompt — e.g. a pasted directory path — is delivered to the model as plain
text with an invisible zero-width-space prefix; clients see the text verbatim
in replay and echoes. Clients should not special-case this.

## Tail replay and history pagination

Replaying a long session's full history is O(history) on every attach and
reconnect. The bridge supports tail replay (non-standard, additive — omit
everything below and you get the full replay):

- **Tail limit**: `session/load` with `_meta.zcode.limit` (NOT top-level —
  the SDK's params schema strips unknown top-level keys; `_meta` is the
  preserved extension channel). It counts **messages**, and the replay is
  aligned back to the start of the turn containing the oldest message — never
  a mid-turn cut. `0` attaches with metadata only. Clamped to `[0, 500]`.
- **`replayMeta`** rides top-level in the result:

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

- **`session/load_earlier`** (`{ sessionId, before, limit }`, limit defaults
  to 50) delivers one page of `session/update`s strictly older than `before`,
  oldest → newest — prepend them. Same `replayMeta` shape in the result;
  `hasMore: false` ends pagination. Requires the session to be attached in
  this bridge; it never triggers an implicit backend resume.
- **Cursor expiry**: a cursor is valid only while the history it points into
  is unchanged — turns appended after it was minted (the session moved on)
  keep it valid. After the session compacts or truncates, `load_earlier`
  returns a `"cursor expired"` error — the recovery is a fresh `session/load`.

While a replay batch is in flight, live updates for the same session queue
behind it: batches are atomic and never interleave with the live turn.

UI-side recipes for consuming all of this — state model, prepend handling,
scroll pagination, reconnect recovery — live in
[REPLAY-GUIDE.md](REPLAY-GUIDE.md).

## Multi-client semantics

The stdio editor and every remote client are peers on the same sessions:

- All agent notifications (`session/update`) are broadcast to every client.
- Permission and elicitation requests go to **every** client and the **first
  response wins**. Losers receive `$/cancel_request` for the pending request
  id — close the dialog and drop it. Never leave a request unanswered forever.
- Capabilities are OR-merged across clients: a remote client advertising e.g.
  `elicitation.form` upgrades the shared interaction for the whole bridge.
- Concurrent prompts for one session are serialized by the bridge — two
  clients prompting at once cannot interleave turns.

## Failure & recovery

| Symptom                                | Cause                                                                                                                                                                                                                                                                    | Client action                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| WS closes                              | bridge exited (editor closed) or network drop                                                                                                                                                                                                                            | Poll `/api/instances`; if the instance is gone, its sessions are gone too — drop it from the UI.    |
| Instance missing from `/api/instances` | Heartbeats stopped >30s, or `?probe=1` found the bridge port unreachable                                                                                                                                                                                                 | Remove the instance from the UI.                                                                    |
| Connect fails for a while              | Hub process died; a bridge re-spawns it on the next heartbeat (typically ≤10s, worst case ~1min under the spawn throttle). Also expected for a few seconds after a bridge upgrade: the hub notices a newer bridge, restarts, and is re-spawned from the upgraded install | Retry with backoff.                                                                                 |
| Disconnect mid-turn                    | Mobile network flap, background suspension                                                                                                                                                                                                                               | The turn continues server-side. Reconnect and `session/load` — history replay is the recovery path. |

Updates emitted while you are disconnected are not individually re-delivered;
`session/load` replay is the catch-up mechanism.

## Platform notes

- **Browser**: a page served over `https://` can only open `wss://` — take TLS
  from the tunnel. CORS is `*`, so any static host works; the client needs no
  backend of its own.
- **Mobile**: background suspension kills the socket; on resume, reconnect and
  `session/load` the previously open session. Store hub URL + token locally;
  reconnect with exponential backoff. The 30s hub pings keep NAT mappings warm
  while foregrounded.
- **CLI / native tools**: prefer the `Authorization` header; a one-shot
  `session/prompt` + update stream is a perfectly fine first client.
