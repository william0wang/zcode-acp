/**
 * Single merge point for user preferences: config file > env var > default.
 *
 * Every accessor reads the file live (via loadUserConfig, no cache) so an
 * edit takes effect on the next use without a bridge restart — same
 * convention the remote prefs established. Env vars stay a full fallback:
 * per-field precedence is file value (when present AND valid) > env var >
 * built-in default. See src/config/user-config.ts for the file schema.
 */

import { loadUserConfig } from "./user-config.js";

/** Auto-compact trigger: absolute token count; 0 = disabled. */
export function autoCompactThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const file = loadUserConfig(env).autoCompact?.threshold;
  if (file !== undefined) return file;
  const raw = Number(env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD ?? "0");
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Goal-loop hard round budget before a pause (default 100). */
export function goalMaxTurns(env: NodeJS.ProcessEnv = process.env): number {
  const file = loadUserConfig(env).goal?.maxTurns;
  if (file !== undefined) return file;
  const raw = Number(env.ZCODE_ACP_GOAL_MAX_TURNS ?? "0");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
}

/** Escape hatch routing /goal through the legacy backend goal mode. */
export function goalModeIsBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = loadUserConfig(env).goal?.mode;
  if (file !== undefined) return file === "backend";
  return env.ZCODE_ACP_GOAL_MODE === "backend";
}

/** Mode a newly created session starts in (default "yolo"). */
export function initialSessionMode(env: NodeJS.ProcessEnv = process.env): string {
  const file = loadUserConfig(env).session?.mode;
  if (file !== undefined) return file;
  return env.ZCODE_ACP_MODE || "yolo";
}

/**
 * Wait cap (ms) for permission/elicitation requests; 0 = wait forever.
 * Resolved once at bridge start (module-load const in server-requests.ts) —
 * same lifetime as the env var it generalizes.
 */
export function interactionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const file = loadUserConfig(env).interaction?.timeoutMs;
  if (file !== undefined) return file;
  const raw = env.ZCODE_ACP_INTERACTION_TIMEOUT_MS;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Global Seatbelt arming switch (per-project opt-in stays in sandbox.json). */
export function globalSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = loadUserConfig(env).sandbox?.enabled;
  if (file !== undefined) return file;
  const raw = env.ZCODE_ACP_SANDBOX;
  return raw === "1" || raw === "true";
}

/** Verbose diagnostic logging flag. */
export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = loadUserConfig(env).debug;
  if (file !== undefined) return file;
  return env.ZCODE_ACP_DEBUG === "1";
}

/**
 * TUI stats-dock segment filter (martty's DSH_TUI_STATS vocabulary). The
 * file value wins over the env var: the hub daemon that incubates TUI
 * windows is long-lived and detached, so its birth env predates most shell
 * exports — an env-only preference silently stops reaching every window the
 * hub opens afterwards. Undefined = martty's default (full dock).
 */
export function tuiStatsSegments(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = loadUserConfig(env).tui?.stats;
  if (file !== undefined) return file;
  const raw = env.DSH_TUI_STATS;
  return raw !== undefined ? raw : undefined;
}

/**
 * Explicit user-facing-string language override ("zh" | "en"); undefined
 * lets the caller's fallback chain (app locale → POSIX → en) decide.
 * Prefix-tolerant on both sources ("zh_CN" reads as "zh"), like the env-only
 * picker in i18n.ts always was.
 */
export function languageOverride(env: NodeJS.ProcessEnv = process.env): "zh" | "en" | undefined {
  const pick = (v: string | undefined): "zh" | "en" | undefined => {
    const s = (v ?? "").trim().toLowerCase();
    if (s.startsWith("zh")) return "zh";
    if (s.startsWith("en")) return "en";
    return undefined;
  };
  return pick(loadUserConfig(env).lang) ?? pick(env.ZCODE_ACP_LANG);
}
