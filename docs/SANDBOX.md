# Sandbox

Optional macOS Seatbelt confinement for the file writes the agent performs.
This page is the full manual; the README keeps only a summary.

The sandbox is armed by the GLOBAL switch (macOS only):

- `ZCODE_ACP_SANDBOX=1`, or
- `"sandbox": { "enabled": true }` in `~/.config/zcode-acp/config.json`
  (`$XDG_CONFIG_HOME` aware).

Flipping the switch on mid-run takes effect on the next prompt (the backend
restarts sandboxed); flipping it back takes effect the next time the backend
restarts on its own. A workspace's `.zcode/acp/sandbox.json` is only ever
created by an allow/reject popup decision for a path inside that workspace
(see below) — nothing is written to a project just by opening it.

Once armed, the zcode backend subprocess — and every Bash/Edit/Write it
performs, including all child processes — runs wrapped in a
Seatbelt (`sandbox-exec`) profile that denies file writes everywhere except:

- the workspace root(s) of your live sessions,
- `~/.zcode*` (the backend's own sessions/db/logs),
- the well-known system temp trees — `/tmp` (→ `/private/tmp`), `/var/tmp`,
  and the per-user `/var/folders` tree that `$TMPDIR` lives in — plus
  regenerable tool caches (`~/Library/Caches`, `~/.cache`, `~/.npm`,
  `~/Library/pnpm`, `~/.node-gyp`),
- the `allow` lists of both config layers (see below),
- bridge-lifetime "allow once" grants from the allow popup.

Path grants live in two config layers, unioned into the profile on every
backend (re)start:

1. **Machine-global** — `~/.config/zcode-acp/sandbox.json` (`$XDG_CONFIG_HOME`
   aware), schema:

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

2. **Per-project** — `<workspace>/.zcode/acp/sandbox.json`, same schema.
   Its `allow` joins the allow section, its `deny` joins the deny tail (a
   project deny wins over every allow), and `strictGit` is OR-ed with the
   global flag; a legacy `enabled` key is ignored — the global switch is the
   only arm. The file is read on every backend (re)start, so a team can
   commit it to share an allowlist, or gitignore it for a personal one. An
   absent or malformed file simply adds no project grants. The agent cannot
   edit this file either: `<workspace>/.zcode/acp/` is a deny island in the
   profile, and the bridge persists in-workspace popup decisions there from
   outside the sandbox.

**History**: grants lived only in per-project files until 2026-11-17, which
moved them into the global file through a one-shot merge that ran only where
no global file existed yet — machines that already had one silently lost
their per-project grants. Since 2026-11-27 the per-project file is live
config again, so a legacy file works as it is; nothing needs copying.

When a write outside the whitelist is attempted, the tool fails with
`Operation not permitted` and the bridge asks via the editor's permission
popup with four choices: allow **once**, allow **always**, reject **once**,
reject **always**. "Once" choices and dismissed popups persist nothing and
will ask again. The "always" choices are persisted by the bridge into the
layer that matches the path: a denial inside a live workspace asks once for
the workspace **root** (one ask per repo, not one per directory) and lands
in that project's file — "always reject" records the originally denied path
there, never the whole workspace. Any other denial keeps the parent directory
as its target and the global file as its store.
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
