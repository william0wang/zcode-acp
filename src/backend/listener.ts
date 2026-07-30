/**
 * Event-stream listener and turn monitor.
 *
 * `EventStreamListener` subscribes to ZCode's `session/subscribe` event push
 * (deliveryKind `desktop-continuous`) and queues `session/event` notifications
 * for the turn loop to consume. It tracks a `lastSeq` watermark and can
 * resubscribe from it to recover missed events after a stall.
 *
 * `TurnMonitor` is the legacy snapshot path: a one-shot `session/read` that
 * returns the authoritative projection. Used for stall reconciliation and
 * lock-release probing.
 */

import type { ZcodeBackend } from "./client.js";
import type {
  ZcodeEvent,
  ZcodeProjection,
  ZcodeResponse,
  ZcodeSnapshot,
  ZcodeSubscribeResult,
} from "./types.js";
import { log, warn } from "../utils.js";

/** ID generator function (the server's `_next_id`). */
export type NextId = () => number;

/** A pending pollEvent consumer. `done` is set once the promise has settled
 *  (event delivered or timeout fired) so a late event skips it. */
interface Waiter {
  done: boolean;
  resolve: (ev: ZcodeEvent | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EventStreamListener {
  private readonly backend: ZcodeBackend;
  readonly sid: string;
  /** High-watermark of consumed event sequence numbers. */
  lastSeq = 0;
  subscribed = false;
  private readonly queue: ZcodeEvent[] = [];
  private readonly waiters: Waiter[] = [];

  constructor(backend: ZcodeBackend, zcodeSid: string) {
    this.backend = backend;
    this.sid = zcodeSid;
  }

  /**
   * Subscribe and capture the initial snapshot + eventSeq watermark.
   *
   * Returns the snapshot (with projection/messages). Throws on failure,
   * surfacing the backend's real error message (reader dead, timeout, pipe
   * broken, method not found on old CLI, or a session-level business error) so
   * the caller can distinguish root causes instead of seeing a single
   * misleading "version too old" string.
   */
  async subscribe(nextId: NextId): Promise<ZcodeSnapshot> {
    // Retry transient timeouts as a lightweight safety net for cold-start /
    // network blips. The cancel-preempt path no longer needs subscribe retries
    // to absorb a backend stop-finalization window: the turn loop now blocks
    // until the backend emits turn.completed/turn.failed before its prompt()
    // exits, so by the time the next prompt reaches subscribe the backend is
    // already idle. These retries are just a last-resort cushion.
    //
    // Only `timeout` is retried — non-transient errors (reader dead, pipe
    // broken, method-not-found, session-level business error) fail fast.
    // Each attempt uses a fresh id from `nextId()` (monotonic, never reused), so
    // a late response to an earlier timed-out request is safely discarded by
    // `resolvePending` (no pending entry → dropped).
    //
    // includeSnapshot is FALSE here on purpose. The caller (prompt()) discards
    // the returned snapshot anyway (`void snapshot`) — the projection baseline
    // comes from a separate fetchMessages() call. Asking the backend for a
    // snapshot here only makes it compute a full session snapshot (which grows
    // O(messages) and can take seconds-to-tens-of-seconds on long sessions:
    // observed 3.8s at 267 messages, 38s at 3500 messages) and is the primary
    // cause of subscribe timeouts. The eventSeq watermark is all we need.
    const MAX_ATTEMPTS = 2;
    const backoffMs = (attempt: number): number => 500 * attempt; // 0.5s
    let resp: ZcodeResponse;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      resp = await this.backend.request(
        nextId(),
        "session/subscribe",
        {
          sessionId: this.sid,
          deliveryKind: "desktop-continuous",
          includeSnapshot: false,
          afterSeq: 0,
        },
        5000,
      );
      if (!resp.error) break; // success
      const isTimeout = resp.error.message === "timeout";
      if (!isTimeout || attempt === MAX_ATTEMPTS) {
        if (isTimeout) {
          warn(`subscribe: all ${MAX_ATTEMPTS} attempts timed out (backend unresponsive for ~${Math.round((MAX_ATTEMPTS * 5000 + 500) / 1000)}s)`);
        }
        throw new Error(formatSubscribeError(resp));
      }
      log(
        `subscribe attempt ${attempt}/${MAX_ATTEMPTS} timed out, retrying in ${backoffMs(attempt)}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
    }
    const result = (resp!.result ?? {}) as ZcodeSubscribeResult;
    this.lastSeq = result.eventSeq ?? 0;
    this.subscribed = true;
    return result.snapshot ?? { projection: undefined, messages: [] };
  }

  /** Called by the backend reader when a `session/event` arrives. */
  handleEvent(event: ZcodeEvent): void {
    if (event.seq > this.lastSeq) this.lastSeq = event.seq;
    // Drop waiters that already timed out (their promise settled with null) so
    // a late event never lands on a dead promise — that would silently drop it.
    let waiter = this.waiters.shift();
    while (waiter && waiter.done) waiter = this.waiters.shift();
    if (waiter) {
      waiter.done = true;
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    } else {
      this.queue.push(event);
    }
  }

  /**
   * Wait for the next event, resolving once one arrives or `timeoutMs` elapses
   * (resolves null on timeout). Events arriving with no active waiter are
   * queued. A timed-out waiter is marked `done` so a later event skips it
   * instead of being silently dropped on a settled promise.
   */
  pollEvent(timeoutMs = 500): Promise<ZcodeEvent | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        done: false,
        resolve,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      waiter.timer = setTimeout(() => {
        if (waiter.done) return;
        waiter.done = true;
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /**
   * Stall recovery: resubscribe from `lastSeq` so the server replays missed
   * events. Failure is logged but non-fatal — the caller degrades to polling.
   * The snapshot (if returned despite `includeSnapshot:false`) is intentionally
   * not consumed; resubscribe only refreshes the watermark + resumes the push.
   */
  async resubscribe(nextId: NextId): Promise<boolean> {
    const resp = await this.backend.request(
      nextId(),
      "session/subscribe",
      {
        sessionId: this.sid,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
        afterSeq: this.lastSeq,
      },
      10000,
    );
    if (resp.error) {
      log(
        `resubscribe failed (non-fatal, stall recovery degrades to polling): ${formatSubscribeError(resp)}`,
      );
      return false;
    }
    const result = (resp.result ?? {}) as ZcodeSubscribeResult;
    if ((result.eventSeq ?? this.lastSeq) > this.lastSeq) {
      this.lastSeq = result.eventSeq ?? this.lastSeq;
    }
    return true;
  }
}

/**
 * Legacy snapshot path: a single `session/read` returning the authoritative
 * projection. Used in stall reconciliation and lock-release probing.
 */
export class TurnMonitor {
  private readonly backend: ZcodeBackend;
  private readonly zcodeSid: string;
  private readonly nextId: NextId;

  constructor(backend: ZcodeBackend, zcodeSid: string, nextId: NextId) {
    this.backend = backend;
    this.zcodeSid = zcodeSid;
    this.nextId = nextId;
  }

  /** Returns the projection snapshot, or null on error. */
  async pollOnce(): Promise<ZcodeProjection | null> {
    const resp = await this.backend.request(
      this.nextId(),
      "session/read",
      { sessionId: this.zcodeSid },
      5000,
    );
    if (resp.error) return null;
    const result = (resp.result ?? {}) as { projection?: ZcodeProjection };
    return result.projection ?? null;
  }
}

/**
 * Format a `session/subscribe` failure into a readable message that carries
 * the backend's real error so the caller can distinguish root causes (reader
 * dead, timeout, pipe broken, method-not-found on old CLI, session-level
 * business error) instead of a single generic string.
 */
function formatSubscribeError(resp: ZcodeResponse): string {
  const err = resp.error ?? { message: "unknown error" };
  const code = err.code !== undefined && err.code !== null ? ` (code ${err.code})` : "";
  return `session/subscribe failed: ${err.message ?? "unknown error"}${code}`;
}
