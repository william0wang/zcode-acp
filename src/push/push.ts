/**
 * Offline push dispatch (push-backend-requirements §5): one helper gates every
 * event hook. Push fires only when the bridge has ZERO connected clients (an
 * online client renders the event live) and push is ACTIVE — the single
 * predicate from push/config.ts. Fire-and-forget: send failures warn and never
 * reach the event path.
 */

import type { ZcodeAcpServer } from "../server.js";
import { log, warn } from "../utils.js";
import { pushConfig } from "./config.js";
import { createWeComSender, type WeComSender } from "./wecom.js";

export type PushKind = "permission" | "question" | "run" | "task" | "test";

export interface PushEventData {
  kind: PushKind;
  title: string;
  body?: string;
}

/** undefined = not yet built; null = push inactive. */
let sender: WeComSender | null | undefined;

function pushSender(): WeComSender | null {
  if (sender === undefined) {
    const cfg = pushConfig();
    sender = cfg ? createWeComSender(cfg) : null;
  }
  return sender;
}

/** Test hook: forget the process-wide sender. */
export function resetPushSenderForTests(): void {
  sender = undefined;
}

/** Test hook: inject a fake sender (null = inactive). */
export function setPushSenderForTests(s: WeComSender | null): void {
  sender = s;
}

/**
 * Render the contracted WeCom text: `[<kind>] <title>` + optional body line.
 * Under `contentDetail: "minimal"` the body carries no business strings (§4 —
 * content transits Tencent) — the kind prefix + title identify the event.
 */
export function renderPushContent(
  cfg: { contentDetail: "full" | "minimal" },
  data: PushEventData,
): string {
  const body = cfg.contentDetail === "minimal" ? undefined : data.body;
  return body ? `[${data.kind}] ${data.title}\n${body}` : `[${data.kind}] ${data.title}`;
}

/** §5: the single gated dispatch helper — offline + ACTIVE or nothing. */
export function pushIfOffline(server: ZcodeAcpServer, data: PushEventData): void {
  if (server.clients.size > 0) return;
  const cfg = pushConfig();
  if (!cfg) return;
  const s = pushSender();
  if (!s) return;
  const content = renderPushContent(cfg, data);
  s.sendText(content).then(
    () => log(`push: ${data.kind} "${data.title}" sent via WeCom`),
    (e: unknown) => warn(`push: WeCom send failed: ${e instanceof Error ? e.message : String(e)}`),
  );
}

/**
 * §5.1: derive the permission/question payload at the zero-clients branch of
 * `requestAny` (broadcast.ts) — the single hook covering permission requests,
 * AskUserQuestion, and elicitation.
 */
export function pushInteractionIfOffline(
  server: ZcodeAcpServer,
  method: string,
  params?: unknown,
): void {
  const p = (params ?? {}) as { toolCall?: { title?: string }; message?: string };
  if (method === "session/request_permission") {
    const detail = typeof p.toolCall?.title === "string" ? p.toolCall.title.trim() : "";
    pushIfOffline(server, {
      kind: "permission",
      title: "Approval requested",
      body: detail || undefined,
    });
    return;
  }
  const question = typeof p.message === "string" ? p.message.trim() : "";
  pushIfOffline(server, {
    kind: "question",
    title: "Agent question",
    body: question || undefined,
  });
}

/**
 * §7 test push — sends REGARDLESS of client presence (it verifies the channel,
 * not an offline event). Structured result for the REST route.
 */
export async function sendTestPush(
  title: string,
): Promise<
  | { ok: true; sent: number }
  | { ok: false; error: "push_disabled" | "send_failed"; message?: string }
> {
  const cfg = pushConfig();
  const s = pushSender();
  if (!cfg || !s) return { ok: false, error: "push_disabled" };
  try {
    await s.sendText(renderPushContent(cfg, { kind: "test", title }));
    return { ok: true, sent: 1 };
  } catch (e) {
    return {
      ok: false,
      error: "send_failed",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
