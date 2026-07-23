/**
 * Session-level model cache + initial usage emission.
 *
 * `currentModelCached` avoids a `session/read` round-trip on every usage_update
 * (a high-frequency path). `emitInitialUsage` sends one usage_update right
 * after resume/load so the editor shows the context bar immediately (only when
 * there's actual token data — resume before any turn has 0, which we skip).
 */

import type * as acp from "@agentclientprotocol/sdk";

import type { ZcodeReadResult } from "../backend/types.js";
import { formatModelValue, loadAllModels, modelContextWindow, parseModelValue } from "./options.js";
import { log } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";
import { dispatchEvent } from "../handlers/dispatch.js";
import type { ProjectionDiffer } from "../translators/projection-differ.js";

/**
 * Read the session's current model as an encoded `"providerId\modelId"` string,
 * with a per-session cache. Returns the encoded form so callers can resolve the
 * provider (for context-window lookup / model switching) without a second read.
 */
export async function currentModelCached(
  server: ZcodeAcpServer,
  zcodeSid: string,
): Promise<string> {
  const cached = server.modelCache.get(zcodeSid);
  if (cached) return cached;
  let providerId = "";
  let modelId = "GLM-5.2";
  try {
    const read = await sessionRead(server, zcodeSid);
    const settings = (read.settings ?? {}) as Record<string, unknown>;
    const cur = (settings.model as { current?: { providerId?: string; modelId?: string } })
      ?.current;
    if (cur?.providerId) providerId = cur.providerId;
    if (cur?.modelId) modelId = cur.modelId;
  } catch (e) {
    log(`model-cache: session/read failed (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!providerId) {
    // Legacy session without a providerId — resolve to the first enabled provider.
    providerId = loadAllModels()[0]?.providerId ?? "builtin:bigmodel-coding-plan";
  }
  const encoded = formatModelValue(providerId, modelId);
  server.modelCache.set(zcodeSid, encoded);
  return encoded;
}

/**
 * Emit an initial usage_update after resume/load so the editor shows the
 * context bar. Skips when there's no token data (resume before any turn → 0).
 * Also syncs the differ's usage baseline so the first turn won't re-emit it.
 *
 * Note: the backend's `projection.contextUsed` is 0 after resume — it only
 * updates after a new turn completes. So a resumed session with history won't
 * show a context bar until the first post-resume message. That's acceptable:
 * we don't have a reliable way to estimate the pre-resume context size, and
 * guessing wrong (e.g. from per-turn token totals that include re-sent history)
 * is worse than showing nothing.
 */
export async function emitInitialUsage(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
  differ: ProjectionDiffer | undefined,
): Promise<void> {
  try {
    const read = await sessionRead(server, zcodeSid);
    const proj = (read.projection ?? {}) as {
      contextUsed?: number;
      totalTokenCount?: number;
      contextWindow?: number;
    };
    // `||` (not `??`): an explicit contextUsed=0 is falsy and should fall back
    // to totalTokenCount, matching Python's `proj.get("contextUsed",0) or ...`.
    const used = proj.contextUsed || proj.totalTokenCount || 0;
    if (!used) return; // resume before any turn: skip to avoid showing 0.
    let size = proj.contextWindow ?? 0;
    if (!size) {
      const { providerId, modelId } = parseModelValue(await currentModelCached(server, zcodeSid));
      size = modelContextWindow(providerId, modelId);
    }
    await dispatchEvent(
      server,
      cx,
      acpSid,
      { kind: "UsageDelta", used, size },
      `init_${zcodeSid.slice(0, 8)}`,
    );
    differ?.setLastUsage(used);
  } catch (e) {
    log(`model-cache: emit_initial_usage failed (${e instanceof Error ? e.message : String(e)})`);
  }
}

async function sessionRead(server: ZcodeAcpServer, zcodeSid: string): Promise<ZcodeReadResult> {
  const backend = server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    "session/read",
    { sessionId: zcodeSid },
    5000,
  );
  if (resp.error) throw new Error(resp.error.message);
  return (resp.result ?? {}) as ZcodeReadResult;
}
