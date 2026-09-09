/**
 * Goal-loop driver state-machine tests (ADR-0022). The whole backend/ACP
 * surface is mocked: runOneTurn resolves scripted PromptResponses, and each
 * scripted round pushes the assistant reply the driver will read back via
 * fetchMessages. Pure bridge logic — no subprocess, no network.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runOneTurn = vi.fn();
const compactMock = vi.fn();
const sendTextChunk = vi.fn();

vi.mock("../src/handlers/session.js", () => ({
  runOneTurn: (...args: unknown[]) => runOneTurn(...(args as [])),
  withPreemptLock: (_server: unknown, _sid: unknown, body: () => Promise<void>) => body(),
}));
vi.mock("../src/handlers/extensions.js", () => ({
  compact: (...args: unknown[]) => compactMock(...(args as [])),
}));
vi.mock("../src/handlers/io.js", () => ({
  sendTextChunk: (...args: unknown[]) => sendTextChunk(...(args as [])),
}));

/**
 * Scripted history: each scriptRound() queues the assistant reply that lands
 * when runOneTurn is invoked for it (a reply exists only after its turn).
 * Every fetchMessages call then sees the full history delivered so far —
 * matching the real backend, and the driver's three per-round reads
 * (count / tool activity / verdict text) all observe the same world.
 */
const fetchMessagesState: Array<{ role: "assistant" | "user"; text: string; tools?: boolean }> = [];
const pendingReplies: Array<{ role: "assistant" | "user"; text: string; tools?: boolean }> = [];

vi.mock("../src/handlers/replay.js", () => ({
  fetchMessages: async () =>
    fetchMessagesState.map((m) => ({
      info: { role: m.role },
      parts: [
        ...(m.tools ? [{ type: "tool", callId: "c" }] : []),
        ...(m.text ? [{ type: "text", text: m.text }] : []),
      ],
    })),
}));

/** session/read answers (contextUsed / contextWindow). */
let readProjection: { contextUsed?: number; contextWindow?: number } = {};

function makeServer(root: string): never {
  const request = vi.fn(async (_id: unknown, method: string) => {
    if (method === "session/read") return { result: { projection: readProjection } };
    return { result: {} };
  });
  return {
    projectCwd: () => root,
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
import {
  decomposePrompt,
  parseTickets,
  parseVerifyReply,
  parseVerdict,
} from "../src/goal-loop/templates.js";

let root: string;

/** Script one round: the reply lands when runOneTurn fires for it. */
function scriptRound(
  reply: string,
  opts: { tools?: boolean; verdict?: "end_turn" | "cancelled" } = {},
) {
  pendingReplies.push({ role: "assistant", text: reply, tools: opts.tools ?? true });
  runOneTurn.mockImplementationOnce(async () => {
    const next = pendingReplies.shift();
    if (next) fetchMessagesState.push(next);
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
    const server = makeServer(root);
    scriptRound("```\n- only ticket | check X\n```");
    scriptRound("done\nVERDICT: met");
    scriptRound("FAIL: check X did not hold");

    const driver = await startLoop(server);
    // FAIL → the loop CONTINUES with the failure as ticket feedback.
    await vi.waitFor(() => {
      expect(driver["state"].tickets[0]!.feedback).toContain("check X did not hold");
    });
    expect(driver["state"].status).toBe("running");
    driver.stop();
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

  it("goalMaxTurns defaults to 100 and honors the env override", async () => {
    expect(goalMaxTurns()).toBe(100);
    process.env.ZCODE_ACP_GOAL_MAX_TURNS = "7";
    expect(goalMaxTurns()).toBe(7);
  });
});
