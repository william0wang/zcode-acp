/**
 * Read/write for the ZCode CLI config (`~/.zcode/cli/config.json`).
 *
 * ONE file, four independent owners: skills enablement, MCP servers, hooks, and
 * plugins. Every writer is therefore a read-modify-write that preserves keys it
 * does not recognise — the file also carries agent-runtime settings owned by
 * the backend, and rewriting from a partial model would silently delete them.
 *
 * The enable/disable spellings are not symmetric, and getting them wrong makes
 * a toggle look broken while the file is technically valid:
 *
 *  - **skills**: key = the SKILL.md absolute path, value `{enable: false}`.
 *    `enable: true` is the DEFAULT and must DELETE the key — writing `true`
 *    leaves a permanent override that shadows later enablement changes.
 *  - **MCP**: `enabled: false` inside the server object. Same rule: `true`
 *    deletes the key (and a legacy `enable` key is migrated on the way).
 *  - **hooks**: a whole different shape — a nested tree under `hooks`, gated by
 *    a top-level `hooks.enabled: true`. WITHOUT that flag every hook in the file
 *    is inert, which is the single most common way a hand-written config does
 *    nothing.
 *  - **plugins**: `enabledPlugins` / `suppressedBuiltins` maps keyed by
 *    `<name>@<marketplace>`.
 *
 * None of these are hot-reloaded by the agent: `cli/config.json` is read once
 * at agent start (MCP servers are frozen into the runtime config), except the
 * skills enablement map which the host re-reads live. Writes therefore report
 * `needs-restart` for MCP and hooks, `immediate` for skills.
 */

import { readFile } from "node:fs/promises";

import { readJsonDocument, writeJsonAtomic } from "./atomic-write.js";
import { zcodeCliConfigPath } from "../utils.js";

/** The seven hook events the schema accepts, in its own order. */
export const HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** One hook entry. Passthrough in the schema — unknown keys are preserved. */
export interface HookEntry {
  type: "command" | "process";
  command: string;
  enabled?: boolean;
  async?: boolean;
  shell?: true | string;
  /** Seconds (only meaningful for `type: "command"`). */
  timeout?: number;
  /** Milliseconds; wins over `timeout` when both are present. */
  timeoutMs?: number;
  args?: string[];
  statusMessage?: string;
  [key: string]: unknown;
}

/** One matcher group under an event. STRICT in the schema — no unknown keys. */
export interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

export interface HooksConfig {
  enabled?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  events?: Partial<Record<HookEventName, HookMatcher[]>>;
}

export interface McpServerConfig {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface CliConfigFile {
  skills?: Record<string, { enable?: boolean }>;
  mcp?: { servers?: Record<string, McpServerConfig> };
  hooks?: HooksConfig;
  plugins?: {
    enabled?: boolean;
    dirs?: string[];
    enabledPlugins?: Record<string, boolean>;
    suppressedBuiltins?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Read the CLI config.
 *
 * @throws when the file exists but is malformed. Unlike the app's skills
 *         writer (which silently reads damage as `{}` and would then rewrite
 *         the file from an empty base), this refuses — the caller surfaces an
 *         error instead of destroying what is left of the document.
 */
export async function readCliConfig(): Promise<CliConfigFile> {
  const doc = await readJsonDocument(zcodeCliConfigPath());
  return (doc ?? {}) as CliConfigFile;
}

/** Structural check for the parts of the file this module owns. */
export function validateCliConfig(doc: Record<string, unknown>): boolean | string {
  const skills = doc["skills"];
  if (skills !== undefined && !isRecord(skills)) return "skills must be an object";
  const mcp = doc["mcp"];
  if (mcp !== undefined) {
    if (!isRecord(mcp)) return "mcp must be an object";
    const servers = mcp["servers"];
    if (servers !== undefined && !isRecord(servers)) return "mcp.servers must be an object";
    if (isRecord(servers)) {
      for (const [name, server] of Object.entries(servers)) {
        if (!isRecord(server)) return `mcp.servers.${name} must be an object`;
      }
    }
  }
  const hooks = doc["hooks"];
  if (hooks !== undefined) {
    if (!isRecord(hooks)) return "hooks must be an object";
    const events = hooks["events"];
    if (events !== undefined) {
      if (!isRecord(events)) return "hooks.events must be an object";
      for (const [event, matchers] of Object.entries(events)) {
        if (!HOOK_EVENT_NAMES.includes(event as HookEventName)) {
          return `hooks.events.${event} is not a known event name`;
        }
        if (!Array.isArray(matchers)) return `hooks.events.${event} must be an array`;
        for (const matcher of matchers) {
          if (!isRecord(matcher)) return `hooks.events.${event} entries must be objects`;
          if (!Array.isArray(matcher["hooks"]) || matcher["hooks"].length === 0) {
            return `hooks.events.${event} matcher needs at least one hook`;
          }
          for (const hook of matcher["hooks"] as unknown[]) {
            if (!isRecord(hook)) return "a hook entry must be an object";
            const type = hook["type"];
            if (type !== "command" && type !== "process") {
              return "a hook entry needs type 'command' or 'process'";
            }
            if (typeof hook["command"] !== "string" || !hook["command"]) {
              return "a hook entry needs a non-empty command";
            }
          }
        }
      }
    }
  }
  const plugins = doc["plugins"];
  if (plugins !== undefined && !isRecord(plugins)) return "plugins must be an object";
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The single write path for this file. */
async function saveCliConfig(
  mutator: (doc: CliConfigFile) => CliConfigFile | Promise<CliConfigFile>,
): Promise<CliConfigFile> {
  const { doc } = await writeJsonAtomic(
    zcodeCliConfigPath(),
    async (current) => {
      const next = await mutator(current as CliConfigFile);
      return next as Record<string, unknown>;
    },
    { validate: (d) => validateCliConfig(d) },
  );
  return doc as CliConfigFile;
}

// ---------- skills ----------

/**
 * Set a skill's enabled state.
 *
 * `enable: true` REMOVES the override rather than writing `true` — enabled is
 * the default state, and a stored `true` is a permanent pin that would shadow
 * the file's real state.
 */
export async function setSkillEnabled(skillPath: string, enable: boolean): Promise<CliConfigFile> {
  return saveCliConfig((doc) => {
    const skills = { ...(doc.skills ?? {}) };
    if (enable) delete skills[skillPath];
    else skills[skillPath] = { enable: false };
    return applySkillsBlock(doc, skills);
  });
}

/** Drop the whole `skills` block when every entry is enabled (the app's rule). */
function applySkillsBlock(
  doc: CliConfigFile,
  skills: Record<string, { enable?: boolean }>,
): CliConfigFile {
  const next = { ...doc };
  if (Object.keys(skills).length === 0) delete next.skills;
  else next.skills = skills;
  return next;
}

// ---------- mcp ----------

/**
 * Create or update an MCP server.
 *
 * `enabled: true` deletes the flag (and a legacy `enable` key) instead of
 * storing it; only a DISABLE is worth persisting.
 */
export async function upsertMcpServer(
  name: string,
  server: McpServerConfig,
): Promise<CliConfigFile> {
  assertMcpName(name);
  return saveCliConfig((doc) => {
    const servers = { ...(doc.mcp?.servers ?? {}) };
    const existing = servers[name] ?? {};
    const merged: McpServerConfig = { ...existing, ...server };
    delete merged["enable"];
    if (merged.enabled === true) delete merged.enabled;
    servers[name] = merged;
    return { ...doc, mcp: { ...(doc.mcp ?? {}), servers } };
  });
}

/** Enable or disable an existing MCP server. */
export async function setMcpServerEnabled(name: string, enabled: boolean): Promise<CliConfigFile> {
  return saveCliConfig((doc) => {
    const servers = { ...(doc.mcp?.servers ?? {}) };
    const existing = servers[name];
    if (!existing) throw new Error(`MCP server '${name}' is not configured`);
    const merged: McpServerConfig = { ...existing };
    delete merged["enable"];
    if (enabled) delete merged.enabled;
    else merged.enabled = false;
    servers[name] = merged;
    return { ...doc, mcp: { ...(doc.mcp ?? {}), servers } };
  });
}

export async function removeMcpServer(name: string): Promise<CliConfigFile> {
  return saveCliConfig((doc) => {
    const servers = { ...(doc.mcp?.servers ?? {}) };
    if (!(name in servers)) throw new Error(`MCP server '${name}' is not configured`);
    delete servers[name];
    return { ...doc, mcp: { ...(doc.mcp ?? {}), servers } };
  });
}

function assertMcpName(name: string): void {
  if (!name || /[\\/]/.test(name)) {
    throw new Error("MCP server name must be non-empty and free of path separators");
  }
}

// ---------- hooks ----------

/**
 * Read the hooks tree. Returns the raw config; an absent file yields `{}`.
 *
 * Note the returned `enabled` flag: hooks are inert unless the top-level flag
 * is `true`, so callers must surface it rather than inferring it.
 */
export async function readHooks(): Promise<HooksConfig> {
  const doc = await readCliConfig();
  return doc.hooks ?? {};
}

/**
 * Set the global hooks switch.
 *
 * A file full of hooks with `enabled` absent runs NOTHING — the runtime root
 * defaults to disabled. This is the one field that turns the whole tree on.
 */
export async function setHooksEnabled(enabled: boolean): Promise<CliConfigFile> {
  return saveCliConfig((doc) => {
    const hooks: HooksConfig = { ...(doc.hooks ?? {}) };
    if (enabled) hooks.enabled = true;
    else delete hooks.enabled;
    return { ...doc, hooks };
  });
}

/**
 * Edit ONE existing hook entry in place.
 *
 * Deliberately not a create path: the matcher list is an array of arrays, and
 * an insert shifts every later index, so a remote "add a hook" call races with
 * any concurrent edit of the same event. Editing an existing entry's
 * command/timeout/enabled covers the real use case (temporarily disable one,
 * tweak a command) without that hazard.
 *
 * Unknown keys on the hook object are preserved: the schema is `.passthrough()`
 * precisely so extensions can ride along.
 */
export async function updateHookEntry(
  event: HookEventName,
  matcherIndex: number,
  hookIndex: number,
  patch: Partial<Pick<HookEntry, "command" | "enabled" | "timeoutMs" | "timeout">>,
): Promise<CliConfigFile> {
  if (!HOOK_EVENT_NAMES.includes(event)) {
    throw new Error(`unknown hook event '${event}'`);
  }
  if (!Number.isInteger(matcherIndex) || matcherIndex < 0) {
    throw new Error("matcherIndex must be a non-negative integer");
  }
  if (!Number.isInteger(hookIndex) || hookIndex < 0) {
    throw new Error("hookIndex must be a non-negative integer");
  }
  if (
    patch.timeoutMs !== undefined &&
    (!Number.isFinite(patch.timeoutMs) || patch.timeoutMs <= 0)
  ) {
    throw new Error("timeoutMs must be a positive number");
  }
  if (patch.timeout !== undefined && (!Number.isFinite(patch.timeout) || patch.timeout <= 0)) {
    throw new Error("timeout must be a positive number of seconds");
  }
  if (patch.command !== undefined && !patch.command) {
    throw new Error("command must be non-empty");
  }
  return saveCliConfig((doc) => {
    const hooks: HooksConfig = { ...(doc.hooks ?? {}) };
    const events = { ...(hooks.events ?? {}) };
    const matchers = [...(events[event] ?? [])];
    const matcher = matchers[matcherIndex];
    if (!matcher) throw new Error(`no matcher at index ${matcherIndex} for ${event}`);
    const entries = [...matcher.hooks];
    const entry = entries[hookIndex];
    if (!entry)
      throw new Error(`no hook at index ${hookIndex} in ${event} matcher ${matcherIndex}`);
    // Explicit `enabled: true` removes the flag: enabled is the default, and a
    // stored `true` is a pin that survives later enablement changes.
    const merged: HookEntry = { ...entry };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (key === "enabled") {
        if (value === true) delete merged.enabled;
        else merged.enabled = value as boolean;
        continue;
      }
      (merged as Record<string, unknown>)[key] = value;
    }
    entries[hookIndex] = merged;
    matchers[matcherIndex] = { ...matcher, hooks: entries };
    events[event] = matchers;
    hooks.events = events;
    return { ...doc, hooks };
  });
}

// ---------- plugins ----------

/** Enable or disable a plugin by its `<name>@<marketplace>` key. */
export async function setPluginEnabled(
  pluginKey: string,
  enabled: boolean,
): Promise<CliConfigFile> {
  if (!pluginKey.includes("@")) {
    throw new Error("plugin key must be '<name>@<marketplace>'");
  }
  return saveCliConfig((doc) => {
    const plugins = { ...(doc.plugins ?? {}) };
    const enabledPlugins = { ...(plugins.enabledPlugins ?? {}) };
    if (enabled) delete enabledPlugins[pluginKey];
    else enabledPlugins[pluginKey] = false;
    plugins.enabledPlugins = enabledPlugins;
    return { ...doc, plugins };
  });
}

/** Raw text for the settings snapshot. Absent → null. */
export async function readCliConfigRaw(): Promise<string | null> {
  try {
    return await readFile(zcodeCliConfigPath(), "utf8");
  } catch {
    return null;
  }
}
