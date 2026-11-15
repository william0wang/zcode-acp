/**
 * `_session/steering` extension tests (#352): the cross-adapter steering
 * convention backed by the v4 command API. Drives the handler against a
 * scripted fake backend and asserts the v4/command sendText envelope it
 * emits plus the outcome mapping from the ack.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { steering } from "../src/handlers/steering.js";
import { echoSteeredInputs } from "../src/handlers/io.js";
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

  it("records the steering client's root for the drain-echo exclusion", async () => {
    const server = setup();
    armRunningTurn(server);
    const root = { connection: "martty" };
    const origin = { connectionContext: root } as unknown as Parameters<typeof steering>[2];

    await steering(server, { sessionId: "sess_st", prompt: TEXT_PROMPT }, origin);
    expect(server.steerEchoExclusions("zs_st").has(root)).toBe(true);

    // promptRequired (message not taken) records nothing.
    server.steerEchoSuppressedRoots.clear();
    const idle = setup();
    const result = await steering(idle, { sessionId: "sess_st", prompt: TEXT_PROMPT }, origin);
    expect(result).toEqual({ outcome: "promptRequired", reason: "noRunningTurn" });
    expect(idle.steerEchoSuppressedRoots.size).toBe(0);
  });

  it("a notification-turn busy window counts as running", async () => {
    const server = setup("idle");
    server.notifyTurnActiveSince.set("zs_st", Date.now());
    const result = await steering(server, { sessionId: "sess_st", prompt: TEXT_PROMPT });
    expect(result).toEqual({ outcome: "injected" });
    expect(commands).toHaveLength(1);
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
});

/**
 * Steer-drain observability: `turn.steerDrained` mirrors the backend's
 * persisted user inputs to the clients as user_message_chunk (the injection
 * never passes through session/prompt — no OTHER client ever sees the text).
 * Clients that steered via `_session/steering` are excluded: they render the
 * injected text locally (martty's Send Now cell) and would see it twice.
 */
describe("echoSteeredInputs (turn.steerDrained → user_message_chunk)", () => {
  interface Sent {
    method: string;
    params: { sessionId: string; update: Record<string, unknown> };
  }
  const sent: Sent[] = [];
  /** Roots the fake registry excludes (steering clients). */
  let excludedRoots: Set<unknown>;

  function echoServer(): ZcodeAcpServer {
    sent.length = 0;
    excludedRoots = new Set();
    const server = new ZcodeAcpServer();
    server.registerSession("sess_st", "zs_st");
    server.registerSession("sess_st2", "zs_st"); // second alias, same backend session
    server.clients = {
      notifyExceptRoots: async (
        exclude: Set<unknown>,
        _method: string,
        params: unknown,
      ): Promise<void> => {
        excludedRoots = exclude;
        sent.push({ method: "session/update", params: params as Sent["params"] });
      },
    } as unknown as ZcodeAcpServer["clients"];
    return server;
  }

  it("echoes every drained input, FIFO, to ALL aliases (no exclusion)", () => {
    const server = echoServer();
    echoSteeredInputs(server, "sess_st", {
      pendingInputIds: ["pi1", "pi2"],
      targetTurnId: "t1",
      injectedMessageIds: ["m1", "m2"],
      drainedInputs: [
        { pendingInputId: "pi1", messageId: "m1", text: "first steer" },
        { pendingInputId: "pi2", messageId: "m2", text: "second steer" },
      ],
    });
    expect(sent).toHaveLength(4); // 2 inputs × 2 aliases
    // Alias-outer fan-out: each client receives its inputs in FIFO order.
    expect(sent.map((s) => s.params.sessionId)).toEqual([
      "sess_st",
      "sess_st",
      "sess_st2",
      "sess_st2",
    ]);
    for (const s of sent) {
      expect(s.method).toBe("session/update");
      expect(s.params.update.sessionUpdate).toBe("user_message_chunk");
    }
    expect(sent[0]!.params.update.content).toEqual({ type: "text", text: "first steer" });
    expect(sent[0]!.params.update.messageId).toBe("steer_m1");
    expect(sent[1]!.params.update.content).toEqual({ type: "text", text: "second steer" });
    expect(sent[1]!.params.update.messageId).toBe("steer_m2");
  });

  it("excludes the steering client's root — it renders the text locally", () => {
    const server = echoServer();
    const steererRoot = { connection: "martty" };
    server.suppressSteerEcho("zs_st", steererRoot);

    echoSteeredInputs(server, "sess_st", {
      drainedInputs: [{ pendingInputId: "pi1", messageId: "m1", text: "local cell covers me" }],
    });

    expect(sent).toHaveLength(2); // still both aliases
    expect(excludedRoots.has(steererRoot)).toBe(true);
  });
});
