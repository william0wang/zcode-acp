/**
 * Tests for the dual-runtime launcher (src/runtime.ts).
 *
 * The Bun probe shells out (`which`, `bun --version`) and stats candidate
 * paths, so both node:child_process and node:fs are mocked with a synthetic
 * binary table; the pure pieces (version parsing/gating) are pinned directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bunVersionOk,
  parseBunVersion,
  resetRuntimeCache,
  resolveRuntime,
  runtimeArgv,
} from "../src/runtime.js";

// --- mocks: which/version probe + candidate existence ---

const execMocks = new Map<string, string>();
const existingPaths = new Set<string>();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args: string[]) => {
      if (cmd === "which") {
        return (
          execMocks.get(`which ${args[0]}`) ??
          (() => {
            throw new Error("not found");
          })()
        );
      }
      return (
        execMocks.get(`${cmd} ${args.join(" ")}`) ??
        (() => {
          throw new Error("no mock");
        })()
      );
    }),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => existingPaths.has(p) || actual.existsSync(p),
  };
});

/** Plant one bun install: path exists, `bun --version` answers `version`. */
function plantBun(bin: string, version: string): void {
  existingPaths.add(bin);
  execMocks.set(`which bun`, bin);
  execMocks.set(`${bin} --version`, version);
}

beforeEach(() => {
  execMocks.clear();
  existingPaths.clear();
  resetRuntimeCache();
  delete process.env.ZCODE_ACP_RUNTIME;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bun version parsing", () => {
  it("parses plain semver and rejects junk", () => {
    expect(parseBunVersion("1.4.2")).toEqual([1, 4, 2]);
    expect(parseBunVersion(" 1.5.0\n")).toEqual([1, 5, 0]);
    expect(parseBunVersion("bun 1.4")).toBeNull();
    expect(parseBunVersion("")).toBeNull();
  });

  it("gates on the 1.4 minimum", () => {
    expect(bunVersionOk([1, 4, 0])).toBe(true);
    expect(bunVersionOk([2, 0, 0])).toBe(true);
    expect(bunVersionOk([1, 3, 9])).toBe(false);
    expect(bunVersionOk(null)).toBe(false);
  });
});

describe("resolveRuntime policy", () => {
  it("stays on node with no bun installed", () => {
    const rt = resolveRuntime();
    expect(rt.command).toBe(process.execPath);
    expect(rt.preArgs).toEqual([]);
  });

  it("prefers a >=1.4 bun with --smol", () => {
    plantBun("/usr/local/bin/bun", "1.4.2");
    const rt = resolveRuntime();
    expect(rt.command).toBe("/usr/local/bin/bun");
    expect(rt.preArgs).toEqual(["--smol"]);
  });

  it("rejects an old bun (1.3.x had no memory benefit over node)", () => {
    plantBun("/usr/local/bin/bun", "1.3.9");
    const rt = resolveRuntime();
    expect(rt.command).toBe(process.execPath);
  });

  it("ZCODE_ACP_RUNTIME=node forces node even with bun present", () => {
    plantBun("/usr/local/bin/bun", "1.4.2");
    process.env.ZCODE_ACP_RUNTIME = "node";
    expect(resolveRuntime().command).toBe(process.execPath);
  });

  it("builds the full child argv including trailing args", () => {
    plantBun("/usr/local/bin/bun", "1.4.2");
    expect(runtimeArgv("/x/dist/bin/hub.js")).toEqual([
      "/usr/local/bin/bun",
      "--smol",
      "/x/dist/bin/hub.js",
    ]);
    expect(runtimeArgv("/x/dist/cli.js", "serve")).toEqual([
      "/usr/local/bin/bun",
      "--smol",
      "/x/dist/cli.js",
      "serve",
    ]);
  });
});
