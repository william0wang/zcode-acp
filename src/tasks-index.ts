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

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_MODEL_ID } from "./config/options.js";
import { warn, ZCODE_CREDS_PATH } from "./utils.js";

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
): Promise<T | null> {
  const Sqlite = await loadSqlite();
  if (!Sqlite) return null; // node:sqlite unavailable (Node < 22)
  for (let attempt = 0; attempt < 3; attempt++) {
    // `con` is declared outside try so the finally can close it even when the
    // constructor itself throws (SQLITE_BUSY can surface at open time).
    let con: InstanceType<DatabaseSyncCtor> | null = null;
    try {
      con = new Sqlite(TASKS_INDEX_PATH, { timeout: 5000 });
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
        .prepare("SELECT title_overridden, meta_json FROM tasks WHERE task_id=?")
        .get(taskId) as { title_overridden: number; meta_json: string } | undefined;
      if (!row) return false;

      // The ZCode App reads title from meta_json first (falling back to the
      // title column only when meta_json fails to parse). If we update only the
      // column, the App keeps showing the stale meta_json title (empty at create
      // time). So we patch meta_json.title in both branches below.
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

      if (row.title_overridden === 1) {
        // User overrode the title → respect the column value, but still refresh
        // searchable_text and sync meta_json.title for consistency.
        con
          .prepare("UPDATE tasks SET updated_at=?, searchable_text=?, meta_json=? WHERE task_id=?")
          .run(Date.now(), search, metaJson, taskId);
        return true;
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
