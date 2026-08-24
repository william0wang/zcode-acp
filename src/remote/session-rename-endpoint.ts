/**
 * Remote session rename endpoint, served on the bridge's loopback HTTP server
 * and byte-proxied by the hub at
 * POST /api/instances/{id}/sessions/{sessionId}/rename (JSON body: {title}).
 *
 * A rename is the ONLY way a session title changes after its one-shot
 * auto-title (set once at the first prompt). The bridge applies it in-memory
 * (sessionTitles + discovery summary), persists it to the App's tasks-index
 * with title_overridden=1 — the same pin the App's own rename flow sets, so
 * no later automatic write can touch it — and broadcasts session_info_update
 * so attached editors and phones update live.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { sendSessionUpdate } from "../handlers/io.js";
import type { ZcodeAcpServer } from "../server.js";
import { renameSessionTask } from "../tasks-index.js";
import { log, warn } from "../utils.js";

const MAX_BODY_BYTES = 4096;

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

/**
 * Read the request body as JSON without trusting Content-Type — the hub's
 * forward-and-relay proxy pipes bytes through without forwarding headers.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleRename(
  server: ZcodeAcpServer,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendText(res, 400, "invalid body");
    return;
  }
  const rawTitle = (body as { title?: unknown } | undefined)?.title;
  if (typeof rawTitle !== "string" || rawTitle.trim().length === 0) {
    sendText(res, 400, "title required");
    return;
  }
  if (!server.sessionSummaries.has(sessionId)) {
    sendText(res, 404, "unknown session");
    return;
  }
  // Mirror the auto-title's normalization: single line, trimmed, 80 chars.
  const title = rawTitle
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 80);

  server.sessionTitles.set(sessionId, title);
  server.touchSessionSummary(sessionId, title);
  const zcodeSid = server.resolveSid(sessionId);
  if (zcodeSid) {
    try {
      await renameSessionTask(zcodeSid, title);
    } catch (e) {
      warn(
        `remote: rename persist failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  await sendSessionUpdate(server.clients.broadcast(), sessionId, {
    sessionUpdate: "session_info_update",
    title,
    updatedAt: new Date().toISOString(),
  }).catch(() => undefined);
  log(`remote: session ${sessionId.slice(0, 8)} renamed to "${title}"`);
  sendJson(res, 200, { ok: true, title });
}

/**
 * Build the /sessions/{id}/rename request handler for the loopback endpoint.
 * Async failures degrade to a status code, never into the event loop.
 */
export function createSessionRenameHandler(
  server: ZcodeAcpServer,
): (req: IncomingMessage, res: ServerResponse, sessionId: string) => void {
  return (req, res, sessionId) => {
    if (req.method !== "POST") {
      sendText(res, 405, "method not allowed");
      return;
    }
    void handleRename(server, req, res, sessionId).catch(() => {
      if (res.headersSent) res.destroy();
      else sendText(res, 500, "internal error");
    });
  };
}
