/**
 * The default-model setting: read/write halves of GET/PUT
 * /settings/default-model.
 *
 * The stored value is `session.defaultModel` in the user config; what it
 * MEANS (precedence over the automatic choice, dialect folding, the
 * "never force a switched-off model" rule) lives in `defaultModelRef`
 * (config/options.ts) — the single resolver every consumer goes through, so
 * the settings page reports exactly what a new session would start on.
 */

import { defaultModelRef, formatModelValue, isModelUsable } from "../config/options.js";
import { parseModelRefValue } from "../config/model-resolution.js";
import { loadUserConfig, userConfigPath } from "../config/user-config.js";
import { writeJsonAtomic } from "./atomic-write.js";

export interface DefaultModelSetting {
  /** The manual choice (`session.defaultModel`); null when automatic. */
  configured: string | null;
  /** The model a new session starts on right now. */
  effective: { providerId: string; modelId: string; value: string };
  /**
   * Which rule produced `effective`: the per-process env pin, the manual
   * choice, or the automatic newest-model rule. "auto" while `configured` is
   * set means the choice names a model that is switched off or unknown — it is
   * reported, never forced.
   */
  source: "env" | "config" | "auto";
}

/**
 * Persist (or, for null, clear) the manual default in the user config. Raw
 * read-modify-write under the config lock — the file carries sections owned by
 * other writers, which must survive byte-for-byte. The next default-model
 * read sees the change live (no bridge restart).
 */
export async function setDefaultModel(value: string | null): Promise<void> {
  await writeJsonAtomic(userConfigPath(), (current) => {
    const next = { ...current };
    const session = {
      ...(typeof next["session"] === "object" && next["session"] !== null
        ? (next["session"] as Record<string, unknown>)
        : {}),
    };
    if (value === null) delete session["defaultModel"];
    else session["defaultModel"] = value;
    if (Object.keys(session).length > 0) next["session"] = session;
    else delete next["session"];
    return next;
  });
}

export function defaultModelSetting(): DefaultModelSetting {
  const configured = loadUserConfig().session?.defaultModel?.trim() || null;
  const envProvider = process.env.ZCODE_PROVIDER?.trim();
  const envModel = process.env.ZCODE_MODEL?.trim();
  const pinned = envProvider && envModel ? { providerId: envProvider, modelId: envModel } : null;
  const ref = defaultModelRef();
  // isModelUsable over a one-entry list is the shared "same model" test
  // (provider dialect and model-id case folded).
  const isRef = (providerId: string | undefined, modelId: string): boolean =>
    providerId
      ? isModelUsable([ref], providerId, modelId)
      : ref.modelId.toLowerCase() === modelId.toLowerCase();
  let source: DefaultModelSetting["source"] = "auto";
  if (pinned && isRef(pinned.providerId, pinned.modelId)) source = "env";
  else if (configured) {
    const parsed = parseModelRefValue(configured);
    if (isRef(parsed.providerId, parsed.modelId)) source = "config";
  }
  return {
    configured,
    effective: {
      providerId: ref.providerId,
      modelId: ref.modelId,
      value: formatModelValue(ref.providerId, ref.modelId),
    },
    source,
  };
}
