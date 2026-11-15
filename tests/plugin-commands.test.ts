/**
 * plugin-commands.ts + slash.ts tests — plugin command discovery and
 * unsupported-command error handling.
 *
 * loadPluginCommands is tested by mocking node:fs to provide a synthetic
 * config.json + plugin cache directory structure.
 *
 * handleSlashCommand's default-branch behavior is tested by checking whether
 * unsupported TUI commands return a friendly error vs. unknown commands
 * returning null (passthrough).
 */

import { homedir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as acp from "@agentclientprotocol/sdk";

import { ZcodeAcpServer } from "../src/server.js";

// --- mock fs for loadPluginCommands ---

const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => mockDirs.has(p) || mockFiles.has(p) || actual.existsSync(p),
    readFileSync: (p: string) => {
      if (mockFiles.has(p)) return mockFiles.get(p)!;
      return actual.readFileSync(p);
    },
    readdirSync: (p: string) => {
      // Return mock entries if any exist in the mock store; otherwise delegate.
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
      return entries.length > 0 ? entries : actual.readdirSync(p);
    },
    statSync: (p: string) => {
      if (mockDirs.has(p)) return { isDirectory: () => true } as ReturnType<typeof actual.statSync>;
      return actual.statSync(p);
    },
  };
});

// Import after mocks.
import { loadPluginCommands } from "../src/config/plugin-commands.js";
import { messages } from "../src/i18n.js";
import { handleSlashCommand } from "../src/handlers/slash.js";

function resetMocks(): void {
  mockFiles.clear();
  mockDirs.clear();
}

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

/** Build a minimal server for slash command tests (no backend needed). */
function makeServer(): ZcodeAcpServer {
  const s = new ZcodeAcpServer();
  return s;
}

const SID = "sess_test";

afterEach(() => {
  resetMocks();
});

describe("loadPluginCommands", () => {
  it("loads enabled plugin commands with description and argument-hint", () => {
    resetMocks();

    const home = homedir();
    const configPath = `${home}/.zcode/cli/config.json`;
    const cacheDir = `${home}/.zcode/cli/plugins/cache`;

    // Config with one enabled plugin
    mockFiles.set(
      configPath,
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "code-review@claude-plugins-official": true,
            "disabled-plugin@claude-plugins-official": false,
          },
        },
      }),
    );

    // Plugin directory structure
    mockDirs.add(cacheDir);
    mockDirs.add(`${cacheDir}/claude-plugins-official`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/code-review`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/code-review/0.0.0`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/code-review/0.0.0/commands`);

    // Plugin command file
    mockFiles.set(
      `${cacheDir}/claude-plugins-official/code-review/0.0.0/commands/code-review.md`,
      `---\ndescription: Code review a pull request\nargument-hint: "[pr number or url]"\n---\n\nReview the PR.`,
    );

    const commands = loadPluginCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe("code-review");
    expect(commands[0]!.description).toBe("Code review a pull request");
    expect(commands[0]!.input).toEqual({ hint: "[pr number or url]" });
  });

  it("reads the CLI config and plugin cache from ZCODE_HOME when set", () => {
    resetMocks();

    // An isolated data root that shares nothing with the real ~/.zcode:
    // config + plugin cache there must be discovered, the real home ignored.
    const altRoot = path.join(homedir(), "zcode-alt-home");
    const configPath = `${altRoot}/cli/config.json`;
    const cacheDir = `${altRoot}/cli/plugins/cache`;

    // Real-home plugin of the same name — must NOT be picked up.
    const realCache = `${homedir()}/.zcode/cli/plugins/cache`;
    mockFiles.set(
      `${homedir()}/.zcode/cli/config.json`,
      JSON.stringify({
        plugins: { enabledPlugins: { "decoy@claude-plugins-official": true } },
      }),
    );
    mockDirs.add(realCache);
    mockDirs.add(`${realCache}/claude-plugins-official`);
    mockDirs.add(`${realCache}/claude-plugins-official/decoy`);
    mockDirs.add(`${realCache}/claude-plugins-official/decoy/0.0.0`);
    mockDirs.add(`${realCache}/claude-plugins-official/decoy/0.0.0/commands`);
    mockFiles.set(
      `${realCache}/claude-plugins-official/decoy/0.0.0/commands/decoy.md`,
      `---\ndescription: Real-home decoy command\n---\n`,
    );

    mockFiles.set(
      configPath,
      JSON.stringify({
        plugins: { enabledPlugins: { "code-review@claude-plugins-official": true } },
      }),
    );
    mockDirs.add(cacheDir);
    mockDirs.add(`${cacheDir}/claude-plugins-official`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/code-review`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/code-review/0.0.0`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/code-review/0.0.0/commands`);
    mockFiles.set(
      `${cacheDir}/claude-plugins-official/code-review/0.0.0/commands/code-review.md`,
      `---\ndescription: Code review a pull request\n---\n`,
    );

    vi.stubEnv("ZCODE_HOME", altRoot);
    try {
      const commands = loadPluginCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0]!.name).toBe("code-review");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("handleSlashCommand — unsupported TUI commands", () => {
  it("intercepts /workflow with the gated disabled notice (no gate resolved)", async () => {
    // /workflow left the TUI-only set: it is gated by the dynamic-workflow
    // verdict instead. With no gate resolved (backend never spawned) the
    // fail-closed branch intercepts with workflowDisabled — still an `ok`
    // interception, never raw text to the model.
    const { cx, sent } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/workflow");
    expect(result?.stopReason).toBe("end_turn");
    expect(sent).toHaveLength(1);
    const chunk = sent[0] as { sessionUpdate: string; content: { text: string } };
    expect(chunk.sessionUpdate).toBe("agent_message_chunk");
    expect(chunk.content.text).toBe(messages().workflowDisabled);
  });
});

describe("handleSlashCommand — passthrough commands", () => {
  it("returns null for unknown /x commands (extensibility)", async () => {
    const { cx } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/code-review 123");
    expect(result).toBeNull();
  });
});

describe("handleSlashCommand — non-command text", () => {
  it("returns null for text not starting with /", async () => {
    const { cx } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "hello world");
    expect(result).toBeNull();
  });
});
