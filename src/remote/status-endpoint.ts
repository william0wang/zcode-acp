/**
 * Live session status endpoint, served on the bridge's loopback HTTP server
 * next to /acp and /fs, byte-proxied by the hub at
 * /api/instances/{id}/status (ADR-0005).
 *
 *   GET /status — every live session with its running state
 *
 * Assembled purely from in-memory state (session summaries + pending turns):
 * no backend RPC, so polling clients cost nothing. Title freshness stays the
 * heartbeat's job (collectSessions enriches via session/list); the running
 * state is the real-time part this endpoint exists for. Like /fs, the
 * endpoint is loopback-only and unauthenticated — the hub is the single
 * public entry and enforces the token.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { ZcodeAcpServer } from "../server.js";

export type SessionRunStatus = "running" | "idle";

export interface SessionStatusEntry {
  sessionId: string;
  title?: string;
  status: SessionRunStatus;
  updatedAt: number;
}

function sendText(res: ServerResponse, code: number, message: string): void {
  if (res.writableEnded) return;
  res.writeHead(code, { "Content-Type": "text/plain" });
  res.end(message);
}

/**
 * zcode session ids with a turn still in flight. Matches the `turnActive`
 * derivation in `session/load`: a cancelled-but-finalising turn counts as
 * running — the conversation is still busy until its loop unwinds.
 */
export function runningZcodeSids(server: ZcodeAcpServer): Set<string> {
  const running = new Set<string>();
  for (const turn of server.pendingTurns.values()) running.add(turn.zcodeSid);
  return running;
}

/**
 * Live sessions with their running state. Membership matches collectSessions:
 * `hasActivity` summaries that resolve to a backend session — lazy
 * placeholders that never ran a turn stay invisible.
 */
export function collectStatus(server: ZcodeAcpServer): { sessions: SessionStatusEntry[] } {
  const running = runningZcodeSids(server);
  const sessions: SessionStatusEntry[] = [];
  for (const [acpSid, summary] of server.sessionSummaries) {
    if (!summary.hasActivity) continue;
    const zcodeSid = server.resolveSid(acpSid);
    if (!zcodeSid) continue; // pure placeholder — no backend session behind it
    sessions.push({
      sessionId: acpSid,
      ...(summary.title !== undefined ? { title: summary.title } : {}),
      status: running.has(zcodeSid) ? "running" : "idle",
      updatedAt: summary.updatedAt,
    });
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return { sessions };
}

/**
 * Build the /status request handler for the loopback endpoint. Synchronous
 * assembly means the only failure paths are serialization — still answered
 * with a status code, never thrown into the event loop.
 */
export function createStatusHandler(
  server: ZcodeAcpServer,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "method not allowed");
      return;
    }
    let body: string;
    try {
      body = JSON.stringify(collectStatus(server));
    } catch {
      sendText(res, 500, "internal error");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      // Polling clients must always see the freshest state.
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}
