/**
 * MCP server discovery — reads MCP server configurations from the same sources
 * ZCode uses, so `/mcp` can show users exactly which servers are available.
 *
 * Sources:
 *   1. <zcode-home>/cli/config.json → mcp.servers (user-configured)
 *   2. Enabled plugin .mcp.json files (two formats: flat and nested)
 *
 * `<zcode-home>` is the ZCode data root (`~/.zcode`, or `$ZCODE_HOME` when
 * set — see `zcodeHomeDir()`).
 *
 * The ZCode backend loads these automatically and exposes their tools to the
 * model. This module is purely informational — it lists what's configured so
 * users know what's available without needing the TUI.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { messages } from "../i18n.js";
import { compareVersions, log, zcodeCliConfigPath, zcodePluginCacheDir } from "../utils.js";

/** Information about a discovered MCP server. */
export interface McpServerInfo {
  name: string;
  type: string; // "stdio" | "http" | "sse" | ...
  command?: string; // stdio servers
  args?: string[]; // stdio servers
  url?: string; // http/sse servers
  source: string; // "config" or "plugin: <name>"
}

interface CliConfig {
  mcp?: {
    servers?: Record<string, McpServerConfig>;
  };
  plugins?: {
    enabledPlugins?: Record<string, boolean>;
  };
}

interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
}

/**
 * Discover all MCP servers from config.json and enabled plugins.
 *
 * Best-effort: failures are logged and swallowed.
 */
export function loadMcpServers(): McpServerInfo[] {
  const results: McpServerInfo[] = [];

  let config: CliConfig | null = null;
  try {
    const cliConfigPath = zcodeCliConfigPath();
    if (existsSync(cliConfigPath)) {
      config = JSON.parse(readFileSync(cliConfigPath, "utf8")) as CliConfig;
    }
  } catch (e) {
    log(`mcp-discovery: config read failed (${e instanceof Error ? e.message : String(e)})`);
    return results;
  }

  // 1. User-configured servers from config.json.
  const servers = config?.mcp?.servers ?? {};
  for (const [name, cfg] of Object.entries(servers)) {
    results.push({
      name,
      type: cfg.type ?? "stdio",
      command: cfg.command,
      args: cfg.args,
      url: cfg.url,
      source: "config",
    });
  }

  // 2. Plugin-provided servers from .mcp.json files.
  const enabledPlugins = config?.plugins?.enabledPlugins ?? {};
  for (const [pluginKey, enabledFlag] of Object.entries(enabledPlugins)) {
    if (!enabledFlag) continue;
    const atIdx = pluginKey.indexOf("@");
    if (atIdx <= 0) continue;
    const pluginName = pluginKey.slice(0, atIdx);
    const marketplace = pluginKey.slice(atIdx + 1);

    const pluginDir = path.join(zcodePluginCacheDir(), marketplace, pluginName);
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

    const mcpFile = path.join(pluginDir, latestVersion, ".mcp.json");
    if (!existsSync(mcpFile)) continue;

    try {
      const mcpConfig = JSON.parse(readFileSync(mcpFile, "utf8")) as Record<
        string,
        Record<string, McpServerConfig>
      >;
      // Two formats:
      //   Flat:   { "server-name": { "command": "..." } }
      //   Nested: { "mcpServers": { "server-name": { ... } } }
      const serverMap = mcpConfig["mcpServers"] ?? mcpConfig;
      for (const [name, cfg] of Object.entries(serverMap)) {
        results.push({
          name,
          type: cfg.type ?? "stdio",
          command: cfg.command,
          args: cfg.args,
          url: cfg.url,
          source: `plugin: ${pluginName}`,
        });
      }
    } catch (e) {
      log(
        `mcp-discovery: failed to read ${mcpFile} (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  log(`mcp-discovery: found ${results.length} MCP server(s)`);
  return results;
}

/**
 * Format MCP servers into a human-readable card for the `/mcp` command.
 *
 * Groups by source (config vs plugins) and aligns columns for readability.
 */
export function formatMcpServers(servers: McpServerInfo[]): string {
  const m = messages();
  if (servers.length === 0) {
    return m.mcpNone;
  }

  const configServers = servers.filter((s) => s.source === "config");
  const pluginServers = servers.filter((s) => s.source !== "config");

  const lines: string[] = [m.mcpHeader(servers.length)];

  if (configServers.length > 0) {
    lines.push("", m.mcpFromConfig);
    for (const s of configServers) {
      lines.push(`  ${pad(s.name, 16)} ${pad(s.type, 6)} ${formatEndpoint(s)}`);
    }
  }

  if (pluginServers.length > 0) {
    lines.push("", m.mcpFromPlugins);
    for (const s of pluginServers) {
      const pluginLabel = `[${s.source.replace("plugin: ", "")}]`;
      lines.push(`  ${pad(s.name, 16)} ${pad(s.type, 6)} ${formatEndpoint(s)}  ${pluginLabel}`);
    }
  }

  lines.push("", m.mcpFooter);
  return lines.join("\n");
}

/** Format the endpoint/command string for display. */
function formatEndpoint(s: McpServerInfo): string {
  if (s.url) {
    try {
      const u = new URL(s.url);
      return u.host + u.pathname;
    } catch {
      return s.url;
    }
  }
  if (s.command) {
    const args = s.args?.length ? " " + s.args.join(" ") : "";
    return s.command + args;
  }
  return "?";
}

/** Pad a string to the given width for column alignment. */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Per-server health from the backend `mcp/list` RPC with `mode:"status"`
 * (zcodeMcpServerStatusSnapshot): per-server health WITHOUT connecting.
 * `failureKind` and `authorizationUrl` are present only when set.
 */
export interface McpServerHealth {
  status: string;
  toolCount: number;
  failureKind?: string;
  authorizationUrl?: string;
}

/**
 * Format the backend's live MCP health map into a card for `/mcp`.
 *
 * One line per server — `name · status · N tools · failureKind` (failureKind
 * only when present, raw enum value) — with a pending OAuth authorizationUrl
 * indented on its own line beneath its server.
 */
export function formatMcpServerHealth(statuses: Record<string, McpServerHealth>): string {
  const m = messages();
  const names = Object.keys(statuses).sort();
  if (names.length === 0) {
    return m.mcpNone;
  }
  const lines: string[] = [m.mcpHealthHeader(names.length), ""];
  for (const name of names) {
    const h = statuses[name]!;
    const parts = [name, h.status, m.mcpHealthTools(h.toolCount)];
    if (h.failureKind) parts.push(h.failureKind);
    lines.push(`  ${parts.join(" · ")}`);
    if (h.authorizationUrl) lines.push(`    ${h.authorizationUrl}`);
  }
  lines.push("", m.mcpFooter);
  return lines.join("\n");
}
