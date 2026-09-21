/**
 * Auto-compact: when the session's context-window usage exceeds a threshold,
 * automatically invoke `session/compact` so the next prompt has room.
 *
 * The threshold lives in `autoCompact.threshold` (~/.config/zcode-acp/
 * config.json; absolute token count) with `ZCODE_ACP_AUTO_COMPACT_THRESHOLD`
 * as the env fallback — 0/unset = disabled. The compaction target is decided
 * by the zcode backend — we only control *when* to trigger.
 *
 * Armed by `prompt()` after a successful `end_turn`, but run DETACHED via
 * runAutoCompactDetached once the turn's cleanup has landed (pendingTurns
 * delete + running:false turnState): awaiting it inside the turn kept the
 * FINISHED turn registered for the whole compaction, so any cancel or
 * follow-up prompt preempted it — stopBackendTurn plus the drain gate's
 * close escalation killed the compaction's internal AI turn, the dead lock
 * read as "released", and the bridge reported a false "✓ compressed" while
 * the context never shrank. Failures are best-effort (logged, never thrown).
 */

import { randomUUID } from "node:crypto";

import type * as acp from "@agentclientprotocol/sdk";

import { compact } from "../handlers/extensions.js";
import { messages } from "../i18n.js";
import type { ZcodeAcpServer } from "../server.js";
import { log, warn } from "../utils.js";
import { sendTextChunk } from "../handlers/io.js";
import { autoCompactThreshold } from "./settings.js";

// Re-exported for existing importers (tests, docs); the merge lives in settings.ts.
export { autoCompactThreshold };

/**
 * If the threshold is configured and the session's current context usage meets
 * or exceeds it, invoke `compact()`. No-op when the threshold is unset/zero,
 * when usage is below the threshold, or on any error (best-effort).
 */
export async function maybeAutoCompact(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
): Promise<void> {
  const threshold = autoCompactThreshold();
  if (threshold <= 0) return; // disabled

  const msgId = randomUUID();
  try {
    // Read current context usage via session/read.
    let used = 0;
    try {
      const backend = server.ensureBackend();
      const resp = await backend.request(
        server.nextId(),
        "session/read",
        { sessionId: zcodeSid },
        5000,
      );
      if (resp.error) return;
      const result = (resp.result ?? {}) as { projection?: { contextUsed?: number } };
      used = result.projection?.contextUsed ?? 0;
    } catch (e) {
      warn(`auto-compact: session/read failed (${e instanceof Error ? e.message : String(e)})`);
      return;
    }

    if (used < threshold) return;

    log(`auto-compact: contextUsed=${used} >= threshold=${threshold}, compacting…`);
    const m = messages();
    await sendTextChunk(
      cx,
      acpSid,
      m.autoCompactStart(used.toLocaleString(), threshold.toLocaleString()),
      msgId,
    );

    // compact() handles: session/compact → waitForTurnIdle → emitInitialUsage.
    const result = (await compact(server, { sessionId: acpSid }, cx)) as {
      __lockTimeout?: boolean;
      __compactFailed?: boolean;
    };
    if (result.__lockTimeout) {
      await sendTextChunk(cx, acpSid, m.autoCompactTimeout, msgId);
    } else if (result.__compactFailed) {
      // The backend swallowed the failure into a state.updated notification —
      // without this check the user saw "✓ compressed" while nothing shrank.
      await sendTextChunk(cx, acpSid, m.autoCompactFailed(m.autoCompactBackendFailed), msgId);
    } else {
      await sendTextChunk(cx, acpSid, m.autoCompactDone, msgId);
    }
    log("auto-compact: done");
  } catch (e) {
    warn(`auto-compact: compact failed (${e instanceof Error ? e.message : String(e)})`);
    await sendTextChunk(
      cx,
      acpSid,
      messages().autoCompactFailed(e instanceof Error ? e.message : String(e)),
      msgId,
    );
    // Best-effort: never break the prompt response.
  }
}

/**
 * Arm maybeAutoCompact as a session-level background task, single-flight per
 * backend session id: an armed-but-still-running compaction swallows later
 * arms (the running one covers them). MUST be called only after the arming
 * turn's cleanup (pendingTurns delete + running:false) — runOneTurn's finally
 * guarantees that ordering. Fire-and-forget; never rejects.
 */
export function runAutoCompactDetached(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
): void {
  if (server.autoCompactInFlight.has(zcodeSid)) return;
  server.autoCompactInFlight.add(zcodeSid);
  void maybeAutoCompact(server, cx, acpSid, zcodeSid)
    .catch((e) => {
      warn(`auto-compact: detached run failed (${e instanceof Error ? e.message : String(e)})`);
    })
    .finally(() => server.autoCompactInFlight.delete(zcodeSid));
}

/** Worst-case compaction wall time: settle cap 300s + startup + probe gaps. */
export const AUTO_COMPACT_SETTLE_MS = 330_000;

/**
 * Bounded wait until no detached auto-compact is in flight for the session.
 * For flows with no user to resend (goal-loop rounds, sandbox continuations):
 * prompts are REJECTED during a compaction — their subscribed listener would
 * accumulate the compaction's internal-turn stream as residue — whereas a
 * caller that waits BEFORE subscribing is residue-free by construction.
 * Resolves false on timeout (the compaction may legitimately still run).
 */
export async function waitForAutoCompactIdle(
  server: ZcodeAcpServer,
  zcodeSid: string,
  timeoutMs = AUTO_COMPACT_SETTLE_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (server.autoCompactInFlight.has(zcodeSid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return true;
}
