/**
 * Offline push dispatch (push-backend-requirements §5): one helper gates every
 * event hook. Push fires only when the bridge has ZERO connected clients (an
 * online client renders the event live) and push is ACTIVE — the single
 * predicate from push/config.ts. Fire-and-forget: send failures warn and never
 * reach the event path.
 */

import path from "node:path";

import { appendDiary } from "../crash-guards.js";
import type { ZcodeAcpServer } from "../server.js";
import { log, warn } from "../utils.js";
import { pushConfig, type PushConfig } from "./config.js";
import { createWeComSender, type WeComSender } from "./wecom.js";

export type PushKind =
  "permission" | "question" | "run" | "task" | "test" | "turn" | "goal" | "compact";

/** Settled kinds routed through {@link pushSettled} (§5.2 — per-kind switches). */
export type PushSettledKind = Extract<PushKind, "turn" | "goal" | "run" | "task" | "compact">;

/**
 * "<project> / <session-title>" source label for settled pushes. It rides the
 * leading bracket (never the body — `contentDetail: "minimal"` strips bodies),
 * replacing the kind prefix whose information the title tail already carries.
 * TOTAL (never throws): the push path is fire-and-forget by contract, and the
 * server handle may be a partial object in tests.
 */
export function pushSourceLabel(server: ZcodeAcpServer, acpSid?: string): string {
  const project = path.basename(server.projectCwd?.() ?? process.cwd());
  const title = acpSid !== undefined ? server.sessionTitles?.get(acpSid) : undefined;
  return title ? `${project} / ${title}` : project;
}

export interface PushEventData {
  kind: PushKind;
  title: string;
  body?: string;
  /**
   * Source label (`<project> / <session>`, see {@link pushSourceLabel}). When
   * present it REPLACES the kind in the leading bracket — `[kind] title`
   * would duplicate what the title tail already says (e.g. "turn completed"),
   * and the bracket is the one slot minimal mode never strips.
   */
  label?: string;
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
 * Render the contracted WeCom text: `[<kind or label>] <title>` + optional
 * body line. A `label` replaces the kind in the leading bracket (see
 * {@link PushEventData.label}). Under `contentDetail: "minimal"` the body
 * carries no business strings (§4 — content transits Tencent) — the bracket
 * prefix + title identify the event.
 */
export function renderPushContent(
  cfg: { contentDetail: "full" | "minimal" },
  data: PushEventData,
): string {
  const body = cfg.contentDetail === "minimal" ? undefined : data.body;
  const prefix = `[${data.label ?? data.kind}]`;
  return body ? `${prefix} ${data.title}\n${body}` : `${prefix} ${data.title}`;
}

/** Fire-and-forget send tail shared by both dispatch helpers. */
function dispatchPush(cfg: PushConfig, s: WeComSender, data: PushEventData): void {
  const content = renderPushContent(cfg, data);
  s.sendText(content).then(
    () => {
      log(`push: ${data.kind} "${data.title}" sent via WeCom`);
      // The success trail must outlive stderr (a closed window eats log()):
      // "did the push leave this bridge?" is the first question a
      // missed-notification report asks (observed 2026-09-29).
      appendDiary(`push: ${data.kind} "${data.title}" delivered via WeCom`);
    },
    (e: unknown) => warn(`push: WeCom send failed: ${e instanceof Error ? e.message : String(e)}`),
  );
}

/** §5: the single gated dispatch helper — offline + ACTIVE or nothing. */
export function pushIfOffline(server: ZcodeAcpServer, data: PushEventData): void {
  if (server.clients.size > 0) return;
  const cfg = pushConfig();
  if (!cfg) return;
  const s = pushSender();
  if (!s) return;
  dispatchPush(cfg, s, data);
}

/**
 * Stamp a USER-originated action (session/prompt, session/cancel) as bridge
 * presence — the anchor of {@link pushSettled}'s quiet window. Only real user
 * entry points may call this: bridge-internal rounds (sandbox allow-restart
 * continuations, goal-loop rounds) must NOT refresh the stamp, or a settle
 * minutes after the user left would be misread as "user still at the desk".
 */
export function noteUserActivity(server: ZcodeAcpServer): void {
  server.lastUserActivityAt = Date.now();
}

/**
 * §5.2 settled-event dispatch (turn end / goal loop stop / workflow run /
 * background task / auto-compact settle): NO client-presence gate — an online
 * client renders the event live but cannot wake the user's phone, and the
 * settled event itself IS the "come back" signal. Each kind is individually
 * switchable via `push.notify.<kind>` (default on); the shared ACTIVE
 * predicate still applies.
 *
 * Quiet window: a settle within `quietMs` (default 30s, 0 disables) of the
 * last user prompt/cancel is suppressed — the user is still at the desk, the
 * ping would be noise (a turn that completes seconds after its prompt never
 * needs a phone). Offline interaction pushes (§5.1) are NOT windowed: they
 * fire only with zero connected clients, where recency means the connection
 * DIED, not that the user is watching.
 */
export function pushSettled(
  server: ZcodeAcpServer,
  data: PushEventData & { kind: PushSettledKind },
): void {
  const cfg = pushConfig();
  if (!cfg || !cfg.notify[data.kind]) return;
  const quietMs = cfg.quietMs ?? 0;
  const activeAgo = Date.now() - (server.lastUserActivityAt ?? 0);
  if (quietMs > 0 && activeAgo < quietMs) {
    appendDiary(
      `push: ${data.kind} "${data.title}" suppressed (user active ${Math.round(activeAgo / 1000)}s ago)`,
    );
    return;
  }
  const s = pushSender();
  if (!s) return;
  dispatchPush(cfg, s, data);
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
    appendDiary(`push: test "${title}" delivered via WeCom`);
    return { ok: true, sent: 1 };
  } catch (e) {
    return {
      ok: false,
      error: "send_failed",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
