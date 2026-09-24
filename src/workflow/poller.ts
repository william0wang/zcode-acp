/**
 * Dynamic-workflow run progress poller.
 *
 * The backend strips per-actor/per-node workflow progress from the v3 stream
 * (session-mapper filters `dynamic_workflow_run_progress`; the authoritative
 * projection lives behind the v4 conversation API), so an ACP client would see
 * the CreateWorkflow card sit silent for the whole run. This module re-attaches
 * progress by polling the v4 journal query and folding concise progress lines
 * into the card as `tool_call_update` notifications.
 *
 *   v4/conversation/workflowRunEvents {sessionId, runId, afterSequence, limit}
 *     → {events: [{sequence, type, payload, truncated?}], hasMore}
 *
 * The cursor is the journal sequence (never invalidated), so the poll is
 * stateless and safe to re-issue. Runs are armed by the background-task
 * listener (taskKind "workflow", taskId ≡ runId) — the SINGLE arm point,
 * covering model-launched runs (visible CreateWorkflow card) and
 * settings-launched ones (synthetic tool call, no live card — the fallback
 * [background] card is the fold target). Emissions are append DELTAS (only
 * the lines added since the previous emission) fanned out per-alias via
 * `server.notifyByZcodeSid`, covering both turn-internal and turn-external
 * runs.
 *
 * Everything here is best-effort: request() resolves `{error}` instead of
 * throwing, and every failure path only logs — never into the event loop.
 */

import type * as acp from "@agentclientprotocol/sdk";

import type { ZcodeAcpServer } from "../server.js";
import { log } from "../utils.js";

/** Poll cadence (setTimeout chain, timers unref'd). Injectable for tests. */
export const WORKFLOW_POLL_INTERVAL_MS = 3000;

/** Hard cap: no run polls longer than this, whatever the backend says. */
const WORKFLOW_POLL_HARD_TIMEOUT_MS = 10 * 60_000;

/** Consecutive poll failures tolerated before the poller gives up. */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Page size per workflowRunEvents request (upstream cap 500). */
const EVENTS_PAGE_LIMIT = 100;

/** Pages drained back-to-back per tick while `hasMore` (runaway guard). */
const MAX_PAGES_PER_TICK = 50;

/** Cap on accumulated progress lines (keep first/last, drop the middle). */
const MAX_LINES = 200;

/** One v4 journal event (transport.ts:599-646). */
interface WorkflowRunEvent {
  sequence: number;
  type: string;
  payload?: Record<string, unknown>;
  truncated?: boolean;
}

interface ActiveRun {
  server: ZcodeAcpServer;
  zcodeSid: string;
  runId: string;
  /** ACP tool_call_id of the CreateWorkflow card the lines attach to. */
  toolCallId: string;
  /** Journal cursor: last event sequence already folded (starts 0). */
  afterSequence: number;
  /** Capped history, first/last halves kept — trim accounting only. */
  lines: string[];
  /**
   * Lines not yet emitted (the next delta). ACP tool_call_update content is
   * APPEND semantics on this repo's streaming paths (dispatch.ts's
   * terminal_output, background-task tails, agent chunks), so each emission
   * sends ONLY the lines added since the previous one.
   */
  pending: string[];
  startedAt: number;
  intervalMs: number;
  consecutiveErrors: number;
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set while a poll is in flight so the timer never overlaps requests. */
  polling: boolean;
}

/** Active runs keyed by runId (taskId ≡ runId upstream — one key per run). */
const activeRuns = new Map<string, ActiveRun>();

/**
 * Reduce one journal event to a concise progress line, or null when the event
 * is chatty (log/report/usage updates) and must not reach the card. Payload
 * fields are read defensively — engine payload shapes are not part of the v4
 * wire contract we consume, and raw ids (actorSessionId) are never printed.
 */
export function workflowEventLine(ev: WorkflowRunEvent): string | null {
  const p = ev.payload ?? {};
  const str = (k: string): string | undefined =>
    typeof p[k] === "string" ? (p[k] as string) : undefined;
  const num = (k: string): number | undefined =>
    typeof p[k] === "number" ? (p[k] as number) : undefined;
  switch (ev.type) {
    case "actor-created": {
      const name = str("name") ?? str("actorName");
      const ordinal = num("ordinal");
      const site = str("siteId") ?? str("actorSiteId");
      const label = name ?? site;
      const tag = ordinal !== undefined ? `#${ordinal}` : (site ?? "");
      return label ? `+ actor ${tag} ${label}` : `+ actor ${tag}`.trim();
    }
    case "phase-entered": {
      const phase = str("phaseName") ?? str("name");
      return phase ? `> phase ${phase}` : "> phase";
    }
    case "run-settled": {
      const status = str("status") ?? "unknown";
      return `= run settled: ${status}`;
    }
    default: {
      // Node lifecycle: only the SETTLED events carry an outcome worth a line.
      if (!ev.type.startsWith("node-")) return null;
      const outcome = str("outcome");
      if (outcome !== "ok" && outcome !== "failed" && outcome !== "cancelled") return null;
      const ordinal = num("ordinal");
      const site = str("siteId");
      const label = [site, ordinal !== undefined ? `#${ordinal}` : null]
        .filter((x) => x !== null && x !== undefined && x !== "")
        .join("/");
      const icon = outcome === "ok" ? "✓" : outcome === "failed" ? "✗" : "–";
      return label ? `${icon} node ${label} ${outcome}` : `${icon} node ${outcome}`;
    }
  }
}

/**
 * Append a line under the cap: keep first/last halves with an ellipsis mark.
 * The capped `lines` buffer is trim accounting only — emission sends the
 * `pending` delta, so a trim that drops still-unemitted lines marks the gap
 * with a one-time `…` line in that tick's delta.
 */
function pushLine(run: ActiveRun, line: string): void {
  run.lines.push(line);
  run.pending.push(line);
  if (run.lines.length > MAX_LINES) {
    const half = Math.floor(MAX_LINES / 2);
    run.lines = [...run.lines.slice(0, half), "…", ...run.lines.slice(-(half - 1))];
    run.pending.push("…");
  }
}

/**
 * Emit the lines added since the previous emission (plus an optional one-off
 * notice line) onto the CreateWorkflow card — append semantics, per-alias
 * fan-out. A tick with nothing new emits nothing.
 */
async function emitCardUpdate(run: ActiveRun, notice?: string): Promise<void> {
  const delta = [...run.pending, ...(notice ? [notice] : [])];
  run.pending = [];
  if (delta.length === 0) return;
  const update: acp.SessionUpdate = {
    sessionUpdate: "tool_call_update",
    toolCallId: run.toolCallId,
    content: [{ type: "content", content: { type: "text", text: delta.join("\n") } }],
    _meta: { workflowRun: { runId: run.runId, sequence: run.afterSequence } },
  };
  await run.server.notifyByZcodeSid(run.zcodeSid, update);
}

/** Tear the run down: clear the timer and forget it. Idempotent. */
function teardown(run: ActiveRun): void {
  if (run.timer) clearTimeout(run.timer);
  run.timer = null;
  run.stopped = true;
  if (activeRuns.get(run.runId) === run) activeRuns.delete(run.runId);
}

function scheduleNext(run: ActiveRun): void {
  if (run.stopped) return;
  const t = setTimeout(() => void pollTick(run), run.intervalMs);
  t.unref?.();
  run.timer = t;
}

/**
 * One poll tick: fetch journal pages (draining `hasMore` back-to-back), fold
 * new lines, emit when something meaningful appeared, schedule the next tick.
 */
async function pollTick(run: ActiveRun): Promise<void> {
  run.timer = null;
  if (run.stopped || run.polling) return;
  run.polling = true;
  let emitted = false;
  try {
    if (Date.now() - run.startedAt > WORKFLOW_POLL_HARD_TIMEOUT_MS) {
      log(`workflow poller: run ${run.runId.slice(-8)} hit the 10min hard cap — stopping`);
      await emitCardUpdate(run, "[progress polling stopped: timeout]");
      teardown(run);
      return;
    }
    const backend = run.server.backend;
    if (!backend || backend.isDead) {
      // Backend gone (respawn/shutdown): counts as an error; consecutive
      // failures stop the poller naturally. Never ensureBackend() from here —
      // a poller must not spawn backends as a side effect.
      await handleError(run, { message: "backend unavailable" });
      return;
    }
    for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
      const resp = await backend.request(
        run.server.nextId(),
        "v4/conversation/workflowRunEvents",
        {
          sessionId: run.zcodeSid,
          runId: run.runId,
          afterSequence: run.afterSequence,
          limit: EVENTS_PAGE_LIMIT,
        },
        8000,
      );
      if (resp.error) {
        await handleError(run, resp.error);
        return;
      }
      const result = resp.result as
        { events?: WorkflowRunEvent[]; hasMore?: boolean } | null | undefined;
      const events = Array.isArray(result?.events) ? result!.events! : [];
      for (const ev of events) {
        if (typeof ev?.sequence === "number" && ev.sequence > run.afterSequence) {
          run.afterSequence = ev.sequence;
        }
        const line = workflowEventLine(ev);
        if (line) {
          pushLine(run, line);
          emitted = true;
        }
        if (ev.type === "run-settled") {
          await emitCardUpdate(run);
          log(`workflow poller: run ${run.runId.slice(-8)} settled — stopping`);
          teardown(run);
          return;
        }
      }
      if (!result?.hasMore) break;
    }
    run.consecutiveErrors = 0;
    if (emitted) await emitCardUpdate(run);
  } catch (e) {
    // request() never throws; anything here is our own bug — count it as an
    // error tick so the consecutive-failure stop still applies.
    await handleError(run, {
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    run.polling = false;
    // Stop paths tore the run down (stopped=true); transient errors keep
    // polling. Scheduling from the finally so early `return`s never strand
    // the chain.
    scheduleNext(run);
  }
}

/** Classify an error response: -32601 stops silently, everything else counts. */
async function handleError(
  run: ActiveRun,
  error: { code?: number | string; message?: string },
): Promise<void> {
  if (error.code === -32601) {
    // Backend build without the v4 family — log once, stop without a notice
    // (the run itself is unaffected; only the progress folding is unavailable).
    log(
      `workflow poller: backend has no v4/conversation/workflowRunEvents — ` +
        `stopping run ${run.runId.slice(-8)}`,
    );
    teardown(run);
    return;
  }
  run.consecutiveErrors += 1;
  if (run.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    log(
      `workflow poller: ${run.consecutiveErrors} consecutive failures — ` +
        `stopping run ${run.runId.slice(-8)}`,
    );
    await emitCardUpdate(run, "[progress polling stopped: repeated errors]");
    teardown(run);
    return;
  }
  // Transient (timeout / dead pipe / backend respawn window) — retry next tick.
}

/**
 * Arm the progress poller for a workflow run. Single-flight per runId: a
 * re-arm (task status updates repeat the launch payload) is a no-op. The
 * first poll fires after one interval.
 */
export function armWorkflowRunPoller(
  server: ZcodeAcpServer,
  zcodeSid: string,
  opts: { runId: string; toolCallId: string; intervalMs?: number },
): void {
  const { runId, toolCallId } = opts;
  if (!runId || !toolCallId) return;
  if (activeRuns.has(runId)) return;
  const run: ActiveRun = {
    server,
    zcodeSid,
    runId,
    toolCallId,
    afterSequence: 0,
    lines: [],
    pending: [],
    startedAt: Date.now(),
    intervalMs: opts.intervalMs ?? WORKFLOW_POLL_INTERVAL_MS,
    consecutiveErrors: 0,
    stopped: false,
    timer: null,
    polling: false,
  };
  activeRuns.set(runId, run);
  log(`workflow poller: armed for run ${runId.slice(-8)} on card ${toolCallId.slice(-12)}`);
  scheduleNext(run);
}

/** Stop the poller for one run (background task reached a terminal status). */
export function stopWorkflowRunPoller(runId: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  teardown(run);
  log(`workflow poller: stopped run ${runId.slice(-8)}`);
}

/** Stop every poller (bridge shutdown — mirrors background-task shutdown records). */
export function stopAllWorkflowRunPollers(): void {
  for (const run of [...activeRuns.values()]) teardown(run);
}

/**
 * Stop every poller armed under one backend session (the session/close
 * cleanup path). Best-effort, never throws — a closed session's journal
 * answers can outlive the runtime, and polling it would only end at the hard
 * cap with a stray timeout notice for a conversation nobody can see anymore.
 */
export function stopPollersForSession(zcodeSid: string): void {
  for (const run of [...activeRuns.values()]) {
    if (run.zcodeSid === zcodeSid) teardown(run);
  }
}

/** Test/observability hook: is a poller currently armed for this runId? */
export function workflowPollerActive(runId: string): boolean {
  return activeRuns.has(runId);
}
