/**
 * mcp-discovery.ts + /mcp slash command tests — verifies that MCP servers are
 * discovered from config.json and enabled plugin .mcp.json files, and that
 * the /mcp command renders them as a readable card.
 *
 * Also verifies the /mcp slash command no longer returns "not available".
 */

import { homedir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as acp from "@agentclientprotocol/sdk";
import { ZcodeAcpServer } from "../src/server.js";

// --- mock fs ---

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
      if (mockDirs.has(p))
        return { isDirectory: () => true } as ReturnType<typeof actual.statSync>;
      return actual.statSync(p);
    },
  };
});

import { loadMcpServers, formatMcpServers } from "../src/config/mcp-discovery.js";
import { handleSlashCommand } from "../src/handlers/slash.js";

function resetMocks(): void {
  mockFiles.clear();
  mockDirs.clear();
}

const HOME = homedir();

afterEach(() => {
  resetMocks();
});

describe("loadMcpServers", () => {
  it("returns empty when config.json does not exist", () => {
    resetMocks();
    expect(loadMcpServers()).toEqual([]);
  });

  it("discovers stdio servers from config.json", () => {
    resetMocks();
    mockFiles.set(
      `${HOME}/.zcode/cli/config.json`,
      JSON.stringify({
        mcp: {
          servers: {
            codegraph: {
              type: "stdio",
              command: "codegraph",
              args: ["serve", "--mcp"],
            },
          },
        },
      }),
    );
    const servers = loadMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("codegraph");
    expect(servers[0]!.type).toBe("stdio");
    expect(servers[0]!.command).toBe("codegraph");
    expect(servers[0]!.source).toBe("config");
  });

  it("discovers http servers from config.json", () => {
    resetMocks();
    mockFiles.set(
      `${HOME}/.zcode/cli/config.json`,
      JSON.stringify({
        mcp: {
          servers: {
            devdocs: {
              type: "http",
              url: "https://example.com/mcp",
            },
          },
        },
      }),
    );
    const servers = loadMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.type).toBe("http");
    expect(servers[0]!.url).toBe("https://example.com/mcp");
  });

  it("defaults to stdio type when type is not specified", () => {
    resetMocks();
    mockFiles.set(
      `${HOME}/.zcode/cli/config.json`,
      JSON.stringify({
        mcp: {
          servers: {
            "no-type": {
              command: "some-binary",
            },
          },
        },
      }),
    );
    const servers = loadMcpServers();
    expect(servers[0]!.type).toBe("stdio");
  });

  it("discovers MCP servers from enabled plugin .mcp.json (flat format)", () => {
    resetMocks();
    const cacheDir = `${HOME}/.zcode/cli/plugins/cache`;
    mockFiles.set(
      `${HOME}/.zcode/cli/config.json`,
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "context7@claude-plugins-official": true,
          },
        },
      }),
    );
    mockDirs.add(cacheDir);
    mockDirs.add(`${cacheDir}/claude-plugins-official`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/context7`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/context7/0.0.0`);
    mockFiles.set(
      `${cacheDir}/claude-plugins-official/context7/0.0.0/.mcp.json`,
      JSON.stringify({
        context7: {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
        },
      }),
    );

    const servers = loadMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("context7");
    expect(servers[0]!.command).toBe("npx");
    expect(servers[0]!.source).toBe("plugin: context7");
  });

  it("discovers MCP servers from enabled plugin .mcp.json (nested format)", () => {
    resetMocks();
    const cacheDir = `${HOME}/.zcode/cli/plugins/cache`;
    mockFiles.set(
      `${HOME}/.zcode/cli/config.json`,
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "android-emulator@zcode-plugins-official": true,
          },
        },
      }),
    );
    mockDirs.add(cacheDir);
    mockDirs.add(`${cacheDir}/zcode-plugins-official`);
    mockDirs.add(`${cacheDir}/zcode-plugins-official/android-emulator`);
    mockDirs.add(`${cacheDir}/zcode-plugins-official/android-emulator/0.1.0`);
    mockFiles.set(
      `${cacheDir}/zcode-plugins-official/android-emulator/0.1.0/.mcp.json`,
      JSON.stringify({
        mcpServers: {
          "android-emulator": {
            command: "node",
            args: ["dist/mcp/server.js"],
          },
        },
      }),
    );

    const servers = loadMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("android-emulator");
    expect(servers[0]!.command).toBe("node");
    expect(servers[0]!.source).toBe("plugin: android-emulator");
  });

  it("skips MCP servers from disabled plugins", () => {
    resetMocks();
    const cacheDir = `${HOME}/.zcode/cli/plugins/cache`;
    mockFiles.set(
      `${HOME}/.zcode/cli/config.json`,
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "context7@claude-plugins-official": false,
          },
        },
      }),
    );
    mockDirs.add(cacheDir);
    mockDirs.add(`${cacheDir}/claude-plugins-official`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/context7`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/context7/0.0.0`);
    mockFiles.set(
      `${cacheDir}/claude-plugins-official/context7/0.0.0/.mcp.json`,
      JSON.stringify({ context7: { command: "npx" } }),
    );

    expect(loadMcpServers()).toEqual([]);
  });

  it("merges servers from config.json and plugins", () => {
    resetMocks();
    const cacheDir = `${HOME}/.zcode/cli/plugins/cache`;
    mockFiles.set(
      `${HOME}/.zcode/cli/config.json`,
      JSON.stringify({
        mcp: {
          servers: {
            codegraph: { type: "stdio", command: "codegraph" },
          },
        },
        plugins: {
          enabledPlugins: {
            "context7@claude-plugins-official": true,
          },
        },
      }),
    );
    mockDirs.add(cacheDir);
    mockDirs.add(`${cacheDir}/claude-plugins-official`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/context7`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/context7/0.0.0`);
    mockFiles.set(
      `${cacheDir}/claude-plugins-official/context7/0.0.0/.mcp.json`,
      JSON.stringify({ context7: { command: "npx" } }),
    );

    const servers = loadMcpServers();
    expect(servers).toHaveLength(2);
    const names = servers.map((s) => s.name).sort();
    expect(names).toEqual(["codegraph", "context7"]);
  });
});

describe("formatMcpServers", () => {
  it("shows a message when no servers are configured", () => {
    const text = formatMcpServers([]);
    expect(text).toContain("No MCP servers configured");
  });

  it("formats config servers with name, type, and endpoint", () => {
    const text = formatMcpServers([
      {
        name: "codegraph",
        type: "stdio",
        command: "codegraph",
        args: ["serve", "--mcp"],
        source: "config",
      },
    ]);
    expect(text).toContain("MCP Servers (1)");
    expect(text).toContain("codegraph");
    expect(text).toContain("stdio");
    expect(text).toContain("codegraph serve --mcp");
    expect(text).toContain("From config.json:");
  });

  it("formats http servers with URL host", () => {
    const text = formatMcpServers([
      {
        name: "devdocs",
        type: "http",
        url: "https://example.com/mcp",
        source: "config",
      },
    ]);
    expect(text).toContain("example.com/mcp");
  });

  it("formats plugin servers with plugin label", () => {
    const text = formatMcpServers([
      {
        name: "context7",
        type: "stdio",
        command: "npx",
        source: "plugin: context7",
      },
    ]);
    expect(text).toContain("From plugins:");
    expect(text).toContain("context7");
    expect(text).toContain("[context7]");
  });

  it("includes the auto-invoke note", () => {
    const text = formatMcpServers([
      { name: "s", type: "stdio", command: "x", source: "config" },
    ]);
    expect(text).toContain("auto-invoked by the model");
  });
});

describe("/mcp slash command", () => {
  const SID = "sess_test";

  /** Mock AgentContext that records notify calls. */
  function mockContext(): { cx: acp.AgentContext; sent: unknown[] } {
    const sent: unknown[] = [];
    const cx = {
      notify(_method: string, params: { update: unknown }) {
        sent.push(params.update);
        return Promise.resolve();
      },
    } as unknown as acp.AgentContext;
    return { cx, sent };
  }

  it("returns end_turn with server list (not 'not available')", async () => {
    resetMocks();
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

    const { cx, sent } = mockContext();
    const server = new ZcodeAcpServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/mcp");

    expect(result).not.toBeNull();
    expect(result?.stopReason).toBe("end_turn");

    const textChunk = sent.find(
      (s) => (s as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk",
    ) as { content?: { text?: string } } | undefined;
    expect(textChunk?.content?.text).toContain("MCP Servers");
    expect(textChunk?.content?.text).toContain("codegraph");
    expect(textChunk?.content?.text).not.toContain("not available");
  });

  it("returns end_turn with 'no servers' message when empty", async () => {
    resetMocks();
    mockFiles.set(
      `${HOME}/.zcode/cli/config.json`,
      JSON.stringify({ mcp: { servers: {} } }),
    );

    const { cx, sent } = mockContext();
    const server = new ZcodeAcpServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/mcp");

    expect(result?.stopReason).toBe("end_turn");
    const textChunk = sent.find(
      (s) => (s as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk",
    ) as { content?: { text?: string } } | undefined;
    expect(textChunk?.content?.text).toContain("No MCP servers configured");
  });
});
