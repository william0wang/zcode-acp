# Troubleshooting Guide

## Common Issues Quick Reference

### Backend fails to start

**Symptom:**

```
[zcode-acp] backend: started zcode app-server (pid=12345)
[zcode-acp] backend: reader exited (stdout closed)
```

**Troubleshooting steps:**

1. Check the ZCode CLI version:

   ```bash
   zcode --version
   ```
   - Must be >= 0.14.8

2. Check whether `zcode` is on PATH:

   ```bash
   which zcode
   ```
   - If not found, set: `export ZCODE_BIN=/path/to/zcode`

3. Check the ZCode configuration:

   ```bash
   cat ~/.zcode/v2/config.json
   ```
   - Confirm a `provider` is enabled
   - Confirm `models` are defined

4. Desktop-app CLI (3.12.3+) exits instantly with
   `无法定位 CLI ZCode Built-in Provider Config`: the bundled CLI expects the
   host to pass its provider table via `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`
   (the desktop app does exactly that); launched bare, its own file lookup
   cannot find the copy the bundle ships at `Resources/config/provider/`.
   The bridge injects BOTH provider-table env vars automatically (see
   `builtinProviderEnv` in `src/backend/resolve.ts`), deriving the builtin
   path from the CLI it launches — the CLI uses an injected path verbatim
   only when `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` is set alongside it (it
   defaults to `~/.zcode/v2/provider_config.json`); with the builtin var
   alone the CLI re-syncs the table into a version-keyed runtime copy, which
   voids the bridge's account-config push (next section). The derived value
   also overrides an inherited ambient copy, which is version-keyed and goes
   stale across app updates. To force a custom table, point `ZCODE_BIN` at a
   CLI whose directory carries no adjacent `zcode-builtin.json` and export
   the env var yourself.

### Switching to a GLM coding-plan model fails / snaps back to a third-party model

**Symptom:** picking GLM-5.3 (or GLM-5.3-Flash) in the model picker errors out or the UI
immediately falls back to a third-party model (e.g. DeepSeek); third-party models switch
fine. The bridge log (`ZCODE_ACP_DEBUG=1`) shows
`runtime-model: switch failed (modern: Provider Registry 中不存在 Model …)`.

**Why:** on 3.12+ the backend registry is entitled by an account snapshot the bridge
pushes (`provider/updateAccountConfig`). The push carries a `basedOnZCodeBuiltinRevision`
hash of the provider-table PATH the backend resolved; if the backend resolved a different
copy (its version-keyed runtime copy under
`~/.zcode/v2/runtime/provider/<plat>/<version>/…` instead of the injected
`Resources/config/provider/` path), it accepts the push but silently ignores it — every
`account:*` model is then "not in the Provider Registry". The CLI only uses an injected
builtin path verbatim when BOTH `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and
`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` are set; `builtinProviderEnv` injects both.

**Troubleshooting steps:**

1. Check which table the backend resolved:

   ```bash
   grep -a provider_registry.ready ~/.zcode/cli/log/zcode-$(date +%F).jsonl | tail -1
   ```

   The `configRevision` hash must match the injected path. Verify with:

   ```bash
   python3 -c "import hashlib,os;print(hashlib.sha256(b'/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json').hexdigest()[:16])"
   ```

2. If the hashes differ, the bridge is older than the dual-env fix (0.42.4+) or
   `ZCODE_BIN` points at a CLI without an adjacent `zcode-builtin.json` — check
   `echo $ZCODE_BIN` in the launching shell.

3. Note `session.model_selection.persist_failed` ("FOREIGN KEY constraint failed")
   appears on EVERY switch — including working ones — and is a backend persistence
   wart, not the switching bug. The success signal is the following
   `session.model.updated` event in the same log.

### Switching to a GLM model works but every send fails / retries forever

**Symptom:** the model picker shows the GLM model after switching, but sending a
message errors immediately and retries; the backend log shows
`model.request.failed` with `reason:"unknown"` on `account:bigmodel-…` providers.

**Why:** the 3.12+ backend asks its host for provider runtime headers
(`interaction/requestProviderRuntimeHeaders`) before EVERY model request on an
account provider. A `headersApplied:false` answer makes the turn fail with
-32031 and retry. The bridge (0.42.5+) answers with the coding plan's API key
from `~/.zcode/v2/config.json` (`codingPlanRequestAuthFor`) — if sends still
fail, check that the enabled `builtin:bigmodel-coding-plan` entry carries a
non-empty `options.apiKey` in that file. Start-plan providers stay declined
(Aliyun captcha — desktop app only, issue #123).

### Authentication / credential errors (401, provider auth failed)

**Symptom:** turns fail with authentication errors (e.g. `401`, `provider auth failed`, `invalid api key`), or `~/.zcode/v2/config.json` is missing.

**Why:** This bridge advertises agent-managed auth — it reads the GLM API key from `~/.zcode/v2/config.json` and forwards it to the ZCode subprocess. No editor-side API key or environment variable is involved. If the credentials file is absent, empty, or carries an expired/invalid key, every turn will fail at the first model call.

**Troubleshooting steps:**

1. Confirm the credentials file exists and has an enabled provider:

   ```bash
   cat ~/.zcode/v2/config.json
   ```
   - There must be a `provider` entry with `"enabled": true`
   - Its `options.apiKey` must be present and non-empty

2. If the file is missing or the key is stale, **install and log into the ZCode desktop app** — it writes a fresh `config.json` with a valid enabled provider. There is no manual API-key configuration in the editor.

3. There is no env override for the provider base URL: the app-server reads `ZCODE_BASE_URL` as its own service origin, so the bridge never passes one through (see `src/backend/credentials.ts`). Edit `config.json` (or the provider config in the App) instead.

### session/subscribe fails

**Symptom:**

```
session/subscribe failed: <backend error message> [(code <N>)]
```

The error message carries the backend's real failure reason. It is **no longer**
a hardcoded version string — read the message text to identify the root cause.

**Common causes:**

| Message fragment                 | Cause                                                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reader exited (backend dead)`   | The zcode subprocess crashed/exited. Restart the editor session.                                                                                                                             |
| `timeout`                        | The per-attempt 5s subscribe deadline elapsed. The bridge retries transient timeouts once (2 attempts total, ~10.5s worst case); if both fail, the backend was unresponsive for that window. |
| `pipe broken`                    | The stdin pipe to the zcode subprocess broke (process died mid-write).                                                                                                                       |
| `method not found (code -32601)` | The CLI genuinely is too old (< 0.14.8). Upgrade.                                                                                                                                            |
| `Session is not active` (-32004) | The backend evicted the session's resident runtime (idle ~10min, or its LRU cap). The bridge self-heals via `session/resume` (see below).                                                    |

**`Session is not active` (code -32004) in detail:**

The zcode backend keeps session runtimes ("residents") in memory and evicts
them after ~10 minutes idle (log event `session.resident_deactivated`,
`reason: "idle_timeout"`) or under its resident LRU cap. An evicted session
fails every session-scoped RPC with `-32004` while the session file stays
intact — the editor still shows its local copy of the conversation, but
sending a message errors and remote clients replay an empty session.

The bridge self-heals on every entry point:

- `session/prompt` reloads the session via `session/resume` and retries the
  subscribe once when it sees this error;
- the "loaded in backend" verification carries a 5-minute TTL
  (`BACKEND_RESIDENT_TTL_MS`), so `session/load` / `session/resume` re-issue
  the backend resume RPC instead of trusting a stale in-memory flag;
- `ensureRealSession` (config/slash/extension entry points) reloads a stale
  mapping before use, unless a turn is in flight.

If the error still surfaces, the resume itself is failing — check the backend
log (`~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`) for the underlying cause
(corrupt session file, lock contention from another zcode process).

**Troubleshooting steps:**

1. **Read the error message** — the fragment identifies the cause (table above).

2. If the message indicates `method not found`, confirm ZCode CLI >= 0.14.8:

   ```bash
   zcode --version
   ```

3. If the version is correct but it still fails, check whether the zcode
   app-server supports subscribe:

   ```bash
   cd /path/to/project
   zcode app-server --stdio
   # send manually:
   { "id": 1, "method": "session/subscribe", "params": { "sessionId": "test", "deliveryKind": "desktop-continuous", "includeSnapshot": true, "afterSeq": 0 } }
   ```

4. Check whether other zcode processes are running:
   ```bash
   ps aux | grep zcode
   killall -9 zcode  # caution: this kills all zcode processes
   ```

### Bash terminal output lost

**Symptom:** Bash terminal output disappears after the turn completes.

**Troubleshooting steps:**

1. Confirm the client declares `terminal_output`:

   ```typescript
   // should be present in clientCapabilities:
   { "_meta": { "terminal_output": true } }
   ```

2. Check whether `dispatchTerminalUpdate` correctly sends the 2-notification split:
   - `terminal_output` (data)
   - `terminal_exit` (status)

3. Check whether `seenToolIds` synchronization is in effect:
   - Without sync, ProjectionDiffer re-emits a content-less ToolCallNew
   - This overwrites the terminal output

### Events lost / not streaming in real time

**Symptom:** Text output appears all at once, without a streaming effect.

**Troubleshooting steps:**

1. Check whether `EventStreamListener` subscribed successfully:

   ```
   [zcode-acp] backend: started zcode app-server (pid=12345)
   ```

   If this log is missing, the backend did not start.

2. Check whether `session/event` pushes arrive:
   - Add logging in `client.ts:route()`
   - Or add logging in `listener.handleEvent()`

3. Check the zcode version: 0.14.5 ~ 0.14.7 do not support subscribe (this
   project has removed the polling fallback)

### Interaction request timeout

**Symptom:** The tool permission or AskUserQuestion popup does not appear.

**Troubleshooting steps:**

1. Check whether zcode sent an interaction request:

   ```
   [zcode-acp]   -> interaction/requestPermission (zcode_id=100)
   ```

2. Check which protocol path the client takes (elicitation vs request_permission):
   - `⟳ AskUserQuestion forwarding elicitation/create (form, N fields)` → elicitation path
   - `⟳ AskUserQuestion forwarding session/request_permission` → fallback path
   - The path is decided by `clientCapabilities.elicitation.form`
   - ExitPlanMode has its own gate: `⟳ ExitPlanMode forwarding elicitation/create` only
     fires when `hasMarttyClient` is true (a martty TUI attached to this bridge — the
     flag is sticky for the process lifetime); other clients take
     `session/request_permission` (their popups render the plan markdown)

3. Check whether `askOnce` (fallback path) or `handleAskUserViaElicitation`
   (elicitation path) successfully sent the request:
   - `⚠ elicitation/create failed: ...` → the client does not support it or the request failed
   - `⚠ request_permission failed: ...` → the fallback path failed

### Turn fails with `model_request_failed` / network error

**Symptom:** A turn ends with an error like `model_request_failed` / "Network
connection failed for the provider request" / "Turn execution failed". Instead
of stopping the session, the bridge retries transient failures automatically.

**What happens:**

When the ZCode backend emits `turn.failed` with a transient cause (provider
network blip, rate limit, brief outage), the bridge retries the turn up to
**5 times** (6 total attempts) with exponential backoff capped at 4s
(1s / 2s / 4s / 4s / 4s). Each retry re-sends the prompt and surfaces a
`[网络异常，正在重试 (n/5)…]` hint so the user knows the turn is being retried
rather than hanging.

Transient errors are identified by the nested `error.cause.code`
(`model_request_failed`, `provider_not_configured`, `rate_limit`, `timeout`,
`ECONNRESET`, etc.) or by network/connection/timeout keywords in
`error.cause.message`. Non-transient failures (e.g. `prompt is running`) still
surface as hard errors immediately.

After retries are exhausted, the bridge **degrades gracefully**: it emits a
user-visible `[请求失败：…。会话仍可用，请重新发送消息重试。]` message and returns
`end_turn`, so the session stays usable — resend the message to try again.

**Debugging:**

```
ZCODE_ACP_DEBUG=1
```

Look for `[retry] transient turn failed, re-sending (attempt N/6)` lines to
confirm the retry path is active. If transient failures persist across all
retries, the underlying provider/network issue needs investigation (see
[Authentication / credential errors](#authentication--credential-errors-401-provider-auth-failed)
and check the provider endpoint reachability).

### `/` completion menu is empty

**Symptom:** Typing `/` shows no command completion.

**Troubleshooting steps:**

1. Check whether `available_commands_update` is sent after the session response:
   - `sendAvailableCommandsDeferred` should fire after the `session/new`/`resume`/`load` response
   - The 50ms delay ensures the client's session state machine is ready

2. Confirm `SLASH_COMMANDS` (`utils.ts`) contains the expected commands

3. If it is lost intermittently, the client's state machine may not be ready
   when the response arrives; check whether the delay is long enough

### Memory leak / zombie processes

**Symptom:** Many zcode processes remain; memory keeps growing.

**Troubleshooting steps:**

1. Check whether `ZcodeBackend.close()` is called:
   - SIGTERM / SIGINT / SIGHUP signals
   - stdin close
   - backend reader death

2. Manually inspect zombie processes:

   ```bash
   ps aux | grep zcode
   killall -9 zcode  # cleanup
   ```

3. Confirm the `detached: true` and `process.kill(-pid)` logic:
   - `client.ts:spawn` sets `detached: true`
   - `close()` uses `process.kill(-pid, "SIGTERM")`
   - Falls back to `SIGKILL` after 3s

### Configuration option does not take effect

**Symptom:** After switching model/mode/thought, the UI does not update.

**Troubleshooting steps:**

1. Check whether the switch went through the right path. There are four entry
   points, and each must notify the editor:
   - `session/setMode` request → `extensions.ts:setMode`
   - `session/set_config_option` (configId `mode`/`model`/`thought`) →
     `session.ts:setConfigOptionHandler` → `emitConfigOptionUpdate`
   - `/mode` or `/thought` slash command → `slash.ts` (also calls
     `emitConfigOptionUpdate` since the fix; previously this path was silent)
   - In-turn `EnterPlanMode`/`ExitPlanMode` → reconciled by `emitModeIfChanged`
     at turn completion (`session.ts`)

2. Check whether `emitConfigOptionUpdate` sent the `config_option_update`
   notification:
   - mode also needs a `current_mode_update`
   - the mode value advertised to the client is recorded in `server.lastMode`
     so the turn-completion reconciliation does not re-emit it

3. Check whether `buildConfigOptions` reads the current value from `session/read`:
   - Not `projection.mode` (that is a stale value)
   - But `settings.mode.current`

### "A prompt is already running" after stop

**Symptom:** Pressing stop and then sending a new message fails with
`zcode send failed: A prompt is already running for this session`.

**Troubleshooting steps:**

1. Confirm the bridge version includes `ensureTurnStopped` (`session.ts`). It
   sends `session/stop` and then probes `session/goal show` until the lock is
   released, covering the startup-delay race where stop arrives before the
   turn holds the lock.

2. If the lock is still stuck on an older bridge, the zcode subprocess must be
   killed manually:

   ```bash
   ps aux | grep zcode
   killall -9 zcode  # caution: kills all zcode processes
   ```

3. If the lock leaks again, check whether the watchdog (`backend/client.ts`)
   is present — it reaps the zcode process group when the bridge is SIGKILLed,
   so a reconnect starts from a clean state.

### Tasks-index sync failure

**Symptom:** Sessions created via ACP are not visible in the ZCode App UI.

**Troubleshooting steps:**

1. Check whether `node:sqlite` is available:
   - Requires Node.js >= 22
   - Check whether `loadSqlite()` returns null

2. Check whether `~/.zcode/v2/tasks-index.sqlite` exists:
   - May not exist if the App has never been installed
   - tasks-index sync is best-effort; failure does not block session creation

3. Check whether the tasks-index table schema matches:
   - Table name: `tasks`
   - Fields: workspace_key, task_id, title, task_status, ...

### Remote access: hub unreachable / 401

**Symptom:** A remote client cannot list instances or connect; `curl
http://127.0.0.1:<hub-port>/api/health` fails, or `/api/*` returns 401.

**Troubleshooting steps:**

1. 401 means a token mismatch — `ZCODE_ACP_REMOTE_TOKEN` must be identical in
   the bridge env, the hub env (if run manually), and the client request.
2. Bridges on ≥0.17.0 self-heal after 401s (e.g. the token was rotated while
   some windows kept the old env): the bridge keeps heartbeating and spawns a
   replacement hub carrying its own token (≤1/min). Convergence needs the
   mismatched hub to exit — instantly when nothing else holds the port, or via
   its 10-minute zero-instance idle-exit. On older bridges a 401 permanently
   stopped registration: restart the affected editor windows.
3. A dead hub self-heals: the next bridge heartbeat (≤10s; worst ~1min under
   the spawn throttle) re-spawns the hub daemon. Retry with backoff rather
   than restarting anything by hand.
4. Confirm the ports match: the client must reach `ZCODE_ACP_HUB_PORT`
   (default 8377) through the tunnel, and the tunnel maps exactly that one
   port.
5. Remote silently disabled? `ZCODE_ACP_REMOTE=1` without a token logs a
   warning and leaves the bridge stdio-only by design.

### Remote access: stale instance in the list / connect fails

**Symptom:** `/api/instances` lists a workspace whose editor is already gone,
or a WS connect to it fails.

**Troubleshooting steps:**

1. Hard-killed bridges (Zed force-kill, crash) never unregister — the hub's
   heartbeat TTL drops them within ~30s.
2. For an honest list without waiting out the TTL, call
   `GET /api/instances?probe=1`: the hub TCP-probes each registered port and
   prunes bridges that stay unreachable ~8s (one failed probe only marks the
   instance unhealthy — a busy bridge can stall past the probe timeout while
   alive). Clients should use this on refresh.
3. A few-seconds outage after upgrading the package is expected: a newer
   bridge triggers the hub's version-handshake restart, then re-spawns it.

### Remote access: a conversation opens empty

**Symptom:** one session (typically an older one) opens EMPTY on a remote
client while other sessions show content.

**Cause:** the backend subprocess only serves `session/messages` for sessions
it has loaded via `session/create`/`session/resume`. Older bridges trusted the
in-memory id mapping as "live" and skipped the resume RPC — a mapping
re-registered from the durable store without a resume (or left behind by a
failed one) therefore replayed nothing. Fixed by explicit backend-loaded
tracking; the backend also logs a warning now when `session/messages` errors.

### Remote access: a conversation replays only PARTLY on first entry

**Symptom:** entering a resumed conversation the FIRST time shows history
that ends in the middle; leaving and re-entering shows the full conversation.
Happens often (but not always) with large sessions.

**Cause:** the hub answers the resume request as soon as the incubated
terminal bridge registers — before the terminal's boot-resume finishes — so
the App's `session/load` raced the boot-resume for the SAME backend session.
Both sent `session/resume` concurrently, and `session/messages` reflects only
what the backend has hydrated so far: a query landing mid-restore returns a
PREFIX, which was replayed as if it were the whole conversation. Fixed by
single-flighting `session/resume` TOGETHER WITH its hydration settle per
backend session id (a concurrent load joins the in-flight flight and shares
its settled history snapshot; the settle requires two consecutive
non-growing reads, capped). The bridge log line
`session/load: replayed N messages (total M)` now prints the total
unconditionally — a first-entry total below the session's real size was the
signature of this bug.

### Start Plan (zcode-plan) providers fail headless — 1113 / signing errors

**Symptom:** every turn fails with HTTP 429 error `1113` ("Insufficient
balance or no resource package") or `ClientRequestSigningV4Error: Client
signing credential must contain one separator`, while the same account works
in the ZCode desktop app.

**Cause:** Start Plan providers (`builtin:zai-start-plan`,
`builtin:bigmodel-start-plan`, baseURL `zcode.z.ai/api/v1/zcode-plan/...`)
authenticate with the provider's OAuth JWT **plus an Aliyun captcha session**:
before each model request the backend asks its host via
`interaction/requestProviderRuntimeHeaders` to solve an Aliyun captcha and
inject `X-Aliyun-Captcha-Verify-Param`/`-Region` headers. The desktop app
solves this in its renderer (browser environment, mostly invisible); a
headless bridge has neither a browser nor the captcha credential. GLM Coding
Plan providers are unaffected — they use an `id.secret` API key and sign
requests themselves.

**Workaround:** switch the session's provider to a GLM Coding Plan one
(model dropdown, or re-enable it in the desktop app so
`~/.zcode/v2/config.json` marks it `enabled`). The bridge answers the captcha
request with `headersApplied:false` and the backend surfaces a clear error;
full Start Plan support headless would require solving the Aliyun captcha
outside a browser, which this bridge does not do. That boundary is
deliberate: unofficial clients or proxies that impersonate the desktop app or
bypass the captcha check won't be shipped or supported here — if the provider
ever offers an official headless credential path, this bridge will adopt it
(see #123).

### Interactive TUI / `script` / `expect` fails with `Operation not permitted` under the sandbox

**Symptom:** inside an armed Seatbelt sandbox, pseudo-terminal allocation
fails (`script: openpty: Operation not permitted`, or a TUI binary dying at
terminal init with `os error 1`); the same binaries run fine headless.

**Cause:** `openpty` opens `/dev/ptmx` and the granted `/dev/ttysNNN` pair
`O_RDWR`, and the write half used to collide with the profile's blanket
`file-write*` deny. Since the fix, the profile allows exactly those two write
targets — the slave allow is gated on the sandbox pty extension, mirroring
Apple's own `application.sb`/`com.apple.neagent.sb` profiles, so only slaves
cloned through the sandbox's own `ptmx` opens are writable. Upgrade the bridge
if you still see this.

**Diagnosis tip:** a syscall-level sandbox denial has **no ask popup** (the
dynamic-allow flow only triggers on write-path denials) and surfaces in the
child as a bare `EPERM`, which tools may misreport as their own bug. When the
backend runs sandboxed, the bridge logs a one-shot warning the first time a
tool output contains `Operation not permitted` — that warning is your signal
to suspect the sandbox. Path grants for legitimate writes go in
`.zcode/acp/sandbox.json`.

### UNRESOLVED: CLI (martty) freezes at an old state while the mobile app keeps updating

**Symptom (observed once, 2026-09, no live instance preserved):** a CLI window
attached to a conversation stops receiving everything — messages, model
dropdown, thought-level updates — while the mobile app on the same
conversation keeps receiving and interacting normally. The CLI stays frozen at
a state noticeably older than the conversation.

**Working hypotheses (in rough likelihood order), none confirmed:**

1. **Session-alias divergence** — the interaction moved to an ACP session id
   the martty connection never adopted (e.g. a phone-side `session/new` racing
   the window's binding). martty drops every update addressed to a session id
   it does not know (same failure shape as the 2026-09-06 boot-create
   diagnosis in AGENTS.md). Everything stalling at once — config updates
   included — fits a sessionId mismatch, since all of them are session-scoped.
2. **Two different bridge processes** — the phone attached to the hub's serve
   bridge while the CLI runs its own bridge: live events do not cross
   processes by design (only session listings do). The CLI then only ever
   updates for its own turns.
3. **martty stdio wedge** — the TUI's own input thread stalls; the bridge's
   notifies buffer into the pipe and the mobile (WS path) is unaffected.
   Bridge-side nothing is wrong; typing in the frozen CLI would also be dead.

**If it recurs, capture before closing anything:** whether typing still works
in the frozen CLI (separates hypothesis 3 from 1/2); the bridge's stderr with
`ZCODE_ACP_DEBUG=1` (do `session/update` notifies still leave?); the hub's
instance listing (`GET /api/instances`) — which bridge id the phone's
conversation is on vs the CLI's; and both ends' session ids (CLI transcript vs
phone). See also the resume-race diagnosis in the same period: a partial
first-entry replay is a different bug (history prefix), do not conflate.

## Log Debugging

### Enable verbose logging

Add a timestamp and richer context in `src/utils.ts`:

```typescript
export function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[zcode-acp] [${ts}] ${msg}\n`);
}
```

### Common log patterns

| Log                                           | Meaning                                          |
| --------------------------------------------- | ------------------------------------------------ |
| `backend: started zcode app-server (pid=...)` | Backend started successfully                     |
| `backend: reader exited (...)`                | Backend reader exited (backend may have crashed) |
| `session/new -> sess_xxx`                     | New session created successfully                 |
| `[event] turn.started`                        | Turn started                                     |
| `[event] turn.completed (resultType=...)`     | Turn completed                                   |
| `-> interaction/... (zcode_id=...)`           | Interaction request received                     |
| `<- replied to zcode (N request(s))`          | Interaction request replied                      |
| `⚠ ...`                                       | Warning / error                                  |
