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

import { extractSandboxDenial, handleSandboxDenial } from "../src/handlers/sandbox-allow.js";
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

/** Server + context stubs shared by the handleSandboxDenial cases. */
function makeStubs(decisionOptionId: string) {
  const closed = vi.fn().mockResolvedValue(undefined);
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
    sandboxAskedPaths: new Map<string, Set<string>>(),
    sandboxContinuations: new Map<string, string>(),
  } as unknown as ZcodeAcpServer;
  const request = vi.fn().mockResolvedValue({ outcome: { optionId: decisionOptionId } });
  const notify = vi.fn().mockResolvedValue(undefined);
  const cx = { request, notify } as unknown as acp.AgentContext;
  return { server, cx, closed, request, notify };
}

describe("handleSandboxDenial", () => {
  let wsRoot: string;

  beforeEach(() => {
    wsRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-allow-")));
  });

  afterEach(() => {
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it("always-allow persists to the project config, arms restart + continuation", async () => {
    const { server, cx, closed, request } = makeStubs("sandbox_allow_always");
    server.sessionCwds.set("acp_a", wsRoot);
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      turn,
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
    expect(turn.cancelled).toBe(true);
    expect(turn.stopSent).toBe(true);
    expect(server.sandboxContinuations.get("acp_a")).toContain("请继续刚才的任务");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("relative denial paths resolve against the session cwd before the ask", async () => {
    const { server, cx, request } = makeStubs("sandbox_allow_once");
    server.sessionCwds.set("acp_a", wsRoot);
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      turn,
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
      turn,
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
      turn,
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
      turn,
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
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      turn,
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
      turn,
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
      turn,
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
      turn,
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
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };
    const real = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      await handleSandboxDenial(
        server,
        cx,
        "acp_a",
        turn,
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
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      turn,
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
    const { server, cx, closed } = makeStubs("sandbox_allow_once");
    server.sessionCwds.set("acp_a", wsRoot);
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      turn,
      {
        path: "/opt/data/file.txt",
        isMkdir: false,
      },
      "tc_1",
    );

    expect(server.sandboxOnceAllows.has("/opt/data")).toBe(true);
    expect(readSandboxConfig(wsRoot).allow).toEqual([]);
    expect(turn.cancelled).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("rejection leaves everything untouched (no restart, no continuation)", async () => {
    const { server, cx, closed } = makeStubs("sandbox_reject");
    server.sessionCwds.set("acp_a", wsRoot);
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      turn,
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
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      turn,
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
      turn,
      {
        path: "/opt/data/two.txt",
        isMkdir: false,
      },
      "tc_1",
    );

    // Same directory → the popup fired exactly once.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("a failed ask keeps the sandbox unchanged", async () => {
    const closed = vi.fn().mockResolvedValue(undefined);
    const server = {
      backendSandboxed: true,
      ensureBackend: () => ({ close: closed }),
      sessionCwds: new Map<string, string>(),
      sandboxRoots() {
        return new Set(this.sessionCwds.values());
      },
      cancelAllPendingTurns: vi.fn(),
      sandboxOnceAllows: new Set<string>(),
      sandboxAskedPaths: new Map<string, Set<string>>(),
      sandboxContinuations: new Map<string, string>(),
    } as unknown as ZcodeAcpServer;
    const cx = {
      request: vi.fn().mockRejectedValue(new Error("client gone")),
      notify: vi.fn().mockResolvedValue(undefined),
    } as unknown as acp.AgentContext;
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };

    await handleSandboxDenial(
      server,
      cx,
      "acp_a",
      turn,
      {
        path: "/opt/data/file.txt",
        isMkdir: false,
      },
      "tc_1",
    );

    expect(turn.cancelled).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    // The asked-mark still landed — no retry loop hammering a dead client.
    expect(server.sandboxAskedPaths.get("acp_a")?.size).toBe(1);
  });
});
