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

import { log, ZCODE_CREDS_PATH } from "./utils.js";

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
 * Read provider id + model ref from config.json.
 *
 * The App stores `model` as the full `providerKey/modelId` path (e.g.
 * `builtin:bigmodel-coding-plan/GLM-5.2`) — the provider map's KEY is the
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
        const modelId = Object.keys(models)[0] ?? "GLM-5.2";
        return { providerId: "glm", modelRef: `${providerKey}/${modelId}` };
      }
    }
  } catch {
    // fall through to defaults
  }
  return { providerId: "glm", modelRef: "GLM-5.2" };
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
  const Sqlite = await loadSqlite();
  if (!Sqlite) return false; // node:sqlite unavailable (Node < 22)
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
  try {
    const con = new Sqlite(TASKS_INDEX_PATH, { timeout: 5000 });
    try {
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
    } finally {
      con.close();
    }
    return true;
  } catch (e) {
    log(`tasks-index sync skipped: ${e instanceof Error ? e.message : String(e)}`);
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
  const Sqlite = await loadSqlite();
  if (!Sqlite) return false;
  const trimmed = title.trim().slice(0, 80);
  if (!trimmed) return false;
  // Cap searchable_text at the App's limit (aD = 2e5 = 200000 chars).
  const search = (searchableText ?? trimmed).trim().slice(0, 200_000);
  try {
    const con = new Sqlite(TASKS_INDEX_PATH, { timeout: 5000 });
    try {
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
    } finally {
      con.close();
    }
    return true;
  } catch (e) {
    log(`tasks-index title update skipped: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
