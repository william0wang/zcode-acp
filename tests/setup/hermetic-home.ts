/**
 * Default hermetic HOME for every test file: a fresh temp dir per file.
 *
 * The lazy-alias store (~/.zcode/v2/acp-lazy-sessions.json) is shared with
 * LIVE bridge processes on the dev machine — a test run writing the real
 * store once raced a live bridge and wiped a user's placeholder records
 * (observed 2026-09: an idle editor thread then failed with the backend's
 * "Session ID 不存在" because its alias was gone). Pointing HOME at a temp
 * dir by default keeps every fixture, credential lookup, and store write
 * inside the sandbox; a test that needs a different HOME can still
 * vi.stubEnv("HOME", …) — the later stub wins for that test.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";

vi.stubEnv("HOME", mkdtempSync(path.join(tmpdir(), "zacp-test-home-")));
