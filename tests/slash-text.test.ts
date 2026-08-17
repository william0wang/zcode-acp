/**
 * neutralizeSlashText tests — the unknown-slash-command text path.
 *
 * Rule under test: only commands the bridge advertises (static list +
 * passthrough built-ins + TUI-only names + plugin commands) or `$`-prefixed
 * skills go the command route unchanged. Any other `/`-leading prompt (e.g. a
 * pasted directory path) is prefixed with a zero-width space so the backend's
 * trim() + `^\/` command parse can never match, while the visible text is
 * unchanged.
 *
 * The fs mock feeds loadPluginCommands one fake plugin command ("demo-cmd") so
 * the known-command set is deterministic.
 */

import { homedir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- mock fs (plugin-commands reads ~/.zcode/cli/config.json + cache dir) ---

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
        const rest = key.slice(prefix.length);
        if (key.startsWith(prefix) && !rest.includes("/")) entries.push(rest);
      }
      for (const key of mockFiles.keys()) {
        const rest = key.slice(prefix.length);
        if (key.startsWith(prefix) && !rest.includes("/")) entries.push(rest);
      }
      return entries;
    },
    statSync: (p: string) => {
      if (mockDirs.has(p)) return { isDirectory: () => true } as ReturnType<typeof actual.statSync>;
      return actual.statSync(p);
    },
  };
});

const CLI_CONFIG = path.join(homedir(), ".zcode", "cli", "config.json");
const CMD_DIR = path.join(
  homedir(),
  ".zcode",
  "cli",
  "plugins",
  "cache",
  "market",
  "demo",
  "1.0.0",
  "commands",
);

beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  mockFiles.set(
    CLI_CONFIG,
    JSON.stringify({ plugins: { enabledPlugins: { "demo@market": true } } }),
  );
  // loadPluginCommands existsSync-checks each path segment down to commands/.
  mockDirs.add(path.join(homedir(), ".zcode", "cli", "plugins", "cache"));
  mockDirs.add(path.join(homedir(), ".zcode", "cli", "plugins", "cache", "market"));
  mockDirs.add(path.join(homedir(), ".zcode", "cli", "plugins", "cache", "market", "demo"));
  mockDirs.add(
    path.join(homedir(), ".zcode", "cli", "plugins", "cache", "market", "demo", "1.0.0"),
  );
  mockDirs.add(CMD_DIR);
  mockFiles.set(
    path.join(CMD_DIR, "demo-cmd.md"),
    "---\ndescription: Demo plugin command\n---\nbody",
  );
  // loadPluginCommands runs at module load; reset modules so each test sees
  // the fresh fs mock state.
  vi.resetModules();
});

async function load() {
  const { neutralizeSlashText } = await import("../src/handlers/slash.js");
  return neutralizeSlashText;
}

const ZWSP = "\u200B";

describe("neutralizeSlashText", () => {
  it("leaves non-slash prompts unchanged", async () => {
    const f = await load();
    expect(f("hello world")).toBe("hello world");
    expect(f("look at Users/foo")).toBe("look at Users/foo");
  });

  it("leaves advertised static commands unchanged (backend command path)", async () => {
    const f = await load();
    expect(f("/quota")).toBe("/quota");
    expect(f("/compact now")).toBe("/compact now");
    expect(f("/model GLM-5.3")).toBe("/model GLM-5.3");
  });

  it("leaves passthrough built-ins unchanged", async () => {
    const f = await load();
    expect(f("/skill tdd")).toBe("/skill tdd");
    expect(f("/init")).toBe("/init");
  });

  it("leaves $-prefixed skills unchanged", async () => {
    const f = await load();
    expect(f("/$tdd args")).toBe("/$tdd args");
  });

  it("leaves discovered plugin commands unchanged", async () => {
    const f = await load();
    expect(f("/demo-cmd x")).toBe("/demo-cmd x");
  });

  it("neutralizes unknown commands and pasted paths", async () => {
    const f = await load();
    expect(f("/notacommand")).toBe(`${ZWSP}/notacommand`);
    // The reported bug: a directory path pasted into the chat.
    expect(f("/Users/william/Downloads/mitm/fashion")).toBe(
      `${ZWSP}/Users/william/Downloads/mitm/fashion`,
    );
    expect(f("/tmp")).toBe(`${ZWSP}/tmp`);
  });

  it("neutralizes even with leading whitespace (backend trims)", async () => {
    const f = await load();
    const out = f("  /Users/william/project");
    expect(out.startsWith(ZWSP)).toBe(true);
    expect(out.trimStart().startsWith("/")).toBe(false);
  });

  it("neutralized text survives the backend's trim + ^\\/ parse", async () => {
    const f = await load();
    const out = f("/Users/william/project");
    // Mirror of the backend parser: Sua = /^\/([^\s]+)(?:\s+([\s\S]*))?$/ on trimmed text.
    const backendParse = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(out.trim());
    expect(backendParse).toBeNull();
  });

  it("preserves the visible text verbatim after neutralization", async () => {
    const f = await load();
    const msg = "/Users/william/project\nplease review this directory";
    const out = f(msg);
    expect(out.replace(ZWSP, "")).toBe(msg);
  });
});
