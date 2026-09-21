/**
 * Default hermetic HOME for every test file: a fresh temp dir per file.
 *
 * The lazy-alias store (~/.zcode/v2/acp-lazy-sessions.json) is shared with
 * LIVE bridge processes on the dev machine — a test run writing the real
 * store once raced a live bridge and wiped a user's placeholder records
 * (observed 2026-09: an idle editor thread then failed with the backend's
 * "Session ID 不存在" because its alias was gone).
 *
 * HOME is set by DIRECT assignment, not vi.stubEnv: vi.unstubAllEnvs() only
 * restores values recorded through stubEnv, so a test file calling it
 * mid-run cannot drop the suite back onto the real HOME. A per-test
 * vi.stubEnv("HOME", …) still overrides this default for that test.
 *
 * ZCODE_HOME is DELETED for the same reason as HOME is redirected: it
 * overrides the ZCode data root outright, so a developer with it exported
 * would point the suite back at a real store.
 *
 * The serve-origin markers are DELETED the same way: a vitest run started
 * from inside an incubated TUI inherits them, and the session-close handler
 * reading them would treat the test worker as that TUI's bridge — signalling
 * the REAL window's process tree (observed live 2026-09-08: the run killed
 * its own host window). Tests that need them re-stub explicitly.
 *
 * XDG_CONFIG_HOME is DELETED for the same reason as HOME is redirected: the
 * user config loader (~/.config/zcode-acp/config.json) prefers it, so a
 * developer with it exported (Linux desktops, dotfile shells) would point the
 * suite's file-config reads at their real config — e.g. a real
 * `sandbox.enabled: true` would flip "sandbox stays off by default" tests.
 *
 * ZCODE_MODEL / ANTHROPIC_API_KEY are DELETED for the same reason: a vitest
 * run started from inside a bridge session (ZCODE_PROVIDER/ZCODE_MODEL pin,
 * key export) inherits them, and `mergeEnvWithCreds` deliberately lets the
 * explicit env override the config — assertions on the merged child env then
 * see the developer's pin instead of the fixture value (observed: the PR #215
 * regression tests failing only inside bridge-run sessions).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

const home = mkdtempSync(path.join(tmpdir(), "zacp-test-home-"));
process.env.HOME = home;
delete process.env.ZCODE_HOME;
delete process.env.XDG_CONFIG_HOME;
delete process.env.ZCODE_MODEL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ZCODE_ACP_REMOTE_ORIGIN;
delete process.env.ZCODE_ACP_TUI_CLI_PID;

afterAll(() => {
  // The dir is only used synchronously by store/config reads; by afterAll the
  // file's tests are done. Crashed workers leak a dir — the OS tmp cleaner
  // handles those.
  rmSync(home, { recursive: true, force: true });
});
