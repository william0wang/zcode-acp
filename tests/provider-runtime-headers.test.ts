/**
 * Provider runtime headers (Start Plan captcha session) — issue #123.
 *
 * Start Plan providers (zcode-plan endpoints) ask their host via
 * `interaction/requestProviderRuntimeHeaders` to solve an Aliyun captcha and
 * inject X-Aliyun-Captcha-Verify-* headers; only the desktop renderer can.
 * The bridge must answer `headersApplied:false` with a clear reason so the
 * backend fails with its -32031 error — NOT fall through to the generic
 * unsupported-request error, which made the backend fall back to client
 * signing with the provider's OAuth JWT and die with the misleading
 * "must contain one separator" invalid-config error.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ServerRequest, ZcodeBackend } from "../src/backend/client.js";
import type { PendingTurn, ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/handlers/io.js", () => ({
  sendSessionUpdate: vi.fn().mockResolvedValue(undefined),
}));

import { handleServerRequests } from "../src/handlers/server-requests.js";

function makeServer(): ZcodeAcpServer {
  return {
    nextId: () => 1,
    resolveSid: () => undefined,
  } as unknown as ZcodeAcpServer;
}

function makeBackend(queue: ServerRequest[]) {
  return {
    pollServerRequests: () => queue.splice(0, queue.length),
    requeueServerRequests: (reqs: ServerRequest[]) => queue.unshift(...reqs),
    sendReply: vi.fn(),
    sendError: vi.fn(),
  } as unknown as ZcodeBackend;
}

function runtimeHeadersRequest(zcodeId: number): ServerRequest {
  return {
    id: zcodeId,
    method: "interaction/requestProviderRuntimeHeaders",
    params: {
      requestId: "zs1:provider-runtime-headers:1725597000000",
      sessionId: "zs1",
      turnId: "t1",
      providerId: "builtin:bigmodel-start-plan",
      reason: "model-request",
    },
  };
}

describe("interaction/requestProviderRuntimeHeaders", () => {
  it("declines with headersApplied:false and a clear reason, without touching the editor", async () => {
    const server = makeServer();
    const backend = makeBackend([runtimeHeadersRequest(301)]);
    const cx = { request: vi.fn() } as unknown as acp.AgentContext;

    const handled = await handleServerRequests(server, backend, cx, "s1");
    expect(handled).toBe(true);
    expect(backend.sendReply).toHaveBeenCalledTimes(1);
    const [id, result] = vi.mocked(backend.sendReply).mock.calls[0]!;
    expect(id).toBe(301);
    expect(result).toMatchObject({ headersApplied: false });
    expect((result as { errorMessage?: string }).errorMessage).toContain("Start Plan");
    // No ACP request forwarded, no unsupported-request protocol error.
    expect(cx.request).not.toHaveBeenCalled();
    expect(backend.sendError).not.toHaveBeenCalled();
  });

  it("keeps the headersApplied result shape when the turn is cancelled", async () => {
    const server = makeServer();
    const backend = makeBackend([runtimeHeadersRequest(302)]);
    const cx = { request: vi.fn() } as unknown as acp.AgentContext;
    const turn = { cancelled: true, zcodeSid: "zs1" } as unknown as PendingTurn;

    const handled = await handleServerRequests(server, backend, cx, "s1", turn);
    expect(handled).toBe(true);
    expect(backend.sendReply).toHaveBeenCalledWith(302, {
      headersApplied: false,
      errorMessage: "turn cancelled",
    });
  });
});
