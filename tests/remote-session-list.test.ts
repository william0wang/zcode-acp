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

import { afterEach, describe, expect, it } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import {
  createSessionListHandler,
  DEFAULT_SESSION_LIMIT,
  MAX_SESSION_LIMIT,
} from "../src/remote/session-list-endpoint.js";
import { ZcodeAcpServer } from "../src/server.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
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

  it("sorts newest-first (id desc tiebreak) and paginates with the composite cursor", async () => {
    const server = new ZcodeAcpServer();
    // Deliberately shuffled; same updatedAt for sess_004/sess_005 exercises
    // the tiebreak.
    server.backend = listBackend([
      { sessionId: "sess_003", title: "w3", updatedAt: 1_003 },
      { sessionId: "sess_005", title: "w5", updatedAt: 1_005 },
      { sessionId: "sess_001", title: "w1", updatedAt: 1_001 },
      { sessionId: "sess_004", title: "w4", updatedAt: 1_005 },
      { sessionId: "sess_002", title: "w2", updatedAt: 1_002 },
    ]);
    const base = await bootList(server);
    type Cursor = { before: number; beforeId: string } | null;
    const ids = (b: unknown) => b as { sessions: Array<{ sessionId: string }>; nextCursor: Cursor };
    const page = async (cursor: Cursor): Promise<ReturnType<typeof ids>> =>
      ids(
        await (
          await fetch(
            cursor
              ? `${base}/sessions?limit=2&before=${cursor.before}&beforeId=${encodeURIComponent(cursor.beforeId)}`
              : `${base}/sessions?limit=2`,
          )
        ).json(),
      );

    const page1 = await page(null);
    expect(page1.sessions.map((s) => s.sessionId)).toEqual(["sess_005", "sess_004"]);
    // 5 rows > limit 2 → the cursor names the exact last row (tied ms).
    expect(page1.nextCursor).toEqual({ before: 1_005, beforeId: "sess_004" });

    const page2 = await page(page1.nextCursor);
    expect(page2.sessions.map((s) => s.sessionId)).toEqual(["sess_003", "sess_002"]);
    expect(page2.nextCursor).toEqual({ before: 1_002, beforeId: "sess_002" });

    const page3 = await page(page2.nextCursor);
    expect(page3.sessions.map((s) => s.sessionId)).toEqual(["sess_001"]);
    expect(page3.nextCursor).toBeNull();
  });

  it("reaches every row when one millisecond spans several pages", async () => {
    const server = new ZcodeAcpServer();
    server.backend = listBackend(
      ["e", "d", "c", "b", "a"].map((suffix) => ({
        sessionId: `sess_${suffix}`,
        title: suffix,
        updatedAt: 1_000,
      })),
    );
    const base = await bootList(server);
    const seen: string[] = [];
    let cursor: { before: number; beforeId: string } | null = null;
    for (;;) {
      const url = cursor
        ? `${base}/sessions?limit=2&before=${cursor.before}&beforeId=${encodeURIComponent(cursor.beforeId)}`
        : `${base}/sessions?limit=2`;
      const body = (await (await fetch(url)).json()) as {
        sessions: Array<{ sessionId: string }>;
        nextCursor: { before: number; beforeId: string } | null;
      };
      seen.push(...body.sessions.map((s) => s.sessionId));
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    // All five tied rows, descending id order, none skipped or repeated —
    // a ms-only cursor would strand rows past the first page boundary.
    expect(seen).toEqual(["sess_e", "sess_d", "sess_c", "sess_b", "sess_a"]);
  });

  it("defaults to DEFAULT_SESSION_LIMIT rows and clamps the asked limit", async () => {
    const server = new ZcodeAcpServer();
    server.backend = listBackend(fixture(MAX_SESSION_LIMIT + 50));
    const base = await bootList(server);

    const defaulted = (await (await fetch(`${base}/sessions`)).json()) as {
      sessions: unknown[];
    };
    expect(defaulted.sessions).toHaveLength(DEFAULT_SESSION_LIMIT);

    const clamped = (await (await fetch(`${base}/sessions?limit=99999`)).json()) as {
      sessions: unknown[];
    };
    expect(clamped.sessions).toHaveLength(MAX_SESSION_LIMIT);
  });

  it("answers 400 for malformed pagination params", async () => {
    const server = new ZcodeAcpServer();
    server.backend = listBackend([]);
    const base = await bootList(server);

    expect((await fetch(`${base}/sessions?limit=0`)).status).toBe(400);
    expect((await fetch(`${base}/sessions?limit=00`)).status).toBe(400);
    expect((await fetch(`${base}/sessions?limit=abc`)).status).toBe(400);
    expect((await fetch(`${base}/sessions?before=yesterday`)).status).toBe(400);
    expect((await fetch(`${base}/sessions?limit=-3`)).status).toBe(400);
    expect((await fetch(`${base}/sessions?beforeId=bad%20id`)).status).toBe(400);
  });

  it("excludes a conversation with an in-flight turn", async () => {
    const server = new ZcodeAcpServer();
    server.backend = listBackend([{ sessionId: "sess_live", title: "busy", updatedAt: 900 }]);
    server.registerSession("s-live", "sess_live");
    server.markSessionActive("s-live");
    server.pendingTurns.set(7, { zcodeSid: "sess_live", cancelled: false });

    const res = await fetch(`${await bootList(server)}/sessions`);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
  });

  it("excludes a backend-id-only attachment (pass-through resume)", async () => {
    const server = new ZcodeAcpServer();
    server.backend = listBackend([{ sessionId: "sess_direct", title: "remote", updatedAt: 900 }]);
    server.registerSession("sess_direct", "sess_direct");
    server.markSessionActive("sess_direct");

    const res = await fetch(`${await bootList(server)}/sessions`);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
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

  it("answers 405 for non-GET and 502 when the backend list fails", async () => {
    const server = new ZcodeAcpServer();
    server.backend = listBackend([], () => ({ error: { message: "backend down" } }));
    const base = await bootList(server);

    expect((await fetch(`${base}/sessions`, { method: "POST" })).status).toBe(405);
    const res = await fetch(`${base}/sessions`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("backend down");
  });
});
