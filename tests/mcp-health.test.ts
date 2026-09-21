/**
 * /mcp live health panel — the backend `mcp/list` RPC with `mode:"status"`
 * (per-server health WITHOUT connecting; result `{statuses: Record<name,
 * {status, transport, toolCount, failureKind?, authorization?}>}`). Covers the
 * panel formatter and the slash-command wiring: RPC success upgrades the card
 * to health lines, any RPC failure (older backend / -32601 / empty map) keeps
 * the local-discovery output unchanged.
 */

import { homedir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as acp from "@agentclientprotocol/sdk";
import { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeResponse } from "../src/backend/types.js";

// --- mock fs (same shape as mcp-list.test.ts) ---

const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => mockDirs.has(p) || mockFiles.has(p),
    readFileSync: ((p: string, ...args: unknown[]) => {
      if (mockFiles.has(p)) return mockFiles.get(p)!;
      return actual.readFileSync(p, ...(args as [unknown]));
    }) as typeof actual.readFileSync,
    readdirSync: (p: string) => {
      const entries: string[] = [];
      const prefix = p + "/";
      for (const key of mockDirs) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (!rest.includes("/")) entries.push(rest);
        }
      }
      for (const key of mockFiles.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (!rest.includes("/")) entries.push(rest);
        }
      }
      return entries;
    },
    statSync: (p: string) => {
      if (mockDirs.has(p)) return { isDirectory: () => true } as ReturnType<typeof actual.statSync>;
      return actual.statSync(p);
    },
  };
});

import { formatMcpServerHealth, type McpServerHealth } from "../src/config/mcp-discovery.js";
import { handleSlashCommand } from "../src/handlers/slash.js";

const HOME = homedir();
const SID = "sess_mcp_health";
const CWD = "/proj/mcp-health";

// Asserts the English card; pin the language (see mcp-list.test.ts).
beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});

afterEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  vi.unstubAllEnvs();
});

/** Mock AgentContext that records notify calls. */
function mockContext(): { cx: acp.AgentContext; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const cx = {
    notify(_method: string, params: { update: unknown }) {
      sent.push(params.update as Record<string, unknown>);
      return Promise.resolve();
    },
  } as unknown as acp.AgentContext;
  return { cx, sent };
}

function textChunkOf(sent: Record<string, unknown>[]): string {
  const chunk = sent.find((s) => s["sessionUpdate"] === "agent_message_chunk") as
    { content?: { text?: string } } | undefined;
  return chunk?.content?.text ?? "";
}

/** Seed one configured server so the fallback card has content. */
function seedLocalServer(): void {
  mockFiles.set(
    `${HOME}/.zcode/cli/config.json`,
    JSON.stringify({
      mcp: {
        servers: {
          codegraph: { type: "stdio", command: "codegraph", args: ["serve", "--mcp"] },
        },
      },
    }),
  );
}

/**
 * Server with a fake backend answering `mcp/list`. `mcpListResult` is returned
 * verbatim; an `mcpListError` answers as a JSON-RPC error instead. Captures
 * the outgoing params for assertion.
 */
function makeServer(mcpList: {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}): { server: ZcodeAcpServer; mcpListParams: () => Record<string, unknown> | undefined } {
  const server = new ZcodeAcpServer();
  server.registerSession(SID, SID);
  server.sessionCwds.set(SID, CWD);
  let params: Record<string, unknown> | undefined;
  server.backend = {
    isDead: false,
    request: async (
      id: number,
      method: string,
      p: Record<string, unknown>,
    ): Promise<ZcodeResponse> => {
      if (method === "mcp/list") {
        params = p;
        if (mcpList.error) {
          return { id, error: mcpList.error } as ZcodeResponse;
        }
        return { id, result: mcpList.result ?? {} } as ZcodeResponse;
      }
      return { id, result: {} } as ZcodeResponse;
    },
  } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
  return { server, mcpListParams: () => params };
}

describe("formatMcpServerHealth", () => {
  it("renders name · status · toolCount · failureKind with the authorizationUrl indented", () => {
    const text = formatMcpServerHealth({
      devdocs: {
        status: "failed",
        toolCount: 0,
        failureKind: "connection_timeout",
        authorizationUrl: "https://auth.example.com/mcp/authorize",
      },
    });
    expect(text).toContain("MCP Servers (1) · backend status");
    expect(text).toContain("devdocs · failed · 0 tools · connection_timeout");
    expect(text).toContain("    https://auth.example.com/mcp/authorize");
    expect(text).toContain("auto-invoked by the model");
  });

  it("omits failureKind when absent", () => {
    const text = formatMcpServerHealth({
      codegraph: { status: "connected", toolCount: 12 },
    });
    expect(text).toContain("codegraph · connected · 12 tools");
    expect(text).not.toContain("failureKind");
    // No authorization line.
    expect(text).not.toMatch(/^\s+http/m);
  });

  it("sorts servers by name for a stable panel", () => {
    const text = formatMcpServerHealth({
      zeta: { status: "connected", toolCount: 1 },
      alpha: { status: "connected", toolCount: 2 },
    });
    const a = text.indexOf("alpha");
    const z = text.indexOf("zeta");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(z);
  });

  it("renders the no-servers message for an empty map", () => {
    expect(formatMcpServerHealth({} as Record<string, McpServerHealth>)).toContain(
      "No MCP servers configured",
    );
  });
});

describe("/mcp slash command backend health", () => {
  it("RPC success renders one health line per server (mode:status + workspace params)", async () => {
    seedLocalServer();
    const { server, mcpListParams } = makeServer({
      result: {
        statuses: {
          codegraph: {
            status: "connected",
            transport: "stdio",
            toolCount: 12,
            updatedAt: "2026-09-21T00:00:00Z",
          },
          devdocs: {
            status: "failed",
            transport: "http",
            toolCount: 0,
            updatedAt: "2026-09-21T00:00:00Z",
            failureKind: "oauth_authorization_failed",
            authorization: {
              type: "oauth_authorization_code",
              authorizationUrl: "https://auth.example.com/mcp/authorize",
              startedAt: "2026-09-21T00:00:00Z",
            },
          },
        },
      },
    });
    const { cx, sent } = mockContext();
    const result = await handleSlashCommand(server, cx, SID, SID, "/mcp");

    expect(result?.stopReason).toBe("end_turn");
    // The RPC asked for status-only health scoped to the session's workspace.
    expect(mcpListParams()).toEqual({
      workspace: { workspacePath: CWD, workspaceKey: CWD },
      mode: "status",
    });
    const text = textChunkOf(sent);
    expect(text).toContain("MCP Servers (2) · backend status");
    expect(text).toContain("codegraph · connected · 12 tools");
    expect(text).toContain("devdocs · failed · 0 tools · oauth_authorization_failed");
    expect(text).toContain("    https://auth.example.com/mcp/authorize");
  });

  it("RPC error (-32601, older backend) falls back to the local-discovery card", async () => {
    seedLocalServer();
    const { server } = makeServer({
      error: { code: -32601, message: "Method not found" },
    });
    const { cx, sent } = mockContext();
    const result = await handleSlashCommand(server, cx, SID, SID, "/mcp");

    expect(result?.stopReason).toBe("end_turn");
    const text = textChunkOf(sent);
    expect(text).toContain("MCP Servers (1)");
    expect(text).toContain("From config.json:");
    expect(text).toContain("codegraph serve --mcp");
    expect(text).not.toContain("backend status");
  });

  it("RPC success with an empty status map falls back to the local card", async () => {
    seedLocalServer();
    const { server } = makeServer({ result: { statuses: {} } });
    const { cx, sent } = mockContext();
    await handleSlashCommand(server, cx, SID, SID, "/mcp");
    const text = textChunkOf(sent);
    expect(text).toContain("From config.json:");
    expect(text).not.toContain("backend status");
  });

  it("no local config + RPC failure still renders the no-servers message", async () => {
    const { server } = makeServer({
      error: { code: -32601, message: "Method not found" },
    });
    const { cx, sent } = mockContext();
    const result = await handleSlashCommand(server, cx, SID, SID, "/mcp");
    expect(result?.stopReason).toBe("end_turn");
    expect(textChunkOf(sent)).toContain("No MCP servers configured");
  });
});
