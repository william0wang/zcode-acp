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
      if (mockDirs.has(p))
        return { isDirectory: () => true } as ReturnType<typeof actual.statSync>;
      return actual.statSync(p);
    },
  };
});

// Import after mocks.
import { loadPluginCommands } from "../src/config/plugin-commands.js";
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
  it("returns empty when config.json does not exist", () => {
    resetMocks();
    // No files/dirs set up → existsSync returns false
    expect(loadPluginCommands()).toEqual([]);
  });

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

  it("skips disabled plugins", () => {
    resetMocks();

    const home = homedir();
    mockFiles.set(
      `${home}/.zcode/cli/config.json`,
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "code-review@claude-plugins-official": false,
          },
        },
      }),
    );

    expect(loadPluginCommands()).toEqual([]);
  });

  it("skips plugins without commands directory", () => {
    resetMocks();

    const home = homedir();
    const cacheDir = `${home}/.zcode/cli/plugins/cache`;

    mockFiles.set(
      `${home}/.zcode/cli/config.json`,
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
    // No commands/ directory

    expect(loadPluginCommands()).toEqual([]);
  });

  it("skips command .md files without description", () => {
    resetMocks();

    const home = homedir();
    const cacheDir = `${home}/.zcode/cli/plugins/cache`;

    mockFiles.set(
      `${home}/.zcode/cli/config.json`,
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "test-plugin@claude-plugins-official": true,
          },
        },
      }),
    );

    mockDirs.add(cacheDir);
    mockDirs.add(`${cacheDir}/claude-plugins-official`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/test-plugin`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/test-plugin/1.0.0`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/test-plugin/1.0.0/commands`);

    mockFiles.set(
      `${cacheDir}/claude-plugins-official/test-plugin/1.0.0/commands/bad-cmd.md`,
      `---\nsome-key: value\n---\n\nNo description here.`,
    );

    expect(loadPluginCommands()).toEqual([]);
  });

  it("uses the latest version directory", () => {
    resetMocks();

    const home = homedir();
    const cacheDir = `${home}/.zcode/cli/plugins/cache`;

    mockFiles.set(
      `${home}/.zcode/cli/config.json`,
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "test-plugin@claude-plugins-official": true,
          },
        },
      }),
    );

    mockDirs.add(cacheDir);
    mockDirs.add(`${cacheDir}/claude-plugins-official`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/test-plugin`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/test-plugin/1.0.0`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/test-plugin/1.0.0/commands`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/test-plugin/2.0.0`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/test-plugin/2.0.0/commands`);

    mockFiles.set(
      `${cacheDir}/claude-plugins-official/test-plugin/1.0.0/commands/old-cmd.md`,
      `---\ndescription: Old version command\n---\n`,
    );
    mockFiles.set(
      `${cacheDir}/claude-plugins-official/test-plugin/2.0.0/commands/new-cmd.md`,
      `---\ndescription: New version command\n---\n`,
    );

    const commands = loadPluginCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe("new-cmd");
    expect(commands[0]!.description).toBe("New version command");
  });

  it("uses semver comparison for multi-digit versions (10.0.0 > 2.0.0)", () => {
    resetMocks();

    const home = homedir();
    const cacheDir = `${home}/.zcode/cli/plugins/cache`;

    mockFiles.set(
      `${home}/.zcode/cli/config.json`,
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "test-plugin@claude-plugins-official": true,
          },
        },
      }),
    );

    mockDirs.add(cacheDir);
    mockDirs.add(`${cacheDir}/claude-plugins-official`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/test-plugin`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/test-plugin/2.0.0`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/test-plugin/2.0.0/commands`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/test-plugin/10.0.0`);
    mockDirs.add(`${cacheDir}/claude-plugins-official/test-plugin/10.0.0/commands`);

    mockFiles.set(
      `${cacheDir}/claude-plugins-official/test-plugin/2.0.0/commands/old-cmd.md`,
      `---\ndescription: Version 2\n---\n`,
    );
    mockFiles.set(
      `${cacheDir}/claude-plugins-official/test-plugin/10.0.0/commands/new-cmd.md`,
      `---\ndescription: Version 10\n---\n`,
    );

    const commands = loadPluginCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe("new-cmd");
    expect(commands[0]!.description).toBe("Version 10");
  });
});

describe("handleSlashCommand — unsupported TUI commands", () => {
  it("returns friendly error for /plugins", async () => {
    const { cx } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/plugins");
    expect(result?.stopReason).toBe("end_turn");
  });

  it("returns friendly error for /expert", async () => {
    const { cx } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/expert");
    expect(result?.stopReason).toBe("end_turn");
  });

  it("returns friendly error for /login", async () => {
    const { cx } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/login");
    expect(result?.stopReason).toBe("end_turn");
  });

  it("returns friendly error for /workflow", async () => {
    const { cx } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/workflow");
    expect(result?.stopReason).toBe("end_turn");
  });
});

describe("handleSlashCommand — passthrough commands", () => {
  it("returns null for /skill (backend resolves it)", async () => {
    const { cx } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/skill");
    expect(result).toBeNull();
  });

  it("returns null for /skill with arguments", async () => {
    const { cx } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(
      server,
      cx,
      SID,
      SID,
      "/skill diagnosing-bugs fix the login bug",
    );
    expect(result).toBeNull();
  });

  it("returns null for /init (backend resolves it)", async () => {
    const { cx } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/init");
    expect(result).toBeNull();
  });

  it("returns null for unknown /x commands (extensibility)", async () => {
    const { cx } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/code-review 123");
    expect(result).toBeNull();
  });

  it("returns null for /code-review (plugin command passthrough)", async () => {
    const { cx } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/code-review");
    expect(result).toBeNull();
  });

  it("returns null for $-prefixed skill commands (passthrough)", async () => {
    const { cx } = mockContext();
    const server = makeServer();
    // $-prefixed commands are discovered skills — pass through to the model.
    const result = await handleSlashCommand(server, cx, SID, SID, "/$tdd fix the bug");
    expect(result).toBeNull();
  });

  it("returns null for $-prefixed skill without args", async () => {
    const { cx } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/$arco-design");
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
