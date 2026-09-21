/**
 * Sub-agent visibility during silent phases: while the model runs
 * sub-agents behind a quiet stream (the read watermark advances but no
 * protocol events arrive), runEventTurn's 15s stall-reconcile probe also
 * polls `session/subagents` and surfaces roster CHANGES as one-line text
 * updates — a running/waiting/blocked status line, then a one-shot ended
 * summary when the roster drains. Probe failures (old backends,
 * -32601/unhandled) are silent and never affect the turn.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import "../src/handlers/slash.js";
import { prompt } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

interface RosterPhase {
  running: Array<{ childSessionId: string; status: string }>;
  ended: {
    total: number;
    items: Array<{ childSessionId: string; status: string; endedAt: number }>;
  };
}

function subagentBackend(phases?: RosterPhase[]): {
  backend: ZcodeBackend;
  emit: (event: ZcodeEvent) => void;
  sendRequests: ReturnType<typeof vi.fn>;
  advancePhase: () => void;
} {
  const listeners = new Set<{ handleEvent: (event: ZcodeEvent) => void }>();
  let contextUsed = 0;
  let phase = 0;
  const sendRequests = vi.fn();
  const backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
          return { result: {} };
        case "session/subscribe":
          return { result: { eventSeq: 1 } };
        case "session/messages":
          return { result: { messages: [] } };
        case "session/read": {
          contextUsed += 1000; // advancing watermark: turn stays alive
          return {
            result: {
              projection: { status: "running", contextUsed, contextWindow: 1000000 },
              settings: {},
            },
          };
        }
        case "session/subagents": {
          if (!phases) return { error: { code: -32601, message: "method not found" } };
          const current = phases[Math.min(phase, phases.length - 1)];
          return {
            result: {
              revision: phase + 1,
              childSessionIds: current.running.map((a) => a.childSessionId),
              running: current.running.map((a) => ({
                childSessionId: a.childSessionId,
                subagentType: "Explore",
                title: `task ${a.childSessionId}`,
                status: a.status,
              })),
              ended: current.ended,
            },
          };
        }
        case "session/send":
          sendRequests();
          for (const listener of listeners) listener.handleEvent({ type: "turn.started" });
          return { result: { accepted: true } };
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: vi.fn(),
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, listener: { handleEvent: (e: ZcodeEvent) => void }) =>
      listeners.add(listener),
    unregisterEventListener: (_sid: string, listener: { handleEvent: (e: ZcodeEvent) => void }) =>
      listeners.delete(listener),
  } as unknown as ZcodeBackend;
  return {
    backend,
    emit: (event) => {
      for (const listener of listeners) listener.handleEvent(event);
    },
    sendRequests,
    advancePhase: () => {
      phase += 1;
    },
  };
}

function setup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_sa", "zs_sa");
  server.markBackendLoaded("sess_sa");
  return server;
}

const params = {
  sessionId: "sess_sa",
  prompt: [{ type: "text", text: "hello" }],
} as acp.PromptRequest;

const cx = {
  notify: vi.fn().mockResolvedValue(undefined),
  request: vi.fn().mockResolvedValue({}),
} as unknown as acp.AgentContext;

/** All agent_message_chunk texts carrying the sub-agent marker, in order. */
function subagentLines(): string[] {
  return vi
    .mocked(cx.notify)
    .mock.calls.map(([, payload]) => {
      const update = (
        payload as { update?: { sessionUpdate?: string; content?: { text?: string } } }
      ).update;
      if (update?.sessionUpdate === "agent_message_chunk") return update.content?.text ?? "";
      return "";
    })
    .filter((text) => text.includes("子代理"));
}

describe("sub-agent status lines during silent phases", () => {
  beforeEach(() => {
    vi.stubEnv("ZCODE_ACP_LANG", "zh");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  async function waitForSend(sendRequests: ReturnType<typeof vi.fn>) {
    for (let i = 0; i < 80 && sendRequests.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(sendRequests).toHaveBeenCalledOnce();
  }

  it("surfaces roster changes and a one-shot ended summary", async () => {
    const t0 = Date.now();
    const control = subagentBackend([
      {
        running: [
          { childSessionId: "c1", status: "running" },
          { childSessionId: "c2", status: "waiting" },
        ],
        ended: { total: 0, items: [] },
      },
      {
        running: [{ childSessionId: "c1", status: "running" }],
        ended: {
          total: 1,
          items: [{ childSessionId: "c2", status: "success", endedAt: t0 + 30_000 }],
        },
      },
      {
        running: [],
        ended: {
          total: 2,
          items: [
            { childSessionId: "c1", status: "failed", endedAt: t0 + 60_000 },
            { childSessionId: "c2", status: "success", endedAt: t0 + 30_000 },
          ],
        },
      },
    ]);
    const turn = prompt(setup(control.backend), params, cx, 1);
    await waitForSend(control.sendRequests);

    // 16s of silence → reconcile → phase-1 line (running + waiting).
    await vi.advanceTimersByTimeAsync(16_000);
    expect(subagentLines()).toEqual(["[子代理] 1 运行中 · 1 等待"]);

    control.advancePhase();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(subagentLines()).toEqual(["[子代理] 1 运行中 · 1 等待", "[子代理] 1 运行中"]);

    // Roster drains → one-shot ended summary (2 ended vs baseline 0, 1 failed).
    control.advancePhase();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(subagentLines()).toEqual([
      "[子代理] 1 运行中 · 1 等待",
      "[子代理] 1 运行中",
      "[子代理完成] 2 个结束 · 1 失败",
    ]);

    // The status channel never interferes with the turn itself.
    control.emit({
      sessionId: "zs_sa",
      seq: 99,
      type: "turn.completed",
      payload: { resultType: "success" },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(turn).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("probe failures are silent and the turn is unaffected", async () => {
    const control = subagentBackend(); // session/subagents → -32601
    const turn = prompt(setup(control.backend), params, cx, 2);
    await waitForSend(control.sendRequests);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(subagentLines()).toEqual([]);

    control.emit({
      sessionId: "zs_sa",
      seq: 99,
      type: "turn.completed",
      payload: { resultType: "success" },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(turn).resolves.toEqual({ stopReason: "end_turn" });
  });
});
