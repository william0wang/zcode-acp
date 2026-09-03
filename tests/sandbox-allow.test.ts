/**
 * Tests for the sandbox dynamic-allow flow (ADR-0011): the EPERM path
 * extractor and the ask→persist→restart arming. The popup itself and the
 * backend respawn run against a stubbed AgentContext / server.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
} from "../src/handlers/sandbox-allow.js";
import {
  readSandboxConfig,
  resetSandboxDecisionForTest,
  sandboxConfigPath,
} from "../src/backend/sandbox.js";
import type { PendingTurn, ZcodeAcpServer } from "../src/server.js";

beforeEach(() => {
  process.env.ZCODE_ACP_SANDBOX = "1";
  // These tests assert the Chinese message table.
  vi.stubEnv("ZCODE_ACP_LANG", "zh");
  resetSandboxDecisionForTest();
});

afterEach(() => {
  delete process.env.ZCODE_ACP_SANDBOX;
  vi.unstubAllEnvs();
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

  it("extracts from JSON-escaped tool payload text", () => {
    const json = JSON.stringify({ content: [{ text: "mv: /etc/hosts: Operation not permitted" }] });
    expect(extractSandboxDenial(json)).toEqual({ path: "/etc/hosts", isMkdir: false });
  });

  it("marks mkdir denials so the target dir itself is allowed", () => {
    expect(extractSandboxDenial("mkdir: /opt/tools/bin: Operation not permitted")).toEqual({
      path: "/opt/tools/bin",
      isMkdir: true,
    });
  });

  it("extracts the zsh redirect form (lowercase phrase, path after)", () => {
    expect(
      extractSandboxDenial("zsh:2: operation not permitted: /Users/william/sbx-test.txt"),
    ).toEqual({ path: "/Users/william/sbx-test.txt", isMkdir: false });
    expect(extractSandboxDenial("zsh:1: operation not permitted: ../xxx-app/f.txt")).toEqual({
      path: "../xxx-app/f.txt",
      isMkdir: false,
    });
  });

  it("extracts explicit ./ and ../ paths from sh forms (resolved against session cwd later)", () => {
    expect(extractSandboxDenial("mkdir: ../xxx-app: Operation not permitted")).toEqual({
      path: "../xxx-app",
      isMkdir: true,
    });
    expect(extractSandboxDenial("tee: ./out/log.txt: Operation not permitted")).toEqual({
      path: "./out/log.txt",
      isMkdir: false,
    });
  });

  it("extracts the Node fs error form (quoted paths keep spaces)", () => {
    expect(
      extractSandboxDenial("Error: EPERM: operation not permitted, open '/Users/x/My Dir/a.txt'"),
    ).toEqual({ path: "/Users/x/My Dir/a.txt", isMkdir: false });
    expect(
      extractSandboxDenial("Error: EPERM: operation not permitted, mkdir '/opt/new dir'"),
    ).toEqual({ path: "/opt/new dir", isMkdir: true });
    // Any libuv syscall name matches; rename takes the FIRST path.
    expect(
      extractSandboxDenial("Error: EPERM: operation not permitted, rename '/a/b' -> '/c/d'"),
    ).toEqual({ path: "/a/b", isMkdir: false });
    expect(
      extractSandboxDenial(
        "Error: EPERM: operation not permitted, mkdtemp '/Users/william/.zcode-acp-sbx-XXXXXX'",
      ),
    ).toEqual({ path: "/Users/william/.zcode-acp-sbx-XXXXXX", isMkdir: false });
    // An apostrophe inside the path must NOT truncate into a broader dir —
    // the match is refused entirely (generic-hint fallback).
    expect(
      extractSandboxDenial("Error: EPERM: operation not permitted, open '/Users/x/O'Brien/a.txt'"),
    ).toBeNull();
  });

  it("returns null without an EPERM or without a parsable absolute path", () => {
    expect(extractSandboxDenial("all good")).toBeNull();
    expect(extractSandboxDenial("some file: Operation not permitted")).toBeNull();
    expect(extractSandboxDenial("relative/x: Operation not permitted")).toBeNull();
  });
});

describe("extractPermDeniedPath", () => {
  it("extracts the path from POSIX EACCES output", () => {
    expect(extractPermDeniedPath("ls: /Users/x/sealed: Permission denied\n")).toBe(
      "/Users/x/sealed",
    );
    expect(extractPermDeniedPath("cat: /etc/sudoers: Permission denied")).toBe("/etc/sudoers");
  });

  it("extracts from JSON-escaped tool payload text", () => {
    const json = JSON.stringify({
      kind: "result",
      result: { content: "Exit code 1\nls: /var/db/ocurity: Permission denied" },
    });
    expect(extractPermDeniedPath(json)).toBe("/var/db/ocurity");
  });

  it("extracts explicit ./ and ../ relative paths (resolved by the caller)", () => {
    expect(extractPermDeniedPath("cp: ./secrets/key: Permission denied")).toBe("./secrets/key");
    expect(extractPermDeniedPath("rm: ../sealed/x.txt: Permission denied")).toBe("../sealed/x.txt");
  });

  it("extracts the zsh redirect form (path after the phrase)", () => {
    expect(extractPermDeniedPath("zsh:1: permission denied: /Users/x/run.sh")).toBe(
      "/Users/x/run.sh",
    );
  });

  it("returns null without the phrase or without a parsable path", () => {
    expect(extractPermDeniedPath("all good")).toBeNull();
    expect(extractPermDeniedPath("open: Permission denied")).toBeNull();
    expect(extractPermDeniedPath("relative/x: Permission denied")).toBeNull();
  });

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

  it("always-allow persists to the project config, arms the batched restart", async () => {
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
    expect(readSandboxConfig(wsRoot).allow).toEqual([
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

  it("relative denial paths resolve against the session cwd before the ask", async () => {
    const { server, cx, request } = makeStubs("sandbox_allow_once");
    server.sessionCwds.set("acp_a", wsRoot);

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: "../outside/f.txt", isMkdir: false },
      "tc_rel",
    );

    const expectedDir = path.dirname(path.join(wsRoot, "..", "outside", "f.txt"));
    // The popup's DETAILS carry the resolved absolute dir (option labels stay
    // short), and the params are schema-clean: no non-standard top-level
    // title — a strict client would reject the whole request over it.
    const sentParams = request.mock.calls[0]?.[1] as {
      title?: string;
      toolCall?: { title?: string };
    };
    expect(sentParams.toolCall?.title).toContain(expectedDir);
    expect(sentParams.title).toBeUndefined();
    expect(server.sandboxOnceAllows.has(expectedDir)).toBe(true);
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
    // VISIBLE persistence: recorded in the project config, never in hidden
    // bridge memory — the user can review/undo it by editing the file.
    expect(readSandboxConfig(wsRoot).deny).toEqual([
      path.dirname(path.join(wsRoot, "..", "outside", "f.txt")),
    ]);
    expect(readSandboxConfig(wsRoot).allow).toEqual([]);
    expect(turn.cancelled).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled(); // the confirmation hint reached the editor
  });

  it("reject_once stores nothing — the same ask resurfaces next time", async () => {
    const { server, cx, closed, notify } = makeStubs("sandbox_reject_once");
    server.sessionCwds.set("acp_a", wsRoot);
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: path.join(wsRoot, "..", "outside", "f.txt"), isMkdir: false },
      "tc_rejectonce",
    );

    expect(readSandboxConfig(wsRoot).deny).toEqual([]);
    expect(readSandboxConfig(wsRoot).allow).toEqual([]);
    expect(turn.cancelled).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled(); // the rejection hint reached the editor
  });

  it("a persisted deny list suppresses the popup with a hint", async () => {
    const { server, cx, closed, request, notify } = makeStubs("sandbox_allow_always");
    server.sessionCwds.set("acp_a", wsRoot);
    mkdirSync(path.join(wsRoot, ".zcode", "acp"), { recursive: true });
    writeFileSync(
      sandboxConfigPath(wsRoot),
      JSON.stringify({
        enabled: true,
        allow: [],
        deny: [path.join(wsRoot, "..", "outside")],
        strictGit: false,
      }),
    );
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: path.join(wsRoot, "..", "outside", "f.txt"), isMkdir: false },
      "tc_denyhit",
    );

    expect(request).not.toHaveBeenCalled();
    expect(turn.cancelled).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled(); // the deny-list hint reached the editor
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

    expect(readSandboxConfig(wsRoot).deny).toEqual([]);
    expect(readSandboxConfig(wsRoot).allow).toEqual([]);
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

  it("island paths get a hint instead of a doomed popup (deny always wins)", async () => {
    const { server, cx, closed, request, notify } = makeStubs("sandbox_allow_always");
    server.sessionCwds.set("acp_a", wsRoot);
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: path.join(wsRoot, ".zcode", "acp", "sandbox.json"), isMkdir: false },
      "tc_island",
    );

    expect(request).not.toHaveBeenCalled();
    expect(turn.cancelled).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalled(); // the hint chunk reached the editor
  });

  it("strictGit .git paths are equally unallowable", async () => {
    const { server, cx, request, closed } = makeStubs("sandbox_allow_always");
    server.sessionCwds.set("acp_a", wsRoot);
    mkdirSync(path.join(wsRoot, ".zcode", "acp"), { recursive: true });
    writeFileSync(
      sandboxConfigPath(wsRoot),
      JSON.stringify({ enabled: true, allow: [], strictGit: true }),
    );
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      { path: path.join(wsRoot, ".git", "index.lock"), isMkdir: false },
      "tc_git",
    );

    expect(request).not.toHaveBeenCalled();
    expect(turn.cancelled).toBe(false);
    expect(closed).not.toHaveBeenCalled();
  });

  it("case-variant island paths (.ZCODE/ACP) are also protected on darwin", async () => {
    const { server, cx, request, closed } = makeStubs("sandbox_allow_always");
    server.sessionCwds.set("acp_a", wsRoot);
    const real = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      await handleSandboxDenial(
        server,
        cx,
        "acp_a",
        { path: path.join(wsRoot, ".ZCODE", "ACP", "sandbox.json"), isMkdir: false },
        "tc_case",
      );
    } finally {
      Object.defineProperty(process, "platform", { value: real, configurable: true });
    }
    expect(request).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  });

  it("symlinked config downgrades always-allow to a bridge-lifetime once-allow", async () => {
    const { server, cx, request } = makeStubs("sandbox_allow_always");
    server.sessionCwds.set("acp_a", wsRoot);
    const target = path.join(wsRoot, "cfg.json");
    writeFileSync(target, JSON.stringify({ enabled: true, allow: [] }));
    mkdirSync(path.join(wsRoot, ".zcode", "acp"), { recursive: true });
    symlinkSync(target, sandboxConfigPath(wsRoot));

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      {
        path: "/opt/data/file.txt",
        isMkdir: false,
      },
      "tc_syn",
    );

    expect(request).toHaveBeenCalled();
    expect(server.sandboxOnceAllows.has("/opt/data")).toBe(true);
    // The link target was NOT mutated through the symlink.
    expect(JSON.parse(readFileSync(target, "utf8")).allow).toEqual([]);
  });

  it("once-allow keeps the root in bridge-lifetime memory only", async () => {
    const { server, cx, batchFlush } = makeStubs("sandbox_allow_once");
    server.sessionCwds.set("acp_a", wsRoot);

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      {
        path: "/opt/data/file.txt",
        isMkdir: false,
      },
      "tc_1",
    );

    expect(server.sandboxOnceAllows.has("/opt/data")).toBe(true);
    expect(readSandboxConfig(wsRoot).allow).toEqual([]);
    vi.advanceTimersByTime(SANDBOX_RESTART_BATCH_MS);
    expect(batchFlush).toHaveBeenCalledTimes(1);
  });

  it("rejection leaves everything untouched (no restart, no continuation)", async () => {
    const { server, cx, closed } = makeStubs("sandbox_reject");
    server.sessionCwds.set("acp_a", wsRoot);
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      {
        path: "/opt/data/file.txt",
        isMkdir: false,
      },
      "tc_1",
    );

    expect(turn.cancelled).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(server.sandboxContinuations.size).toBe(0);
  });

  it("debounces repeat asks for the same directory within a session", async () => {
    const { server, cx, request } = makeStubs("sandbox_reject");

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      {
        path: "/opt/data/one.txt",
        isMkdir: false,
      },
      "tc_1",
    );
    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      {
        path: "/opt/data/two.txt",
        isMkdir: false,
      },
      "tc_1",
    );

    // Same directory → the popup fired exactly once.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("a failed ask keeps the sandbox unchanged; the path re-asks after a cooldown", async () => {
    const closed = vi.fn().mockResolvedValue(undefined);
    const batchFlush = vi.fn();
    const server = {
      backendSandboxed: true,
      ensureBackend: () => ({ close: closed }),
      sessionCwds: new Map<string, string>(),
      sandboxRoots() {
        return new Set(this.sessionCwds.values());
      },
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

    const denial = { path: "/opt/data/file.txt", isMkdir: false } as const;
    await handleSandboxDenial(server, cx, "acp_a", denial, "tc_1");

    expect(turn.cancelled).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    // The mark is a FINITE timestamp (a cooldown), not Infinity: the ask died
    // of the environment (timeout, dead channel, or another grant's batched
    // restart killing it), never a user decision — a permanent mute would
    // leave the model hitting a bare EPERM with no way out.
    const mark = server.sandboxAskedPaths.get("acp_a")?.get("/opt/data");
    expect(mark).toBeDefined();
    expect(mark).not.toBe(Number.POSITIVE_INFINITY);

    // Inside the cooldown an instantly-rejecting client is NOT re-asked (no
    // popup storm); after it, the same denial may ask again.
    await handleSandboxDenial(server, cx, "acp_a", denial, "tc_2");
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SANDBOX_ASK_RETRY_MS + 1);
    await handleSandboxDenial(server, cx, "acp_a", denial, "tc_3");
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
      pendingTurns: new Map<number | string, { zcodeSid: string }>(),
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

  it("skips the kill when the backend is already gone (no respawn-then-kill churn)", () => {
    const { target, closed } = makeTarget({ close: async () => undefined, isDead: true });
    target.sessionMap.set("acp_a", "z1");
    target.pendingTurns.set(1, { zcodeSid: "z1" });
    flushSandboxGrants(target, new Map([["acp_a", ["/a"]]]));
    // Continuation still lands for the live session; the dead backend is
    // left alone for the lazy respawn to handle.
    expect(target.sandboxContinuations.get("acp_a")).toContain("/a");
    expect(target.backend).not.toBeNull();
    expect(closed).not.toHaveBeenCalled();
  });
});
