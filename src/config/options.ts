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
import { CONFIG_DISPATCH, CONFIG_META, ZCODE_CREDS_PATH } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";
import { sendSessionUpdate } from "../handlers/io.js";

interface ProviderModelsJson {
  [modelId: string]: { limit?: { context?: number } } | undefined;
}

/** Read the config.json contents (UTF-8). Throws on read/parse failure. */
function readConfig(): unknown {
  return JSON.parse(readFileSync(ZCODE_CREDS_PATH, "utf8"));
}

interface ConfigShape {
  provider?: Record<string, { models?: ProviderModelsJson }>;
}

/** Read the model id list for the enabled provider from config.json. */
export function loadProviderModels(): string[] {
  try {
    const cfg = readConfig() as ConfigShape;
    const models = cfg.provider?.["builtin:bigmodel-coding-plan"]?.models ?? {};
    const keys = Object.keys(models);
    return keys.length > 0 ? keys : ["GLM-5.2"];
  } catch {
    return ["GLM-5.2"];
  }
}

/** Read the context-window size for a model from config.json (limit.context). */
export function modelContextWindow(modelId: string): number {
  try {
    const cfg = readConfig() as ConfigShape;
    const models = cfg.provider?.["builtin:bigmodel-coding-plan"]?.models ?? {};
    const entry = models[modelId];
    return entry?.limit?.context ?? 0;
  } catch {
    return 0;
  }
}

/** Build the ACP SessionModeState ({currentModeId, availableModes}). */
export async function buildModes(
  server: ZcodeAcpServer,
  zcodeSid: string,
): Promise<acp.SessionModeState> {
  let currentMode = "yolo";
  try {
    const read = await sessionRead(server, zcodeSid);
    const settings = (read.settings ?? {}) as Record<string, unknown>;
    const modeSet = (settings.mode as Record<string, unknown>) ?? {};
    currentMode = (modeSet.current as string) ?? currentMode;
  } catch {
    // keep default
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

/** Build the ACP configOptions array (3 items: model/mode/thought). */
export async function buildConfigOptions(
  server: ZcodeAcpServer,
  zcodeSid: string,
): Promise<acp.SessionConfigOption[]> {
  let currentModel = "GLM-5.2";
  let currentMode = "build";
  let currentThought = "high";
  let thoughtOptions: Array<{ value: string; name: string }> | null = null;

  try {
    const read = await sessionRead(server, zcodeSid);
    const settings = (read.settings ?? {}) as Record<string, unknown>;
    const modeSet = (settings.mode as Record<string, unknown>) ?? {};
    currentMode = (modeSet.current as string) ?? currentMode;
    const modelSet = (settings.model as Record<string, unknown>) ?? {};
    const cur = (modelSet.current as { modelId?: string }) ?? {};
    if (cur.modelId) currentModel = cur.modelId;
    const tlSet = (settings.thoughtLevel as Record<string, unknown>) ?? {};
    currentThought = (tlSet.current as string) ?? currentThought;
    const tlAvail = (tlSet.available as Array<Record<string, string>>) ?? [];
    if (tlAvail.length > 0) {
      thoughtOptions = tlAvail.map((a) => ({ value: a.value, name: a.label ?? a.value }));
    }
  } catch {
    // keep defaults
  }

  // Model options: config.json is authoritative (settings.model.available is incomplete).
  let modelOptions = loadProviderModels().map((k) => ({ value: k, name: k }));
  if (!modelOptions.some((o) => o.value === currentModel)) {
    modelOptions = [{ value: currentModel, name: currentModel }, ...modelOptions];
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
      category: "thought" as acp.SessionConfigOptionCategory,
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
 *  Returns the rebuilt options so the caller can include them in the response. */
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
