/**
 * Remote session delete endpoint (tombstone semantics), served on the
 * bridge's loopback HTTP server and byte-proxied by the hub at
 * POST /api/instances/{id}/sessions/{sessionId}/delete.
 *
 * "Delete" is the upstream App's soft delete: the tasks-index row gets
 * deleted=1, every listing (this bridge's /sessions history, the hub's
 * project list, the desktop App sidebar) hides the session, and the backend
 * store keeps the conversation bytes — reversible, never a purge. The id is
 * the RAW backend sid (the /sessions listing's currency, same as the
 * pass-through resume). Live conversations are refused (409): a delete
 * reaching one means a stale client — the listing never offers them.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { ZcodeAcpServer } from "../server.js";
import { softDeleteTask } from "../tasks-index.js";
import { log } from "../utils.js";
import { liveZcodeSids } from "./session-list-endpoint.js";

/** Same charset gate as the hub's beforeId/sessionId validation. */
const SESSION_ID_RE = /^[\w.:-]+$/;

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

async function handleDelete(
  server: ZcodeAcpServer,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  // No request body — drain whatever arrived so the connection reuses cleanly.
  req.resume();

  if (!SESSION_ID_RE.test(sessionId)) {
    sendText(res, 400, "invalid sessionId");
    return;
  }
  if (liveZcodeSids(server).has(sessionId)) {
    sendText(res, 409, "session is live — stop or close it first");
    return;
  }
  // The serve bridge is pinned to one project (ADR-0014), so projectCwd() is
  // the tombstone row's workspace — also the fallback attribution for a
  // session that never had a tasks row.
  const ok = await softDeleteTask({
    taskId: sessionId,
    workspacePath: server.projectCwd(),
  });
  if (!ok) {
    sendText(res, 503, "tasks index unavailable");
    return;
  }
  log(`remote: session ${sessionId.slice(0, 8)} soft-deleted (tombstone)`);
  sendJson(res, 200, { ok: true, deleted: true });
}

/**
 * Build the /sessions/{id}/delete request handler for the loopback endpoint.
 * Async failures degrade to a status code, never into the event loop.
 */
export function createSessionDeleteHandler(
  server: ZcodeAcpServer,
): (req: IncomingMessage, res: ServerResponse, sessionId: string) => void {
  return (req, res, sessionId) => {
    if (req.method !== "POST") {
      sendText(res, 405, "method not allowed");
      return;
    }
    void handleDelete(server, req, res, sessionId).catch(() => {
      if (res.headersSent) res.destroy();
      else sendText(res, 500, "internal error");
    });
  };
}
