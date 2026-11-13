/**
 * Tests for the tombstone-retirement liveness oracle (#376):
 * `ZcodeAcpServer.probeGoneBackendSessions`.
 *
 * The oracle answers which tombstoned ids the backend can no longer serve
 * (physically deleted upstream, or soft-deleted — upstream resume refuses
 * both with "Session not found"), so `reviveTombstonesOnActivity` can RETIRE
 * those rows instead of resurrecting zombies. Contract under test:
 *   - primary face: `session/list {sessionIds}` batch (≤64 ids per request),
 *     gone = ids absent from the returned set;
 *   - a strict-zod "Unrecognized key: sessionIds" rejection pins a per-
 *     generation verdict and falls back to per-id `session/lifecycle/getState`;
 *   - ANY failure answers an empty set — "no verdict" means blind revival
 *     (the pre-#376 behavior), never an un-revival;
 *   - an absent backend answers empty (the probe never spawns one).
 */

import { describe, expect, it } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { ZcodeAcpServer } from "../src/server.js";

interface Call {
  method: string;
  params: Record<string, unknown>;
}

type Reply = { error: { code?: number; message: string } } | { result?: unknown };

function makeBackend(handle: (method: string, params: Record<string, unknown>) => Reply): {
  backend: ZcodeBackend;
  calls: Call[];
} {
  const calls: Call[] = [];
  const backend = {
    isDead: false,
    request: async (_id: number, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return handle(method, params);
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, calls };
}

/** Batch face: echo every requested id EXCEPT the `stored` set it drops. */
function listFace(stored: Set<string>) {
  return (method: string, params: Record<string, unknown>): Reply => {
    if (method !== "session/list") return { error: { code: -32601, message: "Method not found" } };
    const ids = (params["sessionIds"] as string[]) ?? [];
    return {
      result: { sessions: ids.filter((id) => stored.has(id)).map((id) => ({ sessionId: id })) },
    };
  };
}

const count = (calls: Call[], method: string) => calls.filter((c) => c.method === method).length;

describe("probeGoneBackendSessions — tombstone retirement oracle", () => {
  it("answers gone = ids the batch listing dropped", async () => {
    const { backend, calls } = makeBackend(listFace(new Set(["a", "c"])));
    const server = new ZcodeAcpServer();
    server.backend = backend;

    const gone = await server.probeGoneBackendSessions(["a", "b", "c", "b"]);
    expect([...gone].sort()).toEqual(["b"]);
    expect(count(calls, "session/list")).toBe(1);
    expect(calls[0]!.params).toEqual({ sessionIds: ["a", "b", "c"] });
    expect(server.sessionIdsQueryRejected).toBe(false);
  });

  it("chunks the batch at the schema's 64-id cap", async () => {
    const ids = Array.from({ length: 65 }, (_, i) => `s${i}`);
    const { backend, calls } = makeBackend(listFace(new Set(ids)));
    const server = new ZcodeAcpServer();
    server.backend = backend;

    const gone = await server.probeGoneBackendSessions(ids);
    expect(gone.size).toBe(0);
    const listCalls = calls.filter((c) => c.method === "session/list");
    expect(listCalls).toHaveLength(2);
    expect((listCalls[0]!.params["sessionIds"] as string[]).length).toBe(64);
    expect((listCalls[1]!.params["sessionIds"] as string[]).length).toBe(1);
  });

  it("an absent backend answers empty (the probe never spawns one)", async () => {
    const server = new ZcodeAcpServer();
    expect(server.backend).toBeNull();
    const gone = await server.probeGoneBackendSessions(["a", "b"]);
    expect(gone.size).toBe(0);
  });

  it("a transport failure answers empty — no verdict, never an un-revival", async () => {
    const { backend } = makeBackend(() => {
      throw new Error("connection reset");
    });
    const server = new ZcodeAcpServer();
    server.backend = backend;

    const gone = await server.probeGoneBackendSessions(["a"]);
    expect(gone.size).toBe(0);
  });

  it("a non-schema RPC error answers empty (transient, verdict stays unpinned)", async () => {
    const { backend } = makeBackend(() => ({ error: { code: -32000, message: "boom" } }));
    const server = new ZcodeAcpServer();
    server.backend = backend;

    expect((await server.probeGoneBackendSessions(["a"])).size).toBe(0);
    expect(server.sessionIdsQueryRejected).toBeNull();
  });

  it("'Unrecognized key: sessionIds' falls back to per-id getState and pins the verdict", async () => {
    const stored = new Set(["a"]);
    const calls: Call[] = [];
    const backend = {
      isDead: false,
      request: async (_id: number, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "session/list") {
          return { error: { code: -32600, message: "Unrecognized key: sessionIds" } };
        }
        if (method === "session/lifecycle/getState") {
          const id = params["sessionId"] as string;
          return stored.has(id)
            ? { result: { state: "unloaded" } }
            : { error: { code: -32004, message: `Session not found: ${id}` } };
        }
        return { error: { code: -32601, message: "Method not found" } };
      },
      send: () => {},
      pollServerRequests: () => [],
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    const server = new ZcodeAcpServer();
    server.backend = backend;

    const gone = await server.probeGoneBackendSessions(["a", "b"]);
    expect([...gone]).toEqual(["b"]);
    expect(server.sessionIdsQueryRejected).toBe(true);
    expect(server.backendLifecycleApi).toBe(true);
    expect(count(calls, "session/lifecycle/getState")).toBe(2);

    // Second probe: the pinned verdict skips the batch face entirely.
    const callsBefore = calls.length;
    const gone2 = await server.probeGoneBackendSessions(["b"]);
    expect([...gone2]).toEqual(["b"]);
    expect(count(calls, "session/list")).toBe(1);
    expect(calls.length - callsBefore).toBe(1);
  });

  it("an unavailable lifecycle family answers empty and pins the verdict", async () => {
    const calls: Call[] = [];
    const backend = {
      isDead: false,
      request: async (_id: number, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "session/list") {
          return { error: { code: -32600, message: "Unrecognized key: sessionIds" } };
        }
        return { error: { code: -32601, message: "Method not found" } };
      },
      send: () => {},
      pollServerRequests: () => [],
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    const server = new ZcodeAcpServer();
    server.backend = backend;

    expect((await server.probeGoneBackendSessions(["a", "b"])).size).toBe(0);
    expect(server.backendLifecycleApi).toBe(false);
    // The lifecycle family verdict short-circuits later per-id probes — with
    // the batch verdict also pinned, the second probe makes NO rpc at all.
    const before = calls.length;
    expect((await server.probeGoneBackendSessions(["a"])).size).toBe(0);
    expect(calls.length - before).toBe(0);
  });

  it("resetBackendGeneration clears both pinned verdicts", async () => {
    const server = new ZcodeAcpServer();
    server.sessionIdsQueryRejected = true;
    server.backendLifecycleApi = false;
    server.resetBackendGeneration();
    expect(server.sessionIdsQueryRejected).toBeNull();
    expect(server.backendLifecycleApi).toBeNull();
  });
});
