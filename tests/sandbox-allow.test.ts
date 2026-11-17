/**
 * Tests for the sandbox dynamic-allow flow (ADR-0011): the EPERM path
 * extractor and the ask→persist→restart arming. The popup itself and the
 * backend respawn run against a stubbed AgentContext / server.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractPermDeniedPath,
  extractSandboxDenial,
  flushSandboxGrants,
  handleSandboxDenial,
  SandboxRestartBatcher,
  SANDBOX_ASK_RETRY_MS,
  SANDBOX_RESTART_BATCH_MS,
  UNATTENDED_PIN,
} from "../src/handlers/sandbox-allow.js";
import {
  globalSandboxConfigDir,
  globalSandboxConfigPath,
  readGlobalSandboxConfig,
  resetSandboxDecisionForTest,
  resolveReal,
} from "../src/backend/sandbox.js";
import type { PendingTurn, ZcodeAcpServer } from "../src/server.js";

let xdgRoot: string;

beforeEach(() => {
  process.env.ZCODE_ACP_SANDBOX = "1";
  // Scratch XDG root so popup persistence lands in the test's own tree.
  xdgRoot = mkdtempSync(path.join(os.tmpdir(), "sb-allow-xdg-"));
  process.env.XDG_CONFIG_HOME = xdgRoot;
  // These tests assert the Chinese message table.
  vi.stubEnv("ZCODE_ACP_LANG", "zh");
  resetSandboxDecisionForTest();
});

afterEach(() => {
  delete process.env.ZCODE_ACP_SANDBOX;
  delete process.env.XDG_CONFIG_HOME;
  vi.unstubAllEnvs();
  rmSync(xdgRoot, { recursive: true, force: true });
  resetSandboxDecisionForTest();
});

describe("extractSandboxDenial", () => {
  it("extracts the path from raw shell error output", () => {
    expect(extractSandboxDenial("rm: /Users/x/important.txt: Operation not permitted")).toEqual(
      {
        path: "/Users/x/important.txt",
        isMkdir: false,
      },
      "tc_1",
    );
    expect(extractSandboxDenial("sh: /private/var/db/a: Operation not permitted\n")).toEqual(
      {
        path: "/private/var/db/a",
        isMkdir: false,
      },
      "tc_1",
    );
  });

  it("marks mkdir denials so the target dir itself is allowed", () => {
    expect(extractSandboxDenial("mkdir: /opt/tools/bin: Operation not permitted")).toEqual({
      path: "/opt/tools/bin",
      isMkdir: true,
    });
  });
});

describe("extractPermDeniedPath", () => {
  it("does not fire on sandbox EPERM text (mutually exclusive phrases)", () => {
    expect(extractPermDeniedPath("touch: /a/b: Operation not permitted")).toBeNull();
    expect(extractPermDeniedPath("Error: EPERM: operation not permitted, open '/a/b'")).toBeNull();
  });
});

/** Server + context stubs shared by the handleSandboxDenial cases. */
function makeStubs(decisionOptionId: string) {
  const closed = vi.fn().mockResolvedValue(undefined);
  const batchFlush = vi.fn();
  const server = {
    // The live process is sandboxed — the flow's process-level gate.
    backendSandboxed: true,
    ensureBackend: () => ({ close: closed }),
    sessionCwds: new Map<string, string>(),
    sandboxRoots() {
      return new Set(this.sessionCwds.values());
    },
    // One "connected" client so a failed ask rejects (null) instead of
    // holding for reconnect; no sid mapping and no goal loops — attended.
    clients: { size: 1 },
    resolveSid: () => undefined,
    goalLoops: new Map(),
    cancelAllPendingTurns: vi.fn(),
    sandboxOnceAllows: new Set<string>(),
    sandboxAskedPaths: new Map<string, Map<string, number>>(),
    sandboxContinuations: new Map<string, string>(),
    sandboxRestartBatcher: new SandboxRestartBatcher(batchFlush),
  } as unknown as ZcodeAcpServer;
  const request = vi.fn().mockResolvedValue({ outcome: { optionId: decisionOptionId } });
  const notify = vi.fn().mockResolvedValue(undefined);
  const cx = { request, notify } as unknown as acp.AgentContext;
  return { server, cx, closed, request, notify, batchFlush };
}

describe("handleSandboxDenial", () => {
  let wsRoot: string;

  beforeEach(() => {
    wsRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-allow-")));
    // The restart-batching window runs on a timer; drive it deterministically.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it("always-allow persists to the global config, arms the batched restart", async () => {
    const { server, cx, closed, request, batchFlush } = makeStubs("sandbox_allow_always");
    server.sessionCwds.set("acp_a", wsRoot);
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      {
        path: path.join(wsRoot, "..", "outside", "decoy.txt"),
        isMkdir: false,
      },
      "tc_eperm",
    );

    // Wire name is snake_case and the params carry the source toolCall —
    // the camelCase form is method-not-found on real clients (review R-C1).
    expect(request.mock.calls[0]?.[0]).toBe("session/request_permission");
    const sentParams = request.mock.calls[0]?.[1] as { toolCall?: { toolCallId?: string } };
    expect(sentParams.toolCall?.toolCallId).toBe("tc_eperm");
    // Directory-granularity: the FILE's directory is what got allowlisted.
    expect(readGlobalSandboxConfig().allow).toEqual([
      path.dirname(path.join(wsRoot, "..", "outside", "decoy.txt")),
    ]);
    // The restart is BATCHED: the grant is queued, but nothing is cancelled
    // or closed until the window flushes (other pending popups survive).
    expect(turn.cancelled).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(batchFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SANDBOX_RESTART_BATCH_MS);
    expect(batchFlush).toHaveBeenCalledTimes(1);
    const batch = batchFlush.mock.calls[0]?.[0] as Map<string, string[]>;
    expect(batch.get("acp_a")).toEqual([
      path.dirname(path.join(wsRoot, "..", "outside", "decoy.txt")),
    ]);
  });

  it("reject_always persists the denial to the config deny list — visible, no restart", async () => {
    const { server, cx, closed, request, notify } = makeStubs("sandbox_reject_always");
    server.sessionCwds.set("acp_a", wsRoot);
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: path.join(wsRoot, "..", "outside", "f.txt"), isMkdir: false },
      "tc_reject",
    );

    expect(request).toHaveBeenCalledTimes(1);
    // VISIBLE persistence: recorded in the global config, never in hidden
    // bridge memory — the user can review/undo it by editing the file.
    expect(readGlobalSandboxConfig().deny).toEqual([
      path.dirname(path.join(wsRoot, "..", "outside", "f.txt")),
    ]);
    expect(readGlobalSandboxConfig().allow).toEqual([]);
    expect(turn.cancelled).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled(); // the confirmation hint reached the editor
  });

  it("timeout / unknown outcome persists NOTHING (no hidden rejection memory)", async () => {
    const { server, cx } = makeStubs("some_other_client_button");
    server.sessionCwds.set("acp_a", wsRoot);

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: path.join(wsRoot, "..", "outside", "f.txt"), isMkdir: false },
      "tc_unknown",
    );

    expect(readGlobalSandboxConfig().deny).toEqual([]);
    expect(readGlobalSandboxConfig().allow).toEqual([]);
  });

  it("phantom-guard: $HOME-wide grants never get a popup", async () => {
    const { server, cx, closed, request, notify } = makeStubs("sandbox_allow_always");
    server.sessionCwds.set("acp_a", wsRoot);
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: path.join(os.homedir(), "sbx-echoed.txt"), isMkdir: false },
      "tc_home",
    );

    expect(request).not.toHaveBeenCalled();
    expect(turn.cancelled).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled(); // the too-broad hint reached the editor
  });

  it("global-config-dir paths get a hint instead of a doomed popup (deny always wins)", async () => {
    const { server, cx, closed, request, notify } = makeStubs("sandbox_allow_always");
    server.sessionCwds.set("acp_a", wsRoot);
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: path.join(globalSandboxConfigDir(), "sandbox.json"), isMkdir: false },
      "tc_island",
    );

    expect(request).not.toHaveBeenCalled();
    expect(turn.cancelled).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled(); // the hint chunk reached the editor
  });

  it("an unparseable global config downgrades always-allow to a once-allow, bytes survive", async () => {
    const { server, cx, request } = makeStubs("sandbox_allow_always");
    server.sessionCwds.set("acp_a", wsRoot);
    const file = globalSandboxConfigPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{not json");

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      {
        path: "/opt/data/file.txt",
        isMkdir: false,
      },
      "tc_corrupt",
    );

    expect(request).toHaveBeenCalled();
    expect(server.sandboxOnceAllows.has("/opt/data")).toBe(true);
    // The user's (broken) bytes were NOT clobbered by the grant.
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("freezes the turn before the ask; a rejection settles it into a continuation", async () => {
    const { server, cx, request } = makeStubs("sandbox_reject_once");
    server.sessionCwds.set("acp_a", wsRoot);
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };
    const freeze = vi.fn().mockResolvedValue(undefined);

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: path.join(wsRoot, "..", "outside", "f.txt"), isMkdir: false },
      "tc_frz",
      turn,
      freeze,
    );

    // The generation was frozen for the ask, and the frozen turn unwinds
    // cancelled with the denial context queued for prompt()'s chained round —
    // the model must not free-run past the EPERM it caused.
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(turn.cancelled).toBe(true);
    const cont = server.sandboxContinuations.get("acp_a");
    expect(typeof cont).toBe("string");
    expect(cont).toContain("拒绝");
  });

  it("unattended timeout pins the path, settles the round for re-dispatch", async () => {
    const { server, cx, request } = makeStubs("sandbox_allow_once");
    server.sessionCwds.set("acp_a", wsRoot);
    // Live goal loop behind the sid mapping → unattended context.
    (server as unknown as { resolveSid: () => string }).resolveSid = () => "sess_z";
    (server as unknown as { goalLoops: Map<string, unknown> }).goalLoops = new Map([
      ["sess_z", {}],
    ]);
    // The ask never resolves — only the unattended timeout can end it.
    request.mockReturnValue(new Promise(() => {}));
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false, goalLoop: true };
    const freeze = vi.fn().mockResolvedValue(undefined);

    const wait = handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: path.join(wsRoot, "..", "outside", "f.txt"), isMkdir: false },
      "tc_unatt",
      turn,
      freeze,
    );
    await vi.advanceTimersByTimeAsync(60_000); // default unattended timeout
    await wait;

    expect(freeze).toHaveBeenCalledTimes(1);
    expect(turn.cancelled).toBe(true);
    expect(turn.sandboxRestart).toBe(true); // driver re-dispatches, no pause
    expect(server.sandboxContinuations.size).toBe(0); // goal rounds take no continuation
    const marks = server.sandboxAskedPaths.get("acp_a")!;
    const pinned = resolveReal(path.dirname(path.join(wsRoot, "..", "outside", "f.txt")));
    expect(marks.get(pinned)).toBe(UNATTENDED_PIN);

    // Pinned for the REST of the context: a repeat denial does not re-ask…
    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: path.join(wsRoot, "..", "outside", "g.txt"), isMkdir: false },
      "tc_unatt2",
      { zcodeSid: "sess_z", cancelled: false, goalLoop: true },
    );
    expect(request).toHaveBeenCalledTimes(1);
    // …and the pin expires with the context (loop gone → asks afresh).
    (server as unknown as { goalLoops: Map<string, unknown> }).goalLoops = new Map();
    // Back to attended: the ask must answer (no timeout racer) — restore the
    // resolving mock so the third ask settles instead of hanging forever.
    request.mockResolvedValue({ outcome: { optionId: "sandbox_allow_once" } });
    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: path.join(wsRoot, "..", "outside", "h.txt"), isMkdir: false },
      "tc_unatt3",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("a failed ask settles the frozen turn (undelivered) and re-asks after a cooldown", async () => {
    const closed = vi.fn().mockResolvedValue(undefined);
    const batchFlush = vi.fn();
    const server = {
      backendSandboxed: true,
      ensureBackend: () => ({ close: closed }),
      sessionCwds: new Map<string, string>(),
      sandboxRoots() {
        return new Set(this.sessionCwds.values());
      },
      // One "connected" client so the failed ask rejects (null) instead of
      // holding for reconnect; attended (no sid mapping, no goal loops).
      clients: { size: 1 },
      resolveSid: () => undefined,
      goalLoops: new Map(),
      cancelAllPendingTurns: vi.fn(),
      sandboxOnceAllows: new Set<string>(),
      sandboxAskedPaths: new Map<string, Map<string, number>>(),
      sandboxContinuations: new Map<string, string>(),
      sandboxRestartBatcher: new SandboxRestartBatcher(batchFlush),
    } as unknown as ZcodeAcpServer;
    const request = vi.fn().mockRejectedValue(new Error("client gone"));
    const cx = {
      request,
      notify: vi.fn().mockResolvedValue(undefined),
    } as unknown as acp.AgentContext;
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };
    const freeze = vi.fn();

    const denial = { path: "/opt/data/file.txt", isMkdir: false } as const;
    await handleSandboxDenial(server, cx, "acp_a", denial, "tc_1", turn, freeze);

    // The generation was frozen for this ask; an ask that dies undelivered
    // (clients around, every attempt failed) must still settle the turn —
    // nothing will re-trigger the EPERM, so without a continuation the round
    // would strand on the stop's half reply.
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(turn.cancelled).toBe(true);
    expect(server.sandboxContinuations.get("acp_a")).toContain("/opt/data");
    expect(closed).not.toHaveBeenCalled();
    // The mark is a FINITE timestamp (a cooldown), not Infinity and not the
    // unattended pin: the ask died of the environment (client error / dead
    // channel), never a user decision and never an unattended timeout — a
    // permanent mute would leave the model hitting a bare EPERM with no way
    // out.
    const mark = server.sandboxAskedPaths.get("acp_a")?.get("/opt/data");
    expect(mark).toBeDefined();
    expect(mark).not.toBe(Number.POSITIVE_INFINITY);
    expect(mark).not.toBe(UNATTENDED_PIN);

    // Inside the cooldown an instantly-rejecting client is NOT re-asked (no
    // popup storm); after it, the same denial may ask again.
    await handleSandboxDenial(server, cx, "acp_a", denial, "tc_2", turn, freeze);
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SANDBOX_ASK_RETRY_MS + 1);
    await handleSandboxDenial(server, cx, "acp_a", denial, "tc_3", turn, freeze);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("two approvals inside one window share a single restart flush", async () => {
    const { server, cx, closed, batchFlush } = makeStubs("sandbox_allow_always");
    server.sessionCwds.set("acp_a", wsRoot);

    // Two parallel denials on different paths, both approved (the popups
    // would previously kill each other via per-approval restarts).
    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: path.join(wsRoot, "..", "outside", "a.txt"), isMkdir: false },
      "tc_a",
    );
    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: "/opt/other/b.txt", isMkdir: false },
      "tc_b",
    );

    // Nothing restarted yet — both grants are only queued, so sibling
    // popups (and the turns behind them) survive the window.
    expect(closed).not.toHaveBeenCalled();
    expect(server.cancelAllPendingTurns).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SANDBOX_RESTART_BATCH_MS);
    expect(batchFlush).toHaveBeenCalledTimes(1);
    const batch = batchFlush.mock.calls[0]?.[0] as Map<string, string[]>;
    expect(batch.get("acp_a")).toEqual([
      path.dirname(path.join(wsRoot, "..", "outside", "a.txt")),
      "/opt/other",
    ]);
  });
});

describe("SandboxRestartBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dedupes the same path and flushes once per window", () => {
    const flush = vi.fn();
    const batcher = new SandboxRestartBatcher(flush, 1000);
    batcher.add("s1", "/a");
    batcher.add("s1", "/a"); // duplicate — ignored
    batcher.add("s1", "/b");
    batcher.add("s2", "/c"); // another session joins the same batch
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(1);
    const batch = flush.mock.calls[0]?.[0] as Map<string, string[]>;
    expect(batch.get("s1")).toEqual(["/a", "/b"]);
    expect(batch.get("s2")).toEqual(["/c"]);
    // The window re-arms for grants arriving after a flush.
    batcher.add("s1", "/d");
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});

describe("flushSandboxGrants", () => {
  /** Minimal SandboxFlushTarget: a fake backend + the server state maps. */
  function makeTarget(backend: { close(): Promise<void>; isDead: boolean } | null) {
    const closed = vi.fn().mockResolvedValue(undefined);
    const target = {
      cancelAllPendingTurns: vi.fn(),
      sandboxContinuations: new Map<string, string>(),
      sessionMap: new Map<string, string>(),
      pendingTurns: new Map<
        number | string,
        { zcodeSid: string; cancelled?: boolean; goalLoop?: boolean; sandboxRestart?: boolean }
      >(),
      backend: backend === null ? null : { close: closed, isDead: backend.isDead },
    };
    return { target, closed };
  }

  it("cancels all turns, sets one continuation for LIVE sessions, nulls + closes the backend", () => {
    const { target, closed } = makeTarget({ close: async () => undefined, isDead: false });
    target.sessionMap.set("acp_a", "z1");
    target.pendingTurns.set(1, { zcodeSid: "z1" }); // in-flight turn for acp_a
    target.sessionMap.set("acp_b", "z2"); // session exists, turn already finished

    flushSandboxGrants(
      target,
      new Map([
        ["acp_a", ["/a", "/b"]],
        ["acp_b", ["/c"]],
      ]),
    );

    expect(target.cancelAllPendingTurns).toHaveBeenCalledTimes(1);
    expect(target.sandboxContinuations.get("acp_a")).toContain("/a");
    expect(target.sandboxContinuations.get("acp_a")).toContain("/b");
    // Non-live session: NO continuation — an orphaned entry would later be
    // consumed by an unrelated cancelled prompt (ESC/preempt) as an automatic
    // "continue" round.
    expect(target.sandboxContinuations.has("acp_b")).toBe(false);
    // The reference is dropped before the async kill so a racing
    // ensureBackend() respawns instead of adopting the dying backend.
    expect(target.backend).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("kills the backend even for non-live sessions — grants need the respawn to apply", () => {
    const { target, closed } = makeTarget({ close: async () => undefined, isDead: false });
    flushSandboxGrants(target, new Map([["acp_a", ["/a"]]]));
    expect(target.backend).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("marks goalLoop turns for driver re-dispatch and never queues their continuation", () => {
    const { target } = makeTarget({ close: async () => undefined, isDead: false });
    target.sessionMap.set("acp_a", "z1");
    const goalTurn = { zcodeSid: "z1", goalLoop: true };
    target.pendingTurns.set(1, goalTurn); // goal round is acp_a's ONLY turn
    target.sessionMap.set("acp_b", "z2");
    target.pendingTurns.set(2, { zcodeSid: "z2" }); // editor prompt turn

    flushSandboxGrants(
      target,
      new Map([
        ["acp_a", ["/a"]],
        ["acp_b", ["/b"]],
      ]),
    );

    // The goal turn is still cancelled (the backend restart kills its
    // generation) but marked so the DRIVER re-dispatches the ticket — prompt()
    // never drives goal turns, so a continuation for acp_a would be orphaned
    // and later hijack an unrelated cancelled prompt.
    expect(goalTurn.sandboxRestart).toBe(true);
    expect(target.sandboxContinuations.has("acp_a")).toBe(false);
    expect(target.sandboxContinuations.get("acp_b")).toContain("/b");
  });
});
