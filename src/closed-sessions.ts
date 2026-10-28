/**
 * Bridge-side remote-close record (ADR-0006 persistence amendment).
 *
 * A remote close retires the conversation from discovery with an IN-MEMORY
 * stamp (`server.discoveryRetiredAt`) — and a serve-origin bridge then
 * EXITS itself (last conversation closed), so the stamp dies with the
 * process. When the hub incubates the next serve bridge and a client's
 * reconnect ladder session/loads the conversation, the fresh process has no
 * retirement memory: the load re-arms discovery, the heartbeat re-advertises
 * the sid, the hub clears its close tombstone, and the conversation the user
 * closed resurrects on every surface (observed live 2026-10-28: closed
 * 00:48, resurrected by an auto load at 01:07 with a real turn).
 *
 * This store is the durable half of the retirement: the close endpoint
 * records EVERY id spelling of the conversation (editor aliases + backend
 * sess_ id), the auto-load retirement gate reads it (`loadSession`), and
 * genuine use (`markSessionActive` — a prompt, a user-intent load) clears
 * it, preserving ADR-0006's self-heal: touching the session reopens it.
 *
 * Same durability rules as the lazy-alias store: a tiny JSON file under
 * ~/.zcode/v2 shared by every bridge process, written only via temp+rename.
 * Best-effort by design — read failures read as "nothing closed", write
 * failures are logged and simply do not stick.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { warn, zcodeHomeDir } from "./utils.js";

/** Store file lives next to the lazy-alias store under ~/.zcode/v2/. */
const STORE_FILENAME = "acp-closed-sessions.json";

/**
 * Entries older than this expire: a conversation closed this long ago
 * without a single bridge-side touch stays closed in any practical sense,
 * and the expiry bounds staleness mistakes (a desktop-side reopen that never
 * passed through a bridge would otherwise keep the App's tab retired
 * forever).
 */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    for (const [sid, at] of Object.entries(raw)) {
      if (typeof at === "number") out[sid] = at;
    }
    return out;
  } catch {
    // Corrupt or unreadable reads as nothing closed — never fatal.
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
      `closed-sessions: store write failed ` +
        `(${e instanceof Error ? e.message : String(e)}) — the close record will not stick`,
    );
  }
}

/**
 * True when this id spelling belongs to a remotely closed conversation the
 * user has not touched since (within the TTL). The auto-load retirement gate
 * consults this; a USER-intent load or real use clears the record instead.
 */
export function isClosedSessionId(sid: string | undefined): boolean {
  if (typeof sid !== "string" || sid.length === 0) return false;
  const at = readTable()[sid];
  return at !== undefined && Date.now() - at <= TTL_MS;
}

/**
 * Record every id spelling of a remotely closed conversation (the close
 * endpoint's alias set plus the backend sess_ id). TTL-expired entries are
 * pruned at write.
 */
export function recordClosedSessionIds(sids: Array<string | undefined>): void {
  const ids = sids.filter((sid): sid is string => typeof sid === "string" && sid.length > 0);
  if (ids.length === 0) return;
  const table = readTable();
  const now = Date.now();
  for (const [sid, at] of Object.entries(table)) {
    if (now - at > TTL_MS) delete table[sid];
  }
  for (const sid of new Set(ids)) table[sid] = now;
  persist(table);
}

/**
 * Clear the close record for a conversation's id spellings — genuine use
 * (`markSessionActive`): a prompt turn or a user-intent load reopens the
 * conversation and the next serve-bridge respawn must not re-retire it.
 * No-op (no write) when nothing is recorded.
 */
export function clearClosedSessionIds(sids: Array<string | undefined>): void {
  const ids = sids.filter((sid): sid is string => typeof sid === "string" && sid.length > 0);
  if (ids.length === 0) return;
  const table = readTable();
  let touched = false;
  for (const sid of new Set(ids)) {
    if (sid in table) {
      delete table[sid];
      touched = true;
    }
  }
  if (touched) persist(table);
}
