/**
 * Tests for interaction forward settle-once.
 *
 * Bug: handleOne registered the reannounce dedup entry BEFORE forwarding to
 * the client, with no try/catch around the forward. Any throw (adapter on
 * malformed params, a rejecting notification send) skipped
 * sendInteractionReply: the zcode request was never answered, the dedup entry
 * leaked (its 30s cleanup timer is only armed inside sendInteractionReply),
 * and the backend's ~1s reannounces kept refreshing the turn loop's
 * no-progress timer — the 120s timeout never fired and the turn hung.
 *
 * The fix: the forward degrades to a decline reply instead of propagating, so
 * zcode always gets exactly one answer and the entry always resolves.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerRequest, ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/handlers/io.js", () => ({
  sendSessionUpdate: vi.fn().mockResolvedValue(undefined),
}));

import { handleServerRequests } from "../src/handlers/server-requests.js";
import { sendSessionUpdate } from "../src/handlers/io.js";

/** Minimal server stub (only nextId/resolveSid are touched on this path). */
function makeServer(): ZcodeAcpServer {
  return {
    nextId: () => 1,
    resolveSid: () => undefined,
  } as unknown as ZcodeAcpServer;
}

/** Fake backend draining a mutable request queue, recording replies. */
function makeBackend(queue: ServerRequest[]) {
  return {
    pollServerRequests: () => queue.splice(0, queue.length),
    requeueServerRequests: (reqs: ServerRequest[]) => queue.unshift(...reqs),
    sendReply: vi.fn(),
    sendError: vi.fn(),
  } as unknown as ZcodeBackend;
}

function permissionRequest(zcodeId: number): ServerRequest {
  return {
    id: zcodeId,
    method: "interaction/requestPermission",
    params: {
      requestId: "r1",
      sessionId: "zs1",
      toolCallId: "tc1",
      toolName: "Bash",
      input: { command: "ls" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    },
  };
}

describe("interaction forward settle-once", () => {
  beforeEach(() => {
    vi.mocked(sendSessionUpdate).mockReset();
    vi.mocked(sendSessionUpdate).mockResolvedValue(undefined);
  });

  it("a throwing forward still replies decline and resolves the dedup entry", async () => {
    const server = makeServer();
    const queue = [permissionRequest(101)];
    const backend = makeBackend(queue);
    vi.mocked(sendSessionUpdate).mockRejectedValue(new Error("client gone"));
    const cx = { request: vi.fn() } as unknown as acp.AgentContext;

    const handled = await handleServerRequests(server, backend, cx, "s1");
    expect(handled).toBe(true);
    expect(backend.sendReply).toHaveBeenCalledWith(101, {
      action: "decline",
      reason: "bridge error during forward",
    });

    // The entry resolved: a reannounce of the same key gets the CACHED
    // decline immediately (no second forward, no leak).
    queue.push(permissionRequest(102));
    await handleServerRequests(server, backend, cx, "s1");
    expect(backend.sendReply).toHaveBeenCalledWith(102, {
      action: "decline",
      reason: "bridge error during forward",
    });
    expect(cx.request).not.toHaveBeenCalled();
  });

  it("normal path unaffected: allow answer reaches the backend", async () => {
    const server = makeServer();
    const queue = [permissionRequest(201)];
    const backend = makeBackend(queue);
    const request = vi.fn().mockResolvedValue({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    const cx = { request } as unknown as acp.AgentContext;

    await handleServerRequests(server, backend, cx, "s1");
    expect(backend.sendReply).toHaveBeenCalledWith(201, { decision: "allow" });
  });
});
