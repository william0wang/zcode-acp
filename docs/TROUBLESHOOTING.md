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

3. If you need to override the key/base URL without touching `config.json`, set `ZCODE_BASE_URL` and provide the key via the provider config (see `src/backend/credentials.ts` for the merge order).

### session/subscribe fails

**Symptom:**

```
session/subscribe failed (ZCode CLI 0.14.8+ required)
```

**Troubleshooting steps:**

1. Confirm ZCode CLI >= 0.14.8:

   ```bash
   zcode --version
   ```

2. If the version is correct but it still fails, check whether the zcode
   app-server supports subscribe:

   ```bash
   cd /path/to/project
   zcode app-server --stdio
   # send manually:
   { "id": 1, "method": "session/subscribe", "params": { "sessionId": "test", "deliveryKind": "desktop-continuous", "includeSnapshot": true, "afterSeq": 0 } }
   ```

3. Check whether other zcode processes are running:
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

3. Check whether `askOnce` (fallback path) or `handleAskUserViaElicitation`
   (elicitation path) successfully sent the request:
   - `⚠ elicitation/create failed: ...` → the client does not support it or the request failed
   - `⚠ request_permission failed: ...` → the fallback path failed

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
