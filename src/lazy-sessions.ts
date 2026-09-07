/**
 * Durable alias store for lazy `session/new` placeholders.
 *
 * `session/new` returns a placeholder id with no backend session behind it
 * (the real `session/create` is deferred to first use). The editor stores this
 * placeholder and may resume it later — including after a bridge restart, when
 * the in-memory `pendingSessions`/`sessionMap` are gone. Without a durable
 * record, `session/resume` then fails with "Session not found".
 *
 * This module keeps a tiny JSON file (`~/.zcode/v2/acp-lazy-sessions.json`,
 * next to tasks-index.sqlite) mapping acp_sid → { cwd, zcodeSid?, createdAt }:
 *   - `rememberLazySession` — written at session/new (no zcodeSid yet);
 *   - `recordMaterializedSession` — updated once the placeholder materializes;
 *   - `lookupLazySession` — lets resume/load/ensureRealSession recover a
 *     placeholder from a previous bridge lifetime.
 *
 * Best-effort side-channel like tasks-index: failures are logged and swallowed
 * so a store problem never breaks session/new or first use. NEVER-USED
 * placeholders older than 30 days are pruned on load — the real session stays
 * reachable via session/list after that, only the unused alias expires.
 * Materialized records never expire: their alias is the only link from the
 * editor's thread id to the backend session.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import { warn } from "./utils.js";

/** Placeholder alias record persisted in the store. */
export interface LazySessionRecord {
  cwd: string;
  /** Backend session id once the placeholder materialized (absent = never used). */
  zcodeSid?: string;
  createdAt: number;
}

/** Store file lives next to config.json / tasks-index.sqlite under ~/.zcode/v2/. */
const STORE_FILENAME = "acp-lazy-sessions.json";

/** NEVER-USED placeholders expire after 30 days; materialized records never do. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Resolved at call time so tests can stub HOME without re-importing. */
function storePath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".zcode", "v2", STORE_FILENAME);
}

/** Parse and validate the table. No side effects — never rewrites the file. */
function readTable(): { kept: Record<string, LazySessionRecord>; pruned: boolean } {
  try {
    const p = storePath();
    if (!existsSync(p)) return { kept: {}, pruned: false };
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, LazySessionRecord>;
    if (typeof raw !== "object" || raw === null) return { kept: {}, pruned: false };
    const now = Date.now();
    let pruned = false;
    const kept: Record<string, LazySessionRecord> = {};
    for (const [acpSid, rec] of Object.entries(raw)) {
      // TTL applies to NEVER-USED placeholders only. A materialized record
      // (zcodeSid set) is the sole durable link between the editor's thread
      // id and the backend session — pruning it orphans a session the
      // backend still happily resumes, and the prune-on-read persist below
      // makes that loss permanent on first touch (observed: every thread
      // older than the 30-day TTL failed with "alias lost" in Zed).
      if (!rec.zcodeSid && (typeof rec?.createdAt !== "number" || now - rec.createdAt > TTL_MS)) {
        pruned = true;
        continue;
      }
      kept[acpSid] = rec;
    }
    return { kept, pruned };
  } catch (e) {
    warn(
      `lazy-sessions: store read failed ` +
        `(${e instanceof Error ? e.message : String(e)}) — placeholder aliases unavailable`,
    );
    return { kept: {}, pruned: false };
  }
}

/**
 * Overwrite the store file atomically. Failures are logged, never thrown.
 *
 * Several bridge processes (editor + serve/TUI + tests) share this file with
 * no lock; a torn direct write corrupts the JSON, and the next reader treats
 * corruption as an empty table — permanently wiping every alias. The
 * write-then-rename leaves readers with either the old or the new file.
 */
function persist(table: Record<string, LazySessionRecord>): void {
  try {
    const p = storePath();
    const dir = path.dirname(p);
    mkdirSync(dir, { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(table, null, 2));
    renameSync(tmp, p);
    sweepStaleTmp(dir, p);
  } catch (e) {
    // warn, not gated log: this store is an idle thread's only recovery path,
    // so a silent write failure must be visible in stderr.
    warn(`lazy-sessions: store write failed (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Stale atomic-write leftovers older than this are swept on the next persist. */
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Remove leftover `.tmp-*` siblings a crashed writer never renamed away. The
 * 1h age guard keeps a concurrently-writing process's microsecond-lived tmp
 * untouched; the sweep runs only from persist, so readers pay nothing.
 */
function sweepStaleTmp(dir: string, storeFile: string): void {
  try {
    const prefix = `${path.basename(storeFile)}.tmp-`;
    const cutoff = Date.now() - TMP_MAX_AGE_MS;
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith(prefix)) continue;
      const full = path.join(dir, entry);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch {
        // a racing removal or vanished file is fine — best-effort
      }
    }
  } catch {
    // best-effort — the sweep must never fail a persist
  }
}

/** Read the store, pruning expired records (persisting the survivors). */
function loadRecords(): Record<string, LazySessionRecord> {
  const { kept, pruned } = readTable();
  if (pruned) persist(kept);
  return kept;
}

/** Record a new placeholder at session/new (no backend session yet). */
export function rememberLazySession(acpSid: string, cwd: string): void {
  // Merge over a FRESH disk read at write time: persisting a stale snapshot
  // silently drops records a concurrent bridge process just added.
  const { kept } = readTable();
  persist({ ...kept, [acpSid]: { cwd, createdAt: Date.now() } });
}

/** Attach the backend session id once the placeholder materializes. */
export function recordMaterializedSession(acpSid: string, zcodeSid: string, cwd: string): void {
  const { kept } = readTable();
  const existing = kept[acpSid];
  if (existing?.zcodeSid === zcodeSid) return;
  persist({
    ...kept,
    [acpSid]: {
      cwd: existing?.cwd ?? cwd,
      zcodeSid,
      createdAt: existing?.createdAt ?? Date.now(),
    },
  });
}

/** Look up a placeholder alias (undefined = unknown to this bridge and store). */
export function lookupLazySession(acpSid: string): LazySessionRecord | undefined {
  return loadRecords()[acpSid];
}
