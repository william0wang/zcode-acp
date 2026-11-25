/**
 * The default-thought-level setting: read/write halves of GET/PUT
 * /settings/default-thought-level.
 *
 * The stored value is `session.defaultThoughtLevel` in the user config; what
 * it MEANS for a new session lives in config/options.ts — the projection the
 * pending `session/new` menu advertises (`pendingThoughtProjection`) and the
 * pin at materialization (`applyDefaultThoughtLevel`) — so the settings page
 * reports exactly what a new session would start on.
 */

import {
  configuredDefaultThoughtLevel,
  matchThoughtLevel,
  pendingThoughtProjection,
} from "../config/options.js";
import { userConfigPath } from "../config/user-config.js";
import { writeJsonAtomic } from "./atomic-write.js";

export interface DefaultThoughtLevelSetting {
  /** The manual choice (`session.defaultThoughtLevel`); null when unset. */
  configured: string | null;
  /** The level a new session starts on right now. */
  effective: string;
  /**
   * Which rule produced `effective`: the manual choice, or the default
   * model's own default. "model" while `configured` is set means the default
   * model does not offer that level — it is reported, never forced.
   */
  source: "config" | "model";
  /** The default model's thought vocabulary, as the pending menu offers it. */
  options: Array<{ value: string; name: string }>;
}

/**
 * Persist (or, for null, clear) the manual default in the user config. Raw
 * read-modify-write under the config lock — the file carries sections owned by
 * other writers, which must survive byte-for-byte. The next default-thought
 * read sees the change live (no bridge restart).
 */
export async function setDefaultThoughtLevel(value: string | null): Promise<void> {
  await writeJsonAtomic(userConfigPath(), (current) => {
    const next = { ...current };
    const session = {
      ...(typeof next["session"] === "object" && next["session"] !== null
        ? (next["session"] as Record<string, unknown>)
        : {}),
    };
    if (value === null) delete session["defaultThoughtLevel"];
    else session["defaultThoughtLevel"] = value;
    if (Object.keys(session).length > 0) next["session"] = session;
    else delete next["session"];
    return next;
  });
}

export function defaultThoughtLevelSetting(): DefaultThoughtLevelSetting {
  const configured = configuredDefaultThoughtLevel() ?? null;
  const projection = pendingThoughtProjection();
  const matched = configured
    ? matchThoughtLevel(
        projection.options.map((o) => o.value),
        configured,
      )
    : undefined;
  return {
    configured,
    effective: matched ?? projection.current,
    source: matched ? "config" : "model",
    options: projection.options,
  };
}
