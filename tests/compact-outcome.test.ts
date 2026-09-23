/**
 * compact() outcome reporting — the session/compact RPC ack is always
 * "accepted"; real success/failure only surfaces via the state.updated
 * notification the backend broadcasts when the background compaction turn
 * ends (reasons session_compacted / session_compact_cancelled /
 * session_compact_failed — source: runCompactTurnInBackground →
 * afterStateMutation). These tests pin the bridge-side detection wired
 * through ZcodeAcpServer.compactOutcomes, plus the /compact instructions
 * passthrough and the already_running ack.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import { waitForAutoCompactIdle } from "../src/config/auto-compact.js";
import { compact } from "../src/handlers/extensions.js";
import { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeResponse } from "../src/backend/types.js";

const SID_A = "acp-cmp-1";
const SID_Z = "zc-cmp-1";

interface CompactCase {
  compactResult: Record<string, unknown>;
  outcome?: { reason: string; at?: number };
}

/**
 * Real server + fake backend. The lock probe (session/goal show) answers
 * "prompt is running" once (the compaction's internal turn starting), then
 * succeeds — waitForTurnIdle sees lock-seen → released, the fast path.
 */
function makeServer(c: CompactCase): {
  server: ZcodeAcpServer;
  compactParams: () => Record<string, unknown> | undefined;
} {
  const server = new ZcodeAcpServer();
  server.registerSession(SID_A, SID_Z);
  // Mark resident so ensureRealSession's eviction guard skips the reload +
  // hydration-settle path (this suite exercises compact(), not resume).
  server.markBackendLoaded(SID_A);
  let seenParams: Record<string, unknown> | undefined;
  let goalProbe = 0;
  server.backend = {
    isDead: false,
    request: async (
      id: number,
      method: string,
      params: Record<string, unknown>,
    ): Promise<ZcodeResponse> => {
      if (method === "session/compact") {
        seenParams = params;
        return { id, result: c.compactResult } as ZcodeResponse;
      }
      if (method === "session/goal") {
        goalProbe++;
        // First probe: busy (the compaction's internal turn) — 0.16.9's exact
        // -32010 wording; then idle. waitForTurnIdle must recognize BOTH this
        // and the 0.16.5 "prompt is running" spelling.
        if (goalProbe === 1) {
          return {
            id,
            error: { code: -32010, message: "A prompt is already running for this session" },
          } as ZcodeResponse;
        }
        return { id, result: {} } as ZcodeResponse;
      }
      if (method === "session/read") {
        return {
          id,
          result: { settings: {}, projection: { contextUsed: 1, contextWindow: 100 } },
        } as ZcodeResponse;
      }
      return { id, result: {} } as ZcodeResponse;
    },
  } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
  if (c.outcome) {
    server.compactOutcomes.set(SID_Z, {
      reason: c.outcome.reason,
      at: c.outcome.at ?? Date.now(),
    });
  }
  return { server, compactParams: () => seenParams };
}

const cx = { notify: vi.fn().mockResolvedValue(undefined) } as unknown as acp.AgentContext;

describe("compact() instructions passthrough", () => {
  it("forwards trimmed /compact focus text as instructions", async () => {
    const { server, compactParams } = makeServer({
      compactResult: { response: "", compact: { state: "accepted" } },
    });
    const res = (await compact(
      server,
      { sessionId: SID_A, instructions: "  focus on tests " },
      cx,
    )) as {
      __compactFailed?: boolean;
    };
    expect(compactParams()?.["instructions"]).toBe("focus on tests");
    expect(res.__compactFailed).toBe(false);
  });

  it("omits the instructions field for blank text", async () => {
    const { server, compactParams } = makeServer({
      compactResult: { response: "", compact: { state: "accepted" } },
    });
    await compact(server, { sessionId: SID_A, instructions: "   " }, cx);
    expect(compactParams()).not.toHaveProperty("instructions");
  });
});

describe("compact() outcome detection", () => {
  it("reports failure on session_compact_failed", async () => {
    const notifySpy = vi.fn().mockResolvedValue(undefined);
    const cxx = { notify: notifySpy } as unknown as acp.AgentContext;
    const { server } = makeServer({
      compactResult: { response: "", compact: { state: "accepted" } },
      outcome: { reason: "session_compact_failed" },
    });
    const res = (await compact(server, { sessionId: SID_A }, cxx)) as {
      __compactFailed?: boolean;
      __lockTimeout?: boolean;
    };
    expect(res.__lockTimeout).toBe(false);
    expect(res.__compactFailed).toBe(true);
    // No usage refresh on failure — the context did NOT shrink.
    const kinds = notifySpy.mock.calls.map(([, p]) => p?.update?.sessionUpdate);
    expect(kinds).not.toContain("usage_update");
  });

  it("reports failure on session_compact_cancelled", async () => {
    const { server } = makeServer({
      compactResult: { response: "", compact: { state: "accepted" } },
      outcome: { reason: "session_compact_cancelled" },
    });
    const res = (await compact(server, { sessionId: SID_A }, cx)) as { __compactFailed?: boolean };
    expect(res.__compactFailed).toBe(true);
  });

  it("treats a stale outcome (previous compaction) as success", async () => {
    const { server } = makeServer({
      compactResult: { response: "", compact: { state: "accepted" } },
      outcome: { reason: "session_compact_failed", at: Date.now() - 60_000 },
    });
    const res = (await compact(server, { sessionId: SID_A }, cx)) as { __compactFailed?: boolean };
    expect(res.__compactFailed).toBe(false);
  });

  it("success path emits the usage refresh", async () => {
    const notifySpy = vi.fn().mockResolvedValue(undefined);
    const cxx = { notify: notifySpy } as unknown as acp.AgentContext;
    const { server } = makeServer({
      compactResult: { response: "", compact: { state: "accepted" } },
      outcome: { reason: "session_compacted" },
    });
    const res = (await compact(server, { sessionId: SID_A }, cxx)) as {
      __compactFailed?: boolean;
    };
    expect(res.__compactFailed).toBe(false);
    const kinds = notifySpy.mock.calls.map(([, p]) => p?.update?.sessionUpdate);
    expect(kinds).toContain("usage_update");
  });
});

describe("compact() already_running ack", () => {
  it("surfaces the backend's already_running state", async () => {
    const { server } = makeServer({
      compactResult: { response: "", compact: { state: "already_running", operationId: "op-1" } },
    });
    const res = (await compact(server, { sessionId: SID_A }, cx)) as {
      __alreadyRunning?: boolean;
    };
    expect(res.__alreadyRunning).toBe(true);
  });

  it("treats an ack-less result (pre-0.16.9 shape) as a normal compact", async () => {
    const { server } = makeServer({ compactResult: { response: "" } });
    const res = (await compact(server, { sessionId: SID_A }, cx)) as {
      __alreadyRunning?: boolean;
      __compactFailed?: boolean;
    };
    expect(res.__alreadyRunning).toBe(false);
    expect(res.__compactFailed).toBe(false);
  });
});

/**
 * Manual /compact busy window: the compaction must report running:true to
 * EVERY client for its whole duration — without it the session read as idle,
 * clients offered Send, and the prompt died against the backend's compact
 * lock as "backend still busy" instead of queueing (the client-side hold the
 * auto-compact path has had since #247; this suite pins the manual path).
 */
describe("compact() busy window (manual /compact)", () => {
  type Gate = { releaseCompact: (resp: ZcodeResponse) => void };

  /** makeServer variant whose session/compact RPC blocks on a manual gate. */
  function makeGatedServer(c: CompactCase): { server: ZcodeAcpServer; gate: Gate } {
    const base = makeServer(c);
    const server = base.server;
    let goalProbe = 0;
    let releaseCompact!: (resp: ZcodeResponse) => void;
    const gated = new Promise<ZcodeResponse>((r) => (releaseCompact = r));
    server.backend = {
      isDead: false,
      request: async (
        id: number,
        method: string,
        _params: Record<string, unknown>,
      ): Promise<ZcodeResponse> => {
        if (method === "session/compact") return gated;
        if (method === "session/goal") {
          goalProbe++;
          if (goalProbe === 1) {
            return {
              id,
              error: { code: -32010, message: "A prompt is already running for this session" },
            } as ZcodeResponse;
          }
          return { id, result: {} } as ZcodeResponse;
        }
        if (method === "session/read") {
          return {
            id,
            result: { settings: {}, projection: { contextUsed: 1, contextWindow: 100 } },
          } as ZcodeResponse;
        }
        return { id, result: {} } as ZcodeResponse;
      },
    } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
    return { server, gate: { releaseCompact } };
  }

  /** A fake registered client whose notify calls are inspectable. */
  function attachClient(server: ZcodeAcpServer): { turnStates: () => Array<boolean | undefined> } {
    const seen: Array<{ method: string; running?: boolean }> = [];
    server.clients.add({
      notify: async (method: string, params?: unknown) => {
        const p = params as { running?: boolean } | undefined;
        seen.push({ method, running: p?.running });
      },
      request: async () => undefined,
    });
    return {
      turnStates: () => seen.filter((s) => s.method === "$/zcode/turnState").map((s) => s.running),
    };
  }

  const flush = () => new Promise<void>((r) => setImmediate(r));

  const ACCEPTED = { response: "", compact: { state: "accepted" } };

  it("broadcasts running:true for the whole window and settles at the end", async () => {
    const { server, gate } = makeGatedServer({ compactResult: ACCEPTED });
    const client = attachClient(server);
    const running = compact(server, { sessionId: SID_A }, cx);
    await flush();
    await flush();
    // Mid-window: every client sees busy, and the in-flight flag (the prompt
    // path's hold gate) is registered BEFORE the RPC goes out.
    expect(client.turnStates()).toEqual([true]);
    expect(server.autoCompactInFlight.has(SID_Z)).toBe(true);
    gate.releaseCompact({ id: 1, result: ACCEPTED } as ZcodeResponse);
    await running;
    expect(client.turnStates()).toEqual([true, false]);
    expect(server.autoCompactInFlight.has(SID_Z)).toBe(false);
  });

  it("is visible to waitForAutoCompactIdle — a prompt sent mid-window queues", async () => {
    const { server, gate } = makeGatedServer({ compactResult: ACCEPTED });
    attachClient(server);
    const running = compact(server, { sessionId: SID_A }, cx);
    await flush();
    await flush();
    const idle = waitForAutoCompactIdle(server, SID_Z, 2_000);
    gate.releaseCompact({ id: 1, result: ACCEPTED } as ZcodeResponse);
    await running;
    // The wait releases only once the manual compaction leaves the set —
    // runPrompt's hold sits on exactly this gate instead of erroring.
    expect(await idle).toBe(true);
  });

  it("settles and clears the flag even when the RPC itself fails", async () => {
    const { server, gate } = makeGatedServer({ compactResult: ACCEPTED });
    const client = attachClient(server);
    const running = compact(server, { sessionId: SID_A }, cx);
    await flush();
    await flush();
    gate.releaseCompact({ id: 1, error: { code: -32000, message: "boom" } } as ZcodeResponse);
    await expect(running).rejects.toThrow("compact failed");
    expect(client.turnStates()).toEqual([true, false]);
    expect(server.autoCompactInFlight.has(SID_Z)).toBe(false);
  });
});
