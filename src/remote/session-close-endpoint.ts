/**
 * Remote session close endpoint (ADR-0006), served on the bridge's loopback
 * HTTP server and byte-proxied by the hub at
 * POST /api/instances/{id}/sessions/{sessionId}/close.
 *
 * Closing RETIRES a session from remote discovery — it is not deletion. The
 * backend store, the editor's own conversation storage, and the App's
 * tasks-index are untouched; the backend's resident runtime for the session
 * is evicted (session/close) so the conversation stops without losing
 * history. Why it exists: the ACP protocol has no editor→agent "tab closed"
 * notification, so a conversation retired on the editor side stays
 * advertised by this bridge's in-memory summary forever.
 *
 * The "editor side still has it open" guard cannot be a precondition check
 * (unobservable); it is the hasActivity gate's natural re-arm instead: a
 * closed entry loses its summary, and `markSessionActive` (any prompt, any
 * load with history) recreates it — so a wrongly closed conversation
 * reappears the moment the editor touches it, while an editor-side-retired
 * one stays gone. A running turn is the one case we CAN observe and reject.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import process from "node:process";

import { cancelSessionTurns } from "../handlers/session.js";
import { recordClosedSessionIds } from "../closed-sessions.js";
import type { ZcodeAcpServer } from "../server.js";
import { log } from "../utils.js";
import { stopPollersForSession } from "../workflow/poller.js";

function sendText(res: ServerResponse, code: number, message: string): void {
  if (res.writableEnded) return;
  res.writeHead(code, { "Content-Type": "text/plain" });
  res.end(message);
}

function sendJson(res: ServerResponse, code: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Grace before the bridge exits itself when the TUI group signal missed. */
const SELF_EXIT_MS = 1_500;

/**
 * Force close: how long to wait for the cancelled turn(s) to settle before
 * evicting the resident runtime anyway (the eviction kills any generation
 * that ignored the stop pair). Test hook override via the setter below.
 */
export let forceSettleMs = 3_000;

/** Test hook: shrink the force-close settle bound so tests don't sleep. */
export function setForceSettleMsForTests(ms: number): void {
  forceSettleMs = ms;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MAX_CLOSE_BODY_BYTES = 256;

/**
 * Read the optional close body without trusting Content-Type (the hub's
 * forward-and-relay proxy pipes bytes through without forwarding headers).
 * Empty body → undefined; anything malformed throws for the 400 path.
 */
async function readCloseBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_CLOSE_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface ServeTerminateDecision {
  /** Terminate this bridge once the close response has flushed. */
  terminate: boolean;
  /** Foreground process-group id of the incubated TUI tree; absent = headless. */
  tuiPgid?: number;
}

/**
 * Should closing a session TERMINATE this bridge? Only for remote-incubated
 * instances (ZCODE_ACP_REMOTE_ORIGIN=serve, ADR-0016): their CLI was spawned
 * for exactly this conversation, so the last close ends it — the TUI window's
 * whole process tree (cli → martty → bridge) via one group signal, or a plain
 * self-exit for the headless serve bridge (pulling its idle exit forward).
 * Editor-origin bridges return null and keep the retire-only semantics.
 * Pure — exported for unit tests.
 */
export function serveTerminateDecision(
  advertisedCount: number,
  env: { ZCODE_ACP_REMOTE_ORIGIN?: string; ZCODE_ACP_TUI_CLI_PID?: string } = process.env,
): ServeTerminateDecision | null {
  if ((env.ZCODE_ACP_REMOTE_ORIGIN ?? "").trim() !== "serve") return null;
  if (advertisedCount > 0) return { terminate: false };
  const pid = Number.parseInt((env.ZCODE_ACP_TUI_CLI_PID ?? "").trim(), 10);
  return {
    terminate: true,
    ...(Number.isInteger(pid) && pid > 0 ? { tuiPgid: pid } : {}),
  };
}

/**
 * Advertised-session count after a close: summaries with activity plus
 * REMOTE-created empty placeholders (mirrors the /status membership rule).
 */
function advertisedSessionCount(server: ZcodeAcpServer): number {
  let count = server.remoteCreatedSessions.size;
  for (const [sid, summary] of server.sessionSummaries) {
    if (summary.hasActivity && !server.remoteCreatedSessions.has(sid)) count++;
  }
  return count;
}

/**
 * Pids to SIGTERM directly when tearing down an incubated TUI tree: the
 * incubated CLI (ZCODE_ACP_TUI_CLI_PID — tui.ts forwards its SIGTERM to the
 * martty child and exits clean) and this bridge's parent (the TUI host
 * driving this bridge's stdio). Deduped; pid 1 excluded. Pure — for tests.
 */
export function tuiTeardownPids(tuiPgid: number, ppid: number): number[] {
  const out: number[] = [];
  for (const pid of [tuiPgid, ppid]) {
    if (Number.isInteger(pid) && pid > 1 && !out.includes(pid)) out.push(pid);
  }
  return out;
}

/**
 * Tear the incubated CLI down AFTER the close response flushed (the phone
 * must get its 200 before the bridge dies). The group SIGTERM covers every
 * descendant at once — but ONLY when the terminal made the script a session
 * leader (Terminal.app, -e-style terminals). Ghostty's AppleScript tab and
 * Warp's URI tab run the script inside the terminal app's own session: the
 * group ESRCHs (verified live 2026-09-08 — kill(-pid) failed while the pid
 * was alive), and without the direct pid signals only this bridge died,
 * leaving the window on a dead-agent error page. martty converts SIGTERM to
 * an orderly exit, restores the TTY, the tree ends with exit code 0, and each
 * terminal's own close-on-exit pref takes the window. The self-exit timer is
 * the fallback for the headless serve bridge and for launch paths where both
 * signal forms miss.
 */
function terminateAfterFlush(decision: ServeTerminateDecision, res: ServerResponse): void {
  const run = () => {
    if (decision.tuiPgid !== undefined) {
      try {
        process.kill(-decision.tuiPgid, "SIGTERM");
        log(`remote: last session closed — SIGTERM to TUI process group ${decision.tuiPgid}`);
      } catch (e) {
        log(
          `remote: TUI group signal failed ` +
            `(${e instanceof Error ? e.message : String(e)}) — signalling the tree pids directly`,
        );
      }
      // Direct signals for terminals that run the script without a new
      // session (see above); harmless duplicates when the group signal landed.
      for (const pid of tuiTeardownPids(decision.tuiPgid, process.ppid)) {
        try {
          process.kill(pid, "SIGTERM");
          log(`remote: last session closed — SIGTERM to TUI pid ${pid}`);
        } catch {
          // already gone — the self-exit below still ends this bridge
        }
      }
    }
    // Self-exit through the orderly path: signalling ourselves runs the
    // index.ts SIGTERM handler (unregister with the hub, reap the backend
    // group) — a bare process.exit(0) left the hub serving a corpse row for
    // up to its 30s heartbeat TTL and the desktop's ladder dialing the dead
    // id until the probe pruned it (2026-10-28), and it skipped the backend
    // teardown the orderly shutdown owns. The hard exit stays as the
    // backstop for a wedged orderly path (bounded like the unregister).
    setTimeout(() => {
      process.kill(process.pid, "SIGTERM");
      setTimeout(() => process.exit(0), SELF_EXIT_MS).unref();
    }, SELF_EXIT_MS);
  };
  // 'finish' fires asynchronously after end(), so attaching here never misses.
  if (res.writableEnded) res.once("finish", run);
  else run();
}

async function handleClose(
  server: ZcodeAcpServer,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  // Optional JSON body: {force: true} stops an in-flight turn before closing
  // (an explicit terminate gesture — the desktop's End session). Absent body
  // keeps the plain ADR-0006 contract.
  let body: unknown;
  try {
    body = await readCloseBody(req);
  } catch {
    sendText(res, 400, "invalid body");
    return;
  }
  const force = (body as { force?: unknown } | undefined)?.force === true;

  // An empty REMOTE-created placeholder (no turn yet) has no summary but IS
  // advertised by discovery — it must be closable too, or it blocks the
  // last-close CLI termination forever (advertisedSessionCount never drops).
  if (!server.sessionSummaries.has(sessionId) && !server.remoteCreatedSessions.has(sessionId)) {
    sendText(res, 404, "unknown session");
    return;
  }
  // Every spelling this bridge knows for the conversation (editor alias(es) +
  // backend sess_ id), captured before retirement: the $/zcode/session_closed
  // fan-out below routes by payload sessionId, and the response's
  // `sessionIds` lets the HUB tombstone the whole conversation — not just the
  // one spelling the close URL happened to quote (a reconnect ladder may
  // POST the backend id while the listing showed the alias).
  const aliases = server.sessionAliases(sessionId);
  const zcodeSid = server.resolveSid(sessionId);
  const running =
    zcodeSid !== undefined &&
    [...server.pendingTurns.values()].some((t) => t.zcodeSid === zcodeSid);
  if (running && !force) {
    sendText(res, 409, 'session is running — cancel the turn first (or send {"force":true})');
    return;
  }
  if (running && zcodeSid !== undefined) {
    // Force close (ADR-0006 amendment): ESC semantics without a client
    // connection — flag the turns cancelled, fire the stop pair, then give
    // them a bounded window to settle (the stop's terminal event persists
    // partial output cleanly) before the runtime eviction below proceeds
    // regardless. The eviction kills any generation that ignored the stop.
    cancelSessionTurns(server, zcodeSid);
    log(`remote: force close cancelling in-flight turn(s) for ${zcodeSid}`);
    const deadline = Date.now() + forceSettleMs;
    while (Date.now() < deadline) {
      if (![...server.pendingTurns.values()].some((t) => t.zcodeSid === zcodeSid)) break;
      await sleep(50);
    }
  }
  // Retire from discovery AND stamp the retirement: a turn that outlives the
  // force-settle bound settles after this point, and its terminal activity
  // must not re-advertise the conversation (the desktop's vanished-then-
  // resurrected row, 2026-10-22). EVERY spelling gets the stamp (hub tombstone
  // parity): a load or close may quote the backend id while the listing showed
  // the alias, and the auto-load retirement gate checks the quoted spelling.
  for (const sid of aliases) server.retireDiscovery(sid);
  // Durable half of the retirement: the in-memory stamp above dies with this
  // process (a serve-origin bridge exits on last close), and the hub-incubated
  // successor must still refuse to resurrect the conversation on a reconnect
  // ladder's auto session/load. Every spelling (aliases + backend id) is
  // recorded; genuine use (markSessionActive) clears the record again.
  recordClosedSessionIds([...aliases, zcodeSid]);
  // Workflow-run progress pollers address this session's journal — stop them
  // with the teardown (best-effort, never throws) instead of letting them run
  // to the hard cap for a conversation nothing else references anymore.
  if (zcodeSid) stopPollersForSession(zcodeSid);
  // Evict the backend's resident runtime so the conversation truly stops (no
  // background turn keeps it alive); the session file stays on disk and
  // session/list / a later resume still work. Best-effort — a bridge with no
  // live backend (or a send failure) still retires discovery, which is the
  // observable contract. The liveness cache must go too, or a later resume
  // would skip the backend's session/resume RPC on a stale "still loaded".
  server.backendLoadedSessions.delete(sessionId);
  if (zcodeSid && server.backend && !server.backend.isDead) {
    try {
      server.backend.send("session/close", { sessionId: zcodeSid });
      log(`remote: session/close sent to backend for ${zcodeSid} (resident runtime evicted)`);
    } catch (e) {
      log(
        `remote: session/close send failed (ignored): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  log(`remote: session ${sessionId.slice(0, 8)} closed from remote (discovery retired)`);
  const terminate = serveTerminateDecision(advertisedSessionCount(server));
  if (terminate !== null) {
    // Serve-origin only: the incubated window's conversation was retired.
    // $/zcode/session_closed lets its martty quit cleanly (last tab) or drop
    // the session's tab; editor-origin bridges stay silent — a remote retire
    // must never close a window the user launched themselves (ADR-0006's
    // self-heal: a touched session reappears). One copy PER session alias:
    // clients route by payload sessionId, and a client may hold the
    // conversation under a different acpSid. Awaited BEFORE the response so
    // it flushes before the terminate path's signals — racedNotify caps the
    // wait per client, so this cannot hang the close. Clients that don't
    // know the method (old martty, editors) ignore it.
    await Promise.all(
      aliases.map((sid) =>
        server.clients.notifyEach("$/zcode/session_closed", () => ({ sessionId: sid })),
      ),
    );
  }
  sendJson(res, 200, { ok: true, sessionIds: aliases });
  if (terminate?.terminate) terminateAfterFlush(terminate, res);
}

/**
 * Build the /sessions/{id}/close request handler for the loopback endpoint.
 * Async failures degrade to a status code, never into the event loop.
 */
export function createSessionCloseHandler(
  server: ZcodeAcpServer,
): (req: IncomingMessage, res: ServerResponse, sessionId: string) => void {
  return (req, res, sessionId) => {
    if (req.method !== "POST") {
      sendText(res, 405, "method not allowed");
      return;
    }
    void handleClose(server, req, res, sessionId).catch(() => {
      if (res.headersSent) res.destroy();
      else sendText(res, 500, "internal error");
    });
  };
}
