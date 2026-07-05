/**
 * runtimeModel overlay plumbing.
 *
 * The backend resolves auth from its OAuth token store, so the `runtimeModel`
 * provider deliberately carries NO `apiKey` (the config.json apiKey is the
 * legacy plain key and has expired → 401). Two uses:
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

import { readFileSync } from "node:fs";

import { ZCODE_CREDS_PATH, log, warn } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";

interface ProviderConfig {
  providerId: string;
  kind: string;
  baseURL: string;
  modelId: string;
  models: string[];
}

interface ProviderEntry {
  enabled?: boolean;
  kind?: string;
  options?: { baseURL?: string };
  models?: Record<string, unknown>;
}

interface ConfigJson {
  provider?: Record<string, ProviderEntry>;
}

const DEFAULTS: ProviderConfig = {
  providerId: "builtin:bigmodel-coding-plan",
  kind: "anthropic",
  baseURL: "https://open.bigmodel.cn/api/anthropic",
  modelId: "GLM-5.2",
  models: ["GLM-5.2"],
};

/** Read the enabled provider's config from config.json (no apiKey). */
function readEnabledProvider(): ProviderConfig {
  try {
    const cfg = JSON.parse(readFileSync(ZCODE_CREDS_PATH, "utf8")) as ConfigJson;
    for (const [pid, p] of Object.entries(cfg.provider ?? {})) {
      if (p?.enabled) {
        const opts = p.options ?? {};
        const modelKeys = Object.keys(p.models ?? {});
        return {
          providerId: pid,
          kind: p.kind ?? DEFAULTS.kind,
          baseURL: opts.baseURL || DEFAULTS.baseURL,
          modelId: modelKeys[0] ?? DEFAULTS.modelId,
          models: modelKeys.length > 0 ? modelKeys : DEFAULTS.models,
        };
      }
    }
  } catch (e) {
    log(`runtime-model: read config.json failed (${e instanceof Error ? e.message : String(e)})`);
  }
  return DEFAULTS;
}

/** Build a runtimeModel overlay object for the enabled provider. */
export function buildRuntimeModel(modelId?: string, revision = "bridge"): unknown | null {
  const pc = readEnabledProvider();
  const targetModel = modelId ?? pc.modelId;
  return {
    revision,
    generatedAt: Date.now(),
    model: { providerId: pc.providerId, modelId: targetModel },
    provider: {
      providerId: pc.providerId,
      kind: pc.kind,
      baseURL: pc.baseURL,
      models: pc.models.map((m) => ({ modelId: m })),
    },
  };
}

/** Build the resume-time overlay (current enabled provider, default model). */
export function buildResumeRuntimeModel(): unknown | null {
  return buildRuntimeModel(undefined, "bridge-resume");
}

/**
 * Switch a session's model via session/updateRuntimeModelConfig.
 *
 * Uses `applyModelSelection:true` so the change applies at runtime without
 * persistence — sidestepping `session/setModel`'s "no loaded config file"
 * failure. Invalidates the model cache on success. Returns true on success.
 */
export async function applyModelSwitch(
  server: ZcodeAcpServer,
  zcodeSid: string,
  modelId: string,
): Promise<boolean> {
  const runtimeModel = buildRuntimeModel(modelId, "bridge-switch");
  if (runtimeModel === null) {
    log("runtime-model: cannot read provider config (config.json)");
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
