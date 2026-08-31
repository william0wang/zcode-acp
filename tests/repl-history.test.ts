/**
 * history.ts tests — per-project prompt history (ADR-0008).
 *
 * fs is mocked with a Map-based fake filesystem (repo pattern): loadHistory /
 * saveHistory round-trip through it, including the over-cap truncate-rewrite
 * and malformed-line tolerance.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({ homedir: () => "/home/tester" }));

const mockFiles = new Map<string, string>();
const writes: Array<{ path: string; data: string }> = [];

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => mockFiles.has(p),
    mkdirSync: () => undefined,
    readFileSync: (p: string) => {
      if (mockFiles.has(p)) return mockFiles.get(p)!;
      throw new Error("ENOENT");
    },
    writeFileSync: (p: string, data: string) => {
      writes.push({ path: p, data });
      mockFiles.set(p, data);
    },
  };
});

import {
  HISTORY_MAX,
  historyPath,
  loadHistory,
  pushHistory,
  saveHistory,
} from "../src/repl/history.js";

const FILE = join("/home/tester", ".zcode", "acp", "repl-history", `${sha1("/proj")}.jsonl`);

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

beforeEach(() => {
  mockFiles.clear();
  writes.length = 0;
});

describe("historyPath", () => {
  it("hashes the cwd into a stable file under ~/.zcode/acp/repl-history", () => {
    const p = historyPath("/proj");
    expect(p.startsWith(join("/home/tester", ".zcode", "acp", "repl-history") + "/")).toBe(true);
    expect(p.endsWith(`${sha1("/proj")}.jsonl`)).toBe(true);
    expect(historyPath("/other")).not.toBe(p);
  });
});

describe("pushHistory", () => {
  it("appends and suppresses only consecutive duplicates", () => {
    let entries = pushHistory([], "one");
    entries = pushHistory(entries, "one"); // consecutive dup — dropped
    entries = pushHistory(entries, "two");
    entries = pushHistory(entries, "one"); // non-consecutive — kept
    expect(entries).toEqual(["one", "two", "one"]);
  });

  it("rejects blank submissions", () => {
    expect(pushHistory(["kept"], "   ")).toEqual(["kept"]);
    expect(pushHistory(["kept"], "")).toEqual(["kept"]);
  });
});

describe("loadHistory", () => {
  it("returns [] for a missing or unreadable file", () => {
    expect(loadHistory(FILE)).toEqual([]);
  });

  it("parses JSONL in order and skips bad lines", () => {
    mockFiles.set(
      FILE,
      JSON.stringify("first") + "\nnot json\n" + JSON.stringify("second") + "\n\n42\n",
    );
    expect(loadHistory(FILE)).toEqual(["first", "second"]);
  });

  it("truncates past the cap and rewrites the newest tail", () => {
    const all = Array.from({ length: HISTORY_MAX + 10 }, (_, i) => `entry-${i}`);
    mockFiles.set(FILE, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const loaded = loadHistory(FILE);
    expect(loaded).toHaveLength(HISTORY_MAX);
    expect(loaded[0]).toBe("entry-10");
    expect(writes.some((w) => w.path === FILE && w.data.includes("entry-10"))).toBe(true);
    expect(writes.some((w) => w.data.includes("entry-0\n"))).toBe(false);
  });
});

describe("saveHistory", () => {
  it("writes JSONL and enforces the cap", () => {
    saveHistory(FILE, ["a", "b"]);
    expect(mockFiles.get(FILE)).toBe(JSON.stringify("a") + "\n" + JSON.stringify("b") + "\n");
    saveHistory(
      FILE,
      Array.from({ length: HISTORY_MAX + 1 }, (_, i) => `e${i}`),
    );
    const stored = (mockFiles.get(FILE) ?? "").split("\n").filter(Boolean);
    expect(stored).toHaveLength(HISTORY_MAX);
    expect(JSON.parse(stored[0]!)).toBe("e1");
  });
});
