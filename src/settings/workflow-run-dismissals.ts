/**
 * Bridge-side hide list for workflow run rows ("dismissed").
 *
 * Upstream's run journal has no delete or archive RPC and belongs to the
 * backend process (the same store-ownership rule that bans physical session
 * deletes, ADR-0031) — so "remove this finished/failed run from my lists" is
 * a BRIDGE-OWNED id set, filtered at every journal read this bridge serves
 * (`workflows/runs`, `v4/conversation/workflowRuns`, the session-history
 * activity join). The journal keeps its record untouched; a re-run mints a
 * new run id and shows up normally.
 *
 * Same durability rules as the lazy-alias store: a tiny JSON file under
 * ~/.zcode/v2 shared by every bridge process, written only via temp+rename.
 * Best-effort by design — read failures read as "nothing dismissed", write
 * failures are logged and simply do not stick.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { warn, zcodeHomeDir } from "../utils.js";

/** Store file lives next to the lazy-alias store under ~/.zcode/v2/. */
const STORE_FILENAME = "acp-workflow-run-dismissals.json";

/** Entries far older than any journal window the filtered lists read expire. */
const TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Resolved at call time so tests can stub HOME/ZCODE_HOME without re-importing. */
function storePath(): string {
  return path.join(zcodeHomeDir(), "v2", STORE_FILENAME);
}

function readTable(): Record<string, number> {
  try {
    const p = storePath();
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) return {};
    const out: Record<string, number> = {};
    for (const [runId, at] of Object.entries(raw)) {
      if (typeof at === "number") out[runId] = at;
    }
    return out;
  } catch {
    // Corrupt or unreadable reads as nothing dismissed — never fatal.
    return {};
  }
}

function persist(table: Record<string, number>): void {
  try {
    const p = storePath();
    const dir = path.dirname(p);
    mkdirSync(dir, { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(table, null, 2));
    renameSync(tmp, p);
  } catch (e) {
    warn(
      `workflow-run-dismissals: store write failed ` +
        `(${e instanceof Error ? e.message : String(e)}) — the dismissal will not stick`,
    );
  }
}

/** The dismissed id set (read-only; never rewrites the file). */
export function dismissedRunIds(): Set<string> {
  return new Set(Object.keys(readTable()));
}

/**
 * Add ids to the hide list. Returns how many were NEWLY added — 0 means
 * every id was already dismissed (or none given); dismissing again is the
 * documented no-op. Year-old entries are pruned at write.
 */
export function dismissWorkflowRunIds(runIds: string[]): number {
  const ids = runIds.filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return 0;
  const table = readTable();
  const now = Date.now();
  for (const [id, at] of Object.entries(table)) {
    if (now - at > TTL_MS) delete table[id];
  }
  let added = 0;
  for (const id of new Set(ids)) {
    if (!(id in table)) added += 1;
    table[id] = now;
  }
  persist(table);
  return added;
}
