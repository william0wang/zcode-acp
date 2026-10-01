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
import {
  PUSH_ASK_WATCHDOG_MS,
  PUSH_PERMISSION_ASK_WATCHDOG_MS,
  pushConfig,
  type PushConfig,
} from "./config.js";
import { createWeComSender, type WeComSender } from "./wecom.js";

export type PushKind =
  | "permission"
  | "question"
  | "run"
  | "task"
  | "test"
  | "turn"
  | "goal"
  | "compact"
  | "workflowStage";

/** Settled kinds routed through {@link pushSettled} (§5.2 — per-kind switches). */
export type PushSettledKind = Extract<
  PushKind,
  "turn" | "goal" | "run" | "task" | "compact" | "workflowStage"
>;

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
 * Derive the permission/question payload from the wire method+params (§4/§5.1)
 * — shared by the zero-clients push and the unanswered-ask watchdog. `label`
 * is the `<project> / <session>` source tag every other push carries; without
 * it the bracket degrades to the bare kind ("[question] Agent question"),
 * which tells the user nothing about WHERE the ask is waiting.
 */
function interactionPushData(method: string, params?: unknown, label?: string): PushEventData {
  const p = (params ?? {}) as { toolCall?: { title?: string }; message?: string };
  if (method === "session/request_permission") {
    const detail = typeof p.toolCall?.title === "string" ? p.toolCall.title.trim() : "";
    return { kind: "permission", label, title: "Approval requested", body: detail || undefined };
  }
  const question = typeof p.message === "string" ? p.message.trim() : "";
  return { kind: "question", label, title: "Agent question", body: question || undefined };
}

// ---------- unanswered-ask watchdog (§5.1 v1.3) ----------
//
// The zero-clients push only judges at DISPATCH: an ask fired while a client
// was connected (phone app backgrounded but holding the socket, an editor
// window open) stayed silent forever when nobody answered — observed 2026-09-29
// as "AskUserQuestion 没有通知". Single-slot bookkeeping:
//   - one timer for the FIRST outstanding ask (a permission storm notifies
//     once), re-armed only after every ask settles;
//   - `askNotified` is set by EITHER the zero-clients push or the watchdog,
//     suppressing duplicates until all asks settle.

let askPending = 0;
let askTimer: NodeJS.Timeout | null = null;
let askTimerDelayMs = 0;
let askNotified = false;

/**
 * Watchdog delay per ask kind: a PERMISSION ask blocks a running tool on a
 * human answer, so it defaults to the much shorter window (a two-minute
 * silent block reads as "no notification" — observed 2026-10-01 on workflow
 * approvals). Each tier has its own file-only delay knob; `??` guards test
 * configs built from partial PushConfig objects.
 */
function askWatchdogDelayMs(method: string): number {
  const cfg = pushConfig();
  if (!cfg) return PUSH_ASK_WATCHDOG_MS;
  return method === "session/request_permission"
    ? (cfg.permissionAskDelayMs ?? PUSH_PERMISSION_ASK_WATCHDOG_MS)
    : (cfg.askDelayMs ?? PUSH_ASK_WATCHDOG_MS);
}

/**
 * Arm the watchdog for one dispatched user-facing ask (permission,
 * elicitation, AskUserQuestion, plan approval, sandbox grant). Fire-and-forget:
 * at the kind's delay (see {@link askWatchdogDelayMs}) with the ask still
 * pending and nothing yet notified, push the same derived payload — clients
 * connected or not.
 */
export function armAskWatchdog(method: string, params?: unknown, label?: string): void {
  askPending++;
  if (askNotified) return;
  const delay = askWatchdogDelayMs(method);
  // A faster tier arriving behind a slower one re-arms the slot at ITS delay
  // and payload: a permission ask (15s) queued behind an elicitation (120s)
  // would otherwise sit silent for the whole slower window — the single-slot
  // "first ask wins" must never out-wait the most urgent outstanding ask.
  if (askTimer) {
    if (delay >= askTimerDelayMs) return;
    clearTimeout(askTimer);
  }
  const data = interactionPushData(method, params, label);
  askTimer = setTimeout(() => {
    askTimer = null;
    askTimerDelayMs = 0;
    if (askPending <= 0 || askNotified) return;
    const cfg = pushConfig();
    if (!cfg || !cfg.notify.ask) return;
    const s = pushSender();
    if (!s) return;
    askNotified = true;
    dispatchPush(cfg, s, data);
  }, delay);
  askTimerDelayMs = delay;
  askTimer.unref?.();
}

/** Settle one ask: clear the timer and reset the notification slot once none remain. */
export function clearAskWatchdog(): void {
  askPending = Math.max(0, askPending - 1);
  if (askPending === 0) {
    if (askTimer) {
      clearTimeout(askTimer);
      askTimer = null;
      askTimerDelayMs = 0;
    }
    askNotified = false;
  }
}

/** Test hook: drop the whole watchdog slot (pending count, timer, notified flag). */
export function resetAskWatchdogForTests(): void {
  if (askTimer) {
    clearTimeout(askTimer);
    askTimer = null;
    askTimerDelayMs = 0;
  }
  askPending = 0;
  askNotified = false;
}

/**
 * §5.1: derive the permission/question payload at the zero-clients branch of
 * `requestAny` (broadcast.ts) — the single hook covering permission requests,
 * AskUserQuestion, and elicitation. Gated by `notify.ask` (default on); a
 * dispatched push marks the notification slot so the watchdog does not
 * duplicate it.
 */
export function pushInteractionIfOffline(
  server: ZcodeAcpServer,
  method: string,
  params?: unknown,
): void {
  const cfg = pushConfig();
  if (!cfg || !cfg.notify.ask) return;
  if (server.clients.size > 0) return;
  const s = pushSender();
  if (!s) return;
  askNotified = true;
  // Every server→client ask carries the ACP sessionId — the same key
  // sessionTitles is indexed by, so the label lands without plumbing a new
  // hook signature through the broadcast observer.
  const sid = (params as { sessionId?: unknown } | undefined)?.sessionId;
  dispatchPush(
    cfg,
    s,
    interactionPushData(
      method,
      params,
      pushSourceLabel(server, typeof sid === "string" ? sid : undefined),
    ),
  );
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
