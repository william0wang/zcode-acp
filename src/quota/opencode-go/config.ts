/**
 * Opencode Go credential discovery.
 *
 * Credentials may come from two sources, merged field-by-field with
 * **environment variables taking precedence** over the config file:
 *   1. `OPENCODE_GO_WORKSPACE_ID` / `OPENCODE_GO_AUTH_COOKIE` env vars
 *      (best for CI / scripts / temporary overrides).
 *   2. `~/.pi/agent/opencode-go.json` — `{ workspaceId, authCookie }`
 *      (the convention used by the @beyona/pi-zai-usage Pi extension, so users
 *      who already configured it there get reuse for free).
 *
 * A field present in env overrides the same field from the file; a field only
 * in the file is still used. This lets a user keep their stable workspaceId in
 * the file while rotating the cookie via env, etc. Both fields must resolve to
 * a valid pair — a missing/invalid one yields `not_configured`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { log } from "../../utils.js";

/** Env var names — documented in the CLI help and README. */
export const ENV_WORKSPACE_ID = "OPENCODE_GO_WORKSPACE_ID";
export const ENV_AUTH_COOKIE = "OPENCODE_GO_AUTH_COOKIE";

/** Config file path (matches the @beyona/pi-zai-usage convention). */
export const CONFIG_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".pi",
  "agent",
  "opencode-go.json",
);

/** Shape of the JSON config file. */
interface OpencodeGoConfig {
  workspaceId?: string;
  authCookie?: string;
}

/**
 * Read (best-effort) the JSON config file. Returns an empty object on any
 * error — missing file, parse error, or wrong shape all degrade to "no fields
 * contributed", which the caller treats as `not_configured`.
 *
 * Best-effort mirrors {@link ../../backend/credentials.ts}: a missing or
 * corrupt config must never crash the bridge, only log.
 */
export function readConfigFile(filePath: string = CONFIG_PATH): OpencodeGoConfig {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log(`opencode-go: config file is not a JSON object (${filePath})`);
      return {};
    }
    const cfg = parsed as Record<string, unknown>;
    return {
      workspaceId: typeof cfg.workspaceId === "string" ? cfg.workspaceId : undefined,
      authCookie: typeof cfg.authCookie === "string" ? cfg.authCookie : undefined,
    };
  } catch (e) {
    // ENOENT (most common — user hasn't created the file) is silent; other
    // read/parse errors are logged but still non-fatal.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/ENOENT/.test(msg)) {
      log(`opencode-go: config read failed (${filePath}): ${msg}`);
    }
    return {};
  }
}
