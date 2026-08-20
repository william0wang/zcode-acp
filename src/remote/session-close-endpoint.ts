/**
 * Remote session close endpoint (ADR-0006), served on the bridge's loopback
 * HTTP server and byte-proxied by the hub at
 * POST /api/instances/{id}/sessions/{sessionId}/close.
 *
 * Closing RETIRES a session from remote discovery — it is not deletion. The
 * backend store, the editor's own conversation storage, and the App's
 * tasks-index are untouched. Why it exists: the ACP protocol has no
 * editor→agent "tab closed" notification, so a conversation retired on the
 * editor side stays advertised by this bridge's in-memory summary forever.
 *
 * The "editor side still has it open" guard cannot be a precondition check
 * (unobservable); it is the hasActivity gate's natural re-arm instead: a
 * closed entry loses its summary, and `markSessionActive` (any prompt, any
 * load with history) recreates it — so a wrongly closed conversation
 * reappears the moment the editor touches it, while an editor-side-retired
 * one stays gone. A running turn is the one case we CAN observe and reject.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

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

async function handleClose(
  server: ZcodeAcpServer,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  // Consume any request body so the client's connection drains cleanly.
  req.resume();

  if (!server.sessionSummaries.has(sessionId)) {
    sendText(res, 404, "unknown session");
    return;
  }
  const zcodeSid = server.resolveSid(sessionId);
  if (zcodeSid && [...server.pendingTurns.values()].some((t) => t.zcodeSid === zcodeSid)) {
    sendText(res, 409, "session is running — cancel the turn first");
    return;
  }
  server.sessionSummaries.delete(sessionId);
  log(`remote: session ${sessionId.slice(0, 8)} closed from remote (discovery retired)`);
  sendJson(res, 200, { ok: true });
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
