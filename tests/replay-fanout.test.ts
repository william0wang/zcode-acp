/**
 * History replays are per-client rendering state: they must ride the
 * REQUESTING connection only. Broadcasting them (the pre-fix wiring passed
 * `server.clients.broadcast()` into session/resume / session/load /
 * session/load_earlier) made every OTHER attached client append the whole
 * history at the bottom of its transcript — the "replay disorder" report
 * (editor + TUI + app sharing one bridge through the hub). Live turn updates
 * keep fanning out via prompt()'s broadcast cx.
 */

import { describe, expect, it, vi } from "vitest";

import type * as acp from "@agentclientprotocol/sdk";

import type { ZcodeResponse } from "../src/backend/types.js";
import { loadEarlier } from "../src/handlers/replay.js";
import { ZcodeAcpServer } from "../src/server.js";

const SID_A = "acp-fanout-1";
const SID_Z = "zc-fanout-1";

/** Valid load_earlier cursor: past the 2-message history, 1 turn on record
 *  (the user message anchors turn 0, so turnStarts = [0]). */
function cursor(index: number, totalTurns: number): string {
  return Buffer.from(JSON.stringify({ v: 1, index, totalTurns }), "utf8").toString("base64url");
}

interface RecordingClient {
  updates: unknown[];
  notify: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
}

function makeClient(): RecordingClient {
  const updates: unknown[] = [];
  return {
    updates,
    notify: vi.fn(async (method: string, params: unknown) => {
      if (method === "session/update") updates.push(params);
    }),
    request: vi.fn(async () => ({})),
  };
}

function makeBackend(): NonNullable<ZcodeAcpServer["backend"]> {
  return {
    isDead: false,
    request: async (id: number, method: string): Promise<ZcodeResponse> => {
      if (method === "session/messages") {
        return {
          id,
          result: {
            messages: [
              { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hello" }] },
              { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "hi" }] },
            ],
          },
        } as ZcodeResponse;
      }
      return { id, result: {} } as ZcodeResponse;
    },
    send: vi.fn(),
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
}

function asContext(client: RecordingClient): acp.AgentContext {
  return client as unknown as acp.AgentContext;
}

describe("replay fan-out contract", () => {
  it("loadEarlier delivers updates only to the requesting client", async () => {
    const server = new ZcodeAcpServer();
    server.backend = makeBackend();
    server.registerSession(SID_A, SID_Z);

    const requesting = makeClient();
    const bystander = makeClient();
    server.clients.add(asContext(requesting));
    server.clients.add(asContext(bystander));

    const { replayMeta } = await loadEarlier(
      server,
      { sessionId: SID_A, before: cursor(2, 1), limit: 10 },
      asContext(requesting),
    );

    expect(replayMeta.replayedMessages).toBe(2);
    expect(requesting.updates.length).toBeGreaterThanOrEqual(2);
    expect(bystander.notify).not.toHaveBeenCalled();
  });

  it("a second client's pagination reaches only that client", async () => {
    const server = new ZcodeAcpServer();
    server.backend = makeBackend();
    server.registerSession(SID_A, SID_Z);

    const first = makeClient();
    const second = makeClient();
    server.clients.add(asContext(first));
    server.clients.add(asContext(second));

    await loadEarlier(
      server,
      { sessionId: SID_A, before: cursor(2, 1), limit: 10 },
      asContext(second),
    );

    expect(second.updates.length).toBeGreaterThanOrEqual(2);
    expect(first.notify).not.toHaveBeenCalled();
  });
});
