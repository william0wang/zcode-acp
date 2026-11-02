/**
 * `_session/steering` extension tests (#352): the cross-adapter steering
 * convention backed by the v4 command API. Drives the handler against a
 * scripted fake backend and asserts the v4/command sendText envelope it
 * emits plus the outcome mapping from the ack.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";

import { steering } from "../src/handlers/steering.js";
import { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeBackend } from "../src/backend/client.js";

/** What session/read answers for the liveness probe ("idle" | "running" | error). */
let readStatus: "idle" | "running" | "error";

/** Recorded v4/command envelopes (the frames under test). */
const commands: Array<Record<string, unknown>> = [];

function fakeBackend(): ZcodeBackend {
  return {
    isDead: false,
    request: async (_id: number, method: string, params?: Record<string, unknown>) => {
      switch (method) {
        case "session/read": {
          if (readStatus === "error") return { error: { message: "boom" } };
          return { result: { projection: { status: readStatus }, settings: {} } };
        }
        case "v4/command": {
          commands.push(params!);
          const ack = ackFor as unknown as Record<string, unknown>;
          return { result: ack };
        }
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
}

/** Mutable per-test v4 ack. */
let ackFor: unknown = { status: "accepted", result: { type: "inputAccepted", delivery: "guide" } };

function setup(read: "idle" | "running" | "error" = "idle"): ZcodeAcpServer {
  readStatus = read;
  commands.length = 0;
  const server = new ZcodeAcpServer();
  server.backend = fakeBackend();
  server.registerSession("sess_st", "zs_st");
  server.markBackendLoaded("sess_st");
  return server;
}

/** Mark a bridge turn as running for zs_st (the fast-path liveness proof). */
function armRunningTurn(server: ZcodeAcpServer): void {
  server.pendingTurns.set(1, { zcodeSid: "zs_st", cancelled: false });
}

const TEXT_PROMPT = [{ type: "text", text: "use the other approach" }];

beforeEach(() => {
  ackFor = { status: "accepted", result: { type: "inputAccepted", delivery: "guide" } };
});

describe("_session/steering", () => {
  it("advertises the extension in the initialize response", async () => {
    const server = new ZcodeAcpServer();
    const resp = await server.initialize({ protocolVersion: 1 });
    const steeringMeta = resp._meta?.["steering"] as
      { supported?: boolean; timings?: string[] } | undefined;
    expect(steeringMeta?.supported).toBe(true);
    expect(steeringMeta?.timings).toEqual(["now", "next"]);
  });

  it("injects into the live turn via v4 sendText guide (default priority)", async () => {
    const server = setup();
    armRunningTurn(server);
    const result = await steering(server, { sessionId: "sess_st", prompt: TEXT_PROMPT });
    expect(result).toEqual({ outcome: "injected" });
    expect(commands).toHaveLength(1);
    const cmd = commands[0]!;
    expect(cmd["type"]).toBe("sendText");
    expect(cmd["sessionId"]).toBe("zs_st");
    expect(cmd["payload"]).toMatchObject({
      text: "use the other approach",
      requestedDelivery: "guide",
    });
    expect(typeof cmd["commandId"]).toBe("string");
  });

  it("priority next maps to queue delivery and reports the queued outcome", async () => {
    const server = setup();
    armRunningTurn(server);
    ackFor = { status: "accepted", result: { type: "inputAccepted", delivery: "queue" } };
    const result = await steering(server, {
      sessionId: "sess_st",
      prompt: TEXT_PROMPT,
      _meta: { steering: { priority: "next" } },
    });
    expect(result).toEqual({ outcome: "queued" });
    expect(commands[0]!["payload"]).toMatchObject({ requestedDelivery: "queue" });
  });

  it("an idle session answers promptRequired without sending anything", async () => {
    const server = setup("idle");
    const result = await steering(server, { sessionId: "sess_st", prompt: TEXT_PROMPT });
    expect(result).toEqual({ outcome: "promptRequired", reason: "noRunningTurn" });
    expect(commands).toHaveLength(0);
  });

  it("a foreign-client running turn (projection running, no pending bridge turn) steers", async () => {
    // The multi-client case: the turn was started by the desktop app, so no
    // pendingTurns entry exists — the session/read probe is the fallback.
    const server = setup("running");
    const result = await steering(server, { sessionId: "sess_st", prompt: TEXT_PROMPT });
    expect(result).toEqual({ outcome: "injected" });
    expect(commands).toHaveLength(1);
  });

  it("a notification-turn busy window counts as running", async () => {
    const server = setup("idle");
    server.notifyTurnActiveSince.set("zs_st", Date.now());
    const result = await steering(server, { sessionId: "sess_st", prompt: TEXT_PROMPT });
    expect(result).toEqual({ outcome: "injected" });
    expect(commands).toHaveLength(1);
  });

  it("a startNow ack (idle race) is reported honestly as startedNewTurn", async () => {
    const server = setup("running");
    armRunningTurn(server);
    ackFor = { status: "accepted", result: { type: "inputAccepted", delivery: "startNow" } };
    const result = await steering(server, { sessionId: "sess_st", prompt: TEXT_PROMPT });
    expect(result).toEqual({ outcome: "startedNewTurn" });
  });

  it("a guide-to-queue fallback upstream reports queued", async () => {
    const server = setup();
    armRunningTurn(server);
    ackFor = { status: "accepted", result: { type: "inputAccepted", delivery: "queue" } };
    const result = await steering(server, { sessionId: "sess_st", prompt: TEXT_PROMPT });
    expect(result).toEqual({ outcome: "queued" });
  });

  it("a failed ack (turn_not_steerable) surfaces the backend reason", async () => {
    const server = setup();
    armRunningTurn(server);
    ackFor = {
      status: "failed",
      reasonCode: "activePrompt",
      message: "Core prompt admission rejected: turn_not_steerable",
    };
    await expect(steering(server, { sessionId: "sess_st", prompt: TEXT_PROMPT })).rejects.toThrow(
      /turn_not_steerable/,
    );
  });

  it("a probe failure treats the session as running and still sends", async () => {
    const server = setup("error");
    const result = await steering(server, { sessionId: "sess_st", prompt: TEXT_PROMPT });
    expect(result).toEqual({ outcome: "injected" });
    expect(commands).toHaveLength(1);
  });

  it("rejects non-text content blocks and empty prompts", async () => {
    const server = setup();
    armRunningTurn(server);
    await expect(
      steering(server, {
        sessionId: "sess_st",
        prompt: [{ type: "image", data: "…" }],
      }),
    ).rejects.toThrow(RequestError);
    await expect(
      steering(server, { sessionId: "sess_st", prompt: [{ type: "text", text: "  " }] }),
    ).rejects.toThrow(/empty/);
    expect(commands).toHaveLength(0);
  });

  it("rejects unsupported _meta.steering values like codex-acp does", async () => {
    const server = setup();
    armRunningTurn(server);
    await expect(
      steering(server, {
        sessionId: "sess_st",
        prompt: TEXT_PROMPT,
        _meta: { steering: { idleBehavior: "startNewTurn" } },
      }),
    ).rejects.toThrow(/idleBehavior/);
    await expect(
      steering(server, {
        sessionId: "sess_st",
        prompt: TEXT_PROMPT,
        _meta: { steering: { priority: "whenever" } },
      }),
    ).rejects.toThrow(/priority/);
    expect(commands).toHaveLength(0);
  });

  it("joins multi-block prompts with newlines", async () => {
    const server = setup();
    armRunningTurn(server);
    await steering(server, {
      sessionId: "sess_st",
      prompt: [
        { type: "text", text: "stop the current approach" },
        { type: "text", text: "switch to the sqlite plan" },
      ],
    });
    expect(commands[0]!["payload"]).toMatchObject({
      text: "stop the current approach\nswitch to the sqlite plan",
    });
  });
});
