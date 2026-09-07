/**
 * lazy-sessions.ts tests — the durable alias store that keeps lazy session/new
 * placeholders resolvable across bridge restarts.
 *
 * The store writes ~/.zcode/v2/acp-lazy-sessions.json (path derived from HOME
 * at call time); tests stub HOME and mock node:fs so nothing touches disk.
 */

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  lookupLazySession,
  recordMaterializedSession,
  rememberLazySession,
} from "../src/lazy-sessions.js";

const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
const STORE = "/fake-home/.zcode/v2/acp-lazy-sessions.json";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => mockFiles.has(p) || mockDirs.has(p),
    readFileSync: (p: string) => {
      if (mockFiles.has(p)) return mockFiles.get(p)!;
      throw new Error(`ENOENT: ${p}`);
    },
    writeFileSync: (p: string, data: string) => {
      mockDirs.add(path.dirname(p));
      mockFiles.set(p, String(data));
    },
    renameSync: (from: string, to: string) => {
      mockFiles.set(to, mockFiles.get(from) ?? "");
      mockFiles.delete(from);
    },
    mkdirSync: (p: string) => {
      mockDirs.add(String(p));
    },
  };
});

beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  vi.stubEnv("HOME", "/fake-home");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lazy session alias store", () => {
  it("records a placeholder at session/new and reads it back", () => {
    rememberLazySession("acp_1", "/tmp/ws");

    expect(lookupLazySession("acp_1")).toEqual({ cwd: "/tmp/ws", createdAt: expect.any(Number) });
    expect(lookupLazySession("acp_missing")).toBeUndefined();
  });

  it("attaches the backend session id at materialization, keeping cwd and createdAt", () => {
    rememberLazySession("acp_1", "/tmp/ws");
    recordMaterializedSession("acp_1", "sess_1", "/tmp/ws");

    const rec = lookupLazySession("acp_1");
    expect(rec?.zcodeSid).toBe("sess_1");
    expect(rec?.cwd).toBe("/tmp/ws");
    expect(rec?.createdAt).toBeTypeOf("number");
  });

  it("drops expired records on load and rewrites the file", () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000; // older than the 30-day TTL
    mockFiles.set(STORE, JSON.stringify({ stale: { cwd: "/tmp/ws", createdAt: old } }));

    expect(lookupLazySession("stale")).toBeUndefined();
    expect(JSON.parse(mockFiles.get(STORE)!)).toEqual({});
  });

  it("tolerates a corrupt store file", () => {
    mockFiles.set(STORE, "{not json");

    expect(lookupLazySession("acp_1")).toBeUndefined();
  });

  it("writes atomically — no .tmp leftovers at the store path", () => {
    rememberLazySession("acp_1", "/tmp/ws");
    recordMaterializedSession("acp_1", "sess_1", "/tmp/ws");

    const paths = [...mockFiles.keys()];
    expect(paths).toEqual([STORE]);
    // The final content is complete, parseable JSON.
    expect(() => JSON.parse(mockFiles.get(STORE)!)).not.toThrow();
  });

  it("merges over the on-disk table, preserving a concurrent writer's record", () => {
    // Process A's placeholder…
    rememberLazySession("acp_a", "/tmp/ws");
    // …then process B replaces the file wholesale (its own snapshot). Process
    // A's next write must re-read and keep B's record, not clobber it.
    mockFiles.set(STORE, JSON.stringify({ acp_b: { cwd: "/tmp/other", createdAt: Date.now() } }));

    rememberLazySession("acp_c", "/tmp/third");

    const table = JSON.parse(mockFiles.get(STORE)!) as Record<string, { cwd: string }>;
    expect(Object.keys(table).sort()).toEqual(["acp_b", "acp_c"]);
  });
});
