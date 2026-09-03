/**
 * Remote session history endpoint (ADR-0015), served on the bridge's loopback
 * HTTP server and wrapped by the hub at
 * GET /api/projects/sessions?workspacePath=…
 *
 * Discovery (the heartbeat payload) deliberately lists only RUNNING-scoped
 * sessions — deriving membership from the store would flood it with every
 * retired conversation. This endpoint is the deliberate counterpart: the
 * project's ENTIRE backend session store, including closed conversations no
 * bridge currently holds, so a remote client can pick one and resume it with
 * `session/load` (pass-through resume accepts raw backend ids).
 *
 * Long-lived projects hold dozens of sessions, so the listing is PAGINATED:
 * newest first (updatedAt descending, sessionId descending as the tiebreak so
 * pages are stable), `limit` per page (default 20, max 200), and a composite
 * cursor for "load more": `?before=<ms>&beforeId=<sessionId>` names the last
 * row of the previous page, so one millisecond holding more rows than a page
 * never skips or repeats them. The response carries `nextCursor`
 * (`{before, beforeId}`, null on the last page). The backend `session/list`
 * has no native pagination — the full store arrives once and is windowed
 * here; entries are tiny, so that round-trip is cheap.
 *
 * Each entry carries `live` (this bridge currently holds the conversation
 * with real activity) and `running` (a turn is in flight) so a client can
 * render state from this one call. The workspace is never client-chosen:
 * `listSessions` pins serve mode to the process cwd (ADR-0014), and the
 * editor case passes the bridge's own project cwd.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { listSessions } from "../handlers/session.js";
import type { ZcodeAcpServer } from "../server.js";
import { runningZcodeSids } from "./status-endpoint.js";

/** Rows per page when the client sends no limit. */
export const DEFAULT_SESSION_LIMIT = 20;
/** Hard cap — a bigger ask is clamped, not refused. */
export const MAX_SESSION_LIMIT = 200;

/** Parsed pagination query; null = a malformed value the caller must 400. */
export interface SessionListQuery {
  limit: number;
  /** updatedAt (ms) of the cursor row: only older rows — or tied, see beforeId. */
  before?: number;
  /** sessionId of the cursor row: excludes it and already-shown tied rows. */
  beforeId?: string;
}

/** Opaque backend session id — the charset `beforeId` may travel as. */
const SESSION_ID_RE = /^[\w.:-]+$/;

/** Parse ?limit=&before=&beforeId=; limit clamped into [1, MAX]. */
export function parseSessionListQuery(searchParams: URLSearchParams): SessionListQuery | null {
  const limitRaw = searchParams.get("limit");
  const beforeRaw = searchParams.get("before");
  const beforeIdRaw = searchParams.get("beforeId");
  let limit = DEFAULT_SESSION_LIMIT;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw)) return null;
    const parsed = parseInt(limitRaw, 10);
    if (parsed < 1) return null;
    limit = Math.min(parsed, MAX_SESSION_LIMIT);
  }
  let before: number | undefined;
  if (beforeRaw !== null) {
    if (!/^\d+$/.test(beforeRaw)) return null;
    before = parseInt(beforeRaw, 10);
  }
  if (beforeIdRaw !== null && !SESSION_ID_RE.test(beforeIdRaw)) return null;
  return { limit, before, beforeId: beforeIdRaw ?? undefined };
}

/** ISO string → ms epoch; absent/unparsable sorts oldest (0). */
function updatedAtMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function sendText(res: ServerResponse, code: number, message: string): void {
  if (res.writableEnded) return;
  res.writeHead(code, { "Content-Type": "text/plain" });
  res.end(message);
}

async function handleList(server: ZcodeAcpServer, req: IncomingMessage, res: ServerResponse) {
  // Consume any request body so the client's connection drains cleanly.
  req.resume();

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const query = parseSessionListQuery(url.searchParams);
  if (!query) {
    sendText(res, 400, "invalid limit/before — positive integers expected");
    return;
  }

  const { sessions } = await listSessions(server, { cwd: server.projectCwd() });
  // Newest first; the id tiebreak makes the order total, and the composite
  // cursor names the exact last row, so pages never repeat or skip rows —
  // even when a single millisecond holds more rows than a page.
  const sorted = [...sessions].sort(
    (a, b) =>
      updatedAtMs(b.updatedAt) - updatedAtMs(a.updatedAt) ||
      (a.sessionId > b.sessionId ? -1 : a.sessionId < b.sessionId ? 1 : 0),
  );
  const before = query.before;
  const filtered =
    before === undefined
      ? sorted
      : sorted.filter((s) => {
          const t = updatedAtMs(s.updatedAt);
          if (t !== before) return t < before;
          // Tied with the cursor row: keep only ids strictly after it in the
          // (descending) id order. Without beforeId (hand-rolled query) tied
          // rows are conservatively dropped — our own cursor always names it.
          return query.beforeId !== undefined && s.sessionId < query.beforeId;
        });
  const page = filtered.slice(0, query.limit);
  const lastRow = page.length > 0 ? page[page.length - 1]! : undefined;
  const nextCursor =
    filtered.length > query.limit && lastRow
      ? { before: updatedAtMs(lastRow.updatedAt), beforeId: lastRow.sessionId }
      : null;

  // live/running flags are computed once for the PAGE — the membership gates
  // are the same as discovery's heartbeat payload.
  const running = runningZcodeSids(server);
  const live = new Set<string>();
  for (const [acpSid, summary] of server.sessionSummaries) {
    if (!summary.hasActivity) continue;
    const zcodeSid = server.resolveSid(acpSid);
    if (zcodeSid) live.add(zcodeSid);
  }
  const body = JSON.stringify({
    sessions: page.map((s) => ({
      ...s,
      live: live.has(s.sessionId),
      running: running.has(s.sessionId),
    })),
    nextCursor,
  });
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    // Listing pages poll on refresh; a stale copy would resurrect closed rows.
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/**
 * Build the /sessions history request handler for the loopback endpoint.
 * Failures (backend down, spawn refused) degrade to a status code, never
 * into the event loop.
 */
export function createSessionListHandler(
  server: ZcodeAcpServer,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "method not allowed");
      return;
    }
    void handleList(server, req, res).catch((e) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendText(res, 502, `session list failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
}
