/**
 * Quota auto-resume watchdog for dynamic-workflow runs.
 *
 * Why: when a workflow subagent hits a usage cap (GLM 1308 …), upstream stops
 * the WHOLE run as `stopped(provider)` with a `ProviderStopDetails{kind:
 * "quota"}` and its notification instructs the agent to call
 * ResumeWorkflowRun AFTER the reset (workflow-notification-copy.ts:55-64).
 * Nothing schedules that "after" — the run sits stopped until a human acts.
 * The bridge owns the process that can wait, so it does: a small persisted
 * registry of pending resumes, a periodic scan over the project's run journal,
 * and a timer per entry.
 *
 * Detection is deliberately journal-first: the v4 session summary carries the
 * failure message (with the provider's business code in brackets) but NOT the
 * structured providerStop/resetAt, and the workflow progress poller gives up
 * after 10 minutes — long runs would never be seen there. The scan reads
 * `workflows/runs` (one session-less RPC), keeps rows that are
 * `stopped(provider)`, and only then resolves the few parent sessions through
 * `v4/conversation/workflowRuns` to read their failure messages.
 *
 * Firing is defensive at every step: quota card first (a known future reset
 * defers without burning an attempt), then a live state read (a run that is
 * running again / finished / no longer resumable drops the entry), then the
 * same `resumeWorkflowRun` command the App's Resume button uses. An accepted
 * resume is re-verified after {@link VERIFY_AFTER_MS}; only a stopped-again run
 * with no known reset burns an attempt and backs off.
 *
 * Store: `~/.zcode/v2/acp-quota-resumes.json`, shared by every bridge process
 * and written only via temp+rename with merge-at-write (the dismissals-store
 * discipline — a torn write would lose every pending resume).
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import { quotaAutoResumeEnabled } from "../config/settings.js";
import { sendTextChunk } from "../handlers/io.js";
import { messages } from "../i18n.js";
import { loadAliasesByZcodeSid } from "../lazy-sessions.js";
import { pushSettled, pushSourceLabel } from "../push/push.js";
import { queryQuota } from "../quota/index.js";
import {
  isQuotaStopFailureMessage,
  quotaBackoffMs,
  quotaResetAtFromResult,
} from "../quota/resume.js";
import type { QuotaResult } from "../quota/types.js";
import type { ZcodeAcpServer } from "../server.js";
import { withFileLock } from "../settings/file-lock.js";
import { WorkflowApiError, conversationRuns, resumeWorkflowRun } from "../settings/workflow.js";
import { dismissedRunIds } from "../settings/workflow-run-dismissals.js";
import { log, warn, zcodeHomeDir } from "../utils.js";

/** Scan cadence for newly quota-stopped runs. */
export const QUOTA_RESUME_SCAN_INTERVAL_MS = 5 * 60_000;

/** First scan after bridge start (lets the backend come up without spawning it). */
const FIRST_SCAN_DELAY_MS = 30_000;

/** Delay before the first resume attempt when no reset moment is known. */
const FIRST_FIRE_DELAY_MS = 15_000;

/** Try again this long after the computed window reset (clock slack). */
const FIRE_MARGIN_MS = 60_000;

/** Re-check an accepted resume this long later (a churned run shows stopped again). */
const VERIFY_AFTER_MS = 10 * 60_000;

/** Backoff base for repeated failed attempts with no known reset. */
const BACKOFF_BASE_MS = 5 * 60_000;

/** Attempts before giving up (push + chat notice; manual resume still works). */
const MAX_ATTEMPTS = 6;

/** Longer timers are chunked: fire re-checks and re-arms. */
const MAX_TIMER_MS = 6 * 60 * 60_000;

/** Overdue entries untouched longer than this are pruned (the journal window is 50). */
const ENTRY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** A scan only backfilleds stops this fresh; older ones stay a manual decision. */
const BACKFILL_MAX_AGE_MS = 24 * 60 * 60_000;

/** Session-busy rejections retry at this fixed short delay. */
const SESSION_BUSY_RETRY_MS = 5 * 60_000;

/** Permanently-failed resume rejections — drop the entry instead of retrying. */
const PERMANENT_REASONS = new Set([
  "not_resumable",
  "not_found",
  "superseded",
  "workflow_disabled",
  "capabilityUnsupported",
  "unknown_session",
  "compile_failed",
  "script_missing",
  "script_mismatch",
  "invalid_name",
]);

/** One pending auto-resume. `attempts` counts resume attempts that did not stick. */
export interface QuotaResumeEntry {
  runId: string;
  /** Parent backend session (the run's journal parentSessionId). */
  zcodeSid: string;
  /** Workspace the run belongs to — bridges re-arm only their own project's entries. */
  cwd: string;
  /** ACP alias when known at schedule time (re-resolved at fire time anyway). */
  acpSid?: string;
  name?: string;
  /** Epoch ms of the next fire. */
  resumeAt: number;
  /** Failed-attempt counter (drives the backoff ladder). */
  attempts: number;
  /** True while the previous resume attempt is inside its verify window. */
  awaitingVerify?: boolean;
  /**
   * Terminal give-up reason. The journal row stays `stopped(provider)+quota`
   * forever, so without this marker the scan would re-schedule the same run
   * every cycle — a retry/give-up loop. A gave-up entry is skipped by scans,
   * re-arms, and the idle-exit predicate; it expires via the TTL, by which
   * time the row is out of the backfill window anyway.
   */
  gaveUp?: string;
  /**
   * In-flight fire claim (cross-process single-flight). Written under the
   * settings file lock by {@link claimFire}; every normal mutation (updateEntry
   * / reschedule / markGaveUp) clears it. Without it, two bridges of the same
   * workspace (editor + serve/TUI) could both resume one run — a money-level
   * double execution.
   */
  firing?: { pid: number; at: number };
  scheduledAt: number;
  updatedAt: number;
}

const STORE_FILENAME = "acp-quota-resumes.json";

function storePath(): string {
  return path.join(zcodeHomeDir(), "v2", STORE_FILENAME);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read + validate the shared store; stale entries are dropped on read. */
function readTable(): Record<string, QuotaResumeEntry> {
  try {
    const p = storePath();
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    const table = asRecord(raw);
    if (!table) return {};
    const now = Date.now();
    const out: Record<string, QuotaResumeEntry> = {};
    for (const [runId, value] of Object.entries(table)) {
      const rec = asRecord(value);
      if (!rec) continue;
      const { zcodeSid, cwd, resumeAt, attempts, scheduledAt, updatedAt } = rec;
      if (
        typeof runId !== "string" ||
        typeof zcodeSid !== "string" ||
        typeof cwd !== "string" ||
        typeof resumeAt !== "number" ||
        typeof attempts !== "number" ||
        typeof scheduledAt !== "number" ||
        typeof updatedAt !== "number"
      ) {
        continue;
      }
      // Prune only OVERDUE-and-abandoned entries. A future-dated entry must
      // never age out mid-wait: a weekly window's reset can sit a full ~7
      // days out, and dropping the entry at the TTL boundary would silently
      // cancel the wait right before it fires.
      if (resumeAt <= now && now - updatedAt > ENTRY_MAX_AGE_MS) continue;
      const firing = asRecord(rec["firing"]);
      const firingValid =
        firing !== undefined &&
        typeof firing["pid"] === "number" &&
        Number.isSafeInteger(firing["pid"]) &&
        typeof firing["at"] === "number";
      out[runId] = {
        runId,
        zcodeSid,
        cwd,
        ...(typeof rec["acpSid"] === "string" ? { acpSid: rec["acpSid"] } : {}),
        ...(typeof rec["name"] === "string" ? { name: rec["name"] } : {}),
        resumeAt,
        attempts,
        ...(rec["awaitingVerify"] === true ? { awaitingVerify: true } : {}),
        ...(typeof rec["gaveUp"] === "string" && rec["gaveUp"] !== ""
          ? { gaveUp: rec["gaveUp"] }
          : {}),
        ...(firingValid
          ? { firing: { pid: firing["pid"] as number, at: firing["at"] as number } }
          : {}),
        scheduledAt,
        updatedAt,
      };
    }
    return out;
  } catch (e) {
    warn(
      `quota-resume: store read failed (${e instanceof Error ? e.message : String(e)}) — treating as empty`,
    );
    return {};
  }
}

/** Persist the whole table (temp+rename). False when the write did not stick. */
function writeTable(table: Record<string, QuotaResumeEntry>): boolean {
  try {
    const p = storePath();
    mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(table, null, 2));
    renameSync(tmp, p);
    return true;
  } catch (e) {
    warn(`quota-resume: store write failed (${e instanceof Error ? e.message : String(e)})`);
    return false;
  }
}

/** How long a store mutation waits for the cross-process file lock. */
const STORE_LOCK_MAX_WAIT_MS = 3000;

/**
 * Read-modify-write one entry under the store file lock (merge-at-write; null
 * removes). Returns the entry that was persisted, or undefined when the lock
 * or the write did not go through.
 *
 * The lock matters: an UNLOCKED whole-table write built from a stale snapshot
 * could erase a sibling bridge's live `firing` claim mid-fire — two bridges
 * would then both resume one run (a money-level double execution). Every
 * mutator therefore serializes on the same lock `claimFire` uses.
 */
async function updateEntry(
  runId: string,
  patch: Partial<QuotaResumeEntry> | null,
): Promise<QuotaResumeEntry | undefined> {
  let result: QuotaResumeEntry | undefined;
  try {
    await withFileLock(
      storePath(),
      async () => {
        const table = readTable();
        const existing = table[runId];
        let next: QuotaResumeEntry | undefined;
        if (patch === null) {
          if (!existing) return;
          delete table[runId];
        } else if (existing) {
          next = { ...existing, ...patch, updatedAt: Date.now() };
        } else if (patch.zcodeSid && patch.cwd && typeof patch.resumeAt === "number") {
          const now = Date.now();
          next = {
            runId,
            zcodeSid: patch.zcodeSid,
            cwd: patch.cwd,
            ...patch,
            resumeAt: patch.resumeAt,
            attempts: patch.attempts ?? 0,
            scheduledAt: patch.scheduledAt ?? now,
            updatedAt: now,
          };
        } else {
          return;
        }
        if (next) {
          // A normal mutation ENDS the fire claim: updateEntry is only reached
          // by a fire attempt of the local process (every outcome of fire()
          // records through here), and the scan's schedule merge — which must
          // NOT stomp a sibling's in-flight claim — has its own locked path.
          delete next.firing;
          table[runId] = next;
        }
        if (writeTable(table)) result = next;
      },
      { lockMaxWaitMs: STORE_LOCK_MAX_WAIT_MS },
    );
  } catch (e) {
    warn(`quota-resume: store update failed (${e instanceof Error ? e.message : String(e)})`);
  }
  return result;
}

// ---------- cross-process fire claim ----------

/** A fire claim older than this is considered abandoned (dead holder). */
const FIRE_CLAIM_STALE_MS = 30 * 60_000;

/** `process.kill(pid, 0)` liveness probe; EPERM means the process exists. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/**
 * Claim the right to fire one entry, cross-process. Under the ZCode settings
 * file lock (the same protocol the desktop app uses), re-read the entry and
 * install `firing:{pid}`; a real claim by a LIVE other process returns
 * undefined. A stale claim (dead pid, or older than the cap) is taken over.
 * Fail CLOSED: a claim whose write does not persist is not granted (the
 * single-flight guarantee must not hinge on a failed disk write). No explicit
 * release: every outcome of {@link fire} records through {@link updateEntry},
 * which clears the claim; a crashed holder is recovered by the stale-claim
 * takeover.
 */
async function claimFire(runId: string): Promise<QuotaResumeEntry | undefined> {
  let claimed: QuotaResumeEntry | undefined;
  try {
    await withFileLock(
      storePath(),
      async () => {
        const table = readTable();
        const entry = table[runId];
        if (!entry || entry.gaveUp) return;
        const firing = entry.firing;
        if (firing && firing.pid !== process.pid) {
          const stale = Date.now() - firing.at > FIRE_CLAIM_STALE_MS;
          if (!stale && isProcessAlive(firing.pid)) return;
        }
        const next: QuotaResumeEntry = {
          ...entry,
          firing: { pid: process.pid, at: Date.now() },
          updatedAt: Date.now(),
        };
        table[runId] = next;
        if (writeTable(table)) claimed = next;
      },
      { lockMaxWaitMs: STORE_LOCK_MAX_WAIT_MS },
    );
  } catch (e) {
    warn(`quota-resume: fire claim failed (${e instanceof Error ? e.message : String(e)})`);
  }
  return claimed;
}

// ---------- timers ----------

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const scanning = new WeakSet<object>();

function clearTimer(runId: string): void {
  const t = timers.get(runId);
  if (t) clearTimeout(t);
  timers.delete(runId);
}

/** Arm (or re-arm) the fire timer for one entry, chunking long waits. */
function setTimer(server: ZcodeAcpServer, entry: QuotaResumeEntry): void {
  clearTimer(entry.runId);
  const delay = Math.max(0, Math.min(entry.resumeAt - Date.now(), MAX_TIMER_MS));
  const t = setTimeout(() => {
    timers.delete(entry.runId);
    void fire(server, entry.runId).catch((e: unknown) => {
      warn(`quota-resume: fire failed (${e instanceof Error ? e.message : String(e)})`);
    });
  }, delay);
  t.unref?.();
  timers.set(entry.runId, t);
}

/** Re-arm a LOCAL timer without touching the shared store (claim lost etc.). */
function rearmLocally(server: ZcodeAcpServer, entry: QuotaResumeEntry, delayMs: number): void {
  setTimer(server, { ...entry, resumeAt: Date.now() + delayMs });
}

/** Reschedule an entry and persist it in one move. */
async function reschedule(
  server: ZcodeAcpServer,
  entry: QuotaResumeEntry,
  patch: Partial<QuotaResumeEntry>,
): Promise<void> {
  const next: QuotaResumeEntry = { ...entry, ...patch, updatedAt: Date.now() };
  const saved = await updateEntry(entry.runId, next);
  setTimer(server, saved ?? next);
}

/**
 * Retire an entry for good (see {@link QuotaResumeEntry.gaveUp}): keep the
 * record so the scan never re-schedules the same journal row, drop the timer.
 */
async function markGaveUp(entry: QuotaResumeEntry, reason: string): Promise<void> {
  clearTimer(entry.runId);
  await updateEntry(entry.runId, {
    ...entry,
    gaveUp: reason,
    awaitingVerify: false,
    updatedAt: Date.now(),
  });
  log(`quota-resume: run ${entry.runId.slice(-8)} gave up (${reason})`);
}

// ---------- scheduling / detection ----------

export interface QuotaResumeInput {
  runId: string;
  zcodeSid: string;
  cwd: string;
  name?: string;
  acpSid?: string;
  /** Provider-reported reset (Retry-After). Absent → the first fire re-derives. */
  resetAt?: number;
}

/**
 * Register (or merge) a pending auto-resume. Idempotent per runId; an earlier
 * resumeAt wins so a duplicate detection never delays an armed timer.
 *
 * The whole read-decide-write runs under the store file lock: the merge must
 * see the CURRENT record (a sibling's in-flight fire claim included — which it
 * must never stomp) rather than a snapshot read before the lock was taken.
 */
export async function scheduleQuotaResume(
  server: ZcodeAcpServer,
  input: QuotaResumeInput,
): Promise<void> {
  if (!quotaAutoResumeEnabled()) return;
  const now = Date.now();
  const resumeAt =
    input.resetAt !== undefined && input.resetAt > now
      ? input.resetAt + FIRE_MARGIN_MS
      : now + FIRST_FIRE_DELAY_MS;
  let armed: QuotaResumeEntry | undefined;
  try {
    await withFileLock(
      storePath(),
      async () => {
        const table = readTable();
        const existing = table[input.runId];
        if (existing && !existing.gaveUp) {
          const merged: QuotaResumeEntry = {
            ...existing,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.acpSid !== undefined ? { acpSid: input.acpSid } : {}),
            resumeAt: Math.min(existing.resumeAt, resumeAt),
            updatedAt: now,
          };
          table[input.runId] = merged;
          if (writeTable(table)) armed = merged;
          return;
        }
        if (existing?.gaveUp) {
          // Explicit re-schedule lifts a prior give-up (a fresh detection
          // pass): the record below replaces it wholesale, so the sticky
          // `gaveUp` marker cannot survive.
          log(`quota-resume: run ${input.runId.slice(-8)} re-scheduled after a previous give-up`);
        }
        const entry: QuotaResumeEntry = {
          runId: input.runId,
          zcodeSid: input.zcodeSid,
          cwd: input.cwd,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.acpSid !== undefined ? { acpSid: input.acpSid } : {}),
          resumeAt,
          attempts: 0,
          scheduledAt: now,
          updatedAt: now,
        };
        table[input.runId] = entry;
        if (writeTable(table)) armed = entry;
      },
      { lockMaxWaitMs: STORE_LOCK_MAX_WAIT_MS },
    );
  } catch (e) {
    warn(`quota-resume: schedule failed (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!armed) return;
  setTimer(server, armed);
  log(
    `quota-resume: scheduled run ${input.runId.slice(-8)} for ` +
      `${new Date(armed.resumeAt).toISOString()} (session ${input.zcodeSid.slice(-8)})`,
  );
}

/**
 * Failures the watchdog classifies as permanent (message patterns for
 * transport-wrapped rejections). `workflow_disabled` is EXEMPT when the
 * rejection is the fail-closed face of an UNRESOLVED gate fetch
 * (`gate mode=unknown …`): the remote verdict is fetched once per backend
 * generation and cached, so a transient network blip must back off and retry,
 * not retire a pending resume machine-wide. A real disabled verdict (the
 * server pulled the flag, or the local switch) stays permanent.
 */
function isPermanentWorkflowError(e: unknown): boolean {
  if (e instanceof WorkflowApiError) {
    if (e.reason === "workflow_disabled") return !e.message.includes("mode=unknown");
    if (PERMANENT_REASONS.has(e.reason)) return true;
  }
  const message = e instanceof Error ? e.message : "";
  return /sessionNotFound|Session not found|Session ID 不存在|not_resumable|superseded/.test(
    message,
  );
}

/** Await a gate promise without ever hanging a scan (it may never settle). */
async function gateVerdict(server: ZcodeAcpServer): Promise<{ enabled: boolean } | null> {
  const promise = server.backendWorkflowGate;
  if (!promise) return null;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1500);
    t.unref?.();
    void promise.then(
      (g) => {
        clearTimeout(t);
        resolve(g);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

/**
 * One scan over the project's journal for quota-stopped runs. Best-effort and
 * side-effect free when nothing matches; never spawns a backend (the scan is
 * discovery — only a fire may act).
 */
export async function scanQuotaStoppedRuns(server: ZcodeAcpServer): Promise<void> {
  if (!quotaAutoResumeEnabled()) return;
  const backend = server.backend;
  if (!backend || backend.isDead) return;
  const gate = await gateVerdict(server);
  if (gate && !gate.enabled) return;

  const cwd = server.projectCwd();
  const resp = await backend.request(
    server.nextId(),
    "workflows/runs",
    { workspace: { workspacePath: cwd, workspaceKey: cwd }, limit: 50 },
    8000,
  );
  if (resp.error) return;
  const runs = (asRecord(resp.result)?.["runs"] ?? []) as unknown;
  if (!Array.isArray(runs)) return;

  const now = Date.now();
  const dismissed = dismissedRunIds();
  const table = readTable();
  const candidates = runs
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => {
      if (!row) return false;
      if (row["status"] !== "stopped" || row["stopReason"] !== "provider") return false;
      const runId = row["runId"];
      const parent = row["parentSessionId"];
      if (typeof runId !== "string" || !runId) return false;
      if (typeof parent !== "string" || !parent) return false;
      if (dismissed.has(runId) || table[runId]) return false;
      const updated = row["updatedAt"];
      if (typeof updated === "number" && now - updated > BACKFILL_MAX_AGE_MS) return false;
      return true;
    });
  if (candidates.length === 0) return;

  const bySession = new Map<string, Record<string, unknown>[]>();
  for (const row of candidates) {
    const sid = row["parentSessionId"] as string;
    const list = bySession.get(sid) ?? [];
    list.push(row);
    bySession.set(sid, list);
  }

  for (const [sid, rows] of bySession) {
    const result = await backend.request(
      server.nextId(),
      "v4/conversation/workflowRuns",
      { sessionId: sid, limit: 64 },
      8000,
    );
    if (result.error) continue;
    const summaries = (asRecord(result.result)?.["runs"] ?? []) as unknown;
    if (!Array.isArray(summaries)) continue;
    for (const row of rows) {
      const runId = row["runId"] as string;
      // Re-read the store: another bridge may have scheduled this run already.
      if (readTable()[runId]) continue;
      const summary = summaries.map((s) => asRecord(s)).find((s) => s && s["runId"] === runId);
      if (!summary) continue;
      if (summary["status"] !== "stopped" || summary["resumable"] !== true) continue;
      if (!isQuotaStopFailureMessage(summary["failureMessage"])) continue;
      const name =
        typeof row["name"] === "string" && row["name"]
          ? row["name"]
          : typeof summary["label"] === "string"
            ? summary["label"]
            : undefined;
      await scheduleQuotaResume(server, {
        runId,
        zcodeSid: sid,
        cwd,
        ...(name !== undefined ? { name } : {}),
      });
    }
  }
}

export interface QuotaResumeDeps {
  /** Injectable for tests; defaults to the real quota card. */
  queryQuota?: () => Promise<QuotaResult>;
}

/**
 * Fire one pending entry. Everything is re-checked here because the state may
 * have moved since scheduling (user resumed/stopped/dismissed the run, quota
 * already recovered, bridge slept past the reset).
 *
 * Cross-process single-flight: the side-effecting tail runs only under a
 * locked fire claim (see {@link claimFire}); a sibling bridge that loses the
 * claim re-arms its local timer and lets the winner's store write (reschedule
 * / retire) become the truth.
 */
export async function fire(
  server: ZcodeAcpServer,
  runId: string,
  deps: QuotaResumeDeps = {},
): Promise<void> {
  const entry = readTable()[runId];
  if (!entry) return;
  if (entry.gaveUp) {
    // Defensive: a retired entry must never fire again.
    clearTimer(runId);
    return;
  }
  if (!quotaAutoResumeEnabled()) {
    await updateEntry(runId, null);
    return;
  }
  if (Date.now() < entry.resumeAt) {
    // Long-wait chunk boundary — re-arm for the remainder.
    setTimer(server, entry);
    return;
  }
  if (dismissedRunIds().has(runId)) {
    await updateEntry(runId, null);
    return;
  }

  // Single-flight across bridges: no side-effecting step below runs without
  // the claim. A lost claim means a sibling is mid-fire; re-arm LOCALLY only
  // (writing the shared entry here would stomp the sibling's claim) and
  // re-read its outcome on the next pass.
  const claimed = await claimFire(runId);
  if (!claimed) {
    rearmLocally(server, entry, SESSION_BUSY_RETRY_MS);
    return;
  }

  // A known future reset defers without burning an attempt (structured reset
  // from the provider is preferred over the card — checked by the caller).
  const query = deps.queryQuota ?? queryQuota;
  const quota = await query().catch((): QuotaResult => ({ kind: "unavailable" }));
  const resetAt = quotaResetAtFromResult(quota);
  if (resetAt !== undefined) {
    await reschedule(server, claimed, {
      resumeAt: resetAt + FIRE_MARGIN_MS,
      awaitingVerify: false,
    });
    return;
  }

  const acpSid =
    server.resolveAcpSid(claimed.zcodeSid) ??
    loadAliasesByZcodeSid().get(claimed.zcodeSid) ??
    claimed.acpSid;
  if (!acpSid) {
    warn(
      `quota-resume: no ACP alias for session ${claimed.zcodeSid.slice(-8)} — ` +
        `cannot resume run ${runId.slice(-8)}`,
    );
    await markGaveUp(claimed, "no ACP alias for the parent session");
    return;
  }
  // Live state check: a run that is running again, finished, or no longer
  // resumable drops the entry (someone else acted, or the history is done).
  let row: Record<string, unknown> | undefined;
  try {
    const state = await conversationRuns(server, claimed.zcodeSid, 64);
    const rows = (asRecord(state)?.["runs"] ?? []) as unknown;
    row = Array.isArray(rows)
      ? (rows.map((r) => asRecord(r)).find((r) => r && r["runId"] === runId) as
          Record<string, unknown> | undefined)
      : undefined;
  } catch (e) {
    if (isPermanentWorkflowError(e)) {
      log(`quota-resume: run ${runId.slice(-8)} dropped (${e instanceof Error ? e.message : e})`);
      await markGaveUp(claimed, "parent session unresolvable");
      return;
    }
    await retryLater(server, claimed, e instanceof Error ? e.message : String(e));
    return;
  }
  if (!row) {
    await updateEntry(runId, null);
    return;
  }
  if (row["status"] === "running" || row["status"] === "pending") {
    await updateEntry(runId, null);
    return;
  }
  if (row["status"] !== "stopped" || row["resumable"] !== true) {
    await updateEntry(runId, null);
    return;
  }

  if (claimed.awaitingVerify) {
    // The previous attempt was accepted but the run is stopped again while the
    // quota card shows no future reset: count it as a failed attempt.
    await retryLater(server, claimed, "resumed run stopped again");
    return;
  }

  try {
    await resumeWorkflowRun(server, {
      runId,
      acpSessionId: acpSid,
      ...(claimed.name !== undefined ? { name: claimed.name } : {}),
    });
  } catch (e) {
    if (isPermanentWorkflowError(e)) {
      log(`quota-resume: run ${runId.slice(-8)} rejected permanently — retiring`);
      await markGaveUp(claimed, e instanceof Error ? e.message : "permanent rejection");
      return;
    }
    if (e instanceof WorkflowApiError && e.reason === "session_busy") {
      await reschedule(server, claimed, { resumeAt: Date.now() + SESSION_BUSY_RETRY_MS });
      return;
    }
    if (e instanceof WorkflowApiError && e.reason === "already_running") {
      // Another actor (a user click, a sibling bridge outside our store)
      // resumed it first — the watchdog's job is done.
      log(`quota-resume: run ${runId.slice(-8)} is already running — dropping`);
      await updateEntry(runId, null);
      return;
    }
    await retryLater(server, claimed, e instanceof Error ? e.message : String(e));
    return;
  }

  // Accepted: verify later that it actually sticks; announce once (first attempt).
  await reschedule(server, claimed, {
    resumeAt: Date.now() + VERIFY_AFTER_MS,
    awaitingVerify: true,
  });
  if (claimed.attempts === 0) announceResumed(server, claimed, acpSid);
  log(
    `quota-resume: run ${runId.slice(-8)} resumed (attempt ${claimed.attempts + 1}); ` +
      `verifying in ${Math.round(VERIFY_AFTER_MS / 60000)}min`,
  );
}

/** Backoff a failed attempt; give up (and say so) past the cap. */
async function retryLater(
  server: ZcodeAcpServer,
  entry: QuotaResumeEntry,
  reason: string,
): Promise<void> {
  const attempts = entry.attempts + 1;
  if (attempts > MAX_ATTEMPTS) {
    warn(
      `quota-resume: run ${entry.runId.slice(-8)} gave up after ${MAX_ATTEMPTS} attempts (${reason})`,
    );
    const acpSid =
      server.resolveAcpSid(entry.zcodeSid) ?? loadAliasesByZcodeSid().get(entry.zcodeSid);
    if (acpSid) announceGaveUp(server, entry, acpSid);
    await markGaveUp(entry, `${MAX_ATTEMPTS} failed attempts: ${reason}`);
    return;
  }
  const delay = quotaBackoffMs(attempts, BACKOFF_BASE_MS);
  await reschedule(server, entry, {
    resumeAt: Date.now() + delay,
    attempts,
    awaitingVerify: false,
  });
  log(
    `quota-resume: run ${entry.runId.slice(-8)} attempt ${attempts} failed (${reason}); ` +
      `retrying in ${Math.round(delay / 60000)}min`,
  );
}

function resumeLabel(entry: QuotaResumeEntry): string {
  return entry.name ?? `run ${entry.runId.slice(0, 8)}`;
}

function announceResumed(server: ZcodeAcpServer, entry: QuotaResumeEntry, acpSid: string): void {
  void sendTextChunk(
    server.clients.broadcast(),
    acpSid,
    messages().workflowQuotaResumed(resumeLabel(entry)),
    randomUUID(),
  ).catch(() => undefined);
  pushSettled(server, {
    kind: "run",
    label: pushSourceLabel(server, acpSid),
    title: `workflow ${resumeLabel(entry)} auto-resumed after quota reset`,
  });
}

function announceGaveUp(server: ZcodeAcpServer, entry: QuotaResumeEntry, acpSid: string): void {
  void sendTextChunk(
    server.clients.broadcast(),
    acpSid,
    messages().workflowQuotaResumeGaveUp(resumeLabel(entry)),
    randomUUID(),
  ).catch(() => undefined);
  pushSettled(server, {
    kind: "run",
    label: pushSourceLabel(server, acpSid),
    title: `workflow ${resumeLabel(entry)} auto-resume gave up — resume manually`,
  });
}

// ---------- watchdog lifecycle ----------

const armedServers = new WeakSet<object>();

/**
 * Arm the watchdog for one bridge: re-arm its project's persisted entries and
 * start the periodic scan. Idempotent per server. Scans never spawn a backend
 * and never throw; a bridge that never sees a backend stays silent.
 */
export function armQuotaResumeWatchdog(server: ZcodeAcpServer): void {
  if (armedServers.has(server)) return;
  armedServers.add(server);
  if (quotaAutoResumeEnabled()) {
    const cwd = server.projectCwd();
    for (const entry of Object.values(readTable())) {
      if (entry.cwd !== cwd || entry.gaveUp) continue;
      setTimer(server, entry);
      log(
        `quota-resume: re-armed run ${entry.runId.slice(-8)} for ` +
          `${new Date(entry.resumeAt).toISOString()}`,
      );
    }
  }
  const scan = (): void => {
    if (scanning.has(server)) return;
    scanning.add(server);
    void scanQuotaStoppedRuns(server)
      .catch((e: unknown) => {
        warn(`quota-resume: scan failed (${e instanceof Error ? e.message : String(e)})`);
      })
      .finally(() => scanning.delete(server));
  };
  const interval = setInterval(scan, QUOTA_RESUME_SCAN_INTERVAL_MS);
  interval.unref?.();
  const first = setTimeout(scan, FIRST_SCAN_DELAY_MS);
  first.unref?.();
}

/** Is a resume armed for this run? (test/observability hook) */
export function quotaResumePending(runId: string): boolean {
  const entry = readTable()[runId];
  if (entry?.gaveUp) return false;
  return timers.has(runId) || entry !== undefined;
}

/**
 * Is any resume pending for a workspace? The headless serve bridge consults
 * this in its idle decision: exiting would kill the backend the pending
 * resume must act on, breaking "the bridge owns the wait" exactly when the
 * app is asleep (the case the watchdog exists for). Retired (gave-up) entries
 * do not hold a serve bridge alive.
 */
export function hasQuotaResumePendingForCwd(cwd: string): boolean {
  for (const entry of Object.values(readTable())) {
    if (entry.cwd === cwd && !entry.gaveUp) return true;
  }
  return false;
}

/** Read one entry (test hook). */
export function quotaResumeEntryForTest(runId: string): QuotaResumeEntry | undefined {
  return readTable()[runId];
}

/** Patch an entry and drop its timer (test hook; patches may include `firing`). */
export function updateQuotaResumeEntryForTest(
  runId: string,
  patch: Partial<QuotaResumeEntry>,
): void {
  const table = readTable();
  const entry = table[runId];
  if (!entry) return;
  // `updatedAt: Date.now()` is the default, but a patch may pin it (TTL tests).
  table[runId] = { ...entry, updatedAt: Date.now(), ...patch };
  writeTable(table);
  clearTimer(runId);
}

/** Drop every timer and the store file (test hook). */
export function resetQuotaResumeForTest(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  try {
    unlinkSync(storePath());
  } catch {
    /* absent — fine */
  }
}
