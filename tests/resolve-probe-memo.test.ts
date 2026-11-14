/**
 * Catalog-probe resolve memoization: every session/new flight resolves the
 * probe command, and an unmemoized resolution spawns subprocess probes
 * (sqlite support + --version) each time — a synchronous 100-300ms event-loop
 * block on machines the probe then refuses to cover. The per-process memo
 * must collapse repeat resolutions to zero extra spawns.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/** Counts real execFileSync calls so the memo is observable. */
const execCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => {
      execCalls.count++;
      return (actual.execFileSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import { resetResolveMemosForTests, resolveZcodeCommand } from "../src/backend/resolve.js";

const SAVED = {
  ZCODE_BIN: process.env.ZCODE_BIN,
  ZCODE_NODE: process.env.ZCODE_NODE,
};

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetResolveMemosForTests();
});

describe("catalog probe resolve memo", () => {
  it("resolves the probe command once per process across repeated flights", () => {
    process.env.ZCODE_BIN = "/nonexistent/zcode.cjs";
    process.env.ZCODE_NODE = process.execPath;
    execCalls.count = 0;

    const first = resolveZcodeCommand({ catalogProbe: true });
    // One sqlite probe + one --version read for the chosen node, plus the
    // PATH `which node` lookup inside candidate discovery.
    expect(execCalls.count).toBe(3);
    const second = resolveZcodeCommand({ catalogProbe: true });
    expect(second).toEqual(first);
    expect(execCalls.count).toBe(3);
    // The memo hands out copies — a caller cannot corrupt later resolutions.
    second.push("mutation");
    expect(resolveZcodeCommand({ catalogProbe: true })).toEqual(first);
  });

  it("re-resolves after a memo reset", () => {
    process.env.ZCODE_BIN = "/nonexistent/zcode.cjs";
    process.env.ZCODE_NODE = process.execPath;
    resolveZcodeCommand({ catalogProbe: true });
    resetResolveMemosForTests();
    execCalls.count = 0;
    resolveZcodeCommand({ catalogProbe: true });
    expect(execCalls.count).toBe(3);
  });
});
