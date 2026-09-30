/**
 * ZCode App tasks-index sync: let the App UI see ACP-created sessions.
 *
 * The ZCode App's session list reads from `~/.zcode/v2/tasks-index.sqlite`
 * (the `tasks` table), NOT from the CLI's `~/.zcode/cli/db/db.sqlite`. These
 * are independent stores — the App's Electron host maintains tasks-index; the
 * headless app-server (which we drive) writes only to cli/db. As a result,
 * every session created via ACP is invisible in the App's UI until the App
 * happens to reindex.
 *
 * This module bridges that gap by writing a tasks-index row directly after
 * session/create. The App picks it up on its next list refresh. INSERT OR
 * IGNORE avoids clobbering rows the App already manages.
 *
 * Best-effort side-channel: failures (locked DB, schema drift) are logged and
 * swallowed so they never break the session/create path.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_MODEL_ID } from "./config/options.js";
import { warn, zcodeHomeDir, ZCODE_CREDS_PATH } from "./utils.js";

// Precise DatabaseSync constructor type from @types/node, captured without a
// runtime import (type position only). node:sqlite's API is prepared-statement
// based: con.prepare(sql) → StatementSync with .run(...)/.get(...); the
// DatabaseSync instance itself has NO .run/.get methods.
type DatabaseSyncCtor = (typeof import("node:sqlite"))["DatabaseSync"];

/**
 * Dynamically load `node:sqlite` (Node ≥ 22). On older Node the import fails;
 * callers degrade gracefully (tasks-index sync is best-effort). We cache the
 * loaded class so repeated calls don't re-import.
 */
let DatabaseSync: DatabaseSyncCtor | null | undefined;

async function loadSqlite(): Promise<DatabaseSyncCtor | null> {
  if (DatabaseSync !== undefined) return DatabaseSync;
  try {
    // node:sqlite ships with Node ≥ 22 (experimental on 22.x — may need
    // --experimental-sqlite on some builds; the catch below covers that).
    const mod = (await import("node:sqlite")) as {
      DatabaseSync: DatabaseSyncCtor;
    };
    DatabaseSync = mod.DatabaseSync;
  } catch {
    DatabaseSync = null; // Node < 22, sqlite unavailable, or flag missing
  }
  return DatabaseSync;
}

/** tasks-index.sqlite sits next to config.json under ~/.zcode/v2/. */
const TASKS_INDEX_PATH = path.join(path.dirname(ZCODE_CREDS_PATH), "tasks-index.sqlite");

/**
 * Detect a SQLite "database is locked" / "busy" error. node:sqlite surfaces
 * SQLITE_BUSY (code 5) and SQLITE_LOCKED (code 6) as an Error whose message is
 * SQLite's standard phrase — verified against a real node:sqlite v22 throw:
 *   `Error: database is locked`, code `ERR_SQLITE_ERROR`.
 * We match the full phrase rather than the bare word "busy" / "locked" so a
 * filesystem path that happens to contain those words (e.g. `/Users/busy_bee/`)
 * inside a different error message can't trigger a false-positive retry.
 */
function isBusyError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /database is (busy|locked)/i.test(msg);
}

/** Promise-based sleep (best-effort retry backoff). */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Open a connection to tasks-index.sqlite and run `fn` against it, retrying on
 * SQLITE_BUSY contention from the App's Electron host. Two short backoffs
 * (200ms, 400ms) give the App's transaction time to commit. The connection is
 * always closed in `finally` so a thrown error never leaks a handle.
 *
 * Returns whatever `fn` returns, or `null` when node:sqlite is unavailable.
 * Rethrows non-busy errors (or busy errors that exhausted retries) so the
 * caller can classify and log them consistently.
 */
async function withSqliteRetry<T>(
  fn: (con: InstanceType<DatabaseSyncCtor>) => T,
  dbPath: string = TASKS_INDEX_PATH,
): Promise<T | null> {
  const Sqlite = await loadSqlite();
  if (!Sqlite) return null; // node:sqlite unavailable (Node < 22)
  for (let attempt = 0; attempt < 3; attempt++) {
    // `con` is declared outside try so the finally can close it even when the
    // constructor itself throws (SQLITE_BUSY can surface at open time).
    let con: InstanceType<DatabaseSyncCtor> | null = null;
    try {
      con = new Sqlite(dbPath, { timeout: 5000 });
      return fn(con);
    } catch (e) {
      // Retry only on transient busy/locked; surface everything else.
      if (attempt < 2 && isBusyError(e)) {
        await sleep(200 * (attempt + 1)); // 200ms, 400ms
        continue;
      }
      throw e;
    } finally {
      con?.close();
    }
  }
  // Unreachable — the loop either returns or throws — but satisfies TS.
  throw new Error("withSqliteRetry: exhausted retries without resolution");
}

/**
 * Read provider id + model ref from config.json.
 *
 * The App stores `model` as the full `providerKey/modelId` path (e.g.
 * `builtin:bigmodel-coding-plan/GLM-5.3`) — the provider map's KEY is the
 * provider id, not the short label. We mirror that format so App-side
 * filtering/grouping by model treats bridge-created rows identically.
 *
 * `providerId` stays the short label (`glm`) — that's what every row uses
 * regardless of source.
 */
function resolveProviderModel(): { providerId: string; modelRef: string } {
  try {
    const cfg = JSON.parse(readFileSync(ZCODE_CREDS_PATH, "utf8")) as {
      provider?: Record<string, { enabled?: boolean; models?: Record<string, unknown> }>;
    };
    for (const [providerKey, p] of Object.entries(cfg.provider ?? {})) {
      if (p?.enabled) {
        const models = p.models ?? {};
        const modelId = Object.keys(models)[0] ?? DEFAULT_MODEL_ID;
        return { providerId: "glm", modelRef: `${providerKey}/${modelId}` };
      }
    }
  } catch {
    // fall through to defaults
  }
  return { providerId: "glm", modelRef: DEFAULT_MODEL_ID };
}

/**
 * Insert (or refresh) a row in tasks-index.sqlite so the App UI shows it.
 * Called after a successful session/create. Uses INSERT OR IGNORE so it never
 * overwrites a row the App is actively managing (e.g. user-renamed titles).
 *
 * Returns true if written, false on failure (logged, never thrown).
 */
export async function upsertSessionTask(opts: {
  workspaceKey: string;
  taskId: string;
  title: string;
  traceId?: string;
  model?: string;
  status?: string;
}): Promise<boolean> {
  if (!existsSync(TASKS_INDEX_PATH)) return false; // App never installed → no index.
  const nowMs = Date.now();
  const { providerId, modelRef } = resolveProviderModel();
  const model = opts.model ?? modelRef;
  const status = opts.status ?? "completed";
  const meta = {
    taskId: opts.taskId,
    traceId: opts.traceId ?? opts.taskId,
    title: opts.title,
    titleOverridden: false,
    workspacePath: opts.workspaceKey,
    createdAt: nowMs,
    updatedAt: nowMs,
    mode: "build",
    model,
    provider: providerId,
    status,
    target: null,
  };
  let metaJson: string;
  try {
    metaJson = JSON.stringify(meta);
  } catch {
    return false;
  }
  // withSqliteRetry handles SQLITE_BUSY contention with the App's Electron
  // host. Visible failure: a missing App-UI row is user-perceivable, so warn()
  // (stderr, always emitted) rather than the quiet log() default.
  try {
    const result = await withSqliteRetry((con) => {
      con
        .prepare(
          "INSERT OR IGNORE INTO tasks " +
            "(workspace_key, workspace_path, workspace_identity, task_id, " +
            " title, task_status, provider, mode, model, " +
            " created_at, updated_at, unread_at, pinned, archived, deleted, " +
            " title_overridden, meta_json, searchable_text) " +
            "VALUES (?, ?, NULL, ?, ?, ?, ?, 'build', ?, ?, ?, NULL, 0, 0, 0, 0, ?, ?)",
        )
        .run(
          opts.workspaceKey,
          opts.workspaceKey,
          opts.taskId,
          opts.title,
          status,
          providerId,
          model,
          nowMs,
          nowMs,
          metaJson,
          opts.title,
        );
      return true;
    });
    return result ?? false;
  } catch (e) {
    warn(`tasks-index sync skipped: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * User-driven rename (remote rename endpoint): pins the title with
 * title_overridden=1 — the same marker the App's own rename flow sets — so no
 * later automatic write can touch it. Best-effort: returns false when the row
 * is missing or the index is unavailable.
 */
export async function renameSessionTask(taskId: string, title: string): Promise<boolean> {
  if (!existsSync(TASKS_INDEX_PATH)) return false;
  const trimmed = title.trim().slice(0, 80);
  if (!trimmed) return false;
  try {
    const result = await withSqliteRetry((con) => {
      const row = con
        .prepare("SELECT deleted, meta_json FROM tasks WHERE task_id=?")
        .get(taskId) as { deleted: number; meta_json: string } | undefined;
      // Deleted rows stay tombstoned: a rename racing a delete must not
      // refresh updated_at and keep the row looking alive (upstream
      // applyAgentPatch returns null on deleted rows for the same reason).
      if (!row || row.deleted === 1) return false;
      let metaJson: string;
      try {
        const meta = JSON.parse(row.meta_json ?? "{}") as Record<string, unknown>;
        meta["title"] = trimmed;
        metaJson = JSON.stringify(meta);
      } catch {
        // meta_json corrupt/unparseable — the App will fall back to the title
        // column anyway, so keep the stored bytes rather than guessing.
        metaJson = row.meta_json ?? "{}";
      }
      con
        .prepare(
          "UPDATE tasks SET title=?, title_overridden=1, updated_at=?, meta_json=? WHERE task_id=?",
        )
        .run(trimmed, Date.now(), metaJson, taskId);
      return true;
    });
    return result ?? false;
  } catch (e) {
    warn(`tasks-index rename skipped: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Update a session's title + searchable_text after the first turn.
 *
 * session/create leaves title empty; once the first prompt completes, set a
 * meaningful title. Respects title_overridden: if the user already renamed in
 * the App, their title wins (but searchable_text is still refreshed — it's not
 * user-controlled).
 *
 * `searchableText` feeds the App's full-text search (the App builds it via
 * `buildSearchableTextFromMessages`: each message's content trimmed + joined
 * by newlines, capped at 200k chars). We pass the first user prompt here; the
 * App later overwrites it with the full conversation when it reindexes, but
 * having it non-empty from the start means the row shows up in search and
 * matches the shape of App-created rows.
 */
export async function updateSessionTitle(
  taskId: string,
  title: string,
  searchableText?: string,
): Promise<boolean> {
  if (!existsSync(TASKS_INDEX_PATH) || !title) return false;
  const trimmed = title.trim().slice(0, 80);
  if (!trimmed) return false;
  // Cap searchable_text at the App's limit (aD = 2e5 = 200000 chars).
  const search = (searchableText ?? trimmed).trim().slice(0, 200_000);
  // Title updates also write to tasks-index.sqlite and are equally exposed to
  // SQLITE_BUSY contention with the App's Electron host — go through the same
  // withSqliteRetry path as upsertSessionTask for consistent retry behaviour.
  try {
    const result = await withSqliteRetry((con) => {
      const row = con
        .prepare("SELECT deleted, title_overridden, meta_json FROM tasks WHERE task_id=?")
        .get(taskId) as
        { deleted: number; title_overridden: number; meta_json: string } | undefined;
      if (!row || row.deleted === 1) return false;

      if (row.title_overridden === 1) {
        // User renamed manually → the displayed title (title column AND
        // meta_json.title — the App may read either) must stay untouched;
        // only refresh searchable_text so search stays useful.
        con
          .prepare("UPDATE tasks SET updated_at=?, searchable_text=? WHERE task_id=?")
          .run(Date.now(), search, taskId);
        return true;
      }

      // The ZCode App reads title from meta_json first (falling back to the
      // title column only when meta_json fails to parse). If we update only the
      // column, the App keeps showing the stale meta_json title (empty at create
      // time). So patch meta_json.title as well.
      let metaJson: string;
      try {
        const meta = JSON.parse(row.meta_json ?? "{}") as Record<string, unknown>;
        meta["title"] = trimmed;
        metaJson = JSON.stringify(meta);
      } catch {
        // meta_json corrupt/unparseable — the App will fall back to the title
        // column anyway, so skip the meta_json write rather than guessing.
        metaJson = row.meta_json ?? "{}";
      }
      con
        .prepare(
          "UPDATE tasks SET title=?, updated_at=?, searchable_text=?, meta_json=? " +
            "WHERE task_id=? AND title_overridden=0",
        )
        .run(trimmed, Date.now(), search, metaJson, taskId);
      return true;
    });
    return result ?? false;
  } catch (e) {
    warn(`tasks-index title update skipped: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ---------- soft delete (tombstones, upstream deleteTask semantics) ----------

/**
 * Soft-delete one session — the upstream App's own delete semantics
 * ("将已持久化 task 标记为列表不可见；CLI session 内容继续保留"): the tasks
 * row gets deleted=1, every reader (this bridge's listings, the hub's project
 * list, the desktop App sidebar) hides it, and the backend store keeps the
 * conversation intact. Reversible by clearing the flag; there is no
 * physical-delete path.
 *
 * A session with no tasks row yet (pre-sync era, App never reindexed) gets a
 * minimal tombstone row first — INSERT OR IGNORE never touches an existing
 * row's title/overrides; the UPDATE then flips the flag (idempotent).
 */
export async function softDeleteTask(opts: {
  taskId: string;
  workspacePath: string;
  title?: string;
}): Promise<boolean> {
  if (!existsSync(TASKS_INDEX_PATH)) return false;
  const nowMs = Date.now();
  const { providerId, modelRef } = resolveProviderModel();
  const title = (opts.title ?? "").trim().slice(0, 80) || "deleted session";
  const meta = {
    taskId: opts.taskId,
    traceId: opts.taskId,
    title,
    titleOverridden: false,
    workspacePath: opts.workspacePath,
    createdAt: nowMs,
    updatedAt: nowMs,
    mode: "build",
    model: modelRef,
    provider: providerId,
    status: "completed",
    target: null,
  };
  let metaJson: string;
  try {
    metaJson = JSON.stringify(meta);
  } catch {
    return false;
  }
  try {
    const result = await withSqliteRetry((con) => {
      // Insert ONLY when no row carries the task id anywhere: an existing row
      // may spell its workspace_key differently (desktop-created, another
      // bridge cwd), and a blind INSERT OR IGNORE would add a duplicate
      // instead of ignoring. The flip below is task_id-scoped either way.
      const existing = con.prepare("SELECT 1 FROM tasks WHERE task_id=?").get(opts.taskId);
      if (!existing) {
        con
          .prepare(
            "INSERT OR IGNORE INTO tasks " +
              "(workspace_key, workspace_path, workspace_identity, task_id, " +
              " title, task_status, provider, mode, model, " +
              " created_at, updated_at, unread_at, pinned, archived, deleted, " +
              " title_overridden, meta_json, searchable_text) " +
              "VALUES (?, ?, NULL, ?, ?, 'completed', ?, 'build', ?, ?, ?, NULL, 0, 0, 1, 0, ?, ?)",
          )
          .run(
            opts.workspacePath,
            opts.workspacePath,
            opts.taskId,
            title,
            providerId,
            modelRef,
            nowMs,
            nowMs,
            metaJson,
            title,
          );
      }
      con
        .prepare("UPDATE tasks SET deleted=1, updated_at=? WHERE task_id=? AND deleted=0")
        .run(nowMs, opts.taskId);
      return true;
    });
    // null = node:sqlite unavailable (withSqliteRetry ran nothing) — the
    // tombstone was NOT written; never report success (503 at the endpoint).
    return result ?? false;
  } catch (e) {
    warn(`tasks-index soft delete skipped: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Soft-delete EVERY task row of a workspace — "delete the project" is just
 * "delete its sessions" en masse: the hub's project list derives from
 * deleted=0 rows, so the project disappears until a new session runs there
 * again (a hide, not a ban). Idempotent; returns the number of rows flipped.
 */
export async function softDeleteWorkspaceTasks(
  workspacePath: string,
  dbPath: string = TASKS_INDEX_PATH,
): Promise<number> {
  if (!existsSync(dbPath)) return 0;
  try {
    const flipped = await withSqliteRetry(
      (con) =>
        Number(
          con
            .prepare(
              "UPDATE tasks SET deleted=1, updated_at=? WHERE workspace_path=? AND deleted=0",
            )
            .run(Date.now(), workspacePath).changes,
        ),
      dbPath,
    );
    return flipped ?? 0;
  } catch (e) {
    warn(`tasks-index workspace delete failed: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

/**
 * Clear delete tombstones when their sessions become USED again (ADR-0031's
 * amendment: a delete is a list-hide, and touching the project/session again
 * cancels it — "undelete = a flag flip", now automatic).
 *
 * Workspace scope: when EVERY row of the workspace is list-hidden (no
 * deleted=0 AND archived=0 row — the state a project delete leaves), any
 * session activity in it revives ALL its deleted rows at once: reopening a
 * project with the CLI/editor and touching any conversation (or creating a
 * new one) brings the whole project back. Runs BEFORE the task-scope flip —
 * reviving the one used session first would make the workspace visible again
 * and suppress the project-wide revival.
 *
 * Task scope: a single tombstoned session that is used again (load with
 * history, resume, a prompt turn) revives itself — the same self-heal
 * doctrine as discovery retirement (ADR-0006). Individually deleted sessions
 * of a VISIBLE workspace stay deleted: the workspace branch runs only at full
 * invisibility, and this branch touches exactly one task id.
 *
 * Archived rows are never revived — `archived=1` is the desktop App's own
 * archive marker (un-deleting would not even unhide them).
 *
 * Returns the number of rows revived (0 when there is nothing to revive, no
 * index, or the write fails — best-effort, never throws).
 */
export async function reviveTombstonesOnActivity(
  opts: { taskId?: string; workspacePath?: string },
  dbPath: string = TASKS_INDEX_PATH,
): Promise<number> {
  if (!existsSync(dbPath)) return 0;
  try {
    const revived = await withSqliteRetry((con) => {
      let flipped = 0;
      const now = Date.now();
      if (opts.workspacePath) {
        const visible = con
          .prepare(
            "SELECT COUNT(*) AS n FROM tasks WHERE workspace_path=? AND deleted=0 AND archived=0",
          )
          .get(opts.workspacePath) as { n: number } | undefined;
        if ((visible?.n ?? 0) === 0) {
          flipped += Number(
            con
              .prepare(
                "UPDATE tasks SET deleted=0, updated_at=? " +
                  "WHERE workspace_path=? AND deleted=1 AND archived=0",
              )
              .run(now, opts.workspacePath).changes,
          );
        }
      }
      if (opts.taskId) {
        flipped += Number(
          con
            .prepare("UPDATE tasks SET deleted=0, updated_at=? WHERE task_id=? AND deleted=1")
            .run(now, opts.taskId).changes,
        );
      }
      return flipped;
    }, dbPath);
    return revived ?? 0;
  } catch (e) {
    warn(`tasks-index tombstone revival skipped: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

/**
 * Task-ids whose tasks rows are list-hidden (deleted or archived tombstones).
 * The sessions listing consults this BEFORE sorting/pagination so pages stay
 * dense and cursors keep naming the exact next row. Silent best-effort: any
 * failure (no index, sqlite unavailable) means "nothing hidden" — listings
 * degrade to showing everything rather than erroring.
 */
export async function hiddenTaskIds(dbPath: string = TASKS_INDEX_PATH): Promise<Set<string>> {
  if (!existsSync(dbPath)) return new Set();
  try {
    const rows = await withSqliteRetry(
      (con) =>
        con
          .prepare("SELECT task_id AS id FROM tasks WHERE deleted=1 OR archived=1")
          .all() as Array<{ id: unknown }>,
      dbPath,
    );
    const out = new Set<string>();
    for (const r of rows ?? []) {
      if (typeof r.id === "string") out.add(r.id);
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Whether a session's tasks row carries the deleted tombstone — guards the
 * hub's resume path so a stale client cannot resurrect a deleted thread.
 * False when the row or index is absent (unknown ≠ deleted).
 */
export async function isTaskDeleted(
  taskId: string,
  dbPath: string = TASKS_INDEX_PATH,
): Promise<boolean> {
  if (!existsSync(dbPath)) return false;
  try {
    const row = await withSqliteRetry(
      (con) =>
        con.prepare("SELECT deleted FROM tasks WHERE task_id=?").get(taskId) as
          { deleted: number } | undefined,
      dbPath,
    );
    return row?.deleted === 1;
  } catch {
    return false;
  }
}

// ---------- known workspaces (remote session-create, ADR-0014) ----------

/**
 * Whether the tasks-index row marks this conversation's title as manually
 * renamed (`title_overridden=1`, set by renameSessionTask). Read-only consult
 * for the title listener: the bridge's in-memory rename pin is lost on
 * restart, but the durable flag keeps a later backend `generated` title push
 * from overriding the user's rename. False when the index or row is absent.
 */
export async function isTitleOverridden(taskId: string): Promise<boolean> {
  if (!existsSync(TASKS_INDEX_PATH)) return false;
  try {
    const row = await withSqliteRetry(
      (con) =>
        con.prepare("SELECT title_overridden FROM tasks WHERE task_id=?").get(taskId) as
          { title_overridden: number } | undefined,
    );
    return row?.title_overridden === 1;
  } catch {
    return false;
  }
}

/** One known project workspace, as recorded by the App's tasks index. */
export interface KnownWorkspace {
  workspacePath: string;
  sessions: number;
  lastActive: number;
}

/**
 * Whether a recorded workspace path may be offered for remote session
 * creation. Excludes: degenerate roots, system temp trees (macOS /tmp is a
 * symlink to /private/tmp — both spellings; $TMPDIR lives under /var/folders),
 * and the ZCode data root itself (the config home, not a project). The
 * directory must still exist — a moved/deleted project disappears from the
 * list.
 */
export function isSelectableWorkspace(p: string): boolean {
  if (!p || p === "/") return false;
  const excluded = ["/tmp", "/private/tmp", "/var/folders", tmpdir(), zcodeHomeDir()];
  for (const ex of excluded) {
    if (p === ex || p.startsWith(ex + path.sep)) return false;
  }
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every project workspace the tasks index has ever recorded a VISIBLE session
 * for — the machine's known-projects list. Serves the hub's remote
 * session-create API: the list gates which projects POST /api/instances
 * accepts. A convenience bound, not a security boundary — bridge-side session
 * materialization writes rows too, and a token holder can drive an
 * editor-bridge session in any cwd (the real boundary is the token).
 *
 * Rows the session listing hides (deleted OR archived tombstones) do not make
 * a workspace known: a project whose every row is archived renders as an
 * empty entry in the remote project list (nothing to resume), so it stays off
 * the list until a new unarchived session records it again — same hide-≠-ban
 * semantics as the delete tombstones.
 *
 * Read-only and best-effort: node:sqlite unavailable → empty list; lock
 * contention retries via withSqliteRetry; other failures warn and return
 * empty. `dbPath` defaults to the App's index (tests inject a fixture).
 */
export async function listKnownWorkspaces(
  dbPath: string = TASKS_INDEX_PATH,
): Promise<KnownWorkspace[]> {
  if (!existsSync(dbPath)) return [];
  try {
    const rows = await withSqliteRetry(
      (con) =>
        con
          .prepare(
            "SELECT workspace_path AS p, COUNT(*) AS n, MAX(updated_at) AS t " +
              "FROM tasks WHERE deleted=0 AND archived=0 GROUP BY workspace_key ORDER BY t DESC",
          )
          .all() as Array<{ p: unknown; n: unknown; t: unknown }>,
      dbPath,
    );
    if (!rows) return []; // node:sqlite unavailable (Node < 22)
    const out: KnownWorkspace[] = [];
    for (const r of rows) {
      const p = typeof r.p === "string" ? r.p : "";
      if (!isSelectableWorkspace(p)) continue;
      out.push({
        workspacePath: p,
        sessions: typeof r.n === "number" ? r.n : 0,
        lastActive: typeof r.t === "number" ? r.t : 0,
      });
    }
    return out;
  } catch (e) {
    warn(`tasks-index workspace list failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
