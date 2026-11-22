/**
 * Per-server MCP health for the settings surfaces.
 *
 * Thin extraction of the fetch the `/mcp` slash command has always done
 * (src/handlers/slash.ts): the backend `mcp/list` RPC with `mode:"status"`
 * (params `{workspace:{workspacePath, workspaceKey}}` — workspace-level, no
 * sessionId; result `statuses` keyed by server name). The settings route
 * (`GET /settings/mcp-status`) needs the same data, so the fetch lives here
 * once and both callers share it.
 *
 * Best-effort by design: returns null on ANY failure (older backend
 * answering -32601, timeout, malformed result, empty status map) after at
 * most one warn — the caller decides what "unavailable" looks like (the
 * slash card falls back to local discovery; the settings route answers
 * `available:false` and the client shows unknown status).
 */

import type { McpServerHealth } from "../config/mcp-discovery.js";
import type { ZcodeAcpServer } from "../server.js";
import { warn } from "../utils.js";

export async function fetchMcpHealth(
  server: ZcodeAcpServer,
  cwd: string,
  warnLabel = "settings: mcp-status",
): Promise<Record<string, McpServerHealth> | null> {
  try {
    const resp = await (
      await server.ensureBackend()
    ).request(
      server.nextId(),
      "mcp/list",
      { workspace: { workspacePath: cwd, workspaceKey: cwd }, mode: "status" },
      15000,
    );
    if (resp.error) {
      warn(`${warnLabel}: mcp/list failed (${resp.error.message})`);
      return null;
    }
    const raw = (resp.result as { statuses?: unknown } | null)?.statuses;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warn(`${warnLabel}: mcp/list returned no statuses`);
      return null;
    }
    const out: Record<string, McpServerHealth> = {};
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const o = entry as Record<string, unknown>;
      const health: McpServerHealth = {
        status: typeof o["status"] === "string" ? o["status"] : "unknown",
        toolCount: typeof o["toolCount"] === "number" ? o["toolCount"] : 0,
      };
      if (typeof o["failureKind"] === "string") health.failureKind = o["failureKind"];
      const authUrl = (o["authorization"] as { authorizationUrl?: unknown } | undefined)
        ?.authorizationUrl;
      if (typeof authUrl === "string" && authUrl) health.authorizationUrl = authUrl;
      out[name] = health;
    }
    // An empty map carries no health information.
    return Object.keys(out).length > 0 ? out : null;
  } catch (e) {
    warn(`${warnLabel}: mcp/list threw (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}
