/**
 * Remote session delete endpoint, served on the bridge's loopback HTTP server
 * and byte-proxied by the hub at POST /api/instances/{id}/sessions/{sessionId}/delete.
 *
 * "Delete" is by default the upstream App's soft delete: the tasks-index row
 * gets deleted=1, every listing (this bridge's /sessions history, the hub's
 * project list, the desktop App sidebar) hides the session, and the backend
 * store keeps the conversation bytes — reversible, never a purge. The id is
 * the RAW backend sid (the /sessions listing's currency, same as the
 * pass-through resume). Live conversations are refused (409): a delete
 * reaching one means a stale client — the listing never offers them.
 *
 * `{"purge": true}` (opt-in, and only when the machine is armed via
 * `delete.purge` in the user config or ZCODE_ACP_DELETE_PURGE=1) physically
 * destroys the bytes through the upstream 3.18+ v4 face —
 * `storage/sessionData/deletionPreview` → `deletionExecute` with its sha256
 * revision guard, busy/in-use blocking and retained-artifact allowlist
 * (ADR-0031's 2026-11-12 revision: the bridge never mints deletes itself;
 * physical delete goes through the upstream face only). The tombstone is
 * written FIRST (hide before the slow purge), so any purge failure degrades
 * to the plain soft delete; a completed purge removes the tasks row (its
 * bytes are gone — the row would be a zombie every reader filters around).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { hardDeleteArmed } from "../config/user-config.js";
import type { ZcodeAcpServer } from "../server.js";
import { deleteTaskRows, retireTasks, softDeleteTask, taskWorkspacePath } from "../tasks-index.js";
import { log, warn } from "../utils.js";
import { liveZcodeSids } from "./session-list-endpoint.js";

/** Same charset gate as the hub's beforeId/sessionId validation. */
const SESSION_ID_RE = /^[\w.:-]+$/;

/** The v4 deletion face moves files — give preview and execute room. */
const DELETION_RPC_TIMEOUT_MS = 30000;

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

/** Read one small optional JSON body (`{"purge": true}`); absent or non-JSON
 * reads as undefined — older clients send no body at all. */
async function readOptionalJson(
  req: IncomingMessage,
): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, c) => n + c.length, 0) > 65536) {
      return undefined; // oversized — not a body shape we defined
    }
  }
  if (!chunks.length) return undefined;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The preview/execute result shapes of the upstream v4 face (strict-zod on
 * the backend side; read leniently here — unknown keys and missing fields
 * degrade to the reason strings below, never a crash). */
interface DeletionPreview {
  revision?: string;
  blockedReason?: string;
  completed?: boolean;
}
interface DeletionResult {
  status?: string;
  reason?: string;
}

/** Outcome of a purge attempt: `blocked` maps to HTTP 409 (upstream guards),
 * everything else answers 200 with an honest `purged` flag — the tombstone
 * already stands, so a degraded purge is a soft delete, not a failure. */
type PurgeOutcome =
  { kind: "purged" } | { kind: "degraded"; reason: string } | { kind: "blocked"; reason: string };

async function purgeSessionBytes(server: ZcodeAcpServer, sessionId: string): Promise<PurgeOutcome> {
  let backend;
  try {
    backend = await server.ensureBackend();
  } catch (e) {
    return {
      kind: "degraded",
      reason: `backend unavailable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  // The store must answer with the SAME workspace path or the preview refuses
  // with identity-mismatch — prefer the tasks row's recorded attribution over
  // the serve bridge's pinned cwd (imported sessions may predate the pin).
  const workspacePath = (await taskWorkspacePath(sessionId)) ?? server.projectCwd();
  let preview: DeletionPreview | undefined;
  try {
    const resp = await backend.request(
      server.nextId(),
      "v4/storage/sessionData/deletionPreview",
      { sessionId, workspace: { workspacePath } },
      DELETION_RPC_TIMEOUT_MS,
    );
    if (resp.error) {
      return { kind: "degraded", reason: `preview failed: ${resp.error.message ?? "unknown"}` };
    }
    preview = (resp.result ?? {}) as DeletionPreview;
  } catch (e) {
    return {
      kind: "degraded",
      reason: `preview failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (preview?.completed) {
    // A previous execution already destroyed the bytes — finish the record.
    await deleteTaskRows([sessionId]);
    return { kind: "purged" };
  }
  if (preview?.blockedReason) {
    if (preview.blockedReason === "not-found") {
      // Physically gone or soft-deleted upstream — resume refuses both, so
      // the row RETIRES (never revivable) instead of holding a zombie tombstone.
      await retireTasks([sessionId]);
      return { kind: "degraded", reason: "not-found" };
    }
    return { kind: "blocked", reason: preview.blockedReason };
  }
  if (!preview?.revision) {
    return { kind: "degraded", reason: "preview returned no revision" };
  }
  try {
    const resp = await backend.request(
      server.nextId(),
      "v4/storage/sessionData/deletionExecute",
      {
        sessionId,
        workspace: { workspacePath },
        revision: preview.revision,
        operationId: randomUUID(),
      },
      DELETION_RPC_TIMEOUT_MS,
    );
    if (resp.error) {
      return { kind: "degraded", reason: `execute failed: ${resp.error.message ?? "unknown"}` };
    }
    const result = (resp.result ?? {}) as DeletionResult;
    if (result.status === "deleted") {
      await deleteTaskRows([sessionId]);
      return { kind: "purged" };
    }
    if (result.status === "incomplete") {
      // Admitted but some files failed — upstream keeps the deletion receipt
      // and a retry completes it; the tombstone hides the session meanwhile.
      warn(`purge of ${sessionId.slice(0, 8)} incomplete: ${result.reason ?? "unknown"}`);
      return { kind: "degraded", reason: `incomplete: ${result.reason ?? "unknown"}` };
    }
    return { kind: "blocked", reason: result.reason ?? result.status ?? "unknown" };
  } catch (e) {
    return {
      kind: "degraded",
      reason: `execute failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function handleDelete(
  server: ZcodeAcpServer,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  const body = await readOptionalJson(req);
  const purge = body?.["purge"] === true;

  if (!SESSION_ID_RE.test(sessionId)) {
    sendText(res, 400, "invalid sessionId");
    return;
  }
  if (purge && !hardDeleteArmed()) {
    // Refuse the WHOLE request, tombstone included: the client asked for a
    // purge, and silently soft-deleting would read as success.
    sendText(
      res,
      403,
      "purge disabled — arm it via delete.purge in the user config or ZCODE_ACP_DELETE_PURGE=1",
    );
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
  if (!purge) {
    log(`remote: session ${sessionId.slice(0, 8)} soft-deleted (tombstone)`);
    sendJson(res, 200, { ok: true, deleted: true });
    return;
  }
  const outcome = await purgeSessionBytes(server, sessionId);
  if (outcome.kind === "purged") {
    log(`remote: session ${sessionId.slice(0, 8)} purged (v4 deletion face)`);
    sendJson(res, 200, { ok: true, deleted: true, purged: true });
    return;
  }
  if (outcome.kind === "blocked") {
    // The tombstone stands; the purge itself was refused by the upstream
    // guards (running / in-use / changed) — the client may retry later.
    sendJson(res, 409, { ok: false, deleted: true, purged: false, reason: outcome.reason });
    return;
  }
  log(`remote: session ${sessionId.slice(0, 8)} soft-deleted (purge degraded: ${outcome.reason})`);
  sendJson(res, 200, { ok: true, deleted: true, purged: false, reason: outcome.reason });
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
