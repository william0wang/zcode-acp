/**
 * runtimeModel overlay plumbing.
 *
 * The backend resolves auth either from its OAuth token store (builtin OAuth
 * providers) or from the apiKey embedded in the runtimeModel (custom providers
 * and builtin apiKey-mode providers). `buildRuntimeModel` auto-detects: when the
 * provider's config.json entry has an `options.apiKey`, it is carried into the
 * overlay so the backend can authenticate; otherwise it is omitted and the
 * backend uses its own OAuth creds.
 *
 * Two uses:
 *
 *   1. Resume overlay (`buildResumeRuntimeModel`): a resumed session may carry
 *      a stale provider id in its history that the backend can no longer
 *      authenticate. Sending the *current* enabled provider's runtimeModel at
 *      resume makes the backend overlay it and use its own OAuth creds.
 *
 *   2. Model switch (`applyModelSwitch`): UI/slash model switching goes through
 *      `session/updateRuntimeModelConfig` with `applyModelSelection:true` (a
 *      runtime-only change, sidestepping `session/setModel`'s "no loaded config
 *      file" persistence failure).
 */

import { findProviderConfig, formatModelValue, loadAllModels, parseModelValue } from "./options.js";
import type { ModelRef } from "./options.js";
import { log, warn } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";

const DEFAULT_KIND = "anthropic";
const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/anthropic";

/** The first enabled provider in config.json (used for resume overlay). */
function firstEnabledProvider(): ModelRef | null {
  const all = loadAllModels();
  return all.length > 0 ? all[0] : null;
}

/** Build a runtimeModel overlay for the given provider+model. */
export function buildRuntimeModel(ref: ModelRef, revision = "bridge"): unknown | null {
  const p = findProviderConfig(ref.providerId);
  if (!p) {
    log(`runtime-model: provider "${ref.providerId}" not in config.json`);
    return null;
  }
  const apiKey = p.options?.apiKey;
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
      // Auto-detect: custom/apiKey-mode providers carry their key so the backend
      // can authenticate; OAuth builtins omit it and use backend-managed tokens.
      ...(apiKey ? { apiKey } : {}),
      models,
    },
  };
}

/** Build the resume-time overlay (current enabled provider, default model). */
export function buildResumeRuntimeModel(): unknown | null {
  const first = firstEnabledProvider();
  if (!first) {
    log("runtime-model: no enabled provider in config.json (resume overlay skipped)");
    return null;
  }
  return buildRuntimeModel(first, "bridge-resume");
}

/**
 * Switch a session's model via session/updateRuntimeModelConfig.
 *
 * `value` is the configOption value: either `"providerId\modelId"` (encoded) or
 * a legacy plain modelId (resolved to the first enabled provider). Uses
 * `applyModelSelection:true` so the change applies at runtime without
 * persistence — sidestepping `session/setModel`'s "no loaded config file"
 * failure. Invalidates the model cache on success. Returns true on success.
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
    "session/updateRuntimeModelConfig",
    { sessionId: zcodeSid, runtimeModel, applyModelSelection: true },
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
