/**
 * A terminal backend turn failure on an ordinary prompt must never be silent
 * AND must not come back as a request error: the desktop app discards prompt
 * errors (it only retracts the bubble and re-queues the draft, then re-sends
 * that draft on every later attach), so a refused conversation read as "the
 * session suddenly stopped and nothing recovers it" (observed 2026-11-27: six
 * prompts in a row refused by the provider's content-safety check, code 1301).
 * Such a turn now leaves its reason in the conversation and ends with
 * `end_turn`; the rounds whose owner handles failures (goal loop, sandbox
 * continuation) keep the structured request error.
 *
 * Harness: prompt-level fake backend modeled on held-prompt-turn.test.ts
 * (events pushed to the registered listeners when session/send is accepted).
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { prompt, runOneTurn } from "../src/handlers/session.js";
import type { PendingTurn } from "../src/server.js";
import { ZcodeAcpServer } from "../src/server.js";

const pushMock = vi.hoisted(() => ({ settled: vi.fn() }));
vi.mock("../src/push/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/push.js")>();
  return { ...actual, pushSettled: (...args: unknown[]) => pushMock.settled(...args) };
});

// Asserted notices are English.
beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});

afterEach(() => {
  vi.unstubAllEnvs();
  pushMock.settled.mockClear();
});

/** The flat 4.0.0 wire shape of a bigmodel content-safety refusal. */
const CONTENT_REFUSAL = {
  type: "unknown_error",
  code: "1301",
  message:
    "[1301][系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语，感谢您的配合。][20261128000121d284ce8ca5c24e45]",
  attribution: { reason: "unknown", providerErrorCode: "1301", retryable: false },
};

type EvFactory = (
  type: string,
  turnId: string | undefined,
  payload?: Record<string, unknown>,
) => ZcodeEvent;

interface FakeOptions {
  /** Scripted outcomes, one per session/send, in order. */
  sends: Array<() => ZcodeEvent[]>;
}

function fakeBackend(opts: FakeOptions): {
  backend: ZcodeBackend;
  sendCount: () => number;
  ev: EvFactory;
} {
  const calls: string[] = [];
  const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
  let seq = 0;
  const ev: EvFactory = (type, turnId, payload = {}) => ({
    sessionId: "zs_term",
    seq: ++seq,
    type: type as ZcodeEvent["type"],
    ...(turnId !== undefined ? { turnId } : {}),
    payload,
  });
  const backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      calls.push(method);
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
        case "session/subscribe":
          return { result: {} };
        case "session/read":
          return { result: { projection: { status: "idle", contextUsed: 0 }, settings: {} } };
        case "session/messages":
          return { result: { messages: [] } };
        case "session/send": {
          const next = opts.sends[calls.filter((m) => m === "session/send").length - 1];
          if (next) for (const e of next()) for (const l of [...listeners]) l.handleEvent(e);
          return { result: { accepted: true } };
        }
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: () => undefined,
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      listeners.push(l);
    },
    unregisterEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      const idx = listeners.indexOf(l);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  } as unknown as ZcodeBackend;
  return {
    backend,
    sendCount: () => calls.filter((m) => m === "session/send").length,
    ev,
  };
}

function setup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_term", "zs_term");
  server.markBackendLoaded("sess_term");
  return server;
}

function promptParams(text: string): acp.PromptRequest {
  return { sessionId: "sess_term", prompt: [{ type: "text", text }] } as acp.PromptRequest;
}

function recordingCx(): {
  cx: acp.AgentContext;
  notices: Array<{ method: string; params: unknown }>;
} {
  const notices: Array<{ method: string; params: unknown }> = [];
  return {
    notices,
    cx: {
      notify: async (method: string, params: unknown) => {
        notices.push({ method, params });
      },
      request: async () => ({}),
    } as unknown as acp.AgentContext,
  };
}

/** Agent text chunks the client received, one entry per notice. */
function agentTexts(notices: Array<{ method: string; params: unknown }>): string[] {
  const out: string[] = [];
  for (const { method, params } of notices) {
    if (method !== "session/update") continue;
    const update = (params as { update?: Record<string, unknown> }).update;
    if (update?.["sessionUpdate"] !== "agent_message_chunk") continue;
    const content = update["content"] as { text?: string } | undefined;
    if (typeof content?.text === "string") out.push(content.text);
  }
  return out;
}

function failedTurn(ev: EvFactory, error: Record<string, unknown>): ZcodeEvent[] {
  return [
    ev("turn.started", "OURS"),
    ev("turn.failed", "OURS", { error, turnPhase: "processing_input" }),
  ];
}

function completedTurn(ev: EvFactory, text: string): ZcodeEvent[] {
  return [
    ev("turn.started", "OURS"),
    ev("model.streaming", "OURS", {
      kind: "text_delta",
      delta: text,
      assistantMessageId: "m1",
    }),
    ev("turn.completed", "OURS", { resultType: "success" }),
  ];
}

/** One goal-loop-style round through runOneTurn directly. */
function runRound(
  server: ZcodeAcpServer,
  backend: ZcodeBackend,
  cx: acp.AgentContext,
  turn: PendingTurn,
  extra: { continuationRound?: boolean } = {},
): Promise<acp.PromptResponse> {
  server.pendingTurns.set("round-1", turn);
  return runOneTurn(server, {
    backend,
    cx,
    acpSid: "sess_term",
    zcodeSid: "zs_term",
    requestId: "round-1",
    turn,
    preempted: false,
    sendText: "go",
    ...extra,
  });
}

describe("terminal turn failure", () => {
  it("content-safety refusal: never resent, ends the turn, reason left in the conversation", async () => {
    const f = fakeBackend({
      sends: [() => failedTurn(f.ev, CONTENT_REFUSAL), () => completedTurn(f.ev, "x")],
    });
    const server = setup(f.backend);
    const { cx, notices } = recordingCx();

    const result = await prompt(server, promptParams("继续"), cx, 1);

    // The turn RAN (the backend accepted and refused it): ending it keeps the
    // desktop from re-queuing the draft and re-sending it on every attach.
    expect(result.stopReason).toBe("end_turn");
    // A resend would re-submit the refused request verbatim.
    expect(f.sendCount()).toBe(1);
    // The notice names the cause and the way out — not "please resend".
    const texts = agentTexts(notices);
    const notice = texts.find((t) => t.includes("content-safety check"));
    expect(notice).toBeDefined();
    expect(notice).toContain("1301");
    expect(notice).toContain("new conversation");
    expect(texts.some((t) => t.includes("please resend"))).toBe(false);
    // The marker never reaches the client.
    expect(JSON.stringify(result)).toBe('{"stopReason":"end_turn"}');
  }, 10_000);

  it('the settled push still reports the failure (not "turn completed")', async () => {
    const f = fakeBackend({ sends: [() => failedTurn(f.ev, CONTENT_REFUSAL)] });
    const server = setup(f.backend);
    const { cx } = recordingCx();

    await prompt(server, promptParams("继续"), cx, 1);

    expect(pushMock.settled).toHaveBeenCalledWith(
      server,
      expect.objectContaining({
        kind: "turn",
        title: "turn failed",
        body: expect.stringContaining("1301"),
      }),
    );
  }, 10_000);

  it("content-safety code behind a gateway-blip cause: still terminal (no bounded resend)", async () => {
    const blip = {
      code: "UNKNOWN_ERROR",
      message: "Turn execution failed",
      cause: {
        code: "invalid_model_request",
        message: "Upstream request failed: [1301][…]",
        context: { providerCode: "1301", retryable: false },
      },
    };
    const f = fakeBackend({ sends: [() => failedTurn(f.ev, blip)] });
    const server = setup(f.backend);
    const { cx, notices } = recordingCx();

    const result = await prompt(server, promptParams("继续"), cx, 1);

    expect(result.stopReason).toBe("end_turn");
    expect(f.sendCount()).toBe(1);
    const notice = agentTexts(notices).find((t) => t.includes("content-safety check"));
    // The nested cause is what the notice shows, never the bare wrapper.
    expect(notice).toContain("Upstream request failed");
    expect(notice).not.toContain("Turn execution failed");
  }, 10_000);

  it("other terminal failure: neutral turn-failed notice, turn ends", async () => {
    const f = fakeBackend({
      sends: [() => failedTurn(f.ev, { code: "model_not_found", message: "no such model" })],
    });
    const server = setup(f.backend);
    const { cx, notices } = recordingCx();

    const result = await prompt(server, promptParams("go"), cx, 1);

    expect(result.stopReason).toBe("end_turn");
    expect(f.sendCount()).toBe(1);
    const notice = agentTexts(notices).find((t) => t.includes("Turn failed"));
    expect(notice).toContain("model_not_found");
    expect(notice).toContain("no such model");
    expect(pushMock.settled).toHaveBeenCalledWith(
      server,
      expect.objectContaining({ kind: "turn", title: "turn failed" }),
    );
  }, 10_000);

  it("a plain gateway blip is still resent (the content check is the only new terminal)", async () => {
    const blip = {
      code: "UNKNOWN_ERROR",
      message: "Turn execution failed",
      cause: {
        code: "invalid_model_request",
        message: "Upstream request failed: [invalid_request_error] thinking must be passed back",
        context: { providerCode: "server_error", retryable: false },
      },
    };
    const f = fakeBackend({
      sends: [() => failedTurn(f.ev, blip), () => completedTurn(f.ev, "recovered")],
    });
    const server = setup(f.backend);
    const { cx, notices } = recordingCx();

    const result = await prompt(server, promptParams("go"), cx, 1);

    expect(result.stopReason).toBe("end_turn");
    expect(f.sendCount()).toBe(2);
    expect(agentTexts(notices).some((t) => t.includes("recovered"))).toBe(true);
    expect(pushMock.settled).toHaveBeenCalledWith(
      server,
      expect.objectContaining({ kind: "turn", title: "turn completed" }),
    );
  }, 10_000);

  it("a goal-loop round keeps the structured request error and gets no notice", async () => {
    // The driver pauses or recovers on the thrown RequestError; a "resend"
    // notice would inject text into a loop that is still running.
    const f = fakeBackend({ sends: [() => failedTurn(f.ev, CONTENT_REFUSAL)] });
    const server = setup(f.backend);
    const { cx, notices } = recordingCx();

    const failure = await runRound(server, f.backend, cx, {
      zcodeSid: "zs_term",
      cancelled: false,
      goalLoop: true,
    }).catch((e: unknown) => e);

    expect((failure as Error).message).toContain("ZCode turn failed");
    expect((failure as Error).message).toContain("1301");
    expect(f.sendCount()).toBe(1);
    expect(agentTexts(notices)).toHaveLength(0);
  }, 10_000);

  it("a sandbox continuation round keeps the request error for its caller's own notice", async () => {
    const f = fakeBackend({ sends: [() => failedTurn(f.ev, CONTENT_REFUSAL)] });
    const server = setup(f.backend);
    const { cx, notices } = recordingCx();

    const failure = await runRound(
      server,
      f.backend,
      cx,
      { zcodeSid: "zs_term", cancelled: false },
      { continuationRound: true },
    ).catch((e: unknown) => e);

    expect((failure as Error).message).toContain("ZCode turn failed");
    expect(agentTexts(notices).some((t) => t.includes("content-safety check"))).toBe(false);
  }, 10_000);
});
