/**
 * App usage stats, aggregated from the local agent database.
 *
 * The desktop app's App Usage panel reads `~/.zcode/cli/db/db.sqlite`
 * (`model_usage` / `turn_usage` / `tool_usage`). Rather than proxying the
 * backend's `usage/stats` RPC — which couples a settings screen to a live
 * backend process and whose `.strict()` params turn any schema drift into a
 * hard failure — the same tables are aggregated here in read-only mode
 * (ADR-0027).
 *
 * Two things this module is careful about:
 *
 *  - **Never blocking the writer.** The connection is opened read-only and every
 *    query is a bounded aggregate. A `SQLITE_BUSY` degrades to the same
 *    `available: false` shape a missing database produces, because the caller
 *    renders an empty state either way.
 *  - **Never claiming data that is not there.** A machine that never ran an
 *    agent has no database; that is a normal state, so the response says
 *    `available: false` with zero values instead of erroring.
 *
 * Day buckets use the process timezone offset. The app does the same and notes
 * the same ≤1h DST imprecision; for a usage overview that is not worth the
 * complexity of a per-request timezone.
 */

import { createRequire } from "node:module";

import { log, warn, zcodeUsageDbPath } from "../utils.js";

type DatabaseSyncCtor = (typeof import("node:sqlite"))["DatabaseSync"];
type DatabaseSync = InstanceType<DatabaseSyncCtor>;

/**
 * Cached constructor; null when node:sqlite is unavailable (Node < 22).
 *
 * Loaded through `createRequire` rather than a dynamic `import`: under vite
 * (the test runner) `import("node:sqlite")` is intercepted and fails to
 * resolve, which would silently disable usage stats in every test. `require`
 * resolves Node built-ins directly.
 */
let sqliteCtor: DatabaseSyncCtor | null | undefined;

function loadSqlite(): DatabaseSyncCtor | null {
  if (sqliteCtor !== undefined) return sqliteCtor;
  try {
    const require = createRequire(import.meta.url);
    const mod = require("node:sqlite") as { DatabaseSync: DatabaseSyncCtor };
    sqliteCtor = mod.DatabaseSync;
  } catch {
    sqliteCtor = null;
  }
  return sqliteCtor;
}

/** A `database is locked/busy` throw from node:sqlite (see tasks-index.ts). */
function isBusyError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /database is (busy|locked)/i.test(msg);
}

const BUSY_RETRY_DELAYS_MS = [200, 400] as const;

/**
 * Open the usage db read-only, retrying briefly on writer contention.
 *
 * Synchronous on purpose: a settings request is a single short operation, and
 * blocking the event loop for at most 600ms is cheaper than making every caller
 * async. `Atomics.wait` is the synchronous sleep that does not busy-spin.
 */
function openReadOnly(dbPath: string): DatabaseSync | null {
  const Ctor = loadSqlite();
  if (!Ctor) return null;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return new Ctor(dbPath, { readOnly: true });
    } catch (error) {
      const delay = BUSY_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isBusyError(error)) return null;
      Atomics.wait(sleeper, 0, 0, delay);
    }
  }
}

export type UsageRange = "7d" | "30d" | "all";

export interface ModelUsageRow {
  modelId: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requestCount: number;
  /** Fraction of the window's total tokens, 0..1. */
  share: number;
}

export interface DailyUsageRow {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  models: Array<{ modelId: string | null; totalTokens: number }>;
}

export interface UsageSnapshot {
  /** false when the database is absent — an empty state, not an error. */
  available: boolean;
  range: UsageRange;
  summary: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    requestCount: number;
    sessionCount: number;
    turnCount: number;
    toolCallCount: number;
    models: number;
    activeDays: number;
  };
  models: ModelUsageRow[];
  daily: DailyUsageRow[];
}

const EMPTY_SNAPSHOT = (range: UsageRange): UsageSnapshot => ({
  available: false,
  range,
  summary: {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    requestCount: 0,
    sessionCount: 0,
    turnCount: 0,
    toolCallCount: 0,
    models: 0,
    activeDays: 0,
  },
  models: [],
  daily: [],
});

/** Range → the `started_at` floor (ms epoch). `all` has no floor. */
function rangeFloor(range: UsageRange, now: number): number {
  if (range === "7d") return now - 7 * 86_400_000;
  if (range === "30d") return now - 30 * 86_400_000;
  return 0;
}

/**
 * Aggregate the window.
 *
 * Two queries: one per-model roll-up, one per-day roll-up. Both are grouped
 * server-side by sqlite, so the bridge transfers only the aggregated rows —
 * the raw table on a developed machine holds tens of thousands of rows.
 */
export async function readUsageStats(range: UsageRange = "7d"): Promise<UsageSnapshot> {
  const db = openReadOnly(zcodeUsageDbPath());
  if (!db) {
    log("settings: usage database unavailable — reporting an empty snapshot");
    return EMPTY_SNAPSHOT(range);
  }
  try {
    const floor = rangeFloor(range, Date.now());
    const modelRows = db
      .prepare(
        `SELECT model_id,
                COALESCE(SUM(computed_total_tokens), 0) AS total_tokens,
                COALESCE(SUM(input_tokens), 0)            AS input_tokens,
                COALESCE(SUM(output_tokens), 0)           AS output_tokens,
                COALESCE(SUM(reasoning_tokens), 0)        AS reasoning_tokens,
                COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_tokens,
                COUNT(*)                                  AS request_count
           FROM model_usage
          WHERE started_at > ?
          GROUP BY model_id
          ORDER BY total_tokens DESC`,
      )
      .all(floor) as Array<Record<string, number | string | null>>;

    // Group by LOCAL calendar day, computed by sqlite. Dividing the epoch by
    // 86400000 would bucket on UTC, which puts a morning session in the wrong
    // day for every timezone east or west of it — the same imprecision the app
    // documents for its own day buckets.
    const dayRows = db
      .prepare(
        `SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
                model_id,
                COALESCE(SUM(computed_total_tokens), 0) AS total_tokens
           FROM model_usage
          WHERE started_at > ?
          GROUP BY day, model_id
          ORDER BY day ASC`,
      )
      .all(floor) as Array<Record<string, number | string | null>>;

    // Session/turn/tool counts describe the same window but come from their own
    // tables; a missing table reads as zero rather than failing the snapshot.
    const scalar = (sql: string): number => {
      try {
        const row = db.prepare(sql).get(floor) as Record<string, number> | undefined;
        return Number(row?.["c"] ?? 0);
      } catch {
        return 0;
      }
    };
    const sessionCount = scalar(
      "SELECT COUNT(DISTINCT session_id) AS c FROM turn_usage WHERE started_at > ?",
    );
    const turnCount = scalar("SELECT COUNT(*) AS c FROM turn_usage WHERE started_at > ?");
    const toolCallCount = scalar("SELECT COUNT(*) AS c FROM tool_usage WHERE started_at > ?");

    const grandTotal = modelRows.reduce((sum, r) => sum + Number(r["total_tokens"] ?? 0), 0);
    const models: ModelUsageRow[] = modelRows.map((r) => {
      const total = Number(r["total_tokens"] ?? 0);
      return {
        modelId: typeof r["model_id"] === "string" ? r["model_id"] : null,
        totalTokens: total,
        inputTokens: Number(r["input_tokens"] ?? 0),
        outputTokens: Number(r["output_tokens"] ?? 0),
        reasoningTokens: Number(r["reasoning_tokens"] ?? 0),
        cacheReadTokens: Number(r["cache_read_tokens"] ?? 0),
        cacheCreationTokens: Number(r["cache_creation_tokens"] ?? 0),
        requestCount: Number(r["request_count"] ?? 0),
        share: grandTotal > 0 ? round4(total / grandTotal) : 0,
      };
    });

    // The day rows arrive already grouped by sqlite; only the per-day model
    // ordering (by volume, so a chart's legend matches its bars) is done here.
    const byDay = new Map<string, Map<string, number>>();
    for (const row of dayRows) {
      const day = typeof row["day"] === "string" ? row["day"] : "";
      if (!day) continue;
      const modelId = typeof row["model_id"] === "string" ? row["model_id"] : "(unknown)";
      const bucket = byDay.get(day) ?? new Map<string, number>();
      bucket.set(modelId, (bucket.get(modelId) ?? 0) + Number(row["total_tokens"] ?? 0));
      byDay.set(day, bucket);
    }
    const daily: DailyUsageRow[] = Array.from(byDay.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, bucket]) => ({
        date,
        models: Array.from(bucket.entries())
          .map(([modelId, totalTokens]) => ({ modelId, totalTokens }))
          .sort((a, b) => b.totalTokens - a.totalTokens),
      }));

    return {
      available: true,
      range,
      summary: {
        totalTokens: grandTotal,
        inputTokens: models.reduce((s, m) => s + m.inputTokens, 0),
        outputTokens: models.reduce((s, m) => s + m.outputTokens, 0),
        reasoningTokens: models.reduce((s, m) => s + m.reasoningTokens, 0),
        cacheReadTokens: models.reduce((s, m) => s + m.cacheReadTokens, 0),
        requestCount: models.reduce((s, m) => s + m.requestCount, 0),
        sessionCount,
        turnCount,
        toolCallCount,
        models: models.length,
        activeDays: daily.length,
      },
      models,
      daily,
    };
  } catch (error) {
    // A schema drift (a renamed column) must not break the settings screen;
    // the rest of the API is unaffected.
    warn(
      `settings: usage aggregation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EMPTY_SNAPSHOT(range);
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
