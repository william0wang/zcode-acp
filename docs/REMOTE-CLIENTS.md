# Remote Clients — Integration Guide

How to attach any out-of-editor client — browser SPA, mobile app, CLI, desktop
tool — to bridge sessions over the network. This document IS the contract:
everything here is implemented by the hub daemon (`zcode-acp hub`) and the bridge's remote
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

| Endpoint                                               | Auth     | Purpose                                                                                                                                                           |
| ------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                      | none     | Liveness probe; `200` body `ok`.                                                                                                                                  |
| `GET /api/instances`                                   | required | Registered bridge instances. Add `?probe=1` to verify first.                                                                                                      |
| `GET /api/instances/{id}/status`                       | required | Real-time per-session running status of one bridge.                                                                                                               |
| `POST /api/instances/{id}/sessions/{sessionId}/close`  | required | Retire a session from remote discovery — see [Closing a session](#closing-a-session).                                                                             |
| `POST /api/instances/{id}/sessions/{sessionId}/rename` | required | Rename a session — see [Renaming a session](#renaming-a-session).                                                                                                 |
| `GET /api/quota`                                       | required | Account-level usage stats — same payload as `account/usage_stats`, no ACP connection needed.                                                                      |
| `POST /api/upgrade`                                    | required | Trigger the hub's own staleness check — see [Hub self-upgrade](#hub-self-upgrade).                                                                                |
| `GET /api/projects`                                    | required | Known-project list (remote session-create whitelist) — see below.                                                                                                 |
| `GET /api/projects/sessions?workspacePath=`            | required | A project's full session store incl. closed ones — see [Resuming a closed session](#resuming-a-closed-session).                                                   |
| `POST /api/instances {workspacePath[, sessionId]}`     | required | Create a bridge for one known project — a visible terminal TUI window (session-create) or one that boots into a closed session (resume, `sessionId`) — see below. |

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
    "origin": "editor",
    "sessions": [
      {
        "sessionId": "5f0c…",
        "title": "Fix login bug",
        "status": "running",
        "updatedAt": 1723800012000
      }
    ]
  }
]
```

- `id` is the bridge process id — stable for that editor window's lifetime,
  unique per window.
- `origin` is `"editor"` (a bridge an editor spawned over stdio) or
  `"serve"` (a headless bridge created via remote session-create — see
  below; older bridges send no field, treat as `"editor"`).
- **On refresh, call `/api/instances?probe=1`**: the hub TCP-probes each
  registered bridge's loopback port before answering. One failed probe only
  marks the instance unhealthy; it is pruned after staying unreachable ~8s
  (verified by a later probe). This keeps a busy-but-alive bridge (momentary
  event-loop stall) listed instead of evicting it and kicking attached
  clients, while a hard-killed bridge still disappears in ~2 refreshes instead
  of waiting out the 30s heartbeat TTL.
- `sessions[].sessionId` is the **ACP session id the editor uses** for that
  conversation (placeholder ids are stable across bridges — Zed stores them
  and the durable alias store records them). Attaching under it via
  `session/load` puts the remote client on the same notification stream as
  the editor tab: turns driven from either side stream live to both. A
  conversation with no editor placeholder is advertised under its backend
  id (`sess_…`), still loadable via `session/load` pass-through resume. The
  title is set exactly once by the bridge — from the first line of the first
  prompt (capped at 80 chars), the moment that prompt is sent — and never
  changes automatically afterwards; a manual rename is the only later
  modifier. Sessions born in a previous bridge lifetime get their title from
  the session store on load/resume.
- `sessions[].status` is a coarse `"running" | "idle"` indicator riding the
  heartbeat (up to ~10s stale; absent on older bridges — treat as unknown).
  For the live value poll [`/api/instances/{id}/status`](#session-running-status).
- **Prompt echo**: when any client sends `session/prompt`, the bridge
  broadcasts the user's text to every OTHER attached client as a
  `user_message_chunk` (messageId prefixed `uprompt_`). Your own prompts are
  never echoed back to you — render them locally as you send them. Without
  this rule a turn driven from the other side arrives without the user
  message that started it.
- `sessions` is gated on two rules: the conversation must be **currently
  running** (a live registration in the advertising bridge — an open editor
  tab, or a remote attachment that ran a turn; a brand-new conversation
  counts from the moment its FIRST turn starts, not after it completes) and
  **accessible** (every listed id resolves and resumes through that bridge).
  Retired conversations of the project are NOT listed even though the
  backend store still has them — the store only enriches live entries with
  the stored title and a cross-bridge `updatedAt`. The auto-title is set once
  at the first prompt (first non-empty line, capped at 80 chars) and is never
  revised by later turns.
- Entries are **deduped across instances**: several bridges of the same
  project (e.g. a leaked old process plus the current one) can all hold the
  same live conversation under the same id; the hub keeps one copy per
  session — the instance whose copy has the freshest `updatedAt` (i.e. the
  bridge actually driving it). Attach to whichever instance the entry
  appears under.
- Poll every 3–5s. There is no push notification for registry changes yet.
- Fields are **additive-only** across releases — ignore fields you don't know.

Lifecycle timings: a bridge re-registers every 10s (the registration doubles as
heartbeat); an instance disappears ~30s after its heartbeats stop; the hub
exits after ~10 idle minutes with no instances and no proxies, and the next
bridge re-spawns it on demand.

## Remote session-create

A remote client can start a NEW agent session in any of the machine's known
projects — no editor required (bridge 0.17.0, ADR-0014):

```text
GET  {hub}/api/projects
   → 200 [{"workspacePath":"/Users/me/proj","sessions":294,"lastActive":1723800000000}, …]

POST {hub}/api/instances  body {"workspacePath":"/Users/me/proj"}
   → 200 {"id":"47073","reused":false}
   → 403 "unknown project"          (path not on the known-project list)
   → 502 (spawn failed / bridge died during startup / never registered;
          ~10s headless, ~20s when a terminal window is opened)
```

- `GET /api/projects` aggregates the App's tasks index: every workspace that
  ever ran a session, filtered (system temp trees, `~/.zcode` itself,
  vanished directories) and sorted by last activity. The POST validates
  against this exact list — no arbitrary paths. Note this is a convenience
  bound, not a security boundary: a token holder can already run any
  editor-bridge session in an arbitrary cwd; the trust boundary is the
  token itself.
- On create the hub incubates a VISIBLE interactive TUI (Martty) in the machine's
  terminal (ADR-0016, macOS): the project's owner gets a real local CLI
  window, and its bridge registers with the hub like any serve instance (it
  appears in `/api/instances` with `origin:"serve"` — allow up to ~20s for
  the GUI round-trip). Headless machines, SSH sessions, or
  `ZCODE_ACP_HUB_TERMINAL=0` fall back to the detached `zcode-acp serve`
  bridge of the original design. Connect with the normal
  `WS /acp?instance=<id>` and drive it like any instance; the new
  conversation's cwd is the project directory regardless of what
  `session/new` sends (session roots are pinned in both surfaces).
- **Which terminal opens** (nothing is auto-detected — the hub is a
  background process and macOS has no default-terminal setting):
  `ZCODE_ACP_HUB_TERMINAL_COMMAND` (a shell command; `{script}` is replaced
  by the quoted script path) wins over `ZCODE_ACP_HUB_TERMINAL_APP`, which
  is matched against built-in launch recipes: Terminal and iTerm run the
  script via `open -a` (both execute `.command`); WezTerm, kitty, Alacritty,
  and Ghostty are driven by their own CLI (`open -na <app> --args … -e …`);
  any other name passes through to `open -a` as-is. Default: Terminal.app.
  Warp cannot execute scripts or commands programmatically at all
  (warpdotdev/warp#1917, #3959, #9083) — naming it warns, and the flow
  degrades to the headless bridge after the register timeout.
- Create NEVER reuses a live serve-origin instance (ADR-0016 amendment):
  the App flow lists project history first, which incubates a headless serve
  bridge, and reuse meant the promised terminal window could never open once
  a project was browsed. Every create incubates its own window and answers
  with the NEW instance; concurrent identical creates join the same in-flight
  spawn instead of racing a duplicate. A client that wants a HEADLESS attach
  should not POST at all — attach to the instance id the history listing
  already returns.
- Lifetime depends on the surface: a terminal-TUI instance lives while its
  window lives (the owner closing it retires the bridge — re-create on
  demand); the headless fallback exists for remote interest only and exits
  ~10 minutes after the last client detaches AND the last running turn
  finishes. Treat any vanished instance like a dead bridge.

## Resuming a closed session

Discovery lists only currently-running conversations. To find and reopen a
PREVIOUS one — including conversations no bridge currently holds — use the
per-project history listing (ADR-0015):

```text
GET {hub}/api/projects/sessions?workspacePath=/Users/me/proj
  → 200 {"workspacePath":"/Users/me/proj",
         "instance":{"id":"47073","origin":"serve"},
         "sessions":[
           {"sessionId":"sess_9f2…","title":"Fix login bug",
            "cwd":"/Users/me/proj","updatedAt":"2026-09-01T10:00:00.000Z",
            "live":false,"running":false}, …],
         "nextCursor":{"before":1723800000000,"beforeId":"sess_9f2…"}}
  → 400 "workspacePath required" / "invalid limit/before …"
  → 403 "unknown project"          (path not on the known-project list)
  → 502 (spawn failed / bridge unreachable / broken list)

POST {hub}/api/instances  body {"workspacePath":"/Users/me/proj",
                                "sessionId":"sess_9f2…"}
  → 200 {"id":"47080","reused":false}   (a NEW instance: the terminal window's bridge)
  → 400 "invalid sessionId — session id expected"
  → 502 (spawn failed / never registered; ~20s — a terminal window opens)
```

- The listing is the project's backend session store — closed conversations
  included, and conversations currently executing on this project's bridge
  (live, or with a turn in flight) EXCLUDED: those belong to discovery, and
  resuming one would load it onto a second bridge. The `live`/`running`
  fields stay in the row shape for compatibility but are always `false`.
  Titles are the store's authoritative ones. A conversation held by a
  DIFFERENT bridge (e.g. an open editor window) cannot be detected here —
  the two id spaces are unreconciled by design; check discovery first if in
  doubt.
- **Pagination** (projects can hold dozens of sessions): rows come
  newest-first (`updatedAt` descending). `?limit=<n>` sets the page size
  (default 20, max 200); the previous response's `nextCursor` splits into
  `?before=<ms-epoch>&beforeId=<sessionId>` for the next older page — the
  composite cursor names the exact last row, so timestamps tied across a
  page boundary are never skipped or repeated. `nextCursor: null` means
  there are no older sessions. Order is total (id tiebreak), so
  paging never repeats or skips rows.
- The first listing of a cold project incubates its serve bridge (the same
  machinery as remote session-create; budget ~12s) — later listings and the
  follow-up load reuse it.
- **Resume in the App (no local surface)**: attach DIRECTLY to the instance
  the listing already returned (`WS /acp?instance=<listing instance id>` —
  no POST; a bare POST would now pop a desktop window, see the amendment
  above), then `session/load {"sessionId":"<the listed id>"}` — history
  replays and the conversation continues with `session/prompt`, entirely in
  the client. A cold project (no listing yet) lists first — the listing IS
  the headless incubator.
- **Resume on the desktop (ADR-0017, amended by ADR-0020)**: `POST
/api/instances` with the `sessionId` too — the hub incubates a VISIBLE
  terminal TUI window that boots straight into that conversation (the same
  terminal/`ZCODE_ACP_HUB_TERMINAL` selection and headless fallback as
  session-create). The window lands on the right session AND shows the previous
  transcript: the bridge serves the boot `session/new` as a load of the target
  id, replays a chunk-formatted history tail after the response (Martty folds
  those), and incubates the window with a `DSH_TUI_AUTOPROMPT` trigger that
  Martty auto-submits at boot — dropping its welcome banner, which would
  otherwise cover the transcript until the user's first message — and the
  bridge answers with a one-line ack instead of a model turn. This happens EVEN when a serve bridge is already live
  (the listing incubated one) — the answer is always the NEW instance, the
  bridge the window runs on; attach to it and `session/load` the same id to
  follow along in the client (both surfaces then share one bridge, one
  backend process). A bogus id still opens the window: the bridge logs the
  load failure and starts a fresh session instead. The terminal tab is named
  after the conversation: the hub reads the title from the serve bridge's
  session history (best-effort, 2s budget — a miss falls back to the project
  name) and the launch script emits it as an OSC 0 title before starting the
  CLI (Martty never sets a terminal title itself, so the name sticks).
  Resuming the same session
  twice pops two windows; only identical concurrent requests share one
  incubation.
- `sessionId` here is the backend store id (`sess_…`), which `session/load`
  accepts as-is (pass-through resume). The same conversation may also appear
  in discovery under a different (ACP) id — treat discovery as the
  live-attention surface and this listing as the browse/resume surface.

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

## Account quota

Two equivalent channels; prefer plain HTTP — it needs no ACP connection:

```text
GET {hub}/api/quota → 200, the JSON body documented below (Cache-Control: no-store)
```

The hub queries the usage APIs directly — quota belongs to the machine's
configured credentials, not to any bridge instance (ADR-0005) — and caches the
result ~30s server-side, so polling is cheap. A `502` means the upstream query
failed; retry later.

The ACP method is `account/usage_stats` (Proposal 0002), useful when a
conversation is already attached. Plan quota is **account-level**, so it is a
pull-only request — callable any time after `initialize`, no session required.
Fetch once after attach and on demand; quota changes are slow, there is no
push.

Both channels return the same payload, mirroring the `zcode-acp quota` CLI card's
data model — one GLM section, one Opencode Go section, and one Ollama Cloud
section — so clients can reproduce the CLI layout exactly:

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
      },
      "ollama": {
        "kind": "success",
        "windows": [
          { "key": "session", "label": "5h", "usagePercent": 31 },
          { "key": "weekly", "label": "Week", "usagePercent": 67.5 }
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
- `ollama` (`kind`: `success` | `not_configured` | `auth_error` |
  `unavailable`): on success, `windows` carries whichever entries the
  account's plan exposes — legacy plans: `session` (`5h`) + `weekly`
  (`Week`); current credit plans: `monthly` (`Month`) — each with
  `usagePercent` (0–100) and, when available, `resetsAt` (epoch ms,
  derived client-side: epoch-aligned 5h buckets / Monday 00:00 UTC weeks /
  the `/api/me` billing period or subscription-day anniversary for monthly).
  `not_configured` means no
  Ollama API key is set — omit the section, like the CLI does.
- Provider failures are per-section `kind` strings, not JSON-RPC errors —
  render the same status line the CLI would (e.g. auth expired) and retry
  later. Only transport-level failures reject the request.
- Cached ~10s server-side (same caches as the `/quota` command).

## Settings API

The machine's ZCode configuration, exposed as JSON so a native client can
render the management UI that the desktop app provides (ADR-0025). Plain HTTP,
no ACP connection needed. **User scope only** — `~/.zcode/`; project-level
(`<ws>/.zcode/`) configuration is not part of this contract yet.

Two mounts, identical routes and identical semantics:

- `{hub}/api/settings/*` — token-gated (`Authorization: Bearer …` or
  `?token=…`), the only public entry.
- `http://127.0.0.1:{bridgePort}/settings/*` — the bridge's own loopback
  server, **unauthenticated** like `/status` and `/fs`. Any local process can
  already write these files, so the HTTP route grants no new capability. The
  bind is `127.0.0.1` only.
- Per-instance proxying is available too:
  `{hub}/api/instances/{id}/settings/*` relays to that bridge's loopback
  mount (same body passthrough as session close/rename).

Every write answers with an **effect class** — read it before deciding whether
to prompt the user:

| `effect`        | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `immediate`     | Applied to the running backend within ~1s (provider table poll, skills) |
| `needs-restart` | Read once at agent start — needs a new backend process to take effect   |

`needs-restart` applies to MCP servers, hooks, and subagent markdown. After
such a write, either prompt the user or call
`POST {hub}/api/instances/{id}/backend/restart`, which cancels in-flight turns
and respawns that bridge's backend (see below). `GET /api/settings/pending-restart`
reports whether this process has recorded any `needs-restart` write since it
started.

### Read endpoints

| Endpoint                     | Purpose                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| `GET /settings/all`          | One-shot snapshot of every section (first screen)                        |
| `GET /settings/models`       | Selectable models, unioned across `config.json` + `provider_config.json` |
| `GET /settings/skills`       | Discovered skills with their enabled state                               |
| `GET /settings/mcp`          | Configured MCP servers (user config + enabled plugins)                   |
| `GET /settings/hooks`        | The full hooks tree, 7 event names                                       |
| `GET /settings/agents`       | Subagents with enabled state and model override                          |
| `GET /settings/usage?range=` | `7d` \| `30d` \| `all` per-model token usage                             |
| `GET /settings/quota`        | Same payload as `/api/quota` (account-level, hub only)                   |
| `GET /settings/reset-cards`  | Coding-plan reset card status (`?providerId=` required)                  |
| `GET /settings/backups`      | Config backups available for restore                                     |
| `GET /settings/app-update`   | ZCode desktop app version check (`?channel=stable\|preview`)             |

`/settings/all` degrades per section: a failure to read the local config files
is a whole-request `500` (the environment is broken), while `usage` and
`resetCards` report their own state — no database and no credentials are normal,
not errors. `resetCards` in the snapshot carries **eligibility only**
(`providers` + whether the credential store decrypts); the cards themselves need
a `providerId` and a network read, so fetch them from
`GET /settings/reset-cards?providerId=…`.

### Write endpoints

| Endpoint                                  | Effect          | Purpose                                     |
| ----------------------------------------- | --------------- | ------------------------------------------- |
| `PUT /settings/providers/{id}`            | `immediate`     | Enable/disable, rename                      |
| `POST /settings/models`                   | `immediate`     | Add a model to an existing provider         |
| `DELETE /settings/models/{pid}/{mid}`     | `immediate`     | Remove a model                              |
| `POST /settings/skills/enable`            | `immediate`     | `{path, enable}`                            |
| `DELETE /settings/skills/{path}`          | `immediate`     | Delete a skill directory                    |
| `POST /settings/skills/copy-to-user`      | `immediate`     | Copy a workspace skill to `~/.zcode/skills` |
| `PUT /settings/mcp/{name}`                | `needs-restart` | Create or update an MCP server              |
| `DELETE /settings/mcp/{name}`             | `needs-restart` | Remove an MCP server                        |
| `POST /settings/mcp/enable`               | `needs-restart` | `{name, enable}`                            |
| `PUT /settings/hooks/{event}/{index}`     | `needs-restart` | Edit one existing hook entry                |
| `POST /settings/hooks/enabled`            | `needs-restart` | `{enabled}` — the whole hooks tree          |
| `PUT /settings/agents/{id}`               | `needs-restart` | Create or update a subagent                 |
| `DELETE /settings/agents/{id}`            | `needs-restart` | Delete a subagent                           |
| `POST /settings/agents/{id}/enable`       | `needs-restart` | `{enable}`                                  |
| `POST /settings/reset-cards/use`          | —               | Consume a reset card (see below)            |
| `POST /settings/reset-cards/opportunity`  | —               | Request an opportunity (see below)          |
| `POST /settings/reset-cards/history-read` | —               | Mark the reset history read                 |
| `POST /settings/backups/restore`          | per file        | Restore a backup                            |
| `POST /settings/app-update/install`       | —               | Download and stage a new app build          |

Notes that clients must honor:

- **Providers cannot be created or deleted** through this API — only enabled
  state, display name, and the models inside an existing provider. Adding a
  brand-new provider stays a desktop-app (or hand-edit) operation.
- **Hooks are read-complete but write-limited**: the tree is returned in full,
  and writes may only modify an existing entry's `command` / `timeoutMs` /
  `enabled`. Adding or removing events, matchers, or hook entries is not
  supported. Unknown keys on a hook object are preserved verbatim.
- **Subagents**: `name`, `description`, `color`, `model`, `thoughtLevel` are
  editable; the system-prompt body is not. Built-in agents (`general-purpose`,
  `Explore`) cannot be edited or deleted — only their model override can change.
  Send `{"providerId": null, "modelId": null}` on a built-in agent to CLEAR its
  override and return it to the workspace default.
- **Reset cards are irreversible.** `POST /settings/reset-cards/use` requires
  the `nonce` returned by `GET /settings/reset-cards`, is restricted to
  `account:*` providers (`403` otherwise), and carries an idempotency key so a
  retry cannot burn two cards. `credentials_unavailable` means the machine's
  encrypted credential store could not be decrypted.
- Every write is a locked read-modify-write of the real file: unknown keys are
  preserved, a backup is taken first, and a write that fails self-validation
  never lands. Concurrent writers are serialized by ZCode's own cross-process
  lock, so the last write wins and no change is silently dropped.

### Restarting the backend

```text
POST {hub}/api/instances/{id}/backend/restart → 200 { "ok": true, "cancelledTurns": 2 }
```

Cancels that bridge's in-flight turns, kills its `zcode app-server` child, and
lets the next prompt respawn it — the same path the sandbox arm-flip uses.
`cancelledTurns` is how many conversations were interrupted; surface it before
the user commits to the action.

`GET /api/instances/{id}/settings/pending-restart` reports whether that bridge
process has recorded any `needs-restart` write since it last restarted its
backend, so a client can ask "is a restart needed?" on a fresh screen instead of
tracking it itself. The flag is cleared by a successful backend restart.

Use the **per-instance** spelling, not the hub-local
`GET /api/settings/pending-restart`: the counter lives in the bridge that served
the write, and the hub has no backend of its own to restart, so its copy can
never be cleared (the hub-local route answers `501` on a restart attempt and
keeps reporting `true` until the hub idle-exits).

### Reset cards (coding-plan quota)

Three calls, in this order:

```text
GET  /settings/reset-cards?providerId=account:bigmodel-individual-coding-plan
POST /settings/reset-cards/use            { providerId, resetType, nonce, idempotencyKey }
POST /settings/reset-cards/history-read   { providerId }
```

```json
→ { "ok": true, "resetCards": {
      "availableFiveHour": [{ "expireAt": 1790000000000 }],
      "availableWeek": [],
      "latestFiveHour": { "usedAt": 1789000000000 },
      "latestWeek": null,
      "hasUnreadHistory": true,
      "nonce": "3f6c…" } }
```

- `resetType` is `FIVE_HOUR` or `WEEK`.
- The `nonce` is single-use and issued per status read. Sending a stale one
  answers `409` — refresh the status and retry. This is what stops a screen the
  user left open an hour ago from spending a card they have since seen change.
- The `idempotencyKey` is what makes a retry safe: the same key always answers
  the same outcome, so a dropped response cannot burn a second card. Generate
  it once per user gesture and reuse it on retry.
- A denial is `{ok: true, granted: false, nextTryAt: <ms>}` — a countdown to
  render, not an error.
- `credentials_unavailable` means the machine's encrypted credential store
  could not be decrypted (missing file, wrong `ZCODE_CREDENTIAL_SECRET`, or a
  different machine's store).
- Known limit: a **team** plan needs organization/project scope headers whose
  ids are not in the credential store a headless process can read, so team-plan
  resets answer a backend error. Personal plans work.

### Usage payload

```json
{
  "available": true,
  "range": "7d",
  "summary": { "totalTokens": 1587917357, "requestCount": 20630, "models": 7 },
  "models": [
    {
      "modelId": "GLM-5.3",
      "totalTokens": 1587917357,
      "inputTokens": 0,
      "outputTokens": 0,
      "reasoningTokens": 0,
      "cacheReadTokens": 0,
      "requestCount": 11419,
      "share": 0.53
    }
  ],
  "daily": [{ "date": "2026-09-22", "models": [{ "modelId": "GLM-5.3", "totalTokens": 100 }] }]
}
```

`available: false` with zero values means the local agent database does not
exist on this machine (never ran an agent) — render an empty state, not an
error. Tool statistics and the activity heatmap are not in the first version.

### Updating the ZCode desktop app

The bridge checks the official release feed and stages the verified download, so
a client can offer "update available" without the user opening the app.

```text
GET  /settings/app-update?channel=stable
POST /settings/app-update/install  { version, url, channel? }
```

```json
→ { "ok": true, "appUpdate": {
      "updateAvailable": true,
      "currentVersion": "3.14.1",
      "latestVersion": "3.14.3",
      "channel": "preview",
      "platform": "darwin-aarch64",
      "appPath": "/Applications/ZCode.app",
      "releaseName": "Release v3.14.3",
      "releaseNotes": "## 新功能\n…",
      "files": [{ "url": "https://cdn-zcode.z.ai/…/ZCode-3.14.3-mac-arm64.zip", "sha512": "…" }],
      "install": { "stage": "idle", "version": null, "receivedBytes": 0, "totalBytes": null } } }
```

- `channel` is `stable` (default) or `preview`. The preview channel is the app's
  own opt-in setting; do not switch a user into it silently.
- `updateAvailable: false` with `currentVersion: null` means **no ZCode app is
  installed on this machine** — hide the row, do not show an error.
- Pass `version` and `url` from the same `GET` response you just read. The bridge
  then **re-reads the manifest itself** and refuses (`409`) unless that exact URL
  is a current manifest entry with a checksum, and `version` is what the channel
  is actually serving — so a client cannot ask for an old build (a silent
  downgrade) or skip verification. A `sha512` in the request body is ignored for
  the same reason: the manifest's checksum is the one that counts.
- Only `https://cdn-zcode.z.ai/…` URLs are accepted (`400` otherwise).
- The install answers `202 Accepted` immediately and runs in the background;
  poll `GET /settings/app-update` (its `install` field) for progress. A second
  install while one is running answers `409`.

`install.stage` is the outcome, and clients must render each one differently:

| `stage`              | Meaning and what to show                                                      |
| -------------------- | ----------------------------------------------------------------------------- |
| `downloading`        | `receivedBytes` / `totalBytes` progress                                       |
| `installing`         | Verified, swapping the bundle                                                 |
| `done`               | Installed. `restartRequired: true` — ask the user to quit and reopen the app  |
| `needs-user-install` | `artifactPath` holds the verified bundle; the install location needs the user |
| `failed`             | `error` carries the reason                                                    |

**`needs-user-install` is an outcome, not a failure.** The bridge probes whether
the install location is writable and swaps the bundle only when it is. When it
is not, the download and checksum still ran, so the verified bundle is left at
`artifactPath` and the user finishes the job: show the path (or reveal it in
Finder), and they drag `ZCode.app` over the old one — macOS raises a one-shot
confirmation for that replacement. Reporting `done` here would be a lie the user
discovers on relaunch.

An app installed in a writable location is replaced directly and answers `done`.
The old bundle is only deleted after the new one is in place, so a failed install
leaves the previous version intact.

## Session running status

Two layers (ADR-0005), both plain HTTP — no ACP connection needed:

- **Heartbeat**: every `sessions[]` entry in `/api/instances` carries
  `status: "running" | "idle"`. Free with the list you already poll, but up
  to ~10s stale (the bridge re-registers every 10s).
- **Real-time**: `GET {hub}/api/instances/{id}/status` proxies the bridge's
  in-memory view — assembled without any backend RPC, safe to poll
  aggressively (1–2s) for a task board or detail view:

```json
{
  "sessions": [
    {
      "sessionId": "5f0c…",
      "title": "Fix login bug",
      "status": "running",
      "updatedAt": 1723800012000
    }
  ]
}
```

- Membership matches discovery: live, accessible sessions only (`hasActivity`
  and a backend mapping). An empty `sessions` array means the bridge holds no
  live conversation.
- A cancelled turn still counts as `running` until its loop unwinds — the
  conversation is busy; treat `idle` as the only "finished" signal.
- `status` is the real-time field. `title` and `updatedAt` come from the
  bridge's in-memory summary, so the heartbeat's store-enriched values in
  `/api/instances` may be fresher for cross-bridge conversations.
- Errors: `401` bad token, `404` unknown instance, `502` bridge unreachable.
  `HEAD` is supported.

## Closing a session

```text
POST {hub}/api/instances/{id}/sessions/{sessionId}/close   → 200 { "ok": true }
```

Retires a conversation from remote discovery. This addresses a protocol gap:
ACP has no editor→agent "tab closed" notification, so a conversation retired
on the editor side stays in this bridge's in-memory summary — and therefore
in your list — until the bridge restarts. Closing clears the summary.

**Closing is not deletion.** The backend session store, the editor's own
conversation storage, and the App's tasks-index are untouched; only remote
visibility changes. Two guards shape the semantics (ADR-0006):

- A session with a **running turn is refused** (`409`) — cancel the turn
  first.
- **Self-healing**: if the editor side actually still has the conversation
  open, its next activity there (any prompt, any load with history)
  re-marks it active and it REAPPEARS in discovery within one heartbeat.
  So a wrongly closed conversation recovers on its own, while an
  editor-side-retired one stays gone. A bridge restart auto-resume alone
  does NOT resurrect a closed session — real use does.

Errors: `401` bad token, `404` unknown session (or instance), `409` running,
`502` bridge unreachable. Takes effect immediately in
`/api/instances/{id}/status` and within one heartbeat (≤10s) in
`/api/instances`.

Cross-instance note: if the same conversation is also registered by another
bridge of the project, the hub's dedupe re-attaches it under that instance —
close it there too.

### Serve-origin instances: closing ends the CLI

Everything above describes **editor-origin** bridges (retire-only). For
`origin: "serve"` instances — the ones the hub incubated for remote
session-create/resume — closing the LAST advertised conversation also
TERMINATES the CLI that hosts it:

- A **terminal TUI** bridge is taken down with one group signal to its whole
  process tree (cli → martty → bridge); martty restores the TTY and exits
  cleanly, and each terminal's own close-on-exit preference then takes the
  window (default: closes in Terminal, iTerm2, Ghostty, Warp).
- A **headless serve** bridge exits immediately (its idle timeout pulled
  forward to zero).

The instance disappears from `/api/instances` within one heartbeat. The
conversation itself is still resumable later via
`POST /api/instances` / `GET /api/projects/sessions` — closing ends the
process, not the history. If other advertised conversations (or remote-created
empty sessions) remain on the instance, it stays up.

## Renaming a session

```text
POST {hub}/api/instances/{id}/sessions/{sessionId}/rename
     body: { "title": "new name" }                        → 200 { "ok": true, "title": "…" }
```

The session title is set **once**, automatically, from the first prompt of a
freshly created session (first non-empty line, capped at 80 chars) — this
endpoint is the only later modifier. ACP has no client→agent rename channel,
and an editor-side rename lives in the editor's own storage forever, so the
remote side is where a rename enters the system.

The bridge applies the rename everywhere: its in-memory title pin (no later
automatic write can touch it), the discovery summary (live within one
heartbeat), the ZCode App's tasks-index (`title_overridden=1`, same marker the
App's own rename sets), and a `session_info_update` broadcast to every
attached client — the editor tab updates live. The title is normalized like
the auto-title: flattened to one line, trimmed, capped at 80 chars; an
all-whitespace title is rejected with `400`.

Errors: `400` missing/empty title or oversized body (>4 KB), `401` bad token,
`404` unknown session (or instance), `502` bridge unreachable. Renaming during
a running turn is allowed — titles are no longer turn-coupled.

## Hub self-upgrade

```text
POST {hub}/api/upgrade   → 200 { "ok": true, "restarting": false, "reason": "up-to-date",
                                    "runningVersion": "0.11.6", "diskVersion": "0.11.6" }
```

Lets a remote client pick up a hub that was rebuilt on the machine (e.g. code
edited and `pnpm build` run through a remote agent session). The client only
**triggers** the check — the restart decision is entirely the hub's own. The
hub restarts onto the on-disk code only when it judges that code NEWER than
itself, by either signal:

- the on-disk `package.json` version is newer than the version frozen into
  the running process at start, **or**
- any `.js` under `dist/` has an mtime later than process start (a rebuild,
  even without a version bump).

When `restarting` is `true`, the hub exits ~500ms after replying, re-spawns
itself from the on-disk dist, and bridges re-register on their next heartbeat
(≤10s). Poll `GET /api/health` until it answers again, then refresh
`/api/instances` and reconnect. A respawned hub starts after the newest dist
mtime, so the condition self-negates — no restart loops, and an OLDER on-disk
version never triggers anything.

Errors: `401` bad token. `GET` (or any other method) falls through to `404`.

## Session files (read-only)

Browse and download files of a session's project — served by the bridge,
byte-proxied by the hub, guarded by the same token as everything else
(ADR-0004). Capability probe: `initialize` returns
`agentCapabilities._meta.zcode.fs === true`.

```text
GET {hub}/api/instances/{id}/fs/list?sessionId=…&path=<rel>    one directory level
GET {hub}/api/instances/{id}/fs/file?sessionId=…&path=<rel>    file bytes
    &offset=…&length=…     byte window → 206 + Content-Range
    &line=…&limit=…        text window (defaults 1 / 200, cap 5000)
    &dl=1                  Content-Disposition: attachment (download, not inline)
```

- `path` resolves against the session's root cwd — the directory the session
  was created or loaded with. Absolute paths work only when they land inside
  it; `..` segments and symlinks pointing outside the root are rejected
  (403).
- `list` returns `{ root, entries: [{name, kind: "file"|"dir"|"symlink",
size, mtime}], truncated }`. Dotfiles are included — filter client-side.
  Entries sort dirs-first in byte order; `truncated: true` marks more than
  2000 entries. Symlinks report placeholder stats (`size: 0`); reading
  through one resolves and scope-checks the target.
- `file` streams with `Content-Length` and a Content-Type inferred from the
  extension (`application/octet-stream` fallback) — `<a download>`,
  `<img src>`, and `fetch` streaming all work directly. `HEAD` is supported.
- Byte and line windows are mutually exclusive (400). A line window returns
  `text/plain` with `X-Zcode-First-Line` set to the first served line;
  memory is O(limit), so it works on arbitrarily large logs.
- Errors: `400` bad params · `403` unknown session / path escapes the root ·
  `404` not found / unknown instance · `416` offset beyond EOF · `502`
  bridge port unreachable. A `404` right after a bridge upgrade is the hub
  self-upgrading to learn the route — retry.
- Read-only by design, and the token remains the security boundary as
  everywhere else; the session root contains accidents (wrong path joins),
  not attackers.

## Slash-command handling

Only the commands the bridge advertises via `available_commands_update` (plus
`skill`/`init` and skills) are treated as commands. Any other `/`-leading
prompt — e.g. a pasted directory path — is delivered to the model as plain
text with an invisible zero-width-space prefix; clients see the text verbatim
in replay and echoes. Clients should not special-case this.

Skill names are PER-CLIENT in the advertised list: editors that group
visually (Zed) receive `$name` (e.g. `$tdd`), while martty and clients that
send no `clientInfo` receive the bare `name` so their `/` completion menu
surfaces skills at all. Both spellings route identically — `/tdd` and `/$tdd`
are the same command.

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

| Symptom                                  | Cause                                                                                                                                                                                                                                                                    | Client action                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| WS closes                                | bridge exited (editor closed) or network drop                                                                                                                                                                                                                            | Poll `/api/instances`; if the instance is gone, its sessions are gone too — drop it from the UI.    |
| Instance missing from `/api/instances`   | Heartbeats stopped >30s, or `?probe=1` found the bridge port unreachable for ~8s straight                                                                                                                                                                                | Remove the instance from the UI.                                                                    |
| `/api/instances/{id}/status` answers 502 | The instance is registered but its bridge port is unreachable — it is dying; the heartbeat TTL or your next `?probe=1` refresh will drop it                                                                                                                              | Fall back to the heartbeat `status` field, then re-discover.                                        |
| Connect fails for a while                | Hub process died; a bridge re-spawns it on the next heartbeat (typically ≤10s, worst case ~1min under the spawn throttle). Also expected for a few seconds after a bridge upgrade: the hub notices a newer bridge, restarts, and is re-spawned from the upgraded install | Retry with backoff.                                                                                 |
| Disconnect mid-turn                      | Mobile network flap, background suspension                                                                                                                                                                                                                               | The turn continues server-side. Reconnect and `session/load` — history replay is the recovery path. |

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
