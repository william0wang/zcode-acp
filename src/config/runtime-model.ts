/**
 * runtimeModel overlay plumbing.
 *
 * The runtimeModel NEVER carries `provider.apiKey`: the backend's runtimeModel
 * schema (`.strict()`) types apiKey as a discriminated union object
 * `{source:"inline"|"credential"|"env"|"server-config", ...}` — a bare string
 * is rejected with "Invalid params". The backend resolves auth itself from
 * config.json / its OAuth store, so the overlay only needs to name the
 * provider+model.
 *
 * Two uses:
 *
 *   1. Resume/load overlay (`buildResumeRuntimeModel`): a resumed session may
 *      carry a stale/revoked model in its history → send fails with "历史模型
 *      不可用". The overlay pins the session onto the default model — the FIRST
 *      enabled provider's FIRST model, the same one a fresh `session/new` lands
 *      on — so resume never inherits the session's last-used (possibly
 *      third-party / unavailable) model.
 *
 *   2. Model switch (`applyModelSwitch`): UI/slash model switching goes through
 *      `session/setModel` with both a `model` ref and a `runtimeModel` provider
 *      definition (runtime-only via `persistAsWorkspaceLastUsed:false`).
 */

import { findProviderConfig, formatModelValue, loadAllModels, parseModelValue } from "./options.js";
import type { ModelRef } from "./options.js";
import { log, warn } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";

const DEFAULT_KIND = "anthropic";
const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/anthropic";

/** Build a runtimeModel overlay for the given provider+model (no apiKey). */
export function buildRuntimeModel(ref: ModelRef, revision = "bridge"): unknown | null {
  const p = findProviderConfig(ref.providerId);
  if (!p) {
    log(`runtime-model: provider "${ref.providerId}" not in config.json`);
    return null;
  }
  const baseURL = p.options?.baseURL ?? DEFAULT_BASE_URL;
  const models =
    Object.keys(p.models ?? {}).length > 0
      ? Object.keys(p.models ?? {}).map((m) => ({ modelId: m }))
      : [{ modelId: ref.modelId }];
  return {
    revision,
    generatedAt: Date.now(),
    model: { providerId: ref.providerId, modelId: ref.modelId },
    provider: {
      providerId: ref.providerId,
      kind: p.kind ?? DEFAULT_KIND,
      baseURL,
      models,
    },
  };
}

/**
 * Build the resume-time overlay pinned to the default model: the FIRST enabled
 * provider's FIRST model (the same one a fresh `session/new` lands on). This
 * ensures resume never inherits the session's last-used model, which may be a
 * now-unavailable third-party model (e.g. Nvidia) and cause "历史模型不可用".
 */
export function buildResumeRuntimeModel(): unknown | null {
  const first = loadAllModels()[0];
  if (!first) {
    log("runtime-model: no enabled provider in config.json (resume overlay skipped)");
    return null;
  }
  return buildRuntimeModel(first, "bridge-resume");
}

/**
 * Switch a session's model via `session/setModel`.
 *
 * `value` is the configOption value: either `"providerId\modelId"` (encoded) or
 * a legacy plain modelId (resolved to the first enabled builtin provider).
 *
 * Sends BOTH a `model` ref (the target) AND a `runtimeModel` (the full provider
 * definition). The runtimeModel lets the backend register the provider into its
 * workspace catalog (so even third-party / non-default models are recognised),
 * while `model` names the selection. `persistAsWorkspaceLastUsed:false` keeps
 * this a runtime-only change. Invalidates the model cache on success.
 *
 * NOTE: the older `session/updateRuntimeModelConfig` path returns `changed:false`
 * on current backends without applying — `session/setModel` is the working
 * protocol since the backend model-management refactor.
 */
export async function applyModelSwitch(
  server: ZcodeAcpServer,
  zcodeSid: string,
  value: string,
): Promise<boolean> {
  const { providerId, modelId } = parseModelValue(value);
  const runtimeModel = buildRuntimeModel({ providerId, providerName: providerId, modelId });
  if (runtimeModel === null) {
    log(`runtime-model: cannot build overlay for "${value}" (provider not found)`);
    return false;
  }
  const backend = server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    "session/setModel",
    {
      sessionId: zcodeSid,
      model: { providerId, modelId },
      runtimeModel,
      persistAsWorkspaceLastUsed: false,
    },
    15000,
  );
  if (resp.error) {
    warn(`runtime-model: switch failed: ${resp.error.message}`);
    return false;
  }
  invalidateModelCache(server, zcodeSid);
  return true;
}

/** Invalidate the session-level model cache after a switch. */
export function invalidateModelCache(server: ZcodeAcpServer, zcodeSid: string): void {
  server.modelCache.delete(zcodeSid);
}

// Re-exported so callers that only import runtime-model.ts can format values.
export { formatModelValue };
