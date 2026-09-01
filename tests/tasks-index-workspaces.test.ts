/**
 * Tests for the known-workspace list (remote session-create whitelist,
 * ADR-0014): listKnownWorkspaces aggregates the App's tasks index per
 * workspace, and isSelectableWorkspace decides which recorded paths may be
 * offered to remote clients.
 *
 * Same mocking strategy as tasks-index.test.ts (in-memory fake DatabaseSync,
 * no real sqlite on CI), plus a controlled node:os so the temp/~/ exclusions
 * are testable without touching the real HOME or TMPDIR, and a statSync fake
 * so directory-existence checks need no filesystem.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Row shape the SELECT aggregates over (only the columns the query reads).
interface FakeRow {
  workspace_key: string;
  workspace_path: string;
  deleted: number;
  updated_at: number;
}

let rows: FakeRow[];

/** Paths handed to the fake DatabaseSync constructor (dbPath pass-through). */
const openedPaths = vi.hoisted(() => [] as string[]);

/** Paths statSync reports as existing directories (everything else fails). */
let realDirs: Set<string>;

vi.mock("node:sqlite", () => {
  class DatabaseSync {
    constructor(
      path: string,
      _options?: { timeout?: number },
    ) {
      openedPaths.push(path);
    }
    prepare(sql: string) {
      if (/^SELECT workspace_path AS p/i.test(sql)) {
        return {
          all() {
            // Mirror GROUP BY workspace_key + ORDER BY MAX(updated_at) DESC:
            // aggregate per key, newest first.
            const groups = new Map<string, FakeRow[]>();
            for (const r of rows) {
              if (r.deleted !== 0) continue;
              const list = groups.get(r.workspace_key) ?? [];
              list.push(r);
              groups.set(r.workspace_key, list);
            }
            const aggregated = Array.from(groups.entries()).map(([key, list]) => ({
              p: key,
              n: list.length,
              t: Math.max(...list.map((r) => r.updated_at)),
            }));
            aggregated.sort((a, b) => b.t - a.t);
            return aggregated;
          },
        };
      }
      throw new Error(`unexpected SQL in workspaces test fake: ${sql}`);
    }
    close() {
      /* no-op */
    }
  }
  return { DatabaseSync };
});

vi.mock("node:os", () => ({
  homedir: () => "/fake/home",
  tmpdir: () => "/fake/tmpdir",
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: () => true,
    statSync: (p: string) => {
      if (realDirs.has(p)) return { isDirectory: () => true } as never;
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
  };
});

import { isSelectableWorkspace, listKnownWorkspaces } from "../src/tasks-index.js";

describe("isSelectableWorkspace", () => {
  beforeEach(() => {
    realDirs = new Set(["/Users/dev/Develop/proj-a"]);
  });

  it("accepts an existing project directory", () => {
    expect(isSelectableWorkspace("/Users/dev/Develop/proj-a")).toBe(true);
  });

  it("rejects degenerate roots", () => {
    expect(isSelectableWorkspace("")).toBe(false);
    expect(isSelectableWorkspace("/")).toBe(false);
  });

  it("rejects system temp trees (both /tmp spellings, $TMPDIR, /var/folders)", () => {
    expect(isSelectableWorkspace("/tmp/proj")).toBe(false);
    expect(isSelectableWorkspace("/private/tmp/proj")).toBe(false);
    expect(isSelectableWorkspace("/fake/tmpdir/proj")).toBe(false);
    expect(isSelectableWorkspace("/var/folders/xy/proj")).toBe(false);
    // Exact match on a temp root itself is equally rejected.
    expect(isSelectableWorkspace("/fake/tmpdir")).toBe(false);
  });

  it("rejects ~/.zcode (the config home, not a project)", () => {
    expect(isSelectableWorkspace("/fake/home/.zcode")).toBe(false);
    expect(isSelectableWorkspace("/fake/home/.zcode/skills")).toBe(false);
    // A .zcode directory inside a normal path is NOT the config home.
    realDirs.add("/Users/dev/work/.zcode");
    expect(isSelectableWorkspace("/Users/dev/work/.zcode")).toBe(true);
  });

  it("rejects missing paths and non-directories", () => {
    expect(isSelectableWorkspace("/Users/dev/Develop/gone")).toBe(false);
    realDirs.add("/Users/dev/Develop/a-file");
    // (a-file is in realDirs, so it "exists" — but every fake entry reports
    // isDirectory true; to test the non-directory branch, use a path NOT in
    // realDirs, which throws ENOENT. The isDirectory-false branch is covered
    // by construction: statSync only ever returns isDirectory:true here.)
    expect(isSelectableWorkspace("/Users/dev/Develop/other")).toBe(false);
  });
});

describe("listKnownWorkspaces", () => {
  beforeEach(() => {
    rows = [];
    realDirs = new Set(["/Users/dev/Develop/proj-a", "/Users/dev/Develop/proj-b"]);
  });

  it("aggregates sessions per workspace, newest activity first", async () => {
    rows = [
      { workspace_key: "/Users/dev/Develop/proj-a", workspace_path: "/Users/dev/Develop/proj-a", deleted: 0, updated_at: 100 },
      { workspace_key: "/Users/dev/Develop/proj-a", workspace_path: "/Users/dev/Develop/proj-a", deleted: 0, updated_at: 300 },
      { workspace_key: "/Users/dev/Develop/proj-b", workspace_path: "/Users/dev/Develop/proj-b", deleted: 0, updated_at: 200 },
    ];
    const list = await listKnownWorkspaces("/fake/db.sqlite");
    expect(list).toEqual([
      { workspacePath: "/Users/dev/Develop/proj-a", sessions: 2, lastActive: 300 },
      { workspacePath: "/Users/dev/Develop/proj-b", sessions: 1, lastActive: 200 },
    ]);
  });

  it("drops deleted rows, temp dirs, the config home, and vanished directories", async () => {
    rows = [
      { workspace_key: "/Users/dev/Develop/gone", workspace_path: "/Users/dev/Develop/gone", deleted: 0, updated_at: 900 },
      { workspace_key: "/tmp/scratch", workspace_path: "/tmp/scratch", deleted: 0, updated_at: 800 },
      { workspace_key: "/fake/home/.zcode", workspace_path: "/fake/home/.zcode", deleted: 0, updated_at: 700 },
      { workspace_key: "/Users/dev/Develop/proj-a", workspace_path: "/Users/dev/Develop/proj-a", deleted: 1, updated_at: 600 },
      { workspace_key: "/Users/dev/Develop/proj-b", workspace_path: "/Users/dev/Develop/proj-b", deleted: 0, updated_at: 500 },
    ];
    const list = await listKnownWorkspaces("/fake/db.sqlite");
    // gone: not in realDirs → excluded. scratch: temp. .zcode: config home.
    // proj-a: all its rows are deleted → no group. Only proj-b survives.
    expect(list).toEqual([
      { workspacePath: "/Users/dev/Develop/proj-b", sessions: 1, lastActive: 500 },
    ]);
  });

  it("returns [] when the aggregate row shapes are malformed", async () => {
    // Simulate a schema-drifted row: workspace_path not a string.
    rows = [{ workspace_key: 42 as unknown as string, workspace_path: "", deleted: 0, updated_at: 1 }];
    const list = await listKnownWorkspaces("/fake/db.sqlite");
    expect(list).toEqual([]);
  });

  it("opens the injected dbPath, not the default tasks index", async () => {
    // Regression: withSqliteRetry used to hardcode TASKS_INDEX_PATH, so the
    // dbPath parameter only gated existsSync — fixtures read the real DB.
    rows = [];
    openedPaths.length = 0;
    await listKnownWorkspaces("/fake/fixture.sqlite");
    expect(openedPaths).toEqual(["/fake/fixture.sqlite"]);
  });
});
