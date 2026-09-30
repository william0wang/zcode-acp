/**
 * Regression tests for tasks-index session sync.
 *
 * History: tasks-index originally mirrored the Python sqlite3 API
 * (con.run(sql, ...params) / con.get(sql, ...params)), but Node's
 * node:sqlite DatabaseSync has NO run/get methods — only prepare(sql) returns a
 * StatementSync with .run(...)/.get(...). The wrong API threw TypeError, which
 * the try/catch swallowed to `false` and the quiet-by-default log() hid, so
 * session sync silently no-op'd for every ACP session. These tests lock the
 * correct prepared-statement call shape and the row-level semantics
 * (INSERT OR IGNORE, title_overridden respect, 80-char truncation).
 *
 * CI stability: node:sqlite is experimental on Node 22.x (may require
 * --experimental-sqlite, absent on stock ubuntu CI). Rather than depend on the
 * real module or real ~/.zcode/ files, we inject an in-memory DatabaseSync that
 * implements the exact subset of SQL the production code issues. This mirrors
 * the quota.test.ts pattern of mocking environment dependencies for CI.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Row shape stored by the in-memory fake. Mirrors the columns the production
// code writes; defaults match the real `tasks` table DDL.
interface FakeRow {
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  title: string;
  task_status: string;
  provider: string;
  mode: string;
  model: string;
  created_at: number;
  updated_at: number;
  unread_at: number | null;
  pinned: number;
  archived: number;
  deleted: number;
  title_overridden: number;
  meta_json: string;
  searchable_text: string;
}

/** A single shared in-memory `tasks` table, keyed by PK (workspace_key, task_id). */
let rows: Map<string, FakeRow>;

/**
 * How many times the next `new DatabaseSync(...)` calls should throw a busy
 * error before letting the write through. Set by tests; the fake decrements on
 * each instantiation. Mirrors SQLITE_BUSY contention with the App.
 */
let busyTimes: number;

/** Build the StatementSync-shaped object returned by DatabaseSync.prepare(). */
function makeStatement(sql: string) {
  // INSERT OR IGNORE INTO tasks (...) VALUES (..., 'build', ..., NULL, 0, 0, 0, 0, ?, ?)
  // The production SQL embeds literal 'build' for mode and NULL for unread_at
  // plus 0 for pinned/archived/deleted/title_overridden. We bind the remaining
  // placeholders positionally in the exact order tasks-index.ts emits them.
  if (/^INSERT OR IGNORE/i.test(sql) && !sql.includes("'completed'")) {
    return {
      // prettier-ignore
      run(...params: unknown[]) {
        // Bound positional order (see tasks-index upsertSessionTask):
        // 0 workspaceKey, 1 workspaceKey(path), 2 taskId, 3 title, 4 status,
        // 5 providerId, 6 model, 7 nowMs(created), 8 nowMs(updated),
        // 9 metaJson, 10 title(searchable_text)
        const [
          workspaceKey,
          _path,
          taskId,
          title,
          status,
          providerId,
          model,
          nowMs,
          _nowMs2,
          metaJson,
          searchable,
        ] = params as [string, string, string, string, string, string, string, number, number, string, string];
        const pk = `${workspaceKey}\u0000${taskId}`;
        if (rows.has(pk)) return { changes: 0 }; // OR IGNORE — PK exists, skip.
        rows.set(pk, {
          workspace_key: workspaceKey,
          workspace_path: workspaceKey,
          workspace_identity: null,
          task_id: taskId,
          title,
          task_status: status,
          provider: providerId,
          mode: "build", // literal in SQL
          model,
          created_at: nowMs,
          updated_at: nowMs,
          unread_at: null, // literal NULL in SQL
          pinned: 0,
          archived: 0,
          deleted: 0,
          title_overridden: 0, // literal 0 in SQL
          meta_json: metaJson,
          searchable_text: searchable,
        });
        return { changes: 1 };
      },
    };
  }
  // INSERT OR IGNORE for the softDeleteTask tombstone: status 'completed' and
  // deleted=1 are literals, so only 10 placeholders bind.
  if (/^INSERT OR IGNORE/i.test(sql)) {
    return {
      // prettier-ignore
      run(...params: unknown[]) {
        // 0 workspacePath, 1 workspacePath(key), 2 taskId, 3 title,
        // 4 providerId, 5 model, 6 nowMs(created), 7 nowMs(updated),
        // 8 metaJson, 9 title(searchable_text)
        const [
          workspacePath,
          _key,
          taskId,
          title,
          providerId,
          model,
          nowMs,
          _nowMs2,
          metaJson,
          searchable,
        ] = params as [string, string, string, string, string, string, number, number, string, string];
        const pk = `${workspacePath}\u0000${taskId}`;
        if (rows.has(pk)) return { changes: 0 }; // OR IGNORE — existing row wins.
        rows.set(pk, {
          workspace_key: workspacePath,
          workspace_path: workspacePath,
          workspace_identity: null,
          task_id: taskId,
          title,
          task_status: "completed", // literal in SQL
          provider: providerId,
          mode: "build", // literal in SQL
          model,
          created_at: nowMs,
          updated_at: nowMs,
          unread_at: null, // literal NULL in SQL
          pinned: 0,
          archived: 0,
          deleted: 1, // literal in SQL — the row is born tombstoned
          title_overridden: 0, // literal 0 in SQL
          meta_json: metaJson,
          searchable_text: searchable,
        });
        return { changes: 1 };
      },
    };
  }
  // SELECT 1 FROM tasks WHERE task_id=? (softDeleteTask existence probe)
  if (/^SELECT 1 FROM tasks/i.test(sql)) {
    return {
      get(taskId: string) {
        for (const r of rows.values()) {
          if (r.task_id === taskId) return { "1": 1 } as const;
        }
        return undefined;
      },
    };
  }
  // SELECT deleted, meta_json FROM tasks WHERE task_id=? (renameSessionTask)
  if (/^SELECT deleted, meta_json/i.test(sql)) {
    return {
      get(taskId: string) {
        for (const r of rows.values()) {
          if (r.task_id === taskId) {
            return { deleted: r.deleted, meta_json: r.meta_json } as const;
          }
        }
        return undefined;
      },
    };
  }
  // SELECT deleted, title_overridden, meta_json FROM tasks WHERE task_id=?
  // (updateSessionTitle)
  if (/^SELECT deleted, title_overridden/i.test(sql)) {
    return {
      get(taskId: string) {
        for (const r of rows.values()) {
          if (r.task_id === taskId) {
            return {
              deleted: r.deleted,
              title_overridden: r.title_overridden,
              meta_json: r.meta_json,
            } as const;
          }
        }
        return undefined;
      },
    };
  }
  // SELECT deleted FROM tasks WHERE task_id=? (isTaskDeleted)
  if (/^SELECT deleted FROM tasks/i.test(sql)) {
    return {
      get(taskId: string) {
        for (const r of rows.values()) {
          if (r.task_id === taskId) return { deleted: r.deleted } as const;
        }
        return undefined;
      },
    };
  }
  // SELECT task_id AS id FROM tasks WHERE deleted=1 OR archived=1
  // (hiddenTaskIds)
  if (/^SELECT task_id AS id/i.test(sql)) {
    return {
      all() {
        const out: Array<{ id: string }> = [];
        for (const r of rows.values()) {
          if (r.deleted === 1 || r.archived === 1) out.push({ id: r.task_id });
        }
        return out;
      },
    };
  }
  // UPDATE tasks SET deleted=1, updated_at=? WHERE task_id=? AND deleted=0
  if (/^UPDATE tasks SET deleted=1.*WHERE task_id/i.test(sql)) {
    return {
      run(updatedAt: number, taskId: string) {
        let changes = 0;
        for (const r of rows.values()) {
          if (r.task_id === taskId && r.deleted === 0) {
            r.deleted = 1;
            r.updated_at = updatedAt;
            changes++;
          }
        }
        return { changes };
      },
    };
  }
  // UPDATE tasks SET deleted=1, updated_at=? WHERE workspace_path=? AND deleted=0
  if (/^UPDATE tasks SET deleted=1.*WHERE workspace_path/i.test(sql)) {
    return {
      run(updatedAt: number, workspacePath: string) {
        let changes = 0;
        for (const r of rows.values()) {
          if (r.workspace_path === workspacePath && r.deleted === 0) {
            r.deleted = 1;
            r.updated_at = updatedAt;
            changes++;
          }
        }
        return { changes };
      },
    };
  }
  // UPDATE tasks SET title=?, title_overridden=1, updated_at=?, meta_json=?
  // WHERE task_id=? (renameSessionTask — pins the manual rename)
  if (/^UPDATE tasks SET title=\?, title_overridden=1/i.test(sql)) {
    return {
      run(title: string, updatedAt: number, metaJson: string, taskId: string) {
        let changes = 0;
        for (const r of rows.values()) {
          if (r.task_id === taskId) {
            r.title = title;
            r.title_overridden = 1;
            r.updated_at = updatedAt;
            r.meta_json = metaJson;
            changes++;
          }
        }
        return { changes };
      },
    };
  }
  // UPDATE tasks SET title=?, updated_at=?, searchable_text=?, meta_json=?
  // WHERE task_id=? AND title_overridden=0
  if (/^UPDATE tasks SET title/i.test(sql)) {
    return {
      run(title: string, updatedAt: number, searchable: string, metaJson: string, taskId: string) {
        let changes = 0;
        for (const r of rows.values()) {
          if (r.task_id === taskId && r.title_overridden === 0) {
            r.title = title;
            r.updated_at = updatedAt;
            r.searchable_text = searchable;
            r.meta_json = metaJson;
            changes++;
          }
        }
        return { changes };
      },
    };
  }
  // UPDATE tasks SET updated_at=?, searchable_text=? WHERE task_id=?
  // (title_overridden=1 branch: keep the user's title everywhere, still
  // refresh searchable_text)
  if (/^UPDATE tasks SET updated_at=\?, searchable_text/i.test(sql)) {
    return {
      run(updatedAt: number, searchable: string, taskId: string) {
        let changes = 0;
        for (const r of rows.values()) {
          if (r.task_id === taskId) {
            r.updated_at = updatedAt;
            r.searchable_text = searchable;
            changes++;
          }
        }
        return { changes };
      },
    };
  }
  throw new Error(`unexpected SQL in tasks-index test fake: ${sql}`);
}

vi.mock("node:sqlite", () => {
  class DatabaseSync {
    constructor(_path: string, _options?: { timeout?: number }) {
      // Simulate SQLITE_BUSY contention: the first `busyTimes` connections
      // throw before a connection opens. Decremented here so retries recover.
      if (busyTimes > 0) {
        busyTimes--;
        throw new TypeError("database is busy");
      }
    }
    prepare(sql: string) {
      return makeStatement(sql);
    }
    close() {
      /* no-op */
    }
  }
  return { DatabaseSync };
});

// Fake fs: pretend tasks-index.sqlite exists so the existsSync gate passes,
// and return a minimal provider config so resolveProviderModel() resolves.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: () => true,
    readFileSync: () =>
      JSON.stringify({
        provider: {
          "builtin:bigmodel-coding-plan": { enabled: true, models: { "GLM-5.2": {} } },
        },
      }),
  };
});

import {
  hiddenTaskIds,
  isTaskDeleted,
  renameSessionTask,
  softDeleteTask,
  softDeleteWorkspaceTasks,
  updateSessionTitle,
  upsertSessionTask,
} from "../src/tasks-index.js";

describe("tasks-index session sync", () => {
  beforeEach(() => {
    rows = new Map();
    busyTimes = 0;
  });

  describe("upsertSessionTask", () => {
    it("inserts a row with correct meta and default flags", async () => {
      const ok = await upsertSessionTask({
        workspaceKey: "/ws",
        taskId: "sess_1",
        title: "first prompt",
        traceId: "trace_1",
      });
      expect(ok).toBe(true);
      expect(rows.size).toBe(1);
      const r = rows.get("/ws\u0000sess_1")!;
      expect(r.task_id).toBe("sess_1");
      expect(r.title).toBe("first prompt");
      expect(r.mode).toBe("build");
      expect(r.title_overridden).toBe(0);
      expect(r.pinned).toBe(0);
      expect(r.unread_at).toBeNull();
      // App stores model as the full providerKey/modelId path so its UI
      // groups/filters bridge rows identically to App-created ones.
      expect(r.model).toBe("builtin:bigmodel-coding-plan/GLM-5.2");
      const meta = JSON.parse(r.meta_json);
      expect(meta.taskId).toBe("sess_1");
      expect(meta.traceId).toBe("trace_1");
      expect(meta.mode).toBe("build");
      expect(meta.provider).toBe("glm");
      expect(meta.model).toBe("builtin:bigmodel-coding-plan/GLM-5.2");
    });

    it("defaults traceId to taskId when not provided", async () => {
      await upsertSessionTask({
        workspaceKey: "/ws",
        taskId: "sess_2",
        title: "",
      });
      const meta = JSON.parse(rows.get("/ws\u0000sess_2")!.meta_json);
      expect(meta.traceId).toBe("sess_2");
    });

    it("is a no-op on the second insert (INSERT OR IGNORE)", async () => {
      await upsertSessionTask({
        workspaceKey: "/ws",
        taskId: "sess_3",
        title: "original",
      });
      // Simulate the App renaming + flagging override on the existing row.
      const row = rows.get("/ws\u0000sess_3")!;
      row.title = "app renamed";
      row.title_overridden = 1;

      const ok = await upsertSessionTask({
        workspaceKey: "/ws",
        taskId: "sess_3",
        title: "should not clobber",
      });
      expect(ok).toBe(true);
      expect(rows.size).toBe(1); // no new row
      // The App-managed row must be untouched.
      expect(rows.get("/ws\u0000sess_3")!.title).toBe("app renamed");
      expect(rows.get("/ws\u0000sess_3")!.title_overridden).toBe(1);
    });

    it("retries on SQLITE_BUSY and writes once contention clears", async () => {
      // The App's Electron host also writes to tasks-index.sqlite; a contended
      // write surfaces as SQLITE_BUSY even with `timeout: 5000`. Two short
      // backoffs must let the write through on the third attempt.
      busyTimes = 2;
      vi.useFakeTimers();
      try {
        const p = upsertSessionTask({
          workspaceKey: "/ws",
          taskId: "sess_busy",
          title: "after contention",
        });
        // Advance through both backoffs (200ms, 400ms) plus connection retries.
        await vi.advanceTimersByTimeAsync(1000);
        const ok = await p;
        expect(ok).toBe(true);
        expect(rows.size).toBe(1);
        expect(rows.get("/ws\u0000sess_busy")!.title).toBe("after contention");
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives up and returns false when busy persists past retries", async () => {
      // All 3 attempts hit busy → surface as a visible failure (warn), but
      // never throw into session/create.
      busyTimes = 99;
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const p = upsertSessionTask({
          workspaceKey: "/ws",
          taskId: "sess_busy_forever",
          title: "never lands",
        });
        await vi.advanceTimersByTimeAsync(2000);
        const ok = await p;
        expect(ok).toBe(false);
        expect(rows.size).toBe(0);
        // warn() writes to stderr — the skipped message must be visible so the
        // failure is diagnosable (it was previously hidden behind ZCODE_ACP_DEBUG).
        const out = warnSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toMatch(/tasks-index sync skipped/i);
      } finally {
        warnSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe("updateSessionTitle", () => {
    it("updates title + searchable_text + meta_json when title_overridden=0", async () => {
      await upsertSessionTask({
        workspaceKey: "/ws",
        taskId: "sess_4",
        title: "",
      });
      const ok = await updateSessionTitle("sess_4", "new title");
      expect(ok).toBe(true);
      const r = rows.get("/ws\u0000sess_4")!;
      expect(r.title).toBe("new title");
      expect(r.searchable_text).toBe("new title");
      expect(r.title_overridden).toBe(0);
      // The App reads title from meta_json first — must be in sync.
      expect(JSON.parse(r.meta_json).title).toBe("new title");
    });

    it("uses the full prompt text as searchable_text when provided", async () => {
      await upsertSessionTask({
        workspaceKey: "/ws",
        taskId: "sess_search",
        title: "",
      });
      const fullPrompt = "explain how the auth module works in detail please";
      await updateSessionTitle("sess_search", fullPrompt.slice(0, 80), fullPrompt);
      const r = rows.get("/ws\u0000sess_search")!;
      // title truncated to 80, searchable_text keeps the full prompt
      expect(r.title).toBe(fullPrompt.slice(0, 80));
      expect(r.searchable_text).toBe(fullPrompt);
    });

    it("caps searchable_text at the App's 200k char limit", async () => {
      await upsertSessionTask({
        workspaceKey: "/ws",
        taskId: "sess_cap",
        title: "",
      });
      const huge = "a".repeat(250_000);
      await updateSessionTitle("sess_cap", "t", huge);
      expect(rows.get("/ws\u0000sess_cap")!.searchable_text.length).toBe(200_000);
    });

    it("truncates the title to 80 characters", async () => {
      await upsertSessionTask({
        workspaceKey: "/ws",
        taskId: "sess_5",
        title: "",
      });
      const long = "x".repeat(120);
      await updateSessionTitle("sess_5", long);
      const r = rows.get("/ws\u0000sess_5")!;
      expect(r.title.length).toBe(80);
      // Without explicit searchableText, title is used as fallback → also 80.
      expect(r.searchable_text.length).toBe(80);
    });

    it("respects user title override but still refreshes searchable_text + meta_json", async () => {
      await upsertSessionTask({
        workspaceKey: "/ws",
        taskId: "sess_6",
        title: "",
      });
      const row = rows.get("/ws\u0000sess_6")!;
      row.title = "user kept name";
      row.title_overridden = 1;

      const ok = await updateSessionTitle("sess_6", "auto title", "search body");
      expect(ok).toBe(true);
      const r = rows.get("/ws\u0000sess_6")!;
      // User's title wins.
      expect(r.title).toBe("user kept name");
      // But searchable_text is still updated (not user-controlled).
      expect(r.searchable_text).toBe("search body");
      // meta_json is left untouched too — the App may read the title from
      // either the column or meta_json.title, so writing the auto title into
      // meta_json could visually revert the user's rename.
      expect(JSON.parse(r.meta_json).title).not.toBe("auto title");
    });

    it("returns false when the session row does not exist", async () => {
      const ok = await updateSessionTitle("never_created", "title");
      expect(ok).toBe(false);
      expect(rows.size).toBe(0);
    });

    it("returns false when the row is deleted — no title refresh on tombstones", async () => {
      await upsertSessionTask({ workspaceKey: "/ws", taskId: "sess_del_t", title: "keep me" });
      await softDeleteTask({ taskId: "sess_del_t", workspacePath: "/ws" });
      const ok = await updateSessionTitle("sess_del_t", "late title");
      expect(ok).toBe(false);
      // The tombstoned row must stay byte-identical (upstream applyAgentPatch
      // returns null on deleted rows for the same reason).
      const r = rows.get("/ws\u0000sess_del_t")!;
      expect(r.title).toBe("keep me");
      expect(JSON.parse(r.meta_json).title).toBe("keep me");
    });

    it("regression: meta_json.title is updated so the App shows the new title", async () => {
      // The ZCode App reads title from meta_json first, falling back to the
      // title column only when meta_json is unparseable. At session/create the
      // meta_json.title is "" (empty). Without patching meta_json on title
      // update, the App keeps showing the empty title even though the column
      // was updated.
      await upsertSessionTask({
        workspaceKey: "/ws",
        taskId: "sess_meta",
        title: "",
      });
      const before = JSON.parse(rows.get("/ws\u0000sess_meta")!.meta_json);
      expect(before.title).toBe(""); // empty at create time

      await updateSessionTitle("sess_meta", "fix the login bug");
      const after = JSON.parse(rows.get("/ws\u0000sess_meta")!.meta_json);
      // App reads this → must reflect the new title.
      expect(after.title).toBe("fix the login bug");
      // Other meta fields must survive the patch.
      expect(after.taskId).toBe("sess_meta");
      expect(after.mode).toBe("build");
    });

    it("retries on SQLITE_BUSY and updates the title once contention clears", async () => {
      // Title updates also write to tasks-index.sqlite → equally exposed to
      // SQLITE_BUSY contention with the App's Electron host. Goes through the
      // same withSqliteRetry path as upsertSessionTask.
      await upsertSessionTask({
        workspaceKey: "/ws",
        taskId: "sess_title_busy",
        title: "",
      });
      busyTimes = 2;
      vi.useFakeTimers();
      try {
        const p = updateSessionTitle("sess_title_busy", "after contention");
        await vi.advanceTimersByTimeAsync(1000);
        const ok = await p;
        expect(ok).toBe(true);
        expect(rows.get("/ws\u0000sess_title_busy")!.title).toBe("after contention");
        // meta_json.title must also reflect the retry (App reads it first).
        expect(JSON.parse(rows.get("/ws\u0000sess_title_busy")!.meta_json).title).toBe(
          "after contention",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("softDeleteTask", () => {
    it("flips deleted=1 on an existing row and keeps its title/overrides", async () => {
      await upsertSessionTask({ workspaceKey: "/ws", taskId: "sess_d1", title: "real title" });
      const row = rows.get("/ws\u0000sess_d1")!;
      row.title_overridden = 1;

      const ok = await softDeleteTask({ taskId: "sess_d1", workspacePath: "/ws" });
      expect(ok).toBe(true);
      expect(row.deleted).toBe(1);
      expect(row.title).toBe("real title");
      expect(row.title_overridden).toBe(1);
    });

    it("inserts a born-tombstoned row for a session that never had one", async () => {
      const ok = await softDeleteTask({
        taskId: "sess_legacy",
        workspacePath: "/old/proj",
        title: "legacy session",
      });
      expect(ok).toBe(true);
      expect(rows.size).toBe(1);
      const r = rows.get("/old/proj\u0000sess_legacy")!;
      expect(r.deleted).toBe(1);
      expect(r.title).toBe("legacy session");
      expect(r.task_status).toBe("completed");
      // The workspace attribution lets a later project delete sweep it up.
      expect(r.workspace_path).toBe("/old/proj");
    });

    it("defaults the tombstone title when none is given", async () => {
      await softDeleteTask({ taskId: "sess_notitle", workspacePath: "/ws" });
      expect(rows.get("/ws\u0000sess_notitle")!.title).toBe("deleted session");
    });

    it("does not duplicate a row whose workspace_key spells differently", async () => {
      // A desktop-created row may key the workspace differently than the
      // deleting bridge's projectCwd(); the existence probe must keep the
      // tombstone a flip on the REAL row, not a second INSERT.
      await upsertSessionTask({ workspaceKey: "/real/key", taskId: "sess_dk", title: "t" });
      const ok = await softDeleteTask({ taskId: "sess_dk", workspacePath: "/other/cwd" });
      expect(ok).toBe(true);
      expect(rows.size).toBe(1);
      expect(rows.get("/real/key\u0000sess_dk")!.deleted).toBe(1);
      expect(rows.get("/real/key\u0000sess_dk")!.workspace_key).toBe("/real/key");
    });

    it("is idempotent — a second delete succeeds and keeps the row single", async () => {
      await upsertSessionTask({ workspaceKey: "/ws", taskId: "sess_d2", title: "t" });
      await softDeleteTask({ taskId: "sess_d2", workspacePath: "/ws" });
      const firstAt = rows.get("/ws\u0000sess_d2")!.updated_at;

      const ok = await softDeleteTask({ taskId: "sess_d2", workspacePath: "/ws" });
      expect(ok).toBe(true);
      expect(rows.size).toBe(1);
      expect(rows.get("/ws\u0000sess_d2")!.deleted).toBe(1);
      // The INSERT OR IGNORE branch did not reset the row; only the UPDATE's
      // updated_at refresh may differ.
      expect(rows.get("/ws\u0000sess_d2")!.updated_at).toBeGreaterThanOrEqual(firstAt);
    });
  });

  describe("softDeleteWorkspaceTasks", () => {
    it("flips every non-deleted row of the workspace and returns the count", async () => {
      await upsertSessionTask({ workspaceKey: "/proj", taskId: "s1", title: "" });
      await upsertSessionTask({ workspaceKey: "/proj", taskId: "s2", title: "" });
      await upsertSessionTask({ workspaceKey: "/other", taskId: "s3", title: "" });

      const flipped = await softDeleteWorkspaceTasks("/proj");
      expect(flipped).toBe(2);
      expect(rows.get("/proj\u0000s1")!.deleted).toBe(1);
      expect(rows.get("/proj\u0000s2")!.deleted).toBe(1);
      // Other workspaces untouched.
      expect(rows.get("/other\u0000s3")!.deleted).toBe(0);
    });

    it("is idempotent — already-deleted rows are not counted again", async () => {
      await upsertSessionTask({ workspaceKey: "/proj", taskId: "s1", title: "" });
      await softDeleteWorkspaceTasks("/proj");
      expect(await softDeleteWorkspaceTasks("/proj")).toBe(0);
    });
  });

  describe("hiddenTaskIds / isTaskDeleted", () => {
    it("collects deleted AND archived rows (desktop archive hides too)", async () => {
      await upsertSessionTask({ workspaceKey: "/ws", taskId: "s_del", title: "" });
      await upsertSessionTask({ workspaceKey: "/ws", taskId: "s_arch", title: "" });
      await upsertSessionTask({ workspaceKey: "/ws", taskId: "s_live", title: "" });
      await softDeleteTask({ taskId: "s_del", workspacePath: "/ws" });
      rows.get("/ws\u0000s_arch")!.archived = 1;

      const hidden = await hiddenTaskIds();
      expect(hidden.has("s_del")).toBe(true);
      expect(hidden.has("s_arch")).toBe(true);
      expect(hidden.has("s_live")).toBe(false);
      expect(hidden.size).toBe(2);
    });

    it("isTaskDeleted: true only for deleted rows, false for absent ones", async () => {
      await upsertSessionTask({ workspaceKey: "/ws", taskId: "s_ok", title: "" });
      await softDeleteTask({ taskId: "s_gone", workspacePath: "/ws" });
      // An ARCHIVED row is hidden but not deleted — resume may still refuse
      // there, but the tombstone predicate itself must stay precise.
      await upsertSessionTask({ workspaceKey: "/ws", taskId: "s_arch2", title: "" });
      rows.get("/ws\u0000s_arch2")!.archived = 1;

      expect(await isTaskDeleted("s_gone")).toBe(true);
      expect(await isTaskDeleted("s_ok")).toBe(false);
      expect(await isTaskDeleted("s_arch2")).toBe(false);
      // Absent row: unknown ≠ deleted (bogus resume ids keep their honest window).
      expect(await isTaskDeleted("never_created")).toBe(false);
    });
  });

  describe("renameSessionTask", () => {
    it("refuses to rename a deleted row (tombstone stays sticky)", async () => {
      await upsertSessionTask({ workspaceKey: "/ws", taskId: "sess_rd", title: "old" });
      await softDeleteTask({ taskId: "sess_rd", workspacePath: "/ws" });

      const ok = await renameSessionTask("sess_rd", "new name");
      expect(ok).toBe(false);
      expect(rows.get("/ws\u0000sess_rd")!.title).toBe("old");
      expect(rows.get("/ws\u0000sess_rd")!.title_overridden).toBe(0);
    });

    it("renames normally on a live row", async () => {
      await upsertSessionTask({ workspaceKey: "/ws", taskId: "sess_rn", title: "old" });
      const ok = await renameSessionTask("sess_rn", "new name");
      expect(ok).toBe(true);
      expect(rows.get("/ws\u0000sess_rn")!.title).toBe("new name");
      expect(rows.get("/ws\u0000sess_rn")!.title_overridden).toBe(1);
    });
  });
});
