/**
 * Orphaned-ask sweep (workflow background interactions): queued server→client
 * requests that no turn loop will ever poll — the observed dead end for
 * app-launched workflow runs (the ask sat in the arrival queue, never
 * forwarded, never pushed, until the backend's ask timeout killed the run).
 *
 * Driven through the real broadcast registry and the real sweep; only the
 * backend queue and the push sender are faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ active: false }));
vi.mock("../src/push/config.js", async (orig) => {
  const actual = await orig<typeof import("../src/push/config.js")>();
  return {
    ...actual,
    pushActive: () => h.active,
    pushConfig: () =>
      h.active
        ? {
            corpId: "ww",
            agentId: 1,
            secret: "s",
            toUser: "@all",
            contentDetail: "full" as const,
            notify: { turn: true, goal: true, run: true, task: true, compact: true, ask: true },
            quietMs: 30_000,
            askDelayMs: 120_000,
          }
        : null,
  };
});

const { sweepOrphanedServerRequests } = await import("../src/handlers/server-requests.js");
const { ZcodeAcpServer } = await import("../src/server.js");
const { resetAskWatchdogForTests, setPushSenderForTests } = await import("../src/push/push.js");

interface QueuedReq {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

function fakeBackend(): {
  backend: unknown;
  queue: QueuedReq[];
  replies: Array<{ id: number; result: unknown }>;
} {
  const queue: QueuedReq[] = [];
  const replies: Array<{ id: number; result: unknown }> = [];
  return {
    queue,
    replies,
    backend: {
      isDead: false,
      pollServerRequests: () => queue.splice(0, queue.length),
      requeueServerRequests: (reqs: QueuedReq[]) => queue.unshift(...reqs),
      sendReply: (id: number, result: unknown) => replies.push({ id, result }),
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    },
  };
}

/** A permission ask shaped like the backend's interaction/requestPermission. */
function perm(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "zc_run",
    requestId: "req-1",
    toolCallId: "tc-1",
    toolName: "Bash",
    input: { command: "ls" },
    options: [
      { optionId: "allow_once", kind: "allow_once", name: "Allow" },
      { optionId: "deny", kind: "reject_once", name: "Deny" },
    ],
    ...over,
  };
}

/** Attach an answering client; records every request it receives. */
function attachClient(server: ZcodeAcpServer): Array<{ method: string; params: unknown }> {
  const asked: Array<{ method: string; params: unknown }> = [];
  server.clients.add({
    notify: async () => {},
    request: async (method: string, params: unknown) => {
      asked.push({ method, params });
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    },
  } as never);
  return asked;
}

/** Silences the deliberate-failure warns from decline paths. */
let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  h.active = false;
  warnSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  resetAskWatchdogForTests();
  setPushSenderForTests(null);
});
afterEach(() => {
  warnSpy?.mockRestore();
});

describe("orphaned-ask sweep", () => {
  it("forwards a no-turn ask under its OWN acp alias and relays the answer", async () => {
    const server = new ZcodeAcpServer();
    server.registerSession("acp_run", "zc_run");
    const { backend, queue, replies } = fakeBackend();
    server.backend = backend as never;
    const asked = attachClient(server);

    queue.push({ id: 7, method: "interaction/requestPermission", params: perm() });
    await sweepOrphanedServerRequests(server);

    expect(asked.map((a) => a.method)).toContain("session/request_permission");
    expect((asked[0]!.params as { sessionId?: string }).sessionId).toBe("acp_run");
    expect(replies).toContainEqual({ id: 7, result: { decision: "allow" } });
  });

  it("requeues asks owned by a running turn and only settles the orphans", async () => {
    const server = new ZcodeAcpServer();
    const { backend, queue, replies } = fakeBackend();
    server.backend = backend as never;
    server.pendingTurns.set(1, { zcodeSid: "zc_turn", cancelled: false } as never);

    queue.push({
      id: 8,
      method: "interaction/requestPermission",
      params: perm({ sessionId: "zc_turn" }),
    });
    queue.push({
      id: 9,
      method: "interaction/requestPermission",
      params: perm({ sessionId: "zc_ghost", requestId: "req-2" }),
    });
    await sweepOrphanedServerRequests(server);

    // The turn-owned ask stays queued for its loop; the orphan was declined.
    expect(queue.map((q) => q.params.sessionId)).toEqual(["zc_turn"]);
    expect(replies).toContainEqual({
      id: 9,
      result: { action: "decline", reason: "no client session to ask" },
    });
  });

  it("auto-allows CreateWorkflow on an internal run session no client can answer", async () => {
    const server = new ZcodeAcpServer();
    const { backend, queue, replies } = fakeBackend();
    server.backend = backend as never;

    queue.push({
      id: 10,
      method: "interaction/requestPermission",
      params: perm({ sessionId: "zc_internal", toolName: "CreateWorkflow" }),
    });
    await sweepOrphanedServerRequests(server);

    expect(replies).toContainEqual({
      id: 10,
      result: { decision: "allow", reason: "Approved for this session" },
    });
  });

  it("declines an unmappable ask with an offline push (the loud failure)", async () => {
    h.active = true;
    const pushed: string[] = [];
    setPushSenderForTests({ sendText: async (text: string) => void pushed.push(text) } as never);

    const server = new ZcodeAcpServer();
    const { backend, queue, replies } = fakeBackend();
    server.backend = backend as never;

    queue.push({
      id: 11,
      method: "interaction/requestPermission",
      params: perm({ sessionId: "zc_ghost", requestId: "req-3" }),
    });
    await sweepOrphanedServerRequests(server);

    expect(replies).toContainEqual({
      id: 11,
      result: { action: "decline", reason: "no client session to ask" },
    });
    expect(pushed).toHaveLength(1);
  });
});
