/**
 * Tests for reconnect resend of undecided interaction requests.
 *
 * Bug: `session/request_permission` / `elicitation/create` are one-shot
 * requests raced across the clients connected at fire time. A remote client
 * that was offline when the agent asked (or dropped mid-wait) never sees the
 * request, and after reconnecting it could not answer — only the primary
 * editor could.
 *
 * Fix: every undecided interaction wait is tracked (ActiveInteraction). When a
 * client completes session/load / session/resume (the reconnect catch-up), the
 * bridge re-sends the session's pending requests to it; the re-send joins the
 * existing first-response-wins race and losers are cancelled so their dialogs
 * dismiss.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingTurn, ZcodeAcpServer } from "../src/server.js";
import type { ZcodeInteractionUserInputParams } from "../src/backend/types.js";

// Mock sendSessionUpdate so emit paths do not need a real cx.notify.
vi.mock("../src/handlers/io.js", () => ({
  sendSessionUpdate: vi.fn().mockResolvedValue(undefined),
}));

import {
  handleAskUserQuestion,
  resendPendingInteractions,
} from "../src/handlers/server-requests.js";
import type { ClientLike } from "../src/remote/broadcast.js";

/** Minimal server stub: elicitation form supported (preferred AskUser path). */
function makeServer(): ZcodeAcpServer {
  return {
    supportsElicitationForm: () => true,
    nextId: () => 1,
  } as unknown as ZcodeAcpServer;
}

/** A client whose `request` never settles — a dialog left open, nobody answers. */
function makeSilentClient(): {
  client: ClientLike;
  request: ReturnType<typeof vi.fn>;
  signal: () => AbortSignal | undefined;
} {
  let captured: AbortSignal | undefined;
  const request = vi.fn(
    (_method: string, _params: unknown, options?: { cancellationSignal?: AbortSignal }) => {
      captured = options?.cancellationSignal;
      return new Promise<never>(() => {});
    },
  );
  return {
    client: { request } as unknown as ClientLike,
    request,
    signal: () => captured,
  };
}

/** A client that answers every request with a canned elicitation accept. */
function makeAnsweringClient(answer: unknown): {
  client: ClientLike;
  request: ReturnType<typeof vi.fn>;
  signal: () => AbortSignal | undefined;
} {
  let captured: AbortSignal | undefined;
  const request = vi.fn(
    (_method: string, _params: unknown, options?: { cancellationSignal?: AbortSignal }) => {
      captured = options?.cancellationSignal;
      return Promise.resolve(answer);
    },
  );
  return {
    client: { request } as unknown as ClientLike,
    request,
    signal: () => captured,
  };
}

/** One single-select question (elicitation form: property q_0). */
function askParams(): ZcodeInteractionUserInputParams {
  return {
    requestId: "r1",
    sessionId: "zs1",
    toolCallId: "tc1",
    questions: [
      {
        question: "Language?",
        multiSelect: false,
        options: [{ label: "TS" }, { label: "JS" }],
      },
    ],
  };
}

/** Elicitation accept answering q_0 with `value`. */
function elicitAccept(value: string): unknown {
  return { action: "accept", content: { q_0: value } };
}

/**
 * Start an AskUserQuestion whose client request stays in flight. Synchronous
 * on purpose: with fake timers enabled, awaiting inside a helper after the
 * ask has started deadlocks the test (vitest 2.1.9); flush with
 * `vi.advanceTimersByTimeAsync(0)` in the test body instead.
 */
function startPendingAsk(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  turn?: PendingTurn,
): Promise<{ action: string }> {
  return handleAskUserQuestion(server, cx, "s1", askParams(), turn) as Promise<{
    action: string;
  }>;
}

describe("reconnect resend of undecided interactions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-sends a pending interaction to the reconnected client and adopts its answer", async () => {
    const server = makeServer();
    const zed = makeSilentClient(); // original target: dialog open, no answer
    const resultP = startPendingAsk(server, zed.client as unknown as acp.AgentContext);
    await vi.advanceTimersByTimeAsync(0);
    expect(zed.request).toHaveBeenCalledTimes(1);

    const phone = makeAnsweringClient(elicitAccept("TS"));
    resendPendingInteractions(server, phone.client, "s1");
    await vi.advanceTimersByTimeAsync(300);

    // The reconnected client got the same elicitation/create for this session.
    expect(phone.request).toHaveBeenCalledTimes(1);
    const [method, params] = phone.request.mock.calls[0] as unknown as [
      string,
      { sessionId?: string },
    ];
    expect(method).toBe("elicitation/create");
    expect(params.sessionId).toBe("s1");

    // Its answer wins the race and completes the AskUserQuestion.
    expect(await resultP).toMatchObject({
      action: "accept",
      content: { answers: { "Language?": "TS" } },
    });
    // The original client lost the race: its dialog is dismissed via cancel.
    expect(zed.signal()?.aborted).toBe(true);
  });

  it("ignores other sessions' pending interactions", async () => {
    const server = makeServer();
    const zed = makeSilentClient();
    void startPendingAsk(server, zed.client as unknown as acp.AgentContext); // s1
    await vi.advanceTimersByTimeAsync(0);

    const phone = makeAnsweringClient(elicitAccept("TS"));
    resendPendingInteractions(server, phone.client, "s2"); // different session
    await vi.advanceTimersByTimeAsync(300);
    expect(phone.request).not.toHaveBeenCalled();
  });

  it("lets the original client win; the re-send is cancelled", async () => {
    const server = makeServer();
    // Zed answers after a delay once the resend is in flight.
    let resolveZed!: (v: unknown) => void;
    const zedRequest = vi.fn(
      (_method: string, _params: unknown, options?: { cancellationSignal?: AbortSignal }) =>
        new Promise<unknown>((res) => {
          resolveZed = res;
          options?.cancellationSignal?.addEventListener("abort", () => res(undefined), {
            once: true,
          });
        }),
    );
    const zedCx = { request: zedRequest } as unknown as acp.AgentContext;
    const resultP = startPendingAsk(server, zedCx);
    await vi.advanceTimersByTimeAsync(0);

    const phone = makeSilentClient();
    resendPendingInteractions(server, phone.client, "s1");
    await vi.advanceTimersByTimeAsync(300);
    expect(phone.request).toHaveBeenCalledTimes(1);

    resolveZed(elicitAccept("JS"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await resultP).toMatchObject({
      action: "accept",
      content: { answers: { "Language?": "JS" } },
    });
    // The phone's re-sent request was cancelled — its dialog drops.
    expect(phone.signal()?.aborted).toBe(true);
  });

  it("does not resend an interaction whose wait was interrupted", async () => {
    const server = makeServer();
    const zed = makeSilentClient();
    const turn: PendingTurn = { zcodeSid: "zs1", cancelled: false };
    const resultP = startPendingAsk(server, zed.client as unknown as acp.AgentContext, turn);
    await vi.advanceTimersByTimeAsync(0);

    // User stops the turn → wait interrupted → decline; entry unregistered.
    turn.cancelled = true;
    await vi.advanceTimersByTimeAsync(200); // turn-cancel poll runs at 100ms
    expect(await resultP).toMatchObject({ action: "decline" });

    const phone = makeAnsweringClient(elicitAccept("TS"));
    resendPendingInteractions(server, phone.client, "s1");
    await vi.advanceTimersByTimeAsync(300);
    expect(phone.request).not.toHaveBeenCalled();
  });

  it("does not resend after the interaction was already answered", async () => {
    const server = makeServer();
    const zed = makeAnsweringClient(elicitAccept("TS"));
    const resultP = startPendingAsk(server, zed.client as unknown as acp.AgentContext);
    await vi.advanceTimersByTimeAsync(0);
    expect(await resultP).toMatchObject({ action: "accept" });

    const phone = makeAnsweringClient(elicitAccept("JS"));
    resendPendingInteractions(server, phone.client, "s1");
    await vi.advanceTimersByTimeAsync(300);
    expect(phone.request).not.toHaveBeenCalled();
  });

  it("survives a re-send client whose request throws synchronously", async () => {
    const server = makeServer();
    // Zed holds the dialog open, answerable via a deferred.
    let resolveZed!: (v: unknown) => void;
    const zedRequest = vi.fn(
      (_method: string, _params: unknown, options?: { cancellationSignal?: AbortSignal }) =>
        new Promise<unknown>((res) => {
          resolveZed = res;
          options?.cancellationSignal?.addEventListener("abort", () => res(undefined), {
            once: true,
          });
        }),
    );
    const zedCx = { request: zedRequest } as unknown as acp.AgentContext;
    const resultP = startPendingAsk(server, zedCx);
    await vi.advanceTimersByTimeAsync(0);

    // The reconnected client's request throws synchronously (broken
    // connection): the timer callback must not crash the process, and the
    // race stays open for the original client.
    const boom = {
      request: vi.fn(() => {
        throw new Error("connection closed");
      }),
    } as unknown as ClientLike;
    resendPendingInteractions(server, boom, "s1");
    await vi.advanceTimersByTimeAsync(300);
    expect(boom.request).toHaveBeenCalledTimes(1);

    resolveZed(elicitAccept("JS"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await resultP).toMatchObject({
      action: "accept",
      content: { answers: { "Language?": "JS" } },
    });
  });
});
