/**
 * Tombstone revival wiring (ADR-0031 amendment).
 *
 * The SQLite semantics live in tasks-index.test.ts; these tests pin the WIRING
 * only, at the three "the project is open" moments:
 * 1. session/new — a client (CLI boot, editor attach) opened the workspace;
 * 2. session/list — the /resume picker: the revival is AWAITED before the
 *    tombstone filter is read, so a deleted project's picker is never empty;
 * 3. markSessionActive — a session was really used (load with history /
 *    resume / prompt): the used session revives under its backend id.
 *
 * The hub's remote-resume 404 guard is deliberately untouched — only real
 * bridge-side usage revives. (The missing-export typeof guard is exercised
 * implicitly by the many suites that mock tasks-index partially and still run
 * these code paths.)
 */

import type * as acp from "@agentclientprotocol/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { listSessions, newSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

const reviveCalls: Array<Record<string, unknown>> = [];
// hiddenTaskIds records how many revival calls had ALREADY landed when the
// tombstone filter was read — the race-free-picker proof.
let hiddenReadAfterRevives = -1;
let failNext = false;
vi.mock("../src/tasks-index.js", () => ({
  reviveTombstonesOnActivity: async (opts: Record<string, unknown>) => {
    reviveCalls.push(opts);
    if (failNext) throw new Error("boom");
    return 0;
  },
  hiddenTaskIds: async () => {
    hiddenReadAfterRevives = reviveCalls.length;
    return new Set<string>();
  },
}));

async function flushMicrotasks(): Promise<void> {
  // Fire-and-forget revival: one tick for the dynamic import, one for the
  // call itself.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Fake backend answering session/list with the given rows. */
function listBackend(sessions: unknown[]): ZcodeBackend {
  return {
    isDead: false,
    request: async (_id: number, method: string) => {
      if (method === "session/list") return { result: { sessions } };
      return { error: { message: `unhandled ${method}` } };
    },
  } as unknown as ZcodeBackend;
}

describe("tombstone revival wiring", () => {
  beforeEach(() => {
    reviveCalls.length = 0;
    hiddenReadAfterRevives = -1;
    failNext = false;
  });

  it("session/new fires the project-open revival (CLI boot / editor attach)", async () => {
    const server = new ZcodeAcpServer();
    await newSession(server, { cwd: "/tmp/proj" } as acp.NewSessionRequest);

    // Fire-and-forget at new; flushed before any picker could open.
    await flushMicrotasks();
    expect(reviveCalls).toEqual([{ workspacePath: "/tmp/proj" }]);
  });

  it("session/list awaits the revival BEFORE reading the tombstone filter", async () => {
    const server = new ZcodeAcpServer();
    server.backend = listBackend([{ sessionId: "sess_old", title: "kept", updatedAt: 5 }]);

    const resp = await listSessions(server, { cwd: "/tmp/proj" } as acp.ListSessionsRequest);

    expect(reviveCalls).toEqual([{ workspacePath: "/tmp/proj" }]);
    // The filter read happened AFTER the revival resolved — this very listing
    // sees the revived rows (no empty-picker race).
    expect(hiddenReadAfterRevives).toBe(1);
    expect(resp.sessions.map((s) => s.sessionId)).toEqual(["sess_old"]);
  });

  it("session/list without a cwd skips the revival (nothing to scope)", async () => {
    const server = new ZcodeAcpServer();
    server.backend = listBackend([]);

    await listSessions(server, {} as acp.ListSessionsRequest);
    expect(reviveCalls).toEqual([]);
  });

  it("markSessionActive revives a mapped session under its backend id and cwd", async () => {
    const server = new ZcodeAcpServer();
    server.registerSession("acp_1", "zc_1");
    server.sessionCwds.set("acp_1", "/tmp/proj");

    server.markSessionActive("acp_1");
    await flushMicrotasks();

    expect(reviveCalls).toEqual([{ taskId: "zc_1", workspacePath: "/tmp/proj" }]);
  });

  it("direct sessions revive under their own id; an unknown cwd is omitted", async () => {
    const server = new ZcodeAcpServer();

    server.markSessionActive("sess_direct");
    await flushMicrotasks();

    expect(reviveCalls).toEqual([{ taskId: "sess_direct" }]);
  });

  it("a throwing revival helper never breaks the activity path", async () => {
    failNext = true;
    const server = new ZcodeAcpServer();
    server.registerSession("acp_2", "zc_2");

    expect(() => server.markSessionActive("acp_2")).not.toThrow();
    await flushMicrotasks(); // the rejection must be swallowed, not unhandled

    expect(reviveCalls).toHaveLength(1);
  });
});
