/**
 * Plan-approval routing: martty → elicitation form, everyone else →
 * request_permission, plus the form → request_permission fallback.
 *
 * The form route is gated on `hasMarttyClient` (NOT on the elicitation.form
 * capability): martty's request_permission overlay draws only the title, so
 * the plan needs the form there — while editors like Zed render
 * toolCall.content as full markdown and only draw form descriptions as plain
 * text, so the form would downgrade them. Zed ≥1.12 declares the capability,
 * so capability-gating wrongly caught it (fixed 2026-09).
 *
 * `hasMarttyClient` is OR-merged process state and survives disconnects, so
 * the flag can outlive the TUI: a martty that attached earlier keeps the form
 * route for the process lifetime — accepted, population-based trade-off. The
 * residual hazard this file guards is a form failure mid-flight (the TUI
 * vanished between gate and ask): elicitation/create fails → null — without
 * the fallback the plan was silently declined with no popup at all. The
 * bridge must fall back once to session/request_permission, which every
 * client can answer.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ServerRequest, ZcodeBackend } from "../src/backend/client.js";

vi.mock("../src/handlers/io.js", () => ({
  sendSessionUpdate: vi.fn().mockResolvedValue(undefined),
}));

import { handleServerRequests } from "../src/handlers/server-requests.js";
import type { ZcodeAcpServer } from "../src/server.js";

function makeServer(opts?: { martty?: boolean }): ZcodeAcpServer {
  return {
    hasMarttyClient: () => opts?.martty ?? true,
    nextId: () => 1,
    resolveSid: () => undefined,
  } as unknown as ZcodeAcpServer;
}

function makeBackend(req: ServerRequest): { backend: ZcodeBackend; replies: unknown[] } {
  const replies: Array<{ id: number | string; result: unknown }> = [];
  let polled = false;
  const backend = {
    pollServerRequests: () => (polled ? [] : ((polled = true), [req])),
    requeueServerRequests: () => {},
    sendReply: (id: number | string, result: unknown) => replies.push({ id, result }),
    sendError: () => {},
  } as unknown as ZcodeBackend;
  return { backend, replies };
}

function planRequest(): ServerRequest {
  return {
    id: 7,
    method: "interaction/requestUserInput",
    params: {
      requestId: "r1",
      sessionId: "zs1",
      toolCallId: "tc1",
      schema: { interaction: "plan_approval" },
      input: { plan: "# The Plan\n1. do it" },
    },
  } as unknown as ServerRequest;
}

describe("plan approval fallback", () => {
  it("non-martty client → straight to request_permission (no form attempt)", async () => {
    const methods: string[] = [];
    const cx = {
      request: vi.fn((method: string) => {
        methods.push(method);
        return Promise.resolve({ outcome: { outcome: "selected", optionId: "approve" } });
      }),
    } as unknown as acp.AgentContext;
    const { backend, replies } = makeBackend(planRequest());

    await handleServerRequests(makeServer({ martty: false }), backend, cx, "s1");

    // Even though the client may declare elicitation.form (Zed ≥1.12 does),
    // only martty's popup is incapable of showing the plan — editors get the
    // markdown-rendering request_permission popup.
    expect(methods).toEqual(["session/request_permission"]);
    expect(replies).toEqual([
      { id: 7, result: { action: "accept", content: { answer_0: "approve" } } },
    ]);
  });

  it("form answered reject → single ask, decline (no double popup)", async () => {
    const methods: string[] = [];
    const cx = {
      request: vi.fn((method: string) => {
        methods.push(method);
        return Promise.resolve({ action: "accept", content: { approval: "reject" } });
      }),
    } as unknown as acp.AgentContext;
    const { backend, replies } = makeBackend(planRequest());

    await handleServerRequests(makeServer(), backend, cx, "s1");

    expect(methods).toEqual(["elicitation/create"]);
    expect(replies).toEqual([{ id: 7, result: { action: "decline", reason: "plan rejected" } }]);
  });

  it("form channel fails (-32601) → falls back to request_permission once", async () => {
    const methods: string[] = [];
    const cx = {
      request: vi.fn((method: string) => {
        methods.push(method);
        if (method === "elicitation/create") {
          // Non-form client: method-not-found.
          return Promise.reject(new Error("Method not found (-32601)"));
        }
        return Promise.resolve({ outcome: { outcome: "selected", optionId: "approve" } });
      }),
    } as unknown as acp.AgentContext;
    const { backend, replies } = makeBackend(planRequest());

    await handleServerRequests(makeServer(), backend, cx, "s1");

    expect(methods).toEqual(["elicitation/create", "session/request_permission"]);
    expect(replies).toEqual([
      { id: 7, result: { action: "accept", content: { answer_0: "approve" } } },
    ]);
  });

  it("fallback popup also unanswered → declines instead of hanging the turn", async () => {
    const methods: string[] = [];
    const cx = {
      request: vi.fn((method: string) => {
        methods.push(method);
        return Promise.reject(new Error("Method not found (-32601)"));
      }),
    } as unknown as acp.AgentContext;
    const { backend, replies } = makeBackend(planRequest());

    await handleServerRequests(makeServer(), backend, cx, "s1");

    expect(methods).toEqual(["elicitation/create", "session/request_permission"]);
    expect(replies).toEqual([
      { id: 7, result: { action: "decline", reason: "declined or cancelled" } },
    ]);
  });
});
