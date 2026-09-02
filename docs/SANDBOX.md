# Sandbox

Optional macOS Seatbelt confinement for the file writes the agent performs.
This page is the full manual; the README keeps only a summary.

Two switches arm the sandbox (macOS only), whichever comes first:

- globally: `ZCODE_ACP_SANDBOX=1`, or
- per project: `"enabled": true` in `<workspace>/.zcode/acp/sandbox.json`.
  The bridge auto-creates that file with `"enabled": false` the first time
  you open the workspace — flip the flag to opt this project in, no global
  env needed. Flipping it mid-run takes effect on the next prompt (the
  backend restarts sandboxed); flipping back takes effect the next time the
  backend restarts on its own.

Once armed, the zcode backend subprocess — and every Bash/Edit/Write it
performs, including all child processes — runs wrapped in a
Seatbelt (`sandbox-exec`) profile that denies file writes everywhere except:

- the workspace root(s) of your live sessions,
- `~/.zcode*` (the backend's own sessions/db/logs),
- the system temp directory and regenerable tool caches (`~/Library/Caches`,
  `~/.cache`, `~/.npm`, `~/Library/pnpm`, `~/.node-gyp`),
- paths granted via the per-project config or the allow popup.

Reads and process execution stay open: deletion (`rm`, `mv`, truncation) is a
write-class syscall, so the write denial stops it regardless of which binary
performs it — including `/bin/rm`, `python shutil.rmtree`, or shell
redirections.

When a write outside the whitelist is attempted, the tool fails with
`Operation not permitted` and the bridge asks via the editor's permission
popup with four choices: allow **once**, allow **always**, reject **once**,
reject **always**. The "always" choices are persisted by the bridge into
`<workspace>/.zcode/acp/sandbox.json` (created on first run — allows to the
`allow` list, rejections to a `deny` list that suppresses future asks; edit
the file to undo either). "Once" choices and dismissed popups persist
nothing and will ask again. The agent itself cannot edit
that file — the sandbox denies
writes to `.zcode/acp/` inside the workspace while the bridge (outside the
sandbox) writes it on your behalf. After an allow, the backend restarts with
the widened profile (a few seconds; the bridge auto-continues the interrupted
task). Set `"strictGit": true` in the config to also put `.git` behind the
popup.

Ordinary filesystem permission failures (`Permission denied`, EACCES — a
chmod/ownership problem no popup can fix) are not sandbox denials; the bridge
surfaces them as a one-time hint instead of raising an ask.

This targets accident prevention, not malice: indirect escapes (an
agent-edited `.bashrc`, build scripts, or git hooks that you later run
yourself outside the sandbox) are out of scope — treat its output like any
other code review. Verify a profile manually with
`bash scripts/verify-sandbox.sh` (macOS, after `pnpm build`).
