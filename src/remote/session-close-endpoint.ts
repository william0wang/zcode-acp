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

import type { ZcodeAcpServer } from "../server.js";
import { log } from "../utils.js";

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
 * Tear the incubated CLI down AFTER the close response flushed (the phone
 * must get its 200 before the bridge dies). The group SIGTERM covers the
 * martty Rust host too — a bare kill of one pid orphans it; martty's client
 * converts the signal to an orderly exit and restores the TTY, the tree ends
 * with exit code 0, and each terminal's own close-on-exit pref takes the
 * window. The self-exit timer is the fallback for the headless serve bridge
 * and for a terminal whose launch path broke process-group membership.
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
            `(${e instanceof Error ? e.message : String(e)}) — exiting this bridge instead`,
        );
      }
    }
    setTimeout(() => process.exit(0), SELF_EXIT_MS);
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
  // Consume any request body so the client's connection drains cleanly.
  req.resume();

  // An empty REMOTE-created placeholder (no turn yet) has no summary but IS
  // advertised by discovery — it must be closable too, or it blocks the
  // last-close CLI termination forever (advertisedSessionCount never drops).
  if (!server.sessionSummaries.has(sessionId) && !server.remoteCreatedSessions.has(sessionId)) {
    sendText(res, 404, "unknown session");
    return;
  }
  const zcodeSid = server.resolveSid(sessionId);
  if (zcodeSid && [...server.pendingTurns.values()].some((t) => t.zcodeSid === zcodeSid)) {
    sendText(res, 409, "session is running — cancel the turn first");
    return;
  }
  server.sessionSummaries.delete(sessionId);
  server.remoteCreatedSessions.delete(sessionId);
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
  sendJson(res, 200, { ok: true });
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
