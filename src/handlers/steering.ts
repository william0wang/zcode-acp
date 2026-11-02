/**
 * `_session/steering` — the cross-adapter ACP steering extension (the
 * codex-acp / claude-agent-acp convention), restoring mid-turn steering on
 * app-server 0.16+ (#352).
 *
 * The v3 surface cannot steer: `session/send` fails fast while a turn runs
 * (-32010), and the old `session/steer` method was removed upstream in favor
 * of the v4 delivery semantics. Steer lives in the `v4/command` `sendText`
 * payload: `requestedDelivery:"guide"` injects into the live turn (core's
 * turn-steer), `"queue"` delivers at the next turn boundary. The bridge
 * already speaks `v4/command` (the dual stop, renames, workflow launches),
 * so this handler is a thin mapping onto that channel.
 *
 * Contract (mirrors codex-acp; additive extras in parentheses):
 *   request  `{ sessionId, prompt: ContentBlock[],
 *              _meta?: { steering?: { priority?: "now"|"next" (ours),
 *                                      idleBehavior?: "promptRequired" } } }`
 *   reply    `{ outcome: "injected" }` | `{ outcome: "queued" (ours) }` |
 *            `{ outcome: "startedNewTurn" }` |
 *            `{ outcome: "promptRequired", reason: "noRunningTurn" }`
 *
 * The agent advertises the extension via `InitializeResponse._meta.steering`
 * (`{ supported: true, timings: ["now","next"] }` — timings declared because
 * the reply shape cannot reveal them; codex-acp advertises `{supported}` only).
 *
 * This bridge never auto-starts a turn from a steering request (every idle
 * outcome is `promptRequired` — codex's opt-in `startedNewTurn` idleBehavior
 * is declined on purpose): a steering text is a course correction, not a
 * prompt, and a surprise turn would race the host's own `session/prompt`.
 */

import { randomUUID } from "node:crypto";

import { RequestError } from "@agentclientprotocol/sdk";

import type { ZcodeAcpServer } from "../server.js";
import { clientConnectionRoot, log, warn } from "../utils.js";
import { ensureRealSession } from "./session.js";

/** v4/command sendText budget — the ack resolves at admission, not injection. */
const STEERING_COMMAND_TIMEOUT_MS = 15_000;

interface SteeringResult {
  outcome: "injected" | "queued" | "startedNewTurn" | "promptRequired";
  reason?: string;
}

/** Flatten ACP content blocks to the plain text v4 sendText carries. */
function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  const parts: string[] = [];
  for (const block of prompt) {
    const b = block as { type?: unknown; text?: unknown };
    if (b?.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b?.type === "text") {
      throw new RequestError(-32602, "steering prompt text block has no text");
    } else {
      // v4 sendText steer is text-only (guide with attachments is not
      // steerable upstream); refuse the block instead of silently dropping.
      throw new RequestError(
        -32602,
        `steering prompt accepts text blocks only (got ${String(b?.type ?? "unknown")})`,
      );
    }
  }
  return parts.join("\n");
}

/**
 * Whether a turn is running for the zcode session, best-effort. Bridge-local
 * state first (a pending bridge turn or an active background-notification
 * window prove liveness with no RPC); otherwise one `session/read` projection
 * probe. A stale "running" verdict is harmless here: the v4 ack's `delivery`
 * is the authoritative outcome and a guide sent to an idle session answers
 * `startNow`, which this handler reports honestly as `startedNewTurn`.
 */
async function turnRunning(server: ZcodeAcpServer, zcodeSid: string): Promise<boolean> {
  for (const turn of server.pendingTurns.values()) {
    if (turn.zcodeSid === zcodeSid) return true;
  }
  if (server.notifyTurnActiveSince.has(zcodeSid)) return true;
  try {
    const backend = await server.ensureBackend();
    const resp = await backend.request(
      server.nextId(),
      "session/read",
      { sessionId: zcodeSid },
      10_000,
    );
    if (resp.error) throw new Error(resp.error.message ?? "session/read failed");
    const status = (resp.result as { projection?: { status?: string } } | null)?.projection?.status;
    return status === "running";
  } catch (e) {
    warn(
      `steering: session/read liveness probe failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    // The send itself will surface the real error; treat as running.
    return true;
  }
}

/** `_session/steering` → `v4/command` sendText (guide | queue). */
export async function steering(
  server: ZcodeAcpServer,
  params: { sessionId: string; prompt?: unknown; _meta?: unknown },
  /** The requesting connection's AgentContext (ctx.client) — read only for
   * its per-connection root (clientConnectionRoot) to exclude the steerer
   * from the later drain echo. */
  origin?: unknown,
): Promise<SteeringResult> {
  const zcodeSid = await ensureRealSession(server, params.sessionId);

  const meta = (params._meta as { steering?: Record<string, unknown> } | undefined)?.steering;
  if (meta !== undefined && (meta === null || typeof meta !== "object" || Array.isArray(meta))) {
    throw new RequestError(-32602, "steering _meta.steering must be an object");
  }
  const idleBehavior = meta?.["idleBehavior"];
  if (idleBehavior !== undefined && idleBehavior !== "promptRequired") {
    throw new RequestError(-32602, "unsupported steering idleBehavior");
  }
  const priority = meta?.["priority"];
  if (priority !== undefined && priority !== "now" && priority !== "next") {
    throw new RequestError(-32602, "unsupported steering priority");
  }
  // "now" (and the codex-acp default, no priority at all) injects into the
  // live turn; "next" queues behind it for the next boundary.
  const requestedDelivery = priority === "next" ? "queue" : "guide";

  const text = promptText(params.prompt).trim();
  if (!text) throw new RequestError(-32602, "steering prompt is empty");

  if (!(await turnRunning(server, zcodeSid))) {
    log(`steering: no running turn for ${zcodeSid.slice(-8)} → promptRequired`);
    return { outcome: "promptRequired", reason: "noRunningTurn" };
  }

  const backend = await server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    "v4/command",
    {
      commandId: randomUUID(),
      clientId: "zcode-acp-server",
      sessionId: zcodeSid,
      type: "sendText",
      payload: { text, requestedDelivery },
      issuedAt: Date.now(),
    },
    STEERING_COMMAND_TIMEOUT_MS,
  );
  if (resp.error) {
    throw new RequestError(-32603, `steering failed: ${resp.error.message ?? "unknown error"}`);
  }
  const ack = (resp.result ?? {}) as {
    status?: string;
    reasonCode?: string;
    message?: string;
    result?: { type?: string; delivery?: string };
  };
  if (ack.status !== "accepted") {
    const detail = ack.message ?? ack.reasonCode ?? ack.status ?? "not accepted";
    throw new RequestError(-32603, `steering rejected by backend: ${detail}`);
  }
  // The agent owns the message from here on, and the steering client
  // renders it LOCALLY (martty keeps its Send Now cell on injected/
  // startedNewTurn; a priority:"next" client shows its queued state).
  // Record the origin so the later drain echo (echoSteeredInputs) excludes
  // it — the steerer must not see the injected text twice.
  if (origin) {
    server.suppressSteerEcho(zcodeSid, clientConnectionRoot(origin));
  }
  const delivery = ack.result?.type === "inputAccepted" ? ack.result.delivery : undefined;
  if (delivery === "guide") {
    log(`steering: injected into the live turn of ${zcodeSid.slice(-8)}`);
    return { outcome: "injected" };
  }
  if (delivery === "queue") {
    // Explicit "next", or guide fell back to queue upstream (the turn's kind
    // cannot take live injection — the input WILL run at the next boundary).
    log(`steering: queued behind the running turn of ${zcodeSid.slice(-8)}`);
    return { outcome: "queued" };
  }
  if (delivery === "startNow") {
    // Lost the race: the turn ended between the liveness probe and the
    // admission, and the backend started a new turn from the steer text.
    log(`steering: session was idle at admission → started a new turn`);
    return { outcome: "startedNewTurn" };
  }
  throw new RequestError(-32603, `steering: unexpected backend ack (status=accepted)`);
}
