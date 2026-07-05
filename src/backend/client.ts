/**
 * ZCode subprocess client: spawn, read-loop multiplexer, async request/response.
 *
 * The ZCode app-server is launched as a subprocess (`zcode app-server --stdio`)
 * speaking line-delimited JSON over stdio. A single async read loop demultiplexes
 * inbound messages into three channels:
 *   - responses (id, no method) → resolve the matching pending request promise
 *   - server→client requests (id + method, id not pending) → server-request queue
 *   - notifications (no id):
 *       - `session/event` → routed to the registered session listener
 *       - anything else   → general notification queue
 *
 * Process-group isolation: the subprocess is its own process-group leader
 * (`detached: true`) so `close()` can kill the whole tree (zcode + its model
 * workers) with `process.kill(-pid)` and leave no orphans.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";

import { log } from "../utils.js";
import type {
  ZcodeEvent,
  ZcodeInbound,
  ZcodeInteractionPermissionParams,
  ZcodeInteractionUserInputParams,
  ZcodeResponse,
} from "./types.js";

/** Pending request resolver. Stored under the request id. */
interface PendingRequest {
  resolve: (resp: ZcodeResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A server→client request that we must reply to. */
export interface ServerRequest {
  id: number;
  method: string;
  params:
    ZcodeInteractionPermissionParams | ZcodeInteractionUserInputParams | Record<string, unknown>;
}

/** Listener for `session/event` pushes on a given session. */
export interface EventListener {
  handleEvent(event: ZcodeEvent): void;
}

export class ZcodeBackend {
  readonly proc: ChildProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly serverRequests: ServerRequest[] = [];
  private readonly listeners = new Map<string, EventListener>();
  private readerDead = false;
  /** Monotonic id for fire-and-forget sends (send()). Uses a high range to
   *  avoid collisions with the server's request ids (low range). */
  private sendIdCounter = 1_000_000_000;
  /** Watchdog process that kills the zcode group if this bridge dies (SIGKILL). */
  private watchdog: ChildProcess | null = null;

  constructor(argv: string[], env: NodeJS.ProcessEnv) {
    this.proc = spawn(argv[0]!, argv.slice(1), {
      stdio: ["pipe", "pipe", "ignore"],
      env,
      detached: true, // own process group → kill(-pid) reaps the whole tree
    });
    this.startReader();
    this.startWatchdog();
    log(`backend: started zcode app-server (pid=${this.proc.pid})`);
  }

  /**
   * Spawn a tiny detached watchdog that kills the zcode process group if this
   * bridge process disappears.
   *
   * The detached/kill(-pid) cleanup in `close()` only runs when the bridge
   * exits cleanly enough for the signal handlers to fire (SIGTERM/SIGINT/etc).
   * If the bridge is SIGKILLed (Zed force-kill on reconnect, crash, OOM), the
   * handler never runs and the zcode subprocess group is orphaned. The
   * watchdog closes that gap: it polls the bridge pid every 2s and, once the
   * bridge is gone, sends SIGKILL to the zcode process group, then exits.
   *
   * The watchdog is its own process-group leader (detached) and `unref`'d, so
   * it never holds the event loop open and is not part of the zcode group it
   * kills. It self-terminates as soon as the zcode process exits, so a normal
   * shutdown leaves no lingering watchdog.
   */
  private startWatchdog(): void {
    const bridgePid = process.pid;
    const zcodePid = this.proc.pid;
    if (!bridgePid || !zcodePid) return;
    // Inline script: poll bridge liveness, kill zcode group on bridge death.
    const script = `
      const bridgePid = ${bridgePid};
      const zcodePid = ${zcodePid};
      const tick = () => {
        // Bridge gone? → reap the whole zcode process group, then exit.
        try { process.kill(bridgePid, 0); }
        catch {
          try { process.kill(-zcodePid, 'SIGKILL'); } catch {}
          process.exit(0);
        }
        // zcode already exited? → watchdog has no job left.
        try { process.kill(-zcodePid, 0); }
        catch { process.exit(0); }
      };
      setInterval(tick, 2000);
      tick();
    `;
    this.watchdog = spawn(process.execPath, ["-e", script], {
      stdio: "ignore",
      detached: true, // own process group, not part of the zcode group
    });
    this.watchdog.unref();
  }

  // ---------- read loop ----------

  private startReader(): void {
    const stdout = this.proc.stdout;
    if (!stdout) {
      this.markReaderDead("no stdout");
      return;
    }
    const rl = createInterface({ input: stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: ZcodeInbound;
      try {
        msg = JSON.parse(trimmed) as ZcodeInbound;
      } catch {
        return; // unparseable line: ignore
      }
      this.route(msg);
    });
    rl.on("close", () => this.markReaderDead("stdout closed"));
  }

  private route(msg: ZcodeInbound): void {
    const method = msg.method;
    const id = msg.id;
    if (id !== undefined && method === undefined) {
      // Response (id, no method) → resolve pending request.
      this.resolvePending(id, msg as unknown as ZcodeResponse);
      return;
    }
    if (id !== undefined && method !== undefined) {
      // id + method: our pending response wins the race; else it's a server→client request.
      if (this.pending.has(id)) {
        this.resolvePending(id, msg as unknown as ZcodeResponse);
      } else {
        this.serverRequests.push({
          id,
          method,
          params: (msg.params ?? {}) as ServerRequest["params"],
        });
      }
      return;
    }
    if (method !== undefined) {
      // Notification.
      if (method === "session/event") {
        const ev = (msg.params ?? {}) as unknown as ZcodeEvent;
        const sid = ev.sessionId;
        const listener = sid ? this.listeners.get(sid) : undefined;
        listener?.handleEvent(ev);
      }
      // Other notifications are currently ignored (state.updated, etc.).
    }
  }

  private resolvePending(id: number, resp: ZcodeResponse): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(resp);
  }

  private markReaderDead(reason: string): void {
    if (this.readerDead) return;
    this.readerDead = true;
    log(`backend: reader exited (${reason})`);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({
        id: 0,
        error: { message: "zcode backend reader exited (backend dead)" },
      });
    }
    this.pending.clear();
  }

  // ---------- listeners / server requests ----------

  registerEventListener(zcodeSid: string, listener: EventListener): void {
    this.listeners.set(zcodeSid, listener);
  }

  unregisterEventListener(zcodeSid: string): void {
    this.listeners.delete(zcodeSid);
  }

  /** Non-blocking drain of pending server→client requests. */
  pollServerRequests(): ServerRequest[] {
    if (this.serverRequests.length === 0) return [];
    return this.serverRequests.splice(0, this.serverRequests.length);
  }

  /** Reply to a zcode server→client request with a result (id + result). */
  sendReply(id: number, result: unknown): void {
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed) {
      log("backend: sendReply dropped (stdin closed)");
      return;
    }
    try {
      stdin.write(JSON.stringify({ id, result }) + "\n");
    } catch (e) {
      // Broken pipe: backend is gone. Mark reader dead so the rest of the
      // bridge stops trying to talk to it; otherwise zcode reannounces would
      // keep hitting a dead pipe and the dedup cache would spin forever.
      this.readerDead = true;
      log(
        `backend: sendReply write failed (marked dead): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Reply to a zcode server→client request with an error. */
  sendError(id: number, code: number, message: string): void {
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed) {
      log("backend: sendError dropped (stdin closed)");
      return;
    }
    try {
      stdin.write(JSON.stringify({ id, error: { code, message } }) + "\n");
    } catch (e) {
      this.readerDead = true;
      log(
        `backend: sendError write failed (marked dead): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ---------- send / request ----------

  /** Fire-and-forget notification to ZCode (no id, no response). */
  notify(method: string, params?: Record<string, unknown>): void {
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed) {
      log("backend: notify dropped (stdin closed)");
      return;
    }
    stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  /**
   * Send a message with an id but WITHOUT registering a pending response
   * (fire-and-forget). Mirrors Python's `_backend.send({"id": ..., ...})` for
   * `session/stop`: some backends route by id presence, so carrying an id is
   * more robust than a bare notify. If the backend replies, the reader's
   * `resolvePending` finds no pending entry and safely discards it.
   */
  send(method: string, params?: Record<string, unknown>): void {
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed) {
      log("backend: send dropped (stdin closed)");
      return;
    }
    const id = this.sendIdCounter++;
    stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + "\n");
  }

  /**
   * Synchronous request/response: register a pending promise, send, await.
   * Other notifications arriving during the wait are routed async by the
   * reader loop (they don't get swallowed).
   *
   * Returns `{error}` on dead backend, broken pipe, or timeout — never throws.
   */
  async request(
    id: number,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30000,
  ): Promise<ZcodeResponse> {
    if (this.readerDead) {
      return { id, error: { message: "zcode backend reader exited (backend dead)" } };
    }
    const promise = new Promise<ZcodeResponse>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ id, error: { message: "timeout" } });
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
    try {
      const stdin = this.proc.stdin;
      if (!stdin || stdin.destroyed) throw new Error("stdin closed");
      stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + "\n");
    } catch (e) {
      this.pending.delete(id);
      this.readerDead = true;
      return {
        id,
        error: {
          message: `zcode backend pipe broken: ${e instanceof Error ? e.message : String(e)}`,
        },
      };
    }
    return promise;
  }

  // ---------- lifecycle ----------

  /**
   * Kill the whole zcode process group and wait for it to die.
   *
   * SIGTERM → wait up to 3s → SIGKILL if still alive. Mirrors the Python
   * `os.killpg` + `proc.wait(3)` + SIGKILL escalation. Note `proc.killed` is
   * NOT set by `process.kill(-pid)` (group signal), so we track liveness via
   * `exitCode === null` instead. Async so the caller can `await` a full reap
   * before the parent exits (an unref'd timer could be skipped on fast exit,
   * leaving orphans).
   */
  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc.pid) return;
    try {
      // Already exited?
      if (proc.exitCode !== null || proc.signalCode) return;
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        return; // group already gone
      }
      // Wait up to 3s for a clean exit.
      const exited = await new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = () => {
          clearTimeout(timer); // don't let the timeout keep the event loop alive
          resolve(true);
        };
        proc.once("exit", done);
        timer = setTimeout(() => {
          proc.removeListener("exit", done);
          resolve(false);
        }, 3000);
      });
      if (exited) return;
      // Still alive → SIGKILL the whole group.
      try {
        if (proc.pid && proc.exitCode === null) process.kill(-proc.pid, "SIGKILL");
      } catch {
        // already gone
      }
    } finally {
      // Stop the watchdog — it would self-exit on its next tick once the zcode
      // group is gone, but killing it here avoids the up-to-2s delay.
      this.killWatchdog();
    }
  }

  /** Terminate the watchdog process if it is still running. */
  private killWatchdog(): void {
    const wd = this.watchdog;
    if (!wd) return;
    this.watchdog = null;
    if (wd.pid && wd.exitCode === null) {
      try {
        process.kill(wd.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  get isDead(): boolean {
    return this.readerDead;
  }
}
