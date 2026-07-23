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
 * Used by the model switch path: UI/slash model switching goes through
 * `session/updateRuntimeModelConfig` with `applyModelSelection:true` (a
 * runtime-only change, sidestepping `session/setModel`'s "no loaded config
 * file" persistence failure). Third-party providers are therefore supported
 * only mid-conversation; session/resume loads with the backend's default
 * (builtin) model — sending a runtimeModel there triggers "Invalid params"
 * because session/resume's schema rejects provider.apiKey.
 */

import { findProviderConfig, formatModelValue, parseModelValue } from "./options.js";
import type { ModelRef } from "./options.js";
import { log, warn } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";

const DEFAULT_KIND = "anthropic";
const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/anthropic";

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
