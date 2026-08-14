/**
 * configOptions + modes construction and session/set_config_option dispatch.
 *
 * Reads `session/read` `settings.*` for current values (NOT projection.mode,
 * which is a zombie value), with config.json fallbacks for the model list.
 * set_config_option: mode/thought forward to setMode/setThoughtLevel; model
 * routes through `runtimeModel` (runtime-model.ts) because the backend rejects
 * the persistence path. After a change, re-builds the option and emits a
 * `config_option_update` (+ `current_mode_update` for mode) so the editor UI
 * reflects the new state.
 */

import { readFileSync } from "node:fs";
import type * as acp from "@agentclientprotocol/sdk";

import type { ZcodeReadResult } from "../backend/types.js";
import { CONFIG_DISPATCH, CONFIG_META, log, ZCODE_CREDS_PATH } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";
import { sendSessionUpdate } from "../handlers/io.js";

interface ProviderModelsJson {
  [modelId: string]: { limit?: { context?: number } } | undefined;
}

/** Read the config.json contents (UTF-8). Throws on read/parse failure. */
function readConfig(): unknown {
  return JSON.parse(readFileSync(ZCODE_CREDS_PATH, "utf8"));
}

/** A single provider's entry in config.json (`provider.<providerId>`). */
interface ProviderEntry {
  name?: string;
  kind?: string;
  enabled?: boolean;
  options?: { baseURL?: string; apiKey?: string };
  models?: ProviderModelsJson;
}

interface ConfigShape {
  provider?: Record<string, ProviderEntry>;
}

/** A model selectable in the dropdown, with its owning provider. */
export interface ModelRef {
  providerId: string;
  providerName: string;
  modelId: string;
}

/**
 * Collect models from config.json for the dropdown.
 *
 * Builtin providers (id prefix `builtin:`) must be `enabled: true` — they
 * reflect the plans the user activated in the ZCode desktop app. Custom
 * (third-party) providers are included UNLESS explicitly `enabled: false`:
 * the newer CLI leaves the flag unset on active third-party providers, so
 * treating "absent" as enabled keeps them in the dropdown while still
 * honoring an explicit disable.
 */
export function loadAllModels(): ModelRef[] {
  try {
    const cfg = readConfig() as ConfigShape;
    const out: ModelRef[] = [];
    for (const [pid, p] of Object.entries(cfg.provider ?? {})) {
      if (isBuiltinProvider(pid)) {
        if (p?.enabled !== true) continue;
      } else if (p?.enabled === false) {
        continue;
      }
      const providerName = p.name ?? pid;
      for (const modelId of Object.keys(p.models ?? {})) {
        out.push({ providerId: pid, providerName, modelId });
      }
    }
    if (out.length === 0) {
      // Fallback: config unreadable or no enabled provider — keep the legacy
      // default so a freshly-installed editor still shows something.
      return [
        {
          providerId: "builtin:bigmodel-coding-plan",
          providerName: "BigModel",
          modelId: "GLM-5.2",
        },
      ];
    }
    return out;
  } catch {
    return [
      { providerId: "builtin:bigmodel-coding-plan", providerName: "BigModel", modelId: "GLM-5.2" },
    ];
  }
}

/** Look up a provider entry by id (any provider, not just enabled). */
export function findProviderConfig(providerId: string): ProviderEntry | null {
  try {
    const cfg = readConfig() as ConfigShape;
    return cfg.provider?.[providerId] ?? null;
  } catch {
    return null;
  }
}

/** Read the context-window size for a provider+model from config.json. */
export function modelContextWindow(providerId: string, modelId: string): number {
  try {
    const cfg = readConfig() as ConfigShape;
    const models = cfg.provider?.[providerId]?.models ?? {};
    const entry = models[modelId];
    return entry?.limit?.context ?? 0;
  } catch {
    return 0;
  }
}

/** Builtin providerIds are prefixed with `builtin:` (e.g. `builtin:bigmodel`). */
export function isBuiltinProvider(providerId: string): boolean {
  return providerId.startsWith("builtin:");
}

/**
 * Encode a provider+model pair into a configOption `value` string.
 *
 * Builtin providers encode as the bare modelId (legacy form, keeps the dropdown
 * clean for the common case). Third-party providers encode as
 * `providerId\modelId` — `\` is unambiguous because providerIds (UUIDs) and
 * modelIds (`/`-separated) never contain it.
 */
export function formatModelValue(providerId: string, modelId: string): string {
  if (isBuiltinProvider(providerId)) return modelId;
  return `${providerId}\\${modelId}`;
}

/**
 * Parse a configOption `value` back into { providerId, modelId }.
 *
 * A value without `\` is a builtin modelId (legacy form) → resolve to the first
 * enabled builtin provider. A value with `\` is a third-party provider+model.
 */
export function parseModelValue(value: string): { providerId: string; modelId: string } {
  const idx = value.indexOf("\\");
  if (idx < 0) {
    // Builtin plain modelId — resolve to the first enabled builtin provider
    // (falling back to the legacy default if none configured).
    const firstBuiltin = loadAllModels().find((m) => isBuiltinProvider(m.providerId));
    return {
      providerId: firstBuiltin?.providerId ?? "builtin:bigmodel-coding-plan",
      modelId: value,
    };
  }
  return { providerId: value.slice(0, idx), modelId: value.slice(idx + 1) };
}

/** Build the ACP SessionModeState ({currentModeId, availableModes}).
 *  zcodeSid null = pending session (session/new not yet materialized) — skip
 *  the backend read and return defaults. */
export async function buildModes(
  server: ZcodeAcpServer,
  zcodeSid: string | null,
): Promise<acp.SessionModeState> {
  let currentMode = "yolo";
  if (zcodeSid !== null) {
    try {
      const read = await sessionRead(server, zcodeSid);
      const settings = (read.settings ?? {}) as Record<string, unknown>;
      const modeSet = (settings.mode as Record<string, unknown>) ?? {};
      currentMode = (modeSet.current as string) ?? currentMode;
    } catch {
      // keep default
    }
  }
  return {
    currentModeId: currentMode,
    // ZCode 3.3.0 mode enum: plan/build/edit/yolo/auto. settings.mode only
    // carries `current` (no `available` list, unlike thoughtLevel), so the full
    // enum is advertised here.
    availableModes: ["plan", "build", "edit", "yolo", "auto"].map((m) => ({
      id: m,
      name: capitalize(m),
    })),
  };
}

/**
 * Canonical display order for thought-level tokens across models
 * (GLM-5.3: low/high/max; GLM-5-Turbo: enabled/off; others may differ).
 * Unknown tokens keep their config order after the known ones.
 */
const THOUGHT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra", "enabled", "disabled", "off"];

export function orderThoughtVariants(variants: string[]): Array<{ value: string; name: string }> {
  const known = THOUGHT_ORDER.filter((t) => variants.includes(t));
  const extra = variants.filter((t) => !THOUGHT_ORDER.includes(t));
  return [...known, ...extra].map((t) => ({ value: t, name: t }));
}

/** Build the ACP configOptions array (3 items: model/mode/thought).
 *  zcodeSid null = pending session — skip the backend read and use defaults;
 *  mode defaults to "yolo" (the mode session/create hardcodes) so the dropdown
 *  matches the mode indicator for a fresh session. */
export async function buildConfigOptions(
  server: ZcodeAcpServer,
  zcodeSid: string | null,
): Promise<acp.SessionConfigOption[]> {
  let currentProviderId = "";
  let currentModelId = "GLM-5.2";
  let currentMode = zcodeSid === null ? "yolo" : "build";
  let currentThought = "high";
  let thoughtOptions: Array<{ value: string; name: string }> | null = null;
  if (zcodeSid === null) {
    // Pending session — no backend to read yet, but the thought vocabulary
    // is per model and the runtime's own source of truth is the enabled
    // provider's models[].reasoning.variants in the local config. Advertise
    // THAT for the default model instead of a hardcoded list: a client that
    // relays the options into a picker (Multica's effort selector) would
    // otherwise offer tokens the runtime rejects ("nothink" was fiction,
    // "low" was missing).
    const cur = loadAllModels()[0];
    if (cur) {
      // The advertised current model follows the dropdown's leading entry
      // (the enabled provider's first model — what the runtime actually
      // starts sessions with) rather than the legacy hardcoded "GLM-5.2".
      // ACP clients skip a requested model switch when it equals the
      // advertised current value, so a stale fiction silently pinned the
      // wrong model whenever the requested id happened to match it.
      currentProviderId = cur.providerId;
      currentModelId = cur.modelId;
      try {
        const cfg = readConfig() as ConfigShape;
        const m = (cfg.provider?.[cur.providerId]?.models as
          | Record<
              string,
              { reasoning?: { enabled?: boolean; variants?: string[]; defaultVariant?: string } }
            >
          | undefined)?.[cur.modelId];
        const reasoning = m?.reasoning;
        const variants = reasoning?.variants;
        if (reasoning?.enabled !== false && variants && variants.length > 0) {
          thoughtOptions = orderThoughtVariants(variants);
          currentThought = reasoning.defaultVariant ?? variants[0];
        }
      } catch {
        // unreadable config — the static fallback below applies
      }
    }
  }

  if (zcodeSid !== null) {
    try {
      const read = await sessionRead(server, zcodeSid);
      const settings = (read.settings ?? {}) as Record<string, unknown>;
      const modeSet = (settings.mode as Record<string, unknown>) ?? {};
      currentMode = (modeSet.current as string) ?? currentMode;
      const modelSet = (settings.model as Record<string, unknown>) ?? {};
      // settings.model.current is { providerId, modelId, variant? } — read BOTH so
      // we can disambiguate same-named models across providers.
      const cur = (modelSet.current as { providerId?: string; modelId?: string }) ?? {};
      if (cur.providerId) currentProviderId = cur.providerId;
      if (cur.modelId) currentModelId = cur.modelId;
      const tlSet = (settings.thoughtLevel as Record<string, unknown>) ?? {};
      currentThought = (tlSet.current as string) ?? currentThought;
      const tlAvail = (tlSet.available as Array<Record<string, string>>) ?? [];
      if (tlAvail.length > 0) {
        thoughtOptions = tlAvail.map((a) => ({ value: a.value, name: a.label ?? a.value }));
      }
    } catch {
      // keep defaults
    }
  }

  // currentValue encodes provider+model so the switch handler can locate the
  // right provider (and its apiKey). Fall back to the first enabled provider
  // when settings omits providerId (legacy sessions).
  const currentModel = formatModelValue(
    currentProviderId || loadAllModels()[0]?.providerId || "builtin:bigmodel-coding-plan",
    currentModelId,
  );

  // Model options: config.json enabled providers are authoritative. Builtin
  // models show as the bare modelId (clean dropdown for the common case);
  // third-party models prefix the provider name so they're distinguishable.
  let modelOptions = loadAllModels().map((m) => ({
    value: formatModelValue(m.providerId, m.modelId),
    name: isBuiltinProvider(m.providerId) ? m.modelId : `${m.providerName} › ${m.modelId}`,
  }));
  if (!modelOptions.some((o) => o.value === currentModel)) {
    // The current model isn't from an enabled provider (e.g. the session was
    // created with a now-disabled provider). Append it so the dropdown still
    // shows the active selection.
    modelOptions = [{ value: currentModel, name: currentModelId }, ...modelOptions];
  }
  if (!thoughtOptions) thoughtOptions = [...CONFIG_META.thought.options];

  return [
    {
      id: "model",
      name: CONFIG_META.model.name,
      category: "model" as acp.SessionConfigOptionCategory,
      type: "select",
      currentValue: currentModel,
      options: modelOptions,
    },
    {
      id: "mode",
      name: CONFIG_META.mode.name,
      category: "mode" as acp.SessionConfigOptionCategory,
      type: "select",
      currentValue: currentMode,
      options: [...CONFIG_META.mode.options],
    },
    {
      id: "thought",
      name: CONFIG_META.thought.name,
      // Category thought_level (not "thought") so ACP clients recognise the
      // option as the reasoning-effort selector: the shared matchers in
      // editors and orchestrators (e.g. Multica's acpEffortOptionIDs) key on
      // id/category "effort"/"thought_level". The id stays "thought" — it is
      // what session/set_config_option addresses.
      category: "thought_level" as acp.SessionConfigOptionCategory,
      type: "select",
      currentValue: currentThought,
      options: thoughtOptions,
    },
  ];
}

/**
 * Dispatch session/set_config_option. mode/thought forward to setMode/
 * setThoughtLevel; model routes through applyModelSwitch (runtime-model.ts).
 *
 * Returns `{ kind, currentValue, options }` so the caller can emit the update
 * notifications, or null when the configId is unknown / model switch fails.
 */
export async function setConfigOption(
  server: ZcodeAcpServer,
  zcodeSid: string,
  configId: string,
  value: string,
): Promise<{ kind: "model" | "mode" | "thought"; currentValue: string } | null> {
  if (configId === "model") {
    const { applyModelSwitch } = await import("./runtime-model.js");
    const ok = await applyModelSwitch(server, zcodeSid, value);
    if (!ok) return null;
    return { kind: "model", currentValue: value };
  }
  const dispatch = CONFIG_DISPATCH[configId];
  if (!dispatch) return null;
  const backend = server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    dispatch.method,
    { sessionId: zcodeSid, [dispatch.paramKey]: value },
    15000,
  );
  if (resp.error) return null;
  return { kind: configId as "mode" | "thought", currentValue: value };
}

/** Emit a config_option_update (+ current_mode_update for mode) after a change.
 *  Returns the rebuilt options so the caller can include them in the response.
 *
 *  For model switches, also emit a usage_update with the NEW model's context
 *  window (from config.json) so the editor's context bar refreshes immediately
 *  instead of waiting for the next turn's UsageDelta. */
export async function emitConfigOptionUpdate(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
  kind: "model" | "mode" | "thought",
): Promise<acp.SessionConfigOption[]> {
  const options = await buildConfigOptions(server, zcodeSid);
  await sendSessionUpdate(cx, acpSid, {
    sessionUpdate: "config_option_update",
    configOptions: options,
  });
  if (kind === "mode") {
    const modes = await buildModes(server, zcodeSid);
    await sendSessionUpdate(cx, acpSid, {
      sessionUpdate: "current_mode_update",
      currentModeId: modes.currentModeId,
    });
  }
  if (kind === "model") {
    // Refresh the context bar: the backend's projection.contextWindow lags
    // behind a model switch, so read the new model's limit from config.json.
    try {
      const read = await sessionRead(server, zcodeSid);
      const proj = (read.projection ?? {}) as {
        contextUsed?: number;
        totalTokenCount?: number;
      };
      const used = proj.contextUsed || proj.totalTokenCount || 0;
      // The rebuilt options[0] (model) currentValue is the just-switched value.
      const modelOpt = options.find((o) => o.id === "model");
      const { providerId, modelId } = parseModelValue(String(modelOpt?.currentValue ?? ""));
      const size = modelContextWindow(providerId, modelId);
      await sendSessionUpdate(cx, acpSid, {
        sessionUpdate: "usage_update",
        used,
        size,
      });
    } catch (e) {
      log(
        `options: usage_update after model switch failed (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }
  return options;
}

// ---------- helpers ----------

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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
