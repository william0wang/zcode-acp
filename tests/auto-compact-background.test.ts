/**
 * Detached auto-compact (the compaction kill-chain fix): the armed turn's
 * response returns and running:false lands BEFORE the compaction finishes;
 * the finished turn is out of pendingTurns (nothing for cancel/preempt to
 * kill); a follow-up prompt during the compaction is REJECTED outright (one
 * resend notice, no send attempt, no stop pair, no drain-gate close
 * escalation) — queueing it would let its subscribed listener dispatch the
 * compaction's internal-turn stream as its own output.
 *
 * Mock layout mirrors tests/turn-state.test.ts, plus compaction controls:
 * session/read reports a HIGH contextUsed on the first read only (the
 * post-compaction refresh and later turns read low), session/goal show
 * reports the lock held until releaseGoal(), and follow-up session/sends
 * are busy (1308) while that lock is held.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { cancel, prompt } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

/** cx recording turnState payloads and agent_message_chunk texts. */
function collectCx(): {
  cx: acp.AgentContext;
  turnStates: Array<{ sessionId: string; running: boolean }>;
  texts: string[];
} {
  const turnStates: Array<{ sessionId: string; running: boolean }> = [];
  const texts: string[] = [];
  const cx = {
    notify: async (method: string, params: Record<string, unknown>) => {
      if (method === "$/zcode/turnState") {
        turnStates.push(params as { sessionId: string; running: boolean });
      } else if (method === "session/update") {
        const u = (
          params as {
            update?: { sessionUpdate?: string; content?: { text?: string } };
          }
        ).update;
        if (u?.sessionUpdate === "agent_message_chunk") texts.push(u.content?.text ?? "");
      }
    },
    request: async () => ({}),
  } as unknown as acp.AgentContext;
  return { cx, turnStates, texts };
}

interface SentFrame {
  method: string;
}

function makeBackend(): {
  backend: ZcodeBackend;
  counts: Map<string, number>;
  sentFrames: SentFrame[];
  releaseGoal: () => void;
  /** Reject the next N sends with the whole-turn busy error, then accept. */
  busySends: (n: number) => void;
} {
  const counts = new Map<string, number>();
  const sentFrames: SentFrame[] = [];
  const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
  let goalLock = true;
  let sendCount = 0;
  let busySendsLeft = 0;
  const bump = (m: string) => counts.set(m, (counts.get(m) ?? 0) + 1);
  const deliver = (events: ZcodeEvent[]) => {
    for (const e of events) for (const l of listeners) l.handleEvent(e);
  };
  const backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      bump(method);
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
        case "session/subscribe":
          return { result: {} };
        case "session/read":
          return {
            result: {
              projection: {
                status: "idle",
                // Usage is HIGH until the compaction settles, LOW after —
                // turn 1's arming read trips the threshold; the post-compact
                // refresh and any later turn read the compacted usage.
                contextUsed: goalLock ? 150_000 : 1_000,
              },
              settings: {},
            },
          };
        case "session/messages":
          return { result: { messages: [] } };
        case "session/compact":
          return { result: {} };
        case "session/goal":
          return goalLock
            ? { error: { code: -32000, message: "prompt is running" } }
            : { result: {} };
        case "session/send": {
          sendCount++;
          // The compaction's lock released (goalLock=false) but the backend is
          // still winding its internal turn down: a send landing in that window
          // is rejected and must be retried, not answered as a failure.
          if (busySendsLeft > 0) {
            busySendsLeft--;
            return { error: { code: 1308, message: "prompt is running" } };
          }
          if (sendCount > 1 && goalLock) {
            return { error: { code: 1308, message: "prompt is running" } };
          }
          deliver([
            { type: "turn.started" },
            { type: "turn.completed", payload: { resultType: "success" } },
          ]);
          return { result: { accepted: true } };
        }
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: (method: string) => {
      sentFrames.push({ method });
    },
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      listeners.push(l);
    },
    unregisterEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  } as unknown as ZcodeBackend;
  return {
    backend,
    counts,
    sentFrames,
    releaseGoal: () => (goalLock = false),
    busySends: (n: number) => {
      busySendsLeft = n;
    },
  };
}

/** Server with a pre-registered, backend-loaded session (no create/resume). */
function setup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_ac", "zs_ac");
  server.markBackendLoaded("sess_ac");
  return server;
}

function promptParams(): acp.PromptRequest {
  return { sessionId: "sess_ac", prompt: [{ type: "text", text: "hello" }] } as acp.PromptRequest;
}

/** Raw backend frames that would kill a generation — must stay empty here. */
const KILL_METHODS = ["v4/command", "session/stop", "session/close"];
const killFrames = (frames: SentFrame[]) => frames.filter((f) => KILL_METHODS.includes(f.method));

beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
  vi.stubEnv("ZCODE_ACP_AUTO_COMPACT_THRESHOLD", "100000");
});

describe("detached auto-compact", () => {
  it("returns the response and settles running:false BEFORE the compaction; the finished turn leaves nothing to preempt", async () => {
    const { backend, counts, sentFrames, releaseGoal } = makeBackend();
    const server = setup(backend);
    const { cx, turnStates } = collectCx();

    const result = await prompt(server, promptParams(), cx, 1);

    // The response returned while the compaction still holds the probe lock —
    // the pre-fix shape parked here for the whole compaction.
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(turnStates).toEqual([
      { sessionId: "sess_ac", running: true },
      { sessionId: "sess_ac", running: false },
    ]);
    expect(server.pendingTurns.size).toBe(0);

    // The detached compaction started: threshold read → session/compact.
    await vi.waitFor(() => expect(counts.get("session/compact")).toBe(1));
    expect(server.autoCompactInFlight.has("zs_ac")).toBe(true);
    // Nothing fired a stop or close — the kill chain is disarmed.
    expect(killFrames(sentFrames)).toEqual([]);

    // Settle the compaction so no probe loop outlives the test (the settle
    // path waits out one 2s probe gap, so the default 1s waitFor is short).
    releaseGoal();
    await vi.waitFor(() => expect(server.autoCompactInFlight.has("zs_ac")).toBe(false), {
      timeout: 10_000,
    });
  }, 15_000);

  it("a follow-up prompt during the compaction is HELD and delivered once it settles (no resend, no kill)", async () => {
    const { backend, counts, sentFrames, releaseGoal } = makeBackend();
    const server = setup(backend);
    const { cx, texts } = collectCx();

    await prompt(server, promptParams(), cx, 1); // turn 1 + detached compaction
    await vi.waitFor(() => expect(counts.get("session/compact")).toBe(1));

    // The prompt is held BEFORE its listener subscribes — the only residue-free
    // place to wait (a subscribed listener would accumulate the compaction's
    // internal-turn stream and dispatch it as this prompt's output). It must
    // NOT be answered while the compaction still runs, and it must NOT be
    // rejected: the user typed a message, so the turn delivers it.
    const r2 = prompt(server, promptParams(), cx, 2);
    // The hold notice fires immediately — not after the wait — so the client
    // shows something during a window that can run for minutes.
    await vi.waitFor(() => expect(texts.filter((t) => t.includes("queued")).length).toBe(1));

    // Nothing fired a stop or close while the prompt waited.
    expect(killFrames(sentFrames)).toEqual([]);

    // Settle the compaction: the held prompt's send now goes out and its turn
    // runs. Turn 1's response already settled, so only turn 2 registers.
    releaseGoal();
    expect(await r2).toEqual({ stopReason: "end_turn" });
    expect(counts.get("session/send")).toBe(2);
    expect(killFrames(sentFrames)).toEqual([]);
    await vi.waitFor(() => expect(server.autoCompactInFlight.has("zs_ac")).toBe(false), {
      timeout: 10_000,
    });
    // The threshold read on turn 2's end re-arms nothing: the compacted usage
    // (1,000) is far below the threshold.
    expect(counts.get("session/compact")).toBe(1);
  }, 30_000);

  it("ESC on a turn racing the compaction gate (registered, send never accepted) does not fire the stop pair at the compaction", async () => {
    const { backend, sentFrames } = makeBackend();
    const server = setup(backend);
    server.autoCompactInFlight.add("zs_ac");
    // The arm-race shape: a turn registered between the entry gate and its
    // first busy response — its send was never accepted, so it owns no
    // generation the compaction guard may stop.
    const turn = { zcodeSid: "zs_ac", cancelled: false };
    server.pendingTurns.set(999, turn as never);

    await cancel(server, { sessionId: "sess_ac" } as acp.CancelNotification);

    expect(turn.cancelled).toBe(true); // the prompt itself IS cancelled
    expect(killFrames(sentFrames)).toEqual([]); // …but nothing was stopped
  });

  it("ESC on an ACCEPTED turn without an execution id still fires the stop pair (no unstoppable generation)", async () => {
    const { backend, sentFrames } = makeBackend();
    const server = setup(backend);
    server.autoCompactInFlight.add("zs_ac");
    // The backend accepted the send but turn.started (and its execution id)
    // never arrived — a deaf stream. This turn may own a RUNNING generation:
    // the compaction guard must not spare it, or ESC leaves the model
    // unstoppable for up to the compaction's whole settle window.
    const turn = { zcodeSid: "zs_ac", cancelled: false, sendAccepted: true };
    server.pendingTurns.set(998, turn as never);

    await cancel(server, { sessionId: "sess_ac" } as acp.CancelNotification);

    expect(turn.cancelled).toBe(true);
    expect(sentFrames.map((f) => f.method)).toEqual(["session/stop", "v4/command"]);
  });

  it("a send landing in the compaction's lock-teardown window is retried, not answered as a failure", async () => {
    const { backend, counts, sentFrames, releaseGoal, busySends } = makeBackend();
    const server = setup(backend);
    const { cx, texts } = collectCx();

    await prompt(server, promptParams(), cx, 1); // turn 1 + detached compaction
    await vi.waitFor(() => expect(counts.get("session/compact")).toBe(1));

    // The compaction settles, but its internal turn is still unwinding: the
    // next send is rejected with the whole-turn busy error. The held prompt
    // must ride it out on the send-retry loop rather than fail — this is the
    // window the pre-subscribe wait cannot cover (the flag clears before the
    // backend's lock does).
    busySends(2);
    releaseGoal();
    const r2 = await prompt(server, promptParams(), cx, 2);
    expect(r2).toEqual({ stopReason: "end_turn" });
    expect(counts.get("session/send")).toBe(4); // turn 1 + 3 attempts
    // No rejection notice and no kill frame: the message went through.
    expect(texts.filter((t) => t.includes("NOT sent"))).toHaveLength(0);
    expect(killFrames(sentFrames)).toEqual([]);
  }, 30_000);

  it("the held prompt's output is its OWN turn's — the compaction's internal stream never leaks in", async () => {
    const { backend, counts, releaseGoal } = makeBackend();
    const server = setup(backend);
    const { cx, texts } = collectCx();

    await prompt(server, promptParams(), cx, 1); // turn 1 + detached compaction
    await vi.waitFor(() => expect(counts.get("session/compact")).toBe(1));

    const r2 = prompt(server, promptParams(), cx, 2);
    await vi.waitFor(() => expect(texts.filter((t) => t.includes("queued")).length).toBe(1));
    releaseGoal();
    expect(await r2).toEqual({ stopReason: "end_turn" });

    // Every notice the user saw is accounted for: turn 1's compaction start
    // and done lines, plus the hold notice. Nothing from the compaction's
    // internal turn (which never delivered any event here) appears as this
    // prompt's output, and no foreign turn.completed ended it early.
    const compactLines = texts.filter((t) => t.includes("auto-compact"));
    expect(compactLines.length).toBeGreaterThanOrEqual(3);
    expect(compactLines.some((t) => t.includes("✓ auto-compact"))).toBe(true);
    expect(counts.get("session/send")).toBe(2);
  }, 30_000);
});
