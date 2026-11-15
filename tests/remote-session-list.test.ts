/**
 * Session history endpoint (ADR-0015, amended by ADR-0017): the bridge-side
 * GET /sessions handler through a real loopback HTTP server with an
 * in-memory ZcodeAcpServer and a fake backend. Proves that currently
 * executing conversations (live or running on this bridge) are EXCLUDED —
 * they belong to discovery, and resuming one would load it onto a second
 * bridge — that closed conversations list with the compatibility row shape,
 * and the pagination that keeps long-lived projects browsable (newest first,
 * limit + before cursor, exclusion applied before the window).
 */

import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

// Tombstones: listSessions consults hiddenTaskIds() (deleted/archived rows in
// the App's tasks index) before sorting. Mock only that function — the rest
// of tasks-index stays real (its module graph is imported by the server).
const hiddenMock = vi.hoisted(() => ({ ids: new Set<string>() }));
vi.mock("../src/tasks-index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tasks-index.js")>();
  return { ...actual, hiddenTaskIds: async () => hiddenMock.ids };
});

import type { ZcodeBackend } from "../src/backend/client.js";
import { createSessionListHandler } from "../src/remote/session-list-endpoint.js";
import {} from "../src/settings/workflow-run-dismissals.js";
import { ZcodeAcpServer } from "../src/server.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  hiddenMock.ids = new Set();
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
});

/** Boot the list handler on an ephemeral port; returns its base URL. */
async function bootList(server: ZcodeAcpServer): Promise<string> {
  const handler = createSessionListHandler(server);
  const httpServer: Server = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname === "/sessions") handler(req, res);
    else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
  const addr = httpServer.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

/** Fake backend answering only session/list with the given sessions array. */
function listBackend(
  sessions: unknown[],
  answer?: () => { result?: unknown; error?: { message: string } },
): ZcodeBackend {
  return {
    isDead: false,
    request: async (_id: number, method: string) => {
      if (method === "session/list") {
        return answer ? answer() : { result: { sessions } };
      }
      return { error: { message: "unhandled" } };
    },
  } as unknown as ZcodeBackend;
}

/** ISO timestamps listSessions would produce from the given ms epochs. */
function fixture(n: number): Array<{ sessionId: string; title: string; updatedAt: number }> {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `sess_${String(i).padStart(3, "0")}`,
    title: `work ${i}`,
    updatedAt: 1_000 + i,
  }));
}

describe("session history endpoint", () => {
  it("excludes sessions this bridge holds live; closed ones list with the row shape", async () => {
    const server = new ZcodeAcpServer();
    server.backend = listBackend([
      { sessionId: "sess_closed", title: "Old work", updatedAt: 800 },
      { sessionId: "sess_live", title: "Current", updatedAt: 900 },
    ]);
    server.registerSession("s-live", "sess_live");
    server.markSessionActive("s-live");

    const res = await fetch(`${await bootList(server)}/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{
        sessionId: string;
        title?: string;
        updatedAt?: string;
        live: boolean;
        running: boolean;
      }>;
      nextCursor: { before: number; beforeId: string } | null;
    };
    // The executing conversation belongs to discovery, not to the resume
    // surface — offering it here would let a client load it onto a second
    // bridge (ADR-0015 as amended by ADR-0017).
    expect(body.sessions.map((s) => s.sessionId)).toEqual(["sess_closed"]);
    expect(body.sessions[0]).toMatchObject({
      title: "Old work",
      // Shape-compat fields: constant false now.
      live: false,
      running: false,
    });
    expect(typeof body.sessions[0]!.updatedAt).toBe("string");
    // Fewer rows than the page size — no continuation.
    expect(body.nextCursor).toBeNull();
  });

  it("hides tombstoned (deleted/archived) sessions before sorting and pagination", async () => {
    // Delete sess_004 + sess_002: pages must stay DENSE (hidden rows never
    // occupy a slot) and cursors keep naming the exact next visible row.
    hiddenMock.ids = new Set(["sess_004", "sess_002"]);
    const server = new ZcodeAcpServer();
    server.backend = listBackend(fixture(5));
    const base = await bootList(server);
    type Cursor = { before: number; beforeId: string } | null;

    const page1 = (await (await fetch(`${base}/sessions?limit=2`)).json()) as {
      sessions: Array<{ sessionId: string }>;
      nextCursor: Cursor;
    };
    expect(page1.sessions.map((s) => s.sessionId)).toEqual(["sess_003", "sess_001"]);
    expect(page1.nextCursor).toEqual({ before: 1_001, beforeId: "sess_001" });

    const page2 = (await (
      await fetch(
        `${base}/sessions?limit=2&before=${page1.nextCursor!.before}&beforeId=${page1.nextCursor!.beforeId}`,
      )
    ).json()) as { sessions: Array<{ sessionId: string }>; nextCursor: Cursor };
    expect(page2.sessions.map((s) => s.sessionId)).toEqual(["sess_000"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("filters executing sessions BEFORE windowing, so pages stay dense", async () => {
    // Regression: excluding after the slice would burn page slots on hidden
    // rows and strand cursor positions. The live row is dropped pre-sort, so
    // limit=1 serves the newest RESUMABLE row and the cursor chains on.
    const server = new ZcodeAcpServer();
    server.backend = listBackend([
      { sessionId: "sess_old", title: "old", updatedAt: 800 },
      { sessionId: "sess_mid", title: "mid", updatedAt: 850 },
      { sessionId: "sess_busy", title: "busy", updatedAt: 900 },
    ]);
    server.registerSession("s-busy", "sess_busy");
    server.markSessionActive("s-busy");
    const base = await bootList(server);
    type Body = {
      sessions: Array<{ sessionId: string }>;
      nextCursor: { before: number; beforeId: string } | null;
    };

    const page1 = (await (await fetch(`${base}/sessions?limit=1`)).json()) as Body;
    expect(page1.sessions.map((s) => s.sessionId)).toEqual(["sess_mid"]);
    expect(page1.nextCursor).toEqual({ before: 850, beforeId: "sess_mid" });

    const page2 = (await (
      await fetch(
        `${base}/sessions?limit=1&before=${page1.nextCursor!.before}&beforeId=${page1.nextCursor!.beforeId}`,
      )
    ).json()) as Body;
    expect(page2.sessions.map((s) => s.sessionId)).toEqual(["sess_old"]);
    expect(page2.nextCursor).toBeNull();
  });
});

// ---------- workflowActivity join (desktop task-row parity) ----------

describe("session history — workflowActivity", () => {
  it("rows carry running count + newest run joined from the journal's newest window", async () => {
    const server = new ZcodeAcpServer();
    server.backendWorkflowGate = Promise.resolve({
      mode: "alwaysOn",
      enabled: true,
      source: "override",
    } satisfies import("../src/config/workflow-gate.js").WorkflowGate);
    server.backend = {
      isDead: false,
      request: async (_id: number, method: string) => {
        if (method === "session/list") {
          return {
            result: {
              sessions: [
                { sessionId: "sess_wf", title: "Runner", updatedAt: 900 },
                { sessionId: "sess_plain", title: "Plain", updatedAt: 800 },
              ],
            },
          };
        }
        if (method === "workflows/runs") {
          return {
            result: {
              runs: [
                // Out of order on purpose: `last` is picked by updatedAt, not
                // arrival order.
                { runId: "r2", parentSessionId: "sess_wf", status: "completed", updatedAt: 4000 },
                {
                  runId: "r1",
                  parentSessionId: "sess_wf",
                  status: "running",
                  updatedAt: 5000,
                  name: "deploy",
                },
              ],
            },
          };
        }
        return { error: { message: "unhandled" } };
      },
    } as unknown as ZcodeBackend;

    const res = await fetch(`${await bootList(server)}/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{
        sessionId: string;
        workflowActivity?: { active: number; last?: { status: string } };
      }>;
    };
    expect(body.sessions.find((s) => s.sessionId === "sess_wf")!.workflowActivity).toMatchObject({
      active: 1,
      last: { status: "running", updatedAt: 5000, name: "deploy" },
    });
    expect(
      body.sessions.find((s) => s.sessionId === "sess_plain")!.workflowActivity,
    ).toBeUndefined();
  });

  it("gate off degrades silently — the page still answers, rows carry no field", async () => {
    const server = new ZcodeAcpServer();
    server.backendWorkflowGate = Promise.resolve({
      mode: "disabled",
      enabled: false,
      source: "remote",
    } satisfies import("../src/config/workflow-gate.js").WorkflowGate);
    server.backend = listBackend([{ sessionId: "sess_x", title: "X", updatedAt: 100 }]);

    const res = await fetch(`${await bootList(server)}/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ sessionId: string; workflowActivity?: unknown }>;
    };
    expect(body.sessions[0]!.workflowActivity).toBeUndefined();
  });
});
