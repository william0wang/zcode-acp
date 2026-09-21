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
 *   1. Resume/load FALLBACK overlay (`buildResumeRuntimeModel`, via
 *      `resumePreservingModel` in handlers/session.ts): sessions are resumed
 *      faithfully (keeping their own model) and this overlay is only applied
 *      when that resume fails outright — history carrying a stale/revoked
 *      third-party model. It pins onto the FIRST enabled provider's FIRST
 *      model as a known-working repair, not as a default choice.
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

import { accountProviderIdFor } from "./account-provider.js";
import { buildModelElement, type ModelEntry } from "./provider-registry.js";
import {
  findProviderConfig,
  formatModelValue,
  isBuiltinProvider,
  loadAllModels,
  parseModelValue,
  personalModelSpec,
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
 * Build the resume-time FALLBACK overlay pinned to the first enabled
 * provider's first model — a known-working repair for sessions whose history
 * references an unavailable model. Only applied when a faithful (no-overlay)
 * resume fails; see resumePreservingModel in handlers/session.ts.
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
 * 3.12+ schema (source-verified 2026-09-21 against the open-sourced 0.16.9):
 * `zcodeSessionSetModelParamsSchema` is strict and `model` must be the
 * modelSelectionSchema OBJECT — no `runtimeModel` key, no string form
 * (zcode-protocol/index.ts:1952-1959; model-selection.ts:4-15). The object
 * form REQUIRES `options.reasoningLevel` for models that declare levels
 * ("Reasoning level is required for <p>/<m>"); the string form that skips that
 * check exists only inside the app facade and is unreachable over the
 * protocol. We therefore send the target model's own default level, read from
 * the captured create/resume snapshot when we have it, and fall back to
 * omitting `options` for level-less models.
 *
 * Provider ids are translated to the registry's own spelling: config.json says
 * `builtin:bigmodel-coding-plan` while the registry exposes
 * `account:bigmodel-individual-coding-plan` (see account-provider.ts). An
 * untranslated id fails with "Provider Registry 中不存在 Model".
 */
export async function applyModelSwitch(
  server: ZcodeAcpServer,
  zcodeSid: string,
  value: string,
): Promise<boolean> {
  const { providerId, modelId } = parseModelValue(value);
  const backend = server.ensureBackend();
  const registryProviderId = accountProviderIdFor(providerId);
  const model: Record<string, unknown> = { providerId: registryProviderId, modelId };
  // The object form requires the level for level-bearing models; resolve the
  // target's authoritative default from the captured create/resume snapshot.
  const level = resolveDefaultReasoningLevel(server, zcodeSid, registryProviderId, modelId);
  if (level) model.options = { reasoningLevel: level };
  const resp = await backend.request(
    server.nextId(),
    "session/setModel",
    { sessionId: zcodeSid, model, persistAsWorkspaceLastUsed: false },
    15000,
  );
  if (resp.error) {
    warn(`runtime-model: switch failed: ${resp.error.message}`);
    return false;
  }
  invalidateModelCache(server, zcodeSid);
  return true;
}

/**
 * The reasoning level a switch should start the model at.
 *
 * The object form REQUIRES a level for level-bearing models
 * ("Reasoning level is required for <p>/<m>"), so one must be supplied. The
 * backend's own answer is the only correct source: config.json's
 * `reasoning.variants` go stale (observed 2026-09 — a third-party model
 * configured `off/high/max` actually ran `low/high/max`). `session/create`'s
 * captured availability list (server.modelAvailability) carries the
 * authoritative `defaultLevel`; models that declare no levels yield null and
 * callers omit `options` so they accept the switch.
 */
function resolveDefaultReasoningLevel(
  server: ZcodeAcpServer,
  zcodeSid: string,
  providerId: string,
  modelId: string,
): string | null {
  const cached = server.modelAvailability.get(zcodeSid) ?? [];
  const hit = cached.find((a) => a.providerId === providerId && a.modelId === modelId);
  if (hit?.defaultLevel) return hit.defaultLevel;
  if (hit) return null; // present but level-less — omit options
  // Not in the captured list (a model the registry gained after create):
  // fall back to config.json's declaration rather than sending no level.
  try {
    const p = findProviderConfig(providerId);
    const entry = (
      p?.models as
        | Record<
            string,
            { reasoning?: { enabled?: boolean; variants?: string[]; defaultVariant?: string } }
          >
        | undefined
    )?.[modelId];
    const reasoning = entry?.reasoning;
    if (reasoning && reasoning.enabled !== false) {
      if (reasoning.defaultVariant) return reasoning.defaultVariant;
      if (reasoning.variants?.length) return reasoning.variants[0]!;
    }
  } catch {
    // unreadable config — try the personal config below
  }
  // In config.json neither — a model the desktop added to its personal
  // provider config after this session was created. The rule carries the
  // level vocabulary (`optionSpecs.reasoningLevel`); its declared default or
  // first value is the best-effort level (omitting `options` would hard-fail
  // a level-bearing switch).
  try {
    const spec = personalModelSpec(providerId, modelId);
    const values = spec?.reasoningValues;
    if (values?.length) return values[0]!;
  } catch {
    // unreadable personal config — omit options
  }
  return null;
}

/** Invalidate the session-level model cache after a switch. */
export function invalidateModelCache(server: ZcodeAcpServer, zcodeSid: string): void {
  server.modelCache.delete(zcodeSid);
}

// Re-exported so callers that only import runtime-model.ts can format values.
export { formatModelValue };
