/**
 * Plugin command discovery — reads enabled plugins from `~/.zcode/cli/config.json`
 * and scans their `commands/*.md` frontmatter to build slash-command entries.
 *
 * Plugin commands (e.g. `/code-review`) are resolved by the ZCode backend's
 * `customCommandPromptResolver` before the model sees them, so they work in
 * app-server mode without bridge interception.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { compareVersions, log } from "../utils.js";

/** Path to the ZCode CLI config (plugins, skills, mcp). */
const CLI_CONFIG_PATH = path.join(
  homedir(),
  ".zcode",
  "cli",
  "config.json",
);

/** Root of the plugin cache directory. */
const PLUGIN_CACHE_DIR = path.join(
  homedir(),
  ".zcode",
  "cli",
  "plugins",
  "cache",
);

/** A slash-command entry compatible with `sendAvailableCommands`. */
export interface PluginCommandEntry {
  name: string;
  description: string;
  input?: { hint: string };
}

interface CliConfig {
  plugins?: {
    enabledPlugins?: Record<string, boolean>;
  };
}

/** Parse YAML-like frontmatter from a plugin command .md file. */
function parseFrontmatter(content: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return fm;
  const lines = match[1]!.split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    // Strip surrounding quotes from the value (YAML scalar style).
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) fm[key] = val;
  }
  return fm;
}

/**
 * Read enabled plugin commands from `~/.zcode/cli/config.json` + the plugin
 * cache directory. Returns entries suitable for `available_commands_update`.
 *
 * Best-effort: failures are logged and swallowed (returns []).
 */
export function loadPluginCommands(): PluginCommandEntry[] {
  if (!existsSync(CLI_CONFIG_PATH) || !existsSync(PLUGIN_CACHE_DIR)) return [];
  try {
    const cfg = JSON.parse(readFileSync(CLI_CONFIG_PATH, "utf8")) as CliConfig;
    const enabled = cfg.plugins?.enabledPlugins ?? {};
    const entries: PluginCommandEntry[] = [];

    // enabledPlugins keys are "pluginName@marketplace"
    for (const [pluginKey, enabledFlag] of Object.entries(enabled)) {
      if (!enabledFlag) continue;
      const atIdx = pluginKey.indexOf("@");
      if (atIdx <= 0) continue;
      const pluginName = pluginKey.slice(0, atIdx);
      const marketplace = pluginKey.slice(atIdx + 1);

      // Scan all versions of this plugin in the cache (use latest found).
      const marketDir = path.join(PLUGIN_CACHE_DIR, marketplace);
      if (!existsSync(marketDir)) continue;
      const pluginDir = path.join(marketDir, pluginName);
      if (!existsSync(pluginDir)) continue;

      // Find the latest version directory.
      let latestVersion = "";
      for (const entry of readdirSync(pluginDir)) {
        const vDir = path.join(pluginDir, entry);
        if (statSync(vDir).isDirectory() && compareVersions(entry, latestVersion) > 0) {
          latestVersion = entry;
        }
      }
      if (!latestVersion) continue;

      const commandsDir = path.join(pluginDir, latestVersion, "commands");
      if (!existsSync(commandsDir)) continue;

      for (const file of readdirSync(commandsDir)) {
        if (!file.endsWith(".md")) continue;
        const cmdPath = path.join(commandsDir, file);
        const content = readFileSync(cmdPath, "utf8");
        const fm = parseFrontmatter(content);
        const name = file.replace(/\.md$/, "");
        const description = fm["description"] ?? "";
        if (!description) continue;
        const entry: PluginCommandEntry = { name, description };
        const hint = fm["argument-hint"];
        if (hint) entry.input = { hint };
        entries.push(entry);
      }
    }

    log(`plugin-commands: loaded ${entries.length} plugin command(s)`);
    return entries;
  } catch (e) {
    log(
      `plugin-commands: load failed (${e instanceof Error ? e.message : String(e)})`,
    );
    return [];
  }
}
