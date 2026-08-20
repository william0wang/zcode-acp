/**
 * Tests for the audit-fix batch (2026-08-20):
 *
 * 1. Settle-once: any throw during interaction forwarding must still reply to
 *    zcode (decline) and cache the result — an unanswered request makes the
 *    backend reannounce forever, refreshing the turn loop's no-progress timer
 *    until the turn hangs.
 * 2. waitForTurnIdle grace: with expectLock, a lock never observed past the
 *    grace window counts a successful probe as released (covers turns that
 *    finish between probes and backend error-message drift).
 * 3. Todo push recheck: when the todos signature is unchanged at tool-result
 *    time (the backend writes the projection asynchronously after the result
 *    event), one delayed re-check must still push the PlanUpdate.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerRequest, ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeAcpServer } from "../src/server.js";

const ioMocks = vi.hoisted(() => ({
  sendSessionUpdate: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../src/handlers/io.js", () => ({
  sendSessionUpdate: ioMocks.sendSessionUpdate,
}));

import { handleServerRequests } from "../src/handlers/server-requests.js";
import { waitForTurnIdle } from "../src/handlers/extensions.js";
import { dispatchPlanIfChanged } from "../src/handlers/session.js";
import { ProjectionDiffer } from "../src/translators/projection-differ.js";

// ---------- 1. settle-once ----------

function makeBackend(queue: ServerRequest[]): {
  backend: ZcodeBackend;
  replies: Array<{ id: number | string; result: unknown }>;
} {
  const replies: Array<{ id: number | string; result: unknown }> = [];
  const backend = {
    pollServerRequests: () => queue.splice(0, queue.length),
    requeueServerRequests: () => {},
    sendReply: (id: number | string, result: unknown) => replies.push({ id, result }),
  } as unknown as ZcodeBackend;
  return { backend, replies };
}

function permissionReq(id: number, requestId: string): ServerRequest {
  return {
    id,
    method: "interaction/requestPermission",
    params: {
      requestId,
      sessionId: "zs1",
      toolCallId: "tc1",
      toolName: "Bash",
      input: { command: "ls" },
      options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow" }],
    },
  } as ServerRequest;
}

describe("settle-once: forward throw still replies to zcode", () => {
  it("declines on throw and answers the reannounce from cache", async () => {
    ioMocks.sendSessionUpdate.mockRejectedValueOnce(new Error("client connection dead"));
    const server = { nextId: () => 1 } as unknown as ZcodeAcpServer;
    const { backend, replies } = makeBackend([permissionReq(101, "r1")]);
    const cx = { notify: vi.fn(), request: vi.fn() } as unknown as acp.AgentContext;

    // First drain: the forward throws (sendSessionUpdate rejects above);
    // settle-once must catch it and reply decline instead of leaking.
    const handled = await handleServerRequests(server, backend, cx, "s1");
    expect(handled).toBe(true);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual({
      id: 101,
      result: { action: "decline", reason: "bridge error during forward" },
    });

    // Reannounce with the same requestId (new zcode id): served from the
    // cached result — no re-prompt, no leak.
    const second = makeBackend([permissionReq(102, "r1")]);
    await handleServerRequests(server, second.backend, cx, "s1");
    expect(second.replies).toHaveLength(1);
    expect(second.replies[0]).toEqual({
      id: 102,
      result: { action: "decline", reason: "bridge error during forward" },
    });
  });
});

// ---------- 2. waitForTurnIdle grace ----------

function probeServer(responses: unknown[]): ZcodeAcpServer {
  let i = 0;
  const backend = {
    request: vi.fn(() => {
      const r = responses[i] ?? responses[responses.length - 1];
      i++;
      return Promise.resolve(r);
    }),
  };
  return {
    ensureBackend: () => backend,
    nextId: () => 1,
  } as unknown as ZcodeAcpServer;
}

describe("waitForTurnIdle grace window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts a successful probe as released once the grace expires", async () => {
    // Lock never observed: probe always succeeds (turn finished between
    // probes, or the backend's lock error message drifted).
    const server = probeServer([{ result: {} }]);
    const p = waitForTurnIdle(server, "zs1", 60_000, "session/goal", true, 100);
    await vi.advanceTimersByTimeAsync(0); // probe #1: in grace → sleep(500)
    await vi.advanceTimersByTimeAsync(600); // probe #2: past grace → released
    expect(await p).toBe(true);
  });

  it("still requires the lock observation inside the grace window", async () => {
    // Lock observed on probe #1, released on probe #2 → released.
    const server = probeServer([{ error: { message: "prompt is running" } }, { result: {} }]);
    const p = waitForTurnIdle(server, "zs1", 60_000, "session/goal", true, 100);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await p).toBe(true);
  });

  it("non-lock error past grace also counts as released", async () => {
    const server = probeServer([{ error: { message: "something else" } }]);
    const p = waitForTurnIdle(server, "zs1", 60_000, "session/goal", true, 100);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toBe(true);
  });
});

// ---------- 3. todo push recheck ----------

describe("dispatchPlanIfChanged delayed re-check", () => {
  beforeEach(() => {
    ioMocks.sendSessionUpdate.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushes the PlanUpdate when the todos appear only on the re-check", async () => {
    const oldTodos = [{ content: "a", status: "pending" }];
    const newTodos = [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
    ];
    let readCount = 0;
    const backend = {
      request: vi.fn(() => {
        readCount++;
        return Promise.resolve({ result: { todos: readCount === 1 ? oldTodos : newTodos } });
      }),
    };
    const server = {
      ensureBackend: () => backend,
      nextId: () => 1,
    } as unknown as ZcodeAcpServer;
    const cx = { notify: vi.fn().mockResolvedValue(undefined) } as unknown as acp.AgentContext;

    const differ = new ProjectionDiffer();
    differ.diffPlan(oldTodos); // prime the signature: first read sees no change

    void dispatchPlanIfChanged(server, cx, "s1", "zs1", differ, "m1");
    await vi.advanceTimersByTimeAsync(0);
    // Signature unchanged at result-time: no push yet, one re-check scheduled.
    expect(ioMocks.sendSessionUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    expect(ioMocks.sendSessionUpdate).toHaveBeenCalledTimes(1);
    const [, sid, update] = ioMocks.sendSessionUpdate.mock.calls[0] as unknown as [
      acp.AgentContext,
      string,
      { sessionUpdate: string; entries: Array<{ content: string; status: string }> },
    ];
    expect(sid).toBe("s1");
    expect(update.sessionUpdate).toBe("plan");
    expect(update.entries).toEqual([
      expect.objectContaining({ content: "a", status: "completed" }),
      expect.objectContaining({ content: "b", status: "in_progress" }),
    ]);
    // Exactly two reads: the result-time one plus one re-check (no loops).
    expect(backend.request).toHaveBeenCalledTimes(2);
  });
});
