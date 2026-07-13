/**
 * Skill discovery — scans the same directories ZCode uses to discover Skills,
 * reads each SKILL.md frontmatter, and returns entries suitable for the ACP
 * `available_commands_update` notification.
 *
 * Each discovered skill becomes its own `/skill-name` slash command in the
 * editor's completion menu (matching Claude Code's behaviour). The model
 * resolves the invocation via its `Skill` tool — the bridge just lists them
 * and passes the text through.
 *
 * Discovery sources (in priority order — first occurrence wins on name clash):
 *   1. ~/.zcode/skills/&#42;/SKILL.md          (user scope, ZCode native)
 *   2. ~/.agents/skills/&#42;/SKILL.md          (user scope, shared agents)
 *   3. enabled plugin <cache>/skills/&#42;/SKILL.md
 *   4. <cwd>/.agents/skills/&#42;/SKILL.md      (project scope)
 *
 * Skills explicitly disabled in `~/.zcode/cli/config.json` (skills map with
 * `enable: false`, keyed by absolute SKILL.md path) are excluded.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { compareVersions, log } from "../utils.js";

/** A slash-command entry compatible with `sendAvailableCommands`. */
export interface SkillEntry {
  name: string;
  description: string;
}

interface CliConfig {
  skills?: Record<string, { enable?: boolean }>;
  plugins?: {
    enabledPlugins?: Record<string, boolean>;
  };
}

const HOME = homedir();

/** Path to the ZCode CLI config (skills enable/disable, plugins, mcp). */
const CLI_CONFIG_PATH = path.join(HOME, ".zcode", "cli", "config.json");

/** Root of the plugin cache directory. */
const PLUGIN_CACHE_DIR = path.join(HOME, ".zcode", "cli", "plugins", "cache");

/** Max description length before truncation with ellipsis. */
const MAX_DESC_LEN = 80;

/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 * Returns a map of key→string (values have surrounding quotes stripped).
 */
function parseFrontmatter(content: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return fm;
  const lines = match[1]!.split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
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

/** Truncate a description to MAX_DESC_LEN, appending "…" if truncated. */
function truncateDesc(desc: string): string {
  if (desc.length <= MAX_DESC_LEN) return desc;
  return desc.slice(0, MAX_DESC_LEN - 1) + "…";
}

/** Read the disabled skill paths from config.json (set of absolute paths). */
function loadDisabledSkillPaths(config: CliConfig | null): Set<string> {
  const disabled = new Set<string>();
  if (!config?.skills) return disabled;
  for (const [skillPath, cfg] of Object.entries(config.skills)) {
    if (cfg?.enable === false) disabled.add(skillPath);
  }
  return disabled;
}

/** Scan a directory for skill subdirectories containing SKILL.md. */
function scanSkillDir(
  dir: string,
  disabledPaths: Set<string>,
  results: SkillEntry[],
  seen: Set<string>,
): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const skillDir = path.join(dir, entry);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const skillMd = path.join(skillDir, "SKILL.md");
    if (!existsSync(skillMd)) continue;

    // Resolve absolute path for disabled-check.
    const absPath = path.resolve(skillMd);
    if (disabledPaths.has(absPath)) continue;

    const content = readFileSync(skillMd, "utf8");
    const fm = parseFrontmatter(content);
    const name = fm["name"] ?? entry;
    const description = fm["description"] ?? "";
    if (!description) continue;

    // Skip explicitly non-user-invocable skills.
    if (fm["user-invocable"] === "false") continue;

    // Prefix with $ so the editor groups skills visually (e.g. "$tdd") and
    // handleSlashCommand can route by prefix.
    const cmdName = `$${name}`;
    if (seen.has(cmdName)) continue;
    seen.add(cmdName);
    results.push({ name: cmdName, description: truncateDesc(description) });
  }
}

/**
 * Discover all enabled skills from the filesystem.
 *
 * Returns entries suitable for `available_commands_update`. Best-effort:
 * failures are logged and swallowed (returns whatever was found).
 */
export function loadSkillCommands(): SkillEntry[] {
  const results: SkillEntry[] = [];
  const seen = new Set<string>();

  // Load config for disabled-skills list + enabled-plugins list.
  let config: CliConfig | null = null;
  try {
    if (existsSync(CLI_CONFIG_PATH)) {
      config = JSON.parse(readFileSync(CLI_CONFIG_PATH, "utf8")) as CliConfig;
    }
  } catch (e) {
    log(`skill-discovery: config read failed (${e instanceof Error ? e.message : String(e)})`);
  }

  const disabledPaths = loadDisabledSkillPaths(config);

  // 1. ~/.zcode/skills/
  scanSkillDir(path.join(HOME, ".zcode", "skills"), disabledPaths, results, seen);

  // 2. ~/.agents/skills/
  scanSkillDir(path.join(HOME, ".agents", "skills"), disabledPaths, results, seen);

  // 3. Enabled plugin skills.
  const enabledPlugins = config?.plugins?.enabledPlugins ?? {};
  for (const [pluginKey, enabledFlag] of Object.entries(enabledPlugins)) {
    if (!enabledFlag) continue;
    const atIdx = pluginKey.indexOf("@");
    if (atIdx <= 0) continue;
    const pluginName = pluginKey.slice(0, atIdx);
    const marketplace = pluginKey.slice(atIdx + 1);

    const pluginDir = path.join(PLUGIN_CACHE_DIR, marketplace, pluginName);
    if (!existsSync(pluginDir)) continue;

    // Find the latest version directory.
    let latestVersion = "";
    try {
      for (const entry of readdirSync(pluginDir)) {
        const vDir = path.join(pluginDir, entry);
        if (statSync(vDir).isDirectory() && compareVersions(entry, latestVersion) > 0) {
          latestVersion = entry;
        }
      }
    } catch {
      continue;
    }
    if (!latestVersion) continue;

    scanSkillDir(
      path.join(pluginDir, latestVersion, "skills"),
      disabledPaths,
      results,
      seen,
    );
  }

  // 4. Project-level .agents/skills/ (if exists).
  scanSkillDir(
    path.join(process.cwd(), ".agents", "skills"),
    disabledPaths,
    results,
    seen,
  );

  log(`skill-discovery: loaded ${results.length} skill(s)`);
  return results;
}
