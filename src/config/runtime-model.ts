/**
 * runtimeModel overlay plumbing.
 *
 * The runtimeModel names the provider+model a session should use. For THIRD-
 * PARTY providers it also carries `apiKey` as `{source:"inline", value:"<key>"}`;
 * the backend resolves model-call auth from the overlay itself, so omitting it
 * yields HTTP 401 "Missing API key". Builtin providers keep using their own
 * OAuth/config auth and never inline a key. `apiFormat` mirrors `kind`.
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
 *
 * Note: a provider registry push (`workspace/updateProviderRegistry`) is ALSO
 * required for the backend to recognise third-party providers at all — without
 * it the turn fails with `provider_not_configured` before auth is even tried.
 * See provider-registry.ts.
 */

import { buildModelElement, type ModelEntry } from "./provider-registry.js";
import {
  findProviderConfig,
  formatModelValue,
  isBuiltinProvider,
  loadAllModels,
  parseModelValue,
} from "./options.js";
import type { ModelRef } from "./options.js";
import { log, warn } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";

const DEFAULT_KIND = "anthropic";
const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/anthropic";

/** Map config.json `kind` → backend `apiFormat`. */
function apiFormatForKind(kind: string | undefined): string {
  if (kind?.includes("anthropic")) return "anthropic-messages";
  return "openai-chat-completions";
}

/**
 * Build a runtimeModel overlay for the given provider+model.
 *
 * For THIRD-PARTY providers the overlay MUST carry `apiKey` as the inline union
 * `{source:"inline", value:"<key>"}` — the backend resolves model-call auth from
 * the runtimeModel itself, so omitting it yields HTTP 401 "Missing API key".
 * (This was previously believed unnecessary; live probing proved otherwise.)
 * Builtin providers resolve auth from their own OAuth/config store, so no
 * apiKey is sent for them. `apiFormat` mirrors `kind` per the backend's catalog.
 */
export function buildRuntimeModel(ref: ModelRef, revision = "bridge"): unknown | null {
  const p = findProviderConfig(ref.providerId);
  if (!p) {
    log(`runtime-model: provider "${ref.providerId}" not in config.json`);
    return null;
  }
  const baseURL = p.options?.baseURL ?? DEFAULT_BASE_URL;
  // Model elements must carry the full definition (reasoning variants /
  // contextWindow / label) — a bare {modelId} overlay makes the backend fall
  // back to the apiFormat's default 2-state thought levels (enabled/disabled),
  // silently resetting the session's max/high/low dropdown on resume/switch.
  const models = Object.entries(p.models ?? {}).map(([modelId, m]) =>
    buildModelElement(modelId, (m ?? {}) as ModelEntry),
  );
  if (models.length === 0) models.push({ modelId: ref.modelId });
  const provider: Record<string, unknown> = {
    providerId: ref.providerId,
    kind: p.kind ?? DEFAULT_KIND,
    apiFormat: apiFormatForKind(p.kind),
    baseURL,
    models,
  };
  // Third-party providers must inline their apiKey — the backend won't resolve
  // it from anywhere else and the call fails with 401 without it. Builtin
  // providers use OAuth/config auth and must NOT send an inline key.
  if (!isBuiltinProvider(ref.providerId) && p.options?.apiKey) {
    provider.apiKey = { source: "inline", value: p.options.apiKey };
  }
  return {
    revision,
    generatedAt: Date.now(),
    model: { providerId: ref.providerId, modelId: ref.modelId },
    provider,
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
