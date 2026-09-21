/**
 * Global user configuration (~/.config/zcode-acp/config.json).
 *
 * The file is the AUTHORITATIVE source for user preferences that must not
 * depend on how a process was launched: the hub daemon is idle-exited and
 * re-spawned by whichever bridge needs it next, so its birth env rotates
 * between GUI-launched editors (no shell rc vars) and interactive shells.
 * Every read is live (no cache) — editing the file takes effect on the next
 * use (e.g. the next remote incubation) without restarting the hub.
 *
 * Precedence everywhere: config file > environment variable > built-in
 * default. Env vars remain fully supported as a fallback for setups without
 * a file and for one-off/test overrides of unspecified fields.
 *
 * Per-process plumbing (ZCODE_ACP_REMOTE_ORIGIN, _PIN_CWD,
 * ZCODE_ACP_RESUME_SESSION) is deliberately NOT file-configurable — those
 * carry per-request/per-role state, not user preference. Bootstrap-time
 * variables (ZCODE_BIN, ZCODE_NODE, ZCODE_HOME, ZCODE_PROVIDER, …) are
 * resolved once at startup and stay env-only for the same reason.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Local copy of utils.warn: importing it here would close a cycle once
// utils.isDebug reads the merged debug flag (utils → settings → user-config
// → utils). ESLint has no no-cycle rule — the graph stays acyclic by hand.
//
// Warn-once dedup, keyed by message: the loader sits on hot paths (log(),
// messages()), so an invalid field must not re-warn on every read. A NEW
// mistake (different message) still warns; the paths embedded in the
// messages keep per-file tests independent.
const warnedOnce = new Set<string>();
function warn(msg: string): void {
  if (warnedOnce.has(msg)) return;
  warnedOnce.add(msg);
  process.stderr.write(`[zcode-acp] ${msg}\n`);
}

/** Terminal incubation preferences for remote session-create (ADR-0016). */
export interface TerminalPrefs {
  /** false → remote session-create stays headless (no visible window). */
  enabled?: boolean;
  /**
   * Ordered terminal preference list — the hub tries them in order (a launch
   * failure or a window that never registers moves down the list) and only
   * goes headless once every entry failed. Names resolve like `app`.
   */
  terminals?: string[];
  /** Terminal app name (Terminal, iTerm, wezterm, kitty, alacritty, ghostty, …). */
  app?: string;
  /** Shell command template; `{script}` is replaced with the quoted script path. */
  command?: string;
}

/** The `remote` section of the user config file. */
export interface RemoteUserConfig {
  enabled?: boolean;
  token?: string;
  hubPort?: number;
  hubHost?: string;
  bridgePort?: number;
  terminal?: TerminalPrefs;
}

/** The `quota` section of the user config file. */
export interface QuotaUserConfig {
  /** Ollama Cloud API key for the `zcode-acp quota` card (cloud.ollama.ai). */
  ollamaApiKey?: string;
  /** Opencode Go workspace id (`wrk_…`) — see the quota CLI docs. */
  opencodeGoWorkspaceId?: string;
  /** Opencode Go `auth` cookie value (`Fe26.2**…`). */
  opencodeGoAuthCookie?: string;
  /** Opencode Go `__Host-console_session` cookie value (`st_…`) — required
   * since the 2026-09 console migration (the API 401s the auth cookie alone). */
  opencodeGoSessionToken?: string;
}

/** The `session` section: defaults for newly created sessions. */
export interface SessionUserConfig {
  /** Mode a new session starts in (plan/build/edit/yolo/auto — the backend's own modes). */
  mode?: string;
}

/** The `autoCompact` section: threshold-based context compaction. */
export interface AutoCompactUserConfig {
  /** Absolute token count that triggers compaction after a turn (0/unset = disabled). */
  threshold?: number;
}

/** The `goal` section: bridge-driven goal/auto loop knobs. */
export interface GoalUserConfig {
  /** Hard round budget before a pause (default 100). */
  maxTurns?: number;
  /** "backend" restores the legacy backend goal mode; anything else uses the bridge loop. */
  mode?: "backend";
}

/** The `interaction` section: server→client request behavior. */
export interface InteractionUserConfig {
  /** Wait cap in ms for permission/elicitation requests (0 = wait forever). */
  timeoutMs?: number;
}

/** The `tui` section: Martty TUI presentation preferences. */
export interface TuiUserConfig {
  /**
   * Composer-dock segment filter for the TUI's stats view (martty's
   * `DSH_TUI_STATS` vocabulary): comma-separated segment ids in render
   * order — `tokens`, `context`, `counts`, `cache`, `time`, `speed`.
   * `all` spells the full dock out; `none`/`off`/empty hides every
   * segment; unset keeps the full dock. File-configured so hub-incubated
   * TUI windows (whose shell inherits launchd's env, not the user's
   * shell) see the same dock as a direct `zcode-acp` launch.
   */
  stats?: string;
}

/** The `sandbox` section: global Seatbelt arming switch (per-project stays in sandbox.json). */
export interface SandboxUserConfig {
  /** true = arm the sandbox globally (same as ZCODE_ACP_SANDBOX=1). */
  enabled?: boolean;
}

export interface UserConfig {
  remote?: RemoteUserConfig;
  quota?: QuotaUserConfig;
  /** Language of user-facing bridge strings ("zh" | "en"). */
  lang?: "zh" | "en";
  /** Verbose diagnostic logging (same as ZCODE_ACP_DEBUG=1). */
  debug?: boolean;
  session?: SessionUserConfig;
  autoCompact?: AutoCompactUserConfig;
  goal?: GoalUserConfig;
  interaction?: InteractionUserConfig;
  sandbox?: SandboxUserConfig;
  tui?: TuiUserConfig;
}

/** Resolve the config file path: $XDG_CONFIG_HOME/zcode-acp or ~/.config/zcode-acp. */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.XDG_CONFIG_HOME ?? "").trim() || path.join(homedir(), ".config");
  return path.join(base, "zcode-acp", "config.json");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The session modes the backend's own mode select offers (mirrors CONFIG_META). */
const SESSION_MODES = new Set(["plan", "build", "edit", "yolo", "auto"]);

/** Normalized language pick: "zh*"/"en*" prefixes accepted, else undefined. */
function parseLang(v: unknown): "zh" | "en" | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (s.startsWith("zh")) return "zh";
  if (s.startsWith("en")) return "en";
  return undefined;
}

/** Integer within [min, ∞) — JSON floats and junk read as absent (warned). */
function parseIntField(v: unknown, min: number, label: string, file: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    warn(`config: ${label}=${JSON.stringify(v)} in ${file} is not an integer >= ${min} — ignoring`);
    return undefined;
  }
  return v;
}

/**
 * Read and validate the user config. Best-effort: a missing file is the
 * normal no-file path ({}), anything unreadable/malformed warns once and
 * reads as absent so the env fallback keeps the process working.
 */
export function loadUserConfig(env: NodeJS.ProcessEnv = process.env): UserConfig {
  const file = userConfigPath(env);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {}; // missing (or unreadable) file — env fallback applies
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warn(
      `config: ${file} is not valid JSON — ignoring (${e instanceof Error ? e.message : String(e)})`,
    );
    return {};
  }
  if (!isPlainObject(parsed)) {
    warn(`config: ${file} is not a JSON object — ignoring`);
    return {};
  }
  const result: UserConfig = {};

  const remote = parsed["remote"];
  if (remote !== undefined && isPlainObject(remote)) {
    const parsedRemote = parseRemoteSection(remote, file);
    if (Object.keys(parsedRemote).length > 0) result.remote = parsedRemote;
  } else if (remote !== undefined) {
    warn(`config: "remote" in ${file} is not an object — ignoring the section`);
  }

  const quota = parsed["quota"];
  if (quota !== undefined) {
    if (!isPlainObject(quota)) {
      warn(`config: "quota" in ${file} is not an object — ignoring the section`);
    } else {
      const q: QuotaUserConfig = {};
      for (const [jsonKey, prop] of [
        ["ollamaApiKey", "ollamaApiKey"],
        ["opencodeGoWorkspaceId", "opencodeGoWorkspaceId"],
        ["opencodeGoAuthCookie", "opencodeGoAuthCookie"],
        ["opencodeGoSessionToken", "opencodeGoSessionToken"],
      ] as const) {
        const v = quota[jsonKey];
        if (typeof v === "string" && v.trim()) q[prop] = v.trim();
      }
      if (Object.keys(q).length > 0) result.quota = q;
    }
  }

  const lang = parseLang(parsed["lang"]);
  if (parsed["lang"] !== undefined) {
    if (lang) result.lang = lang;
    else
      warn(
        `config: "lang"=${JSON.stringify(parsed["lang"])} in ${file} is not "zh"/"en" — ignoring`,
      );
  }

  const debug = parsed["debug"];
  if (debug !== undefined) {
    if (typeof debug === "boolean") result.debug = debug;
    else warn(`config: "debug"=${JSON.stringify(debug)} in ${file} is not a boolean — ignoring`);
  }

  result.session = parseSection(parsed, "session", file, (body, label) => {
    const s: SessionUserConfig = {};
    const mode = body["mode"];
    if (mode !== undefined) {
      const m = typeof mode === "string" ? mode.trim() : "";
      if (m && SESSION_MODES.has(m)) s.mode = m;
      else warn(`config: ${label}.mode=${JSON.stringify(mode)} is not a session mode — ignoring`);
    }
    return s;
  });

  result.autoCompact = parseSection(parsed, "autoCompact", file, (body, label) => {
    const threshold = parseIntField(body["threshold"], 1, `${label}.threshold`, file);
    return threshold !== undefined ? { threshold } : {};
  });

  result.goal = parseSection(parsed, "goal", file, (body, label) => {
    const g: GoalUserConfig = {};
    const maxTurns = parseIntField(body["maxTurns"], 1, `${label}.maxTurns`, file);
    if (maxTurns !== undefined) g.maxTurns = maxTurns;
    const mode = body["mode"];
    if (mode !== undefined) {
      if (mode === "backend") g.mode = "backend";
      else
        warn(
          `config: ${label}.mode=${JSON.stringify(mode)} in ${file} is not "backend" — ignoring`,
        );
    }
    return g;
  });

  result.interaction = parseSection(parsed, "interaction", file, (body, label) => {
    const timeoutMs = parseIntField(body["timeoutMs"], 0, `${label}.timeoutMs`, file);
    return timeoutMs !== undefined ? { timeoutMs } : {};
  });

  result.sandbox = parseSection(parsed, "sandbox", file, (body, label) => {
    const enabled = body["enabled"];
    if (enabled === undefined) return {};
    if (typeof enabled === "boolean") return { enabled };
    warn(
      `config: ${label}.enabled=${JSON.stringify(enabled)} in ${file} is not a boolean — ignoring`,
    );
    return {};
  });

  // An empty string is a VALID value here (martty reads it as "hide every
  // dock segment") — only non-strings are rejected.
  result.tui = parseSection(parsed, "tui", file, (body, label) => {
    const stats = body["stats"];
    if (stats === undefined) return {};
    if (typeof stats === "string") return { stats };
    warn(`config: ${label}.stats=${JSON.stringify(stats)} in ${file} is not a string — ignoring`);
    return {};
  });

  // Drop the empty section shells so consumers' `??` fallbacks stay honest.
  for (const key of Object.keys(result) as Array<keyof UserConfig>) {
    if (isPlainObject(result[key]) && Object.keys(result[key] as object).length === 0) {
      delete result[key];
    }
  }
  return result;
}

/**
 * Parse one object-valued section: absent → undefined, non-object → warn +
 * undefined, valid shape → the parsed (possibly empty) object. Field-level
 * validation lives in the per-section callback.
 */
function parseSection<T>(
  root: Record<string, unknown>,
  name: string,
  file: string,
  parse: (body: Record<string, unknown>, label: string) => T,
): T | undefined {
  const body = root[name];
  if (body === undefined) return undefined;
  if (!isPlainObject(body)) {
    warn(`config: "${name}" in ${file} is not an object — ignoring the section`);
    return undefined;
  }
  return parse(body, name);
}

/** Parse the validated `remote` section object into {@link RemoteUserConfig}. */
function parseRemoteSection(remote: Record<string, unknown>, file: string): RemoteUserConfig {
  const out: RemoteUserConfig = {};
  if (typeof remote["enabled"] === "boolean") out.enabled = remote["enabled"];
  if (typeof remote["token"] === "string" && remote["token"].trim())
    out.token = remote["token"].trim();
  for (const key of ["hubPort", "bridgePort"] as const) {
    const v = remote[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
      warn(`config: remote.${key}=${JSON.stringify(v)} is not a valid port — ignoring`);
    } else {
      out[key] = v;
    }
  }
  if (typeof remote["hubHost"] === "string" && remote["hubHost"].trim()) {
    out.hubHost = remote["hubHost"].trim();
  }
  const terminal = remote["terminal"];
  if (isPlainObject(terminal)) {
    const t: TerminalPrefs = {};
    if (typeof terminal["enabled"] === "boolean") t.enabled = terminal["enabled"];
    if (Array.isArray(terminal["terminals"])) {
      const list = terminal["terminals"]
        .filter((v): v is string => typeof v === "string" && !!v.trim())
        .map((v) => v.trim());
      if (list.length > 0) t.terminals = list;
    } else if (terminal["terminals"] !== undefined) {
      warn(`config: remote.terminal.terminals in ${file} is not an array of names — ignoring`);
    }
    if (typeof terminal["app"] === "string" && terminal["app"].trim())
      t.app = terminal["app"].trim();
    if (typeof terminal["command"] === "string" && terminal["command"].trim()) {
      t.command = terminal["command"].trim();
    }
    if (Object.keys(t).length > 0) out.terminal = t;
  } else if (terminal !== undefined) {
    warn(`config: remote.terminal in ${file} is not an object — ignoring`);
  }
  return out;
}
