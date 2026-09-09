/**
 * Goal-loop driver state-machine tests (ADR-0022). The whole backend/ACP
 * surface is mocked: runOneTurn resolves scripted PromptResponses, and each
 * scripted round pushes the assistant reply the driver will read back via
 * fetchMessages. Pure bridge logic — no subprocess, no network.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runOneTurn = vi.fn();
const compactMock = vi.fn();
const sendTextChunk = vi.fn();

vi.mock("../src/handlers/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/handlers/session.js")>();
  // Keep cancel() and preemptInFlightTurn REAL (exercised by the pre-empt and
  // ESC-during-compact tests); only the turn machinery is scripted.
  return {
    ...actual,
    runOneTurn: (...args: unknown[]) => runOneTurn(...(args as [])),
    withPreemptLock: (_server: unknown, _sid: unknown, body: () => Promise<void>) => body(),
  };
});
vi.mock("../src/handlers/extensions.js", () => ({
  compact: (...args: unknown[]) => compactMock(...(args as [])),
}));
vi.mock("../src/handlers/io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/handlers/io.js")>();
  return {
    ...actual,
    sendTextChunk: (...args: unknown[]) => sendTextChunk(...(args as [])),
  };
});

/**
 * Scripted history: each scriptRound() queues the assistant reply that lands
 * when runOneTurn is invoked for it (a reply exists only after its turn).
 * Every fetchMessages call then sees the full history delivered so far —
 * matching the real backend, and the driver's three per-round reads
 * (count / tool activity / verdict text) all observe the same world.
 */
const fetchMessagesState: Array<{ role: "assistant" | "user"; text: string; tools?: boolean }> = [];
const pendingReplies: Array<{ role: "assistant" | "user"; text: string; tools?: boolean }> = [];

vi.mock("../src/handlers/replay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/handlers/replay.js")>();
  return {
    ...actual,
    fetchMessages: async () =>
      fetchMessagesState.map((m) => ({
        info: { role: m.role },
        parts: [
          ...(m.tools ? [{ type: "tool", callId: "c" }] : []),
          ...(m.text ? [{ type: "text", text: m.text }] : []),
        ],
      })),
  };
});

/** session/read answers (contextUsed / contextWindow). */
let readProjection: { contextUsed?: number; contextWindow?: number } = {};

function makeServer(root: string): never {
  const request = vi.fn(async (_id: unknown, method: string) => {
    if (method === "session/read") return { result: { projection: readProjection } };
    return { result: {} };
  });
  return {
    projectCwd: () => root,
    resolveSid: (sid: string) => (sid === "acp-1" ? "zsid-1" : sid),
    pendingTurns: new Map(),
    preemptLocks: new Map(),
    goalLoops: new Map(),
    modelCache: new Map(),
    lastCancelledAt: new Map(),
    sessionAliases: (sid: string) => [sid],
    clients: { broadcast: () => ({ notify: async () => undefined }) },
    ensureBackend: () => ({ request }),
    nextId: (() => 0) as unknown as () => number,
  } as never;
}

import { GoalLoopDriver, goalCompactThreshold, goalMaxTurns } from "../src/goal-loop/driver.js";
import { readGoalState, verifyPath } from "../src/goal-loop/state.js";
import {
  decomposePrompt,
  parseTickets,
  parseVerifyFile,
  parseVerifyReply,
  parseVerdict,
} from "../src/goal-loop/templates.js";
import { cancel } from "../src/handlers/session.js";

let root: string;

/** Script one round: the reply lands when runOneTurn fires for it. */
function scriptRound(
  reply: string,
  opts: {
    tools?: boolean;
    verdict?: "end_turn" | "cancelled";
    /** Simulates the model writing the verification verdict file this turn. */
    verifyFile?: string;
  } = {},
) {
  pendingReplies.push({ role: "assistant", text: reply, tools: opts.tools ?? true });
  runOneTurn.mockImplementationOnce(async () => {
    const next = pendingReplies.shift();
    if (next) fetchMessagesState.push(next);
    if (opts.verifyFile !== undefined) {
      writeFileSync(verifyPath(root, "zsid-1"), opts.verifyFile);
    }
    return { stopReason: opts.verdict ?? "end_turn" };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sendTextChunk.mockImplementation(async () => undefined);
  compactMock.mockImplementation(async () => ({}));
  fetchMessagesState.length = 0;
  pendingReplies.length = 0;
  readProjection = { contextUsed: 1000, contextWindow: 100_000 };
  root = mkdtempSync(path.join(tmpdir(), "goal-loop-test-"));
  delete process.env.ZCODE_ACP_GOAL_MAX_TURNS;
  delete process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD;
});

async function startLoop(server: unknown, objective = "build it") {
  const driver = GoalLoopDriver.start(server as never, "acp-1", "zsid-1", objective);
  await vi.waitFor(() => {
    if (driver === undefined) throw new Error("driver undefined");
  });
  return driver;
}

/** Wait until the run() promise chain settles (terminal status on record). */
async function waitSettled(driver: GoalLoopDriver, zcodeSid = "zsid-1"): Promise<void> {
  await vi.waitFor(() => {
    // run() deregisters the driver on terminal statuses; paused loops stay
    // registered with a non-running status. Poll the world until either.
    if (driver["state"].status !== "running" && driver["state"].rounds >= 0) return;
    throw new Error("still running");
  });
  void zcodeSid;
}

describe("goal-loop templates", () => {
  it("parses ticket lines from the decompose reply", () => {
    const reply = [
      "intro prose",
      "```",
      "- wire the hub | curl /health returns 200",
      "- add tests | pnpm test green",
      "```",
    ].join("\n");
    const tickets = parseTickets(reply)!;
    expect(tickets).toHaveLength(2);
    expect(tickets[0]).toEqual({ title: "wire the hub", acceptance: "curl /health returns 200" });
  });

  it("parses the trailing VERDICT line with gaps", () => {
    const v = parseVerdict("did half the work\n\nVERDICT: not-yet\nGAPS: endpoint tests missing")!;
    expect(v.kind).toBe("not-yet");
    expect(v.gaps).toBe("endpoint tests missing");
    expect(parseVerdict("no verdict line")).toBeNull();
  });

  it("parses verify replies", () => {
    expect(parseVerifyReply("PASS")).toEqual({ pass: true });
    expect(parseVerifyReply("FAIL: tests red")).toEqual({ pass: false, reason: "tests red" });
    expect(parseVerifyReply("mumble")).toBeNull();
  });

  it("decompose prompt carries the objective", () => {
    expect(decomposePrompt("ship v2")).toContain("ship v2");
  });
});

describe("goal-loop driver", () => {
  it("runs tickets to completion: decompose → dispatch+verify per ticket", async () => {
    const server = makeServer(root);
    scriptRound("```\n- ticket A | check A\n- ticket B | check B\n```");
    // ticket A: not-yet, then met + verify PASS
    scriptRound("half done\nVERDICT: not-yet");
    scriptRound("done A\nVERDICT: met");
    scriptRound("PASS");
    // ticket B: met + PASS
    scriptRound("done B\nVERDICT: met");
    scriptRound("PASS");

    const driver = await startLoop(server);
    await waitSettled(driver);

    expect(driver["state"].status).toBe("complete");
    expect(driver["state"].tickets.map((t) => t.status)).toEqual(["done", "done"]);
    // decompose + 3 dispatch (A: not-yet + met, B: met) + 2 verify = 6 turns
    expect(runOneTurn).toHaveBeenCalledTimes(6);
    // Budget counts dispatch rounds only (verify/decompose excluded).
    expect(driver["state"].rounds).toBe(3);
  });

  it("feeds verification failure back as ticket feedback", async () => {
    // Budget 1: the FAIL feedback lands at the boundary, then the loop pauses
    // (previously this test let the NEXT round run unscripted and crash).
    process.env.ZCODE_ACP_GOAL_MAX_TURNS = "1";
    const server = makeServer(root);
    scriptRound("```\n- only ticket | check X\n```");
    scriptRound("done\nVERDICT: met");
    scriptRound("FAIL: check X did not hold");

    const driver = await startLoop(server);
    // FAIL → the feedback is on record for the next dispatch round.
    await vi.waitFor(() => {
      expect(driver["state"].tickets[0]!.feedback).toContain("check X did not hold");
    });
    await waitSettled(driver);
    expect(driver["state"].status).toBe("paused-budget");
  });

  it("ends as impossible when the worker reports it", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    scriptRound("blocked forever\nVERDICT: impossible\nWHY: no api access");

    const driver = await startLoop(server);
    await waitSettled(driver);
    expect(driver["state"].status).toBe("impossible");
    expect(driver["state"].endedReason).toBe("no api access");
  });

  it("pauses on a cancelled round (ESC) and preserves parked text", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    scriptRound("cut short", { verdict: "cancelled" });

    const driver = await startLoop(server);
    const parked = driver.parkPrompt("user steer text");
    await waitSettled(driver);

    expect(driver["state"].status).toBe("paused");
    expect(await parked).toEqual({ stopReason: "cancelled" });
    expect(driver["state"].parkedText).toBe("user steer text");
  });

  it("merges parked prompts into the next dispatch and settles them", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    scriptRound("done\nVERDICT: met");
    scriptRound("PASS");

    const driver = await startLoop(server);
    const parked = driver.parkPrompt("use library Y");
    await waitSettled(driver);

    const dispatchPrompt = runOneTurn.mock.calls[1]![1] as { sendText: string };
    expect(dispatchPrompt.sendText).toContain("use library Y");
    expect(await parked).toEqual({ stopReason: "end_turn" });
  });

  it("pauses at the round budget (dispatch rounds only)", async () => {
    process.env.ZCODE_ACP_GOAL_MAX_TURNS = "1";
    const server = makeServer(root);
    scriptRound("```\n- t1 | x\n- t2 | y\n```");
    scriptRound("done t1\nVERDICT: met");
    scriptRound("PASS");

    const driver = await startLoop(server);
    await waitSettled(driver);
    expect(driver["state"].status).toBe("paused-budget");
  });

  it("compacts at the boundary when the threshold is met and reads the handoff back", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    scriptRound("done\nVERDICT: met");
    scriptRound("PASS");
    // handoff turn
    scriptRound("DONE", { tools: true });

    readProjection = { contextUsed: 90_000, contextWindow: 100_000 };
    expect(goalCompactThreshold(100_000)).toBe(80_000);

    const driver = await startLoop(server);
    // complete (single ticket) — compaction fires before the final report.
    await waitSettled(driver);
    expect(compactMock).toHaveBeenCalledTimes(1);
  });

  it("pauses when ESC cancels the compaction handoff turn (compaction skipped)", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    scriptRound("done\nVERDICT: met");
    scriptRound("PASS");
    // handoff turn cancelled by ESC
    scriptRound("DONE", { verdict: "cancelled" });

    readProjection = { contextUsed: 90_000, contextWindow: 100_000 };

    const driver = await startLoop(server);
    await waitSettled(driver);
    expect(driver["state"].status).toBe("paused");
    expect(driver["state"].endedReason).toBe("cancelled");
    expect(compactMock).not.toHaveBeenCalled();
  });

  it("settles parked prompts, disarms the keepalive, and persists paused-crash when a round throws", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    let rejectRound!: (e: Error) => void;
    runOneTurn.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRound = reject;
        }),
    );

    const driver = GoalLoopDriver.start(server as never, "acp-1", "zsid-1", "build it");
    await vi.waitFor(() => {
      if (!rejectRound) throw new Error("dispatch round not started");
    });
    // Parked BEFORE the crash: the editor's session/prompt request must not
    // hang forever when the round machinery throws.
    const parked = driver.parkPrompt("mid steer");
    expect(driver["keepalive"]).not.toBeNull();
    rejectRound(new Error("zcode send failed: quota exhausted"));

    await waitSettled(driver);
    expect(driver["state"].status).toBe("paused-crash");
    expect(driver["state"].endedReason).toContain("quota exhausted");
    expect(await parked).toEqual({ stopReason: "cancelled" });
    // Keepalive interval cleared — no phantom turnState running:true every 60s.
    expect(driver["keepalive"]).toBeNull();
    const persisted = readGoalState(root, "zsid-1");
    expect(persisted?.status).toBe("paused-crash");
    expect(persisted?.parkedText).toBe("mid steer");
  });

  it("keeps prompts parked DURING a round for the NEXT round's merge (not dropped)", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    let driverRef: GoalLoopDriver | undefined;
    let midParked: Promise<{ stopReason: string }> | undefined;
    // Round 1: the prompt parks MID-round (after the dispatch-time snapshot).
    // The round lands its own not-yet reply (scriptRound queues replies at
    // SETUP time — shifting here would steal round 2's scripted reply).
    runOneTurn.mockImplementationOnce(async () => {
      midParked = driverRef!.parkPrompt("mid steer");
      fetchMessagesState.push({ role: "assistant", text: "wip\nVERDICT: not-yet", tools: true });
      return { stopReason: "end_turn" };
    });
    scriptRound("done\nVERDICT: met");
    scriptRound("PASS");

    const driver = GoalLoopDriver.start(server as never, "acp-1", "zsid-1", "build it");
    driverRef = driver;
    await waitSettled(driver);

    // The mid-round text merged into round 2's dispatch prompt...
    const round2 = runOneTurn.mock.calls[2]![1] as { sendText: string };
    expect(round2.sendText).toContain("mid steer");
    // ...and settled with THAT round (not resolved-and-dropped by round 1).
    expect(await midParked).toEqual({ stopReason: "end_turn" });
    expect(driver["state"].status).toBe("complete");
  });

  it("re-dispatches the ticket when a sandbox allow-restart cancels the round", async () => {
    const server = makeServer(root);
    scriptRound("```\n- fix login | tests stay green\n```");
    // Round 1 cancelled by flushSandboxGrants (sandboxRestart-marked turn).
    runOneTurn.mockImplementationOnce(
      async (_srv: unknown, opts: { turn: { sandboxRestart?: boolean; cancelled?: boolean } }) => {
        opts.turn.sandboxRestart = true;
        opts.turn.cancelled = true;
        return { stopReason: "cancelled" };
      },
    );
    scriptRound("done\nVERDICT: met");
    scriptRound("PASS");

    const driver = await startLoop(server);
    await waitSettled(driver);

    // The loop CONTINUED (re-dispatched the same ticket) instead of pausing.
    expect(driver["state"].status).toBe("complete");
    expect(driver["state"].rounds).toBe(1);
    const redispatch = runOneTurn.mock.calls[2]![1] as { sendText: string };
    expect(redispatch.sendText).toContain("fix login");
    expect(redispatch.sendText).toContain("tests stay green");
  });

  it("pre-empts a still-running editor turn when the 10s wait times out", async () => {
    vi.useFakeTimers();
    try {
      const server = makeServer(root);
      const editorTurn = { zcodeSid: "zsid-1", cancelled: false };
      server.pendingTurns.set("editor-1", editorTurn as never);
      // The decompose send must land only AFTER the editor turn was cancelled
      // (pre-empt semantics — a send into the live turn would be steer input,
      // its tickets parsed from the foreign reply).
      runOneTurn.mockImplementationOnce(async () => {
        expect(editorTurn.cancelled).toBe(true);
        fetchMessagesState.push({ role: "assistant", text: "```\n- t | x\n```", tools: true });
        return { stopReason: "end_turn" };
      });
      // Dispatch round: cancelled → the loop pauses cleanly.
      runOneTurn.mockImplementationOnce(async () => ({ stopReason: "cancelled" }));

      const driver = GoalLoopDriver.start(server as never, "acp-1", "zsid-1", "build it");
      await vi.advanceTimersByTimeAsync(11_000);

      expect(editorTurn.cancelled).toBe(true);
      await waitSettled(driver);
      expect(driver["state"].status).toBe("paused");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ESC (real cancel) during the compact() window pauses at the next boundary", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    scriptRound("done\nVERDICT: met");
    scriptRound("PASS");
    scriptRound("DONE");
    readProjection = { contextUsed: 90_000, contextWindow: 100_000 };
    let releaseCompact!: () => void;
    compactMock.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          releaseCompact = r;
        }),
    );

    const driver = GoalLoopDriver.start(server as never, "acp-1", "zsid-1", "build it");
    await vi.waitFor(() => {
      if (!releaseCompact) throw new Error("compact window not reached");
    });
    // Real cancel(): no pendingTurns entry exists in this window (the mocked
    // runOneTurn never deregisters its rounds — the real one does it in its
    // finally), so clear them to model the window, then the pause must be
    // parked on the driver (requestPause).
    server.pendingTurns.clear();
    await cancel(server as never, { sessionId: "acp-1" } as never);
    releaseCompact();
    await waitSettled(driver);
    expect(driver["state"].status).toBe("paused");
  });

  it("resume() before the boundary clears the pending pause (loop completes)", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    let releaseRound!: (v: { stopReason: string }) => void;
    runOneTurn.mockImplementationOnce(
      () =>
        new Promise<{ stopReason: string }>((res) => {
          releaseRound = res;
        }),
    );
    scriptRound("PASS");

    const driver = await startLoop(server);
    await vi.waitFor(() => {
      if (!releaseRound) throw new Error("round not in flight");
    });
    driver.pause();
    driver.resume(); // /auto resume before the boundary — must not be swallowed
    // Round 1 lands its own met verdict (scriptRound queues at SETUP time —
    // pushing here avoids stealing the verify round's scripted reply).
    fetchMessagesState.push({ role: "assistant", text: "done\nVERDICT: met", tools: true });
    releaseRound({ stopReason: "end_turn" });
    await waitSettled(driver);
    expect(driver["state"].status).toBe("complete");
  });

  it("a dying driver's cleanup does not unregister a NEWER driver", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    scriptRound("done\nVERDICT: met");
    scriptRound("PASS");
    let releaseEnd!: () => void;
    let chunks = 0;
    // Call #3 is d1's endLoop note (goalStarted → goalReport → end note):
    // hold it so d1's .finally stays pending through d2's registration.
    sendTextChunk.mockImplementation(async () => {
      chunks++;
      if (chunks === 3) {
        return new Promise<void>((r) => {
          releaseEnd = r;
        });
      }
    });

    GoalLoopDriver.start(server as never, "acp-1", "zsid-1", "first");
    await vi.waitFor(() => {
      if (!releaseEnd) throw new Error("endLoop announce not reached");
    });

    // Pause → immediately start a new objective (exactly what a user does):
    // d2 registers and reaches its (held) decompose round.
    sendTextChunk.mockImplementation(async () => undefined);
    let releaseD2!: (v: { stopReason: string }) => void;
    runOneTurn.mockImplementationOnce(
      () =>
        new Promise<{ stopReason: string }>((res) => {
          releaseD2 = res;
        }),
    );
    const d2 = GoalLoopDriver.start(server as never, "acp-1", "zsid-1", "second");
    await vi.waitFor(() => {
      if (!releaseD2) throw new Error("d2 decompose not reached");
    });

    releaseEnd(); // d1's .finally runs — identity check must spare d2's entry
    await new Promise((r) => setImmediate(r));
    expect(server.goalLoops.get("zsid-1")).toBe(d2);

    releaseD2({ stopReason: "cancelled" });
    await waitSettled(d2);
  });

  it("goalMaxTurns defaults to 100 and honors the env override", async () => {
    expect(goalMaxTurns()).toBe(100);
    process.env.ZCODE_ACP_GOAL_MAX_TURNS = "7";
    expect(goalMaxTurns()).toBe(7);
  });
});

describe("verification verdict via file (regression: verbose replies looped forever)", () => {
  it("parseVerifyFile accepts exactly PASS / FAIL: line, rejects prose", () => {
    expect(parseVerifyFile("PASS")).toEqual({ pass: true });
    expect(parseVerifyFile("PASS\n")).toEqual({ pass: true });
    expect(parseVerifyFile("FAIL: tests still red")).toEqual({
      pass: false,
      reason: "tests still red",
    });
    expect(parseVerifyFile("pass")).toBeNull();
    expect(parseVerifyFile("I checked everything and it all works.")).toBeNull();
  });

  it("parseVerifyReply (fallback) tolerates prose containing pass", () => {
    expect(parseVerifyReply("I re-ran the checks.\nAll tests pass.")).toEqual({ pass: true });
    expect(parseVerifyReply("everything looks good")).toBeNull();
  });

  it("completes the ticket from the model-written verdict file", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    scriptRound("done\nVERDICT: met");
    scriptRound("DONE", { verifyFile: "PASS" });
    const driver = await startLoop(server);
    await vi.waitFor(() => expect(driver.state.status).toBe("complete"));
    expect(driver.state.tickets[0]!.status).toBe("done");
    // decompose + dispatch + verify only — no feedback round.
    expect(runOneTurn).toHaveBeenCalledTimes(3);
  });

  it("retries once with the strict prompt, then pauses on unreadable verdicts", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    scriptRound("done\nVERDICT: met");
    scriptRound("我重新跑了检查，一切正常。"); // verbose, no file
    scriptRound("看起来都没问题。"); // still no file
    const driver = await startLoop(server);
    await vi.waitFor(() => expect(driver.state.status).toBe("paused"));
    expect(driver.state.endedReason).toBe("verification unreadable");
    // decompose + dispatch + verify + strict retry — never a re-work round.
    expect(runOneTurn).toHaveBeenCalledTimes(4);
  });

  it("strict retry verdict file is honored", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    scriptRound("done\nVERDICT: met");
    scriptRound("verbose, no file");
    scriptRound("DONE", { verifyFile: "PASS" }); // strict retry writes it
    const driver = await startLoop(server);
    await vi.waitFor(() => expect(driver.state.status).toBe("complete"));
    expect(runOneTurn).toHaveBeenCalledTimes(4);
  });
});

describe("verify prose-fallback guards (review: negation + stale dispatch text)", () => {
  it("parseVerifyReply rejects negated pass statements", () => {
    expect(parseVerifyReply("2 of 5 checks did not pass")).toBeNull();
    expect(parseVerifyReply("I couldn't make the lint pass")).toBeNull();
    expect(parseVerifyReply("tests fail to pass on node 22")).toBeNull();
    expect(parseVerifyReply("All checks pass.")).toEqual({ pass: true });
    expect(parseVerifyReply("re-ran everything; it passed")).toEqual({ pass: true });
  });

  it("never verifies from the dispatch reply's own pass wording", async () => {
    const server = makeServer(root);
    scriptRound("```\n- t | x\n```");
    // Dispatch reply contains an affirmative "made the tests pass" — the
    // verify turn replies bare DONE and writes NO file: the stale text must
    // not count, so the loop goes strict-retry → pause, not done.
    scriptRound("made the tests pass\nVERDICT: met");
    scriptRound("DONE");
    scriptRound("still nothing useful");
    const driver = await startLoop(server);
    await vi.waitFor(() => expect(driver.state.status).toBe("paused"));
    expect(driver.state.endedReason).toBe("verification unreadable");
    expect(driver.state.tickets[0]!.status).toBe("pending");
  });
});
