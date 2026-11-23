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
import { defaultModelRef, formatModelValue, parseModelValue, usageWindowSize } from "./options.js";
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
  let modelId = "";
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
  if (!providerId || !modelId) {
    // A session without a complete identity reports the default model's.
    const fallback = defaultModelRef();
    providerId ||= fallback.providerId;
    modelId ||= fallback.modelId;
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
    const proj = (read.projection ?? {}) as { contextUsed?: number; contextWindow?: number };
    // Occupancy only (#228): totalTokenCount is lifetime consumption — never
    // a context meter. contextUsed absent/0 → nothing trustworthy to show
    // yet; the completion diff reports real occupancy once turns run.
    const used = proj.contextUsed ?? 0;
    if (!used) return; // resume before any turn: skip to avoid showing 0.
    // The context-window ladder (`usageWindowSize`) wins over the projection's
    // contextWindow — the same ladder as dispatchUsageDelta and the
    // post-switch refresh, so the gauge never flip-flops between sources.
    const { providerId, modelId } = parseModelValue(await currentModelCached(server, zcodeSid));
    const size = usageWindowSize(providerId, modelId, proj.contextWindow);
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
  const backend = await server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    "session/read",
    // messageLimit: callers read settings/projection only; the cap stops the
    // backend from serializing the session's whole message array for them.
    { sessionId: zcodeSid, messageLimit: 1 },
    5000,
  );
  if (resp.error) throw new Error(resp.error.message);
  return (resp.result ?? {}) as ZcodeReadResult;
}
