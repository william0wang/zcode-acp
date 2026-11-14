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
 * protocol.
 *
 * The reasoning level is attempted down a LADDER (best candidate first, then
 * omission, then the remaining candidates): setModel validates the selection
 * against the live registry BEFORE anything is stopped or created, so a
 * rejected attempt is a cheap pre-flight — but a stale local file naming a
 * level the registry doesn't know hard-failed EVERY switch to the model
 * (observed 2026-09-28: config.json said "max", the registry def had no such
 * level, four consecutive switches to the same model died with
 * `Reasoning effort "max" is not supported by …`). Level-unrelated errors
 * abort the ladder immediately.
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
  const backend = await server.ensureBackend();
  const generation = server.backendGeneration;
  let { providerId, modelId } = parseModelValue(value);
  // A legacy bare ID is safe only if it identifies exactly one registry pair.
  // A live snapshot supersedes local files, including when it has no match.
  if (!value.includes("\\") && !/^custom:[^:]+:.+$/.test(value)) {
    const models = server.modelAvailability.get(zcodeSid) ?? loadAllModels();
    const providers = new Set(models.filter((m) => m.modelId === value && m.providerId)
      .map((m) => accountProviderIdFor(m.providerId!)));
    if (providers.size !== 1) return false;
    providerId = [...providers][0]!;
    modelId = value;
  }
  if (!providerId || !modelId) return false;
  const registryProviderId = accountProviderIdFor(providerId);
  const candidates = candidateReasoningLevels(server, zcodeSid, registryProviderId, modelId);
  // [best, omit, rest]: omission second so a level-less registry def succeeds
  // on attempt two even when local files claim the model has levels.
  const attempts: Array<string | undefined> = [];
  const seenAttempts = new Set<string>();
  for (const attempt of [candidates[0], undefined, ...candidates.slice(1)]) {
    const key = attempt ?? "\u0000omit";
    if (seenAttempts.has(key)) continue;
    seenAttempts.add(key);
    attempts.push(attempt);
    if (attempts.length >= 5) break;
  }
  let lastError = "unknown error";
  for (let i = 0; i < attempts.length; i++) {
    const level = attempts[i];
    const model: Record<string, unknown> = { providerId: registryProviderId, modelId };
    if (level) model.options = { reasoningLevel: level };
    const resp = await backend.request(
      server.nextId(),
      "session/setModel",
      { sessionId: zcodeSid, model, persistAsWorkspaceLastUsed: false },
      15000,
    );
    if (generation !== server.backendGeneration) return false;
    if (!resp.error) {
      server.currentModelIdentity.set(zcodeSid, { providerId: registryProviderId, modelId });
      invalidateModelCache(server, zcodeSid);
      return true;
    }
    lastError = resp.error.message ?? lastError;
    // Only level-shape rejections are ladder-recoverable; anything else
    // (provider/model not found, busy, schema) fails the switch outright.
    if (!LEVEL_REJECTED.test(lastError) && !LEVEL_REQUIRED.test(lastError)) break;
    log(`runtime-model: level attempt "${level ?? "<omitted>"}" rejected: ${lastError}`);
  }
  warn(`runtime-model: switch failed: ${lastError}`);
  return false;
}

/** setModel rejections that mean "this LEVEL is wrong", not "this switch is wrong". */
const LEVEL_REJECTED = /Reasoning effort ".*" is not supported by/u;
const LEVEL_REQUIRED = /Reasoning level is required for/u;

/**
 * Reasoning-level candidates for a switch, most-trustworthy first:
 *
 * 1. The create/resume snapshot (`server.modelAvailability`) — the registry's
 *    own def at capture time. A hit that declares NO levels is final: the
 *    backend already said the model is level-less, and file-declared variants
 *    are exactly the stale-fiction that broke switches.
 * 2. The personal provider config (`provider_config.json`) — the registry's
 *    INPUT file for 3.12+ custom models. Default = LAST value, mirroring the
 *    upstream default rule (`values.at(-1)`, model-catalog-port.ts).
 * 3. Legacy config.json — stale by design since 3.12 stopped syncing it.
 */
function candidateReasoningLevels(
  server: ZcodeAcpServer,
  zcodeSid: string,
  providerId: string,
  modelId: string,
): string[] {
  const out: string[] = [];
  const push = (v: string | undefined): void => {
    if (v && !out.includes(v)) out.push(v);
  };
  const cached = server.modelAvailability.get(zcodeSid) ?? [];
  const hit = cached.find((a) => a.providerId === providerId && a.modelId === modelId);
  if (hit) {
    if (!hit.defaultLevel && !hit.levels?.length) return [];
    push(hit.defaultLevel);
    for (const level of hit.levels ?? []) push(level);
  }
  try {
    const values = personalModelSpec(providerId, modelId)?.reasoningValues ?? [];
    push(values.at(-1));
    for (const v of values) push(v);
  } catch {
    // unreadable personal config — fall through
  }
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
      push(reasoning.defaultVariant);
      for (const v of reasoning.variants ?? []) push(v);
    }
  } catch {
    // unreadable config.json — whatever we already have is the list
  }
  return out;
}

/** Invalidate the session-level model cache after a switch. */
export function invalidateModelCache(server: ZcodeAcpServer, zcodeSid: string): void {
  server.modelCache.delete(zcodeSid);
}

// Re-exported so callers that only import runtime-model.ts can format values.
export { formatModelValue };
