/**
 * writeTuiScript tests — where the terminal-TUI .command script lands.
 *
 * The script must go into `<workspace>/.zcode/tmp/` (terminal apps bind the
 * tab's project root to the script's parent dir), sweep stale tui-*.command
 * leftovers (>1h), and silently fall back to the mkdtemp(tmpdir()) path when
 * the workspace is not writable. node:fs is mocked with a Map/Set fake
 * filesystem (same pattern as plugin-commands.test.ts).
 */

import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mkdtempSyncMock, unlinkSyncMock, writeFileSyncMock } = vi.hoisted(() => ({
  mkdtempSyncMock: vi.fn(),
  unlinkSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
}));

// Fake filesystem: known files map to mtimeMs; dirs are a Set.
const mockFiles = new Map<string, number>();
const mockDirs = new Set<string>();
const mkdirFailures = new Set<string>();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    mkdirSync: (p: string, _opts?: { recursive?: boolean }) => {
      if (mkdirFailures.has(p)) throw new Error("EACCES: read-only file system");
      mockDirs.add(p);
      return p;
    },
    readdirSync: (p: string) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      return [...mockFiles.keys()]
        .map((f) => (f.startsWith(prefix) ? f.slice(prefix.length) : null))
        .filter((e): e is string => e !== null && !e.includes("/"));
    },
    statSync: (p: string) =>
      ({ mtimeMs: mockFiles.get(p) ?? 0 }) as ReturnType<typeof actual.statSync>,
    unlinkSync: (p: string) => {
      mockFiles.delete(p);
      unlinkSyncMock(p);
    },
    writeFileSync: (p: string, contents: string, opts?: { mode?: number }) => {
      mockFiles.set(p, Date.now());
      writeFileSyncMock(p, contents, opts);
    },
    chmodSync: () => {},
    mkdtempSync: (p: string) => {
      mkdtempSyncMock(p);
      const dir = p + "abc123/";
      mockDirs.add(dir);
      return dir;
    },
  };
});

// Import after mocks.
import { writeTuiScript } from "../src/remote/hub-server.js";

const WORKSPACE = "/tmp/proj";

beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  mkdirFailures.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeTuiScript", () => {
  it("places the script under <workspace>/.zcode/tmp/", () => {
    const script = writeTuiScript(WORKSPACE, "/dist/cli.js", {});
    expect(script.startsWith(path.join(WORKSPACE, ".zcode", "tmp", "tui-"))).toBe(true);
    expect(script.endsWith(".command")).toBe(true);
    expect(mkdtempSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).toHaveBeenCalledWith(script, expect.any(String), { mode: 0o700 });
  });

  it("falls back to mkdtemp(tmpdir()) when the workspace dir is not writable", () => {
    mkdirFailures.add(path.join(WORKSPACE, ".zcode", "tmp"));
    const script = writeTuiScript(WORKSPACE, "/dist/cli.js", {});
    expect(script).toBe(path.join(tmpdir(), "zcode-acp-term-abc123", "tui.command"));
    expect(writeFileSyncMock).toHaveBeenCalledWith(script, expect.any(String), { mode: 0o700 });
  });

  it("sweeps tui-*.command scripts older than 1h but keeps fresh and unrelated ones", () => {
    const dir = path.join(WORKSPACE, ".zcode", "tmp");
    const hour = 60 * 60 * 1000;
    mockFiles.set(path.join(dir, "tui-old.command"), Date.now() - 2 * hour);
    mockFiles.set(path.join(dir, "tui-fresh.command"), Date.now() - 5 * 1000);
    mockFiles.set(path.join(dir, "other.command"), Date.now() - 2 * hour);
    mockFiles.set(path.join(dir, "tui-notes.txt"), Date.now() - 2 * hour);

    writeTuiScript(WORKSPACE, "/dist/cli.js", {});

    expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
    expect(unlinkSyncMock).toHaveBeenCalledWith(path.join(dir, "tui-old.command"));
    expect(mockFiles.has(path.join(dir, "tui-fresh.command"))).toBe(true);
    expect(mockFiles.has(path.join(dir, "other.command"))).toBe(true);
    expect(mockFiles.has(path.join(dir, "tui-notes.txt"))).toBe(true);
  });
});
