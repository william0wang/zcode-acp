# Sandbox

Optional macOS Seatbelt confinement for the file writes the agent performs.
This page is the full manual; the README keeps only a summary.

The sandbox is armed by the GLOBAL switch (macOS only):

- `ZCODE_ACP_SANDBOX=1`, or
- `"sandbox": { "enabled": true }` in `~/.config/zcode-acp/config.json`
  (`$XDG_CONFIG_HOME` aware).

Flipping the switch on mid-run takes effect on the next prompt (the backend
restarts sandboxed); flipping it back takes effect the next time the backend
restarts on its own. Workspaces are never written to — no `.zcode/` config is
created or read from projects anymore.

Once armed, the zcode backend subprocess — and every Bash/Edit/Write it
performs, including all child processes — runs wrapped in a
Seatbelt (`sandbox-exec`) profile that denies file writes everywhere except:

- the workspace root(s) of your live sessions,
- `~/.zcode*` (the backend's own sessions/db/logs),
- the well-known system temp trees — `/tmp` (→ `/private/tmp`), `/var/tmp`,
  and the per-user `/var/folders` tree that `$TMPDIR` lives in — plus
  regenerable tool caches (`~/Library/Caches`, `~/.cache`, `~/.npm`,
  `~/Library/pnpm`, `~/.node-gyp`),
- the machine-global sandbox config's `allow` list (see below),
- bridge-lifetime "allow once" grants from the allow popup.

All path grants live in ONE machine-global file next to the user config:

- `~/.config/zcode-acp/sandbox.json` (`$XDG_CONFIG_HOME` aware), schema:

  ```json
  {
    "allow": ["~/go", "~/.gradle", "~/.m2"],
    "deny": [],
    "strictGit": false
  }
  ```

  - `allow` — absolute or `~/`-prefixed realpaths granted permanent write,
    effective for every project (relative entries are dropped with a
    warning). The file is auto-created on the first backend spawn with a
    pre-granted toolchain template (`~/go`, `~/.gradle`, `~/.m2`, `~/.cargo`,
    `~/.rustup`, `~/.cocoapods`, `~/.pub-cache`, `~/.nuget`, `~/.pnpm-store`,
    `~/.bun`, `~/.android`, `~/Library/Android/sdk`) — trim or extend the
    list to taste (e.g. add `/opt/homebrew` if the agent should install
    packages). Deleting the file means "no grants" (it is not resurrected).
  - `deny` — paths never to ask about again ("always reject" decisions land
    here; edit the array to undo).
  - `strictGit` — `true` puts every workspace's `.git` behind the allow
    popup instead of default-writable.

  The agent cannot edit this file: the sandbox denies writes to
  `~/.config/zcode-acp/` (the bridge, outside the sandbox, persists popup
  decisions there on your behalf). Changing the file takes effect the next
  time the backend (re)starts — flip it live with the session's
  `/restart`, or just approve a pending popup.

**Migration**: the old per-project `<workspace>/.zcode/acp/sandbox.json` is
no longer read. On the first spawn after upgrading, a legacy file's
`allow`/`deny`/`strictGit` entries are merged into the global file once, and
a legacy `enabled: true` carries onto the global switch (an explicit
`sandbox.enabled: false` in the user config wins) — an upgrade never
silently disarms a machine that had the sandbox on. The legacy file itself
is left in place, dead; delete it at your leisure. Projects that were not
open during the upgrade migrate when first opened on a machine where the
global file does not exist yet; otherwise copy entries by hand.

When a write outside the whitelist is attempted, the tool fails with
`Operation not permitted` and the bridge asks via the editor's permission
popup with four choices: allow **once**, allow **always**, reject **once**,
reject **always**. The "always" choices are persisted by the bridge into the
global config (allows to the `allow` list, rejections to the `deny` list).
"Once" choices and dismissed popups persist nothing and will ask again.
After an allow, the backend restarts with the widened profile (a few
seconds; the bridge auto-continues the interrupted task). Approvals are
batched for a short window, so several pending popups granted in a row share
ONE restart instead of each killing the others.

Ordinary filesystem permission failures (`Permission denied`, EACCES — a
chmod/ownership problem no popup can fix) are not sandbox denials; the bridge
surfaces them as a one-time hint instead of raising an ask.

This targets accident prevention, not malice: indirect escapes (an
agent-edited `.bashrc`, build scripts, or git hooks that you later run
yourself outside the sandbox) are out of scope — treat its output like any
other code review. Verify a profile manually with
`bash scripts/verify-sandbox.sh` (macOS, after `pnpm build`, from a normal
terminal — not from inside a sandboxed agent session).
