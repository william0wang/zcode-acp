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
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

const home = mkdtempSync(path.join(tmpdir(), "zacp-test-home-"));
process.env.HOME = home;

afterAll(() => {
  // The dir is only used synchronously by store/config reads; by afterAll the
  // file's tests are done. Crashed workers leak a dir — the OS tmp cleaner
  // handles those.
  rmSync(home, { recursive: true, force: true });
});
