/**
 * Auto-compact: when the session's context-window usage exceeds a threshold,
 * automatically invoke `session/compact` so the next prompt has room.
 *
 * Configured via `ZCODE_ACP_AUTO_COMPACT_THRESHOLD` (absolute token count;
 * 0/unset = disabled). The compaction target is decided by the zcode backend
 * — we only control *when* to trigger.
 *
 * Triggered from `prompt()` after a successful `end_turn`, before the response
 * returns. Failures are best-effort (logged, never thrown) so they never break
 * the prompt response.
 */

import { randomUUID } from "node:crypto";

import type * as acp from "@agentclientprotocol/sdk";

import { compact } from "../handlers/extensions.js";
import type { ZcodeAcpServer } from "../server.js";
import { log, warn } from "../utils.js";
import { sendTextChunk } from "../handlers/io.js";

/** ENV: `ZCODE_ACP_AUTO_COMPACT_THRESHOLD` — absolute token count (0 = disabled). */
export function autoCompactThreshold(): number {
  const raw = Number(process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD ?? "0");
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

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
    await sendTextChunk(
      cx,
      acpSid,
      `🔄 auto-compact: context usage ${used.toLocaleString()} ≥ threshold ${threshold.toLocaleString()}, compressing…`,
      msgId,
    );

    // compact() handles: session/compact → waitForTurnIdle → emitInitialUsage.
    const result = (await compact(server, { sessionId: acpSid }, cx)) as {
      __lockTimeout?: boolean;
    };
    if (result.__lockTimeout) {
      await sendTextChunk(
        cx,
        acpSid,
        "⚠ auto-compact timed out (300s) — backend may still be processing",
        msgId,
      );
    } else {
      await sendTextChunk(cx, acpSid, "✓ auto-compact: context compressed", msgId);
    }
    log("auto-compact: done");
  } catch (e) {
    warn(`auto-compact: compact failed (${e instanceof Error ? e.message : String(e)})`);
    await sendTextChunk(
      cx,
      acpSid,
      `⚠ auto-compact failed: ${e instanceof Error ? e.message : String(e)}`,
      msgId,
    );
    // Best-effort: never break the prompt response.
  }
}
