/**
 * POST /push/test on the loopback endpoint (push-backend-requirements §7).
 * Sends a test WeCom push REGARDLESS of client presence (the route verifies
 * the channel, not an offline event) and answers with the house error shape
 * `{ok:false, error, message?}`. Reached from the app through the hub's
 * `/api/instances/{id}/push/test` proxy (hub-server.ts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { sendTestPush } from "../push/push.js";
import type { ZcodeAcpServer } from "../server.js";

function sendText(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { "Content-Type": "text/plain" });
  res.end(message);
}

function sendJson(res: ServerResponse, code: number, body: Record<string, unknown>): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk as string;
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("body is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Build the /push/test request handler for the loopback endpoint. */
export function createPushTestHandler(
  _server: ZcodeAcpServer,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== "POST") {
      sendText(res, 405, "method not allowed");
      return;
    }
    void (async () => {
      let title = "Test push";
      try {
        const body = await readBody(req);
        if (typeof body["title"] === "string" && body["title"].trim()) {
          title = body["title"].trim();
        }
      } catch {
        sendJson(res, 400, {
          ok: false,
          error: "invalid_body",
          message: "body must be a JSON object",
        });
        return;
      }
      const result = await sendTestPush(title);
      if (result.ok) sendJson(res, 200, { ok: true, sent: result.sent });
      else if (result.error === "push_disabled") sendJson(res, 409, result);
      else sendJson(res, 502, result);
    })().catch(() => {
      if (res.headersSent) res.destroy();
      else sendText(res, 500, "internal error");
    });
  };
}
