/**
 * Session delete endpoint (tombstone semantics): the bridge-side
 * POST /sessions/{id}/delete handler through a real loopback HTTP server.
 * Proves: live/running conversations are refused (409 — deleting history is
 * this route's job, stopping a live one is stop's), closed sessions get the
 * tasks-index tombstone with the serve bridge's pinned cwd as the workspace
 * attribution, and the index being unavailable degrades to 503, never a
 * silent success.
 */

import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

// Only softDeleteTask is behavior under test here — keep the rest of
// tasks-index real (its module graph is imported by the server).
const deleteMock = vi.hoisted(() => ({
  available: true,
  calls: [] as Array<{ taskId: string; workspacePath: string }>,
}));
vi.mock("../src/tasks-index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tasks-index.js")>();
  return {
    ...actual,
    softDeleteTask: async (opts: { taskId: string; workspacePath: string }) => {
      deleteMock.calls.push(opts);
      return deleteMock.available;
    },
  };
});

import { createSessionDeleteHandler } from "../src/remote/session-delete-endpoint.js";
import { ZcodeAcpServer } from "../src/server.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  deleteMock.available = true;
  deleteMock.calls = [];
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
});

/** Boot the delete handler on an ephemeral port; returns its base URL. */
async function bootDelete(server: ZcodeAcpServer): Promise<string> {
  const handler = createSessionDeleteHandler(server);
  const httpServer: Server = createServer((req, res) => {
    const match = new URL(req.url ?? "/", "http://127.0.0.1").pathname.match(
      /^\/sessions\/([^/]+)\/delete$/,
    );
    if (match) handler(req, res, match[1]!);
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

describe("session delete endpoint", () => {
  it("tombstones a closed session with the serve bridge's cwd as workspace", async () => {
    const server = new ZcodeAcpServer();
    server.sessionCwds.set("s-old", "/my/proj");

    const res = await fetch(`${await bootDelete(server)}/sessions/sess_hist1/delete`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, deleted: true });
    expect(deleteMock.calls).toEqual([{ taskId: "sess_hist1", workspacePath: "/my/proj" }]);
  });

  it("refuses a session this bridge holds live (409)", async () => {
    const server = new ZcodeAcpServer();
    server.registerSession("s-live", "sess_live_now");
    server.markSessionActive("s-live");

    const res = await fetch(`${await bootDelete(server)}/sessions/sess_live_now/delete`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/live/i);
    expect(deleteMock.calls).toEqual([]);
  });

  it("refuses a session with a turn in flight (409)", async () => {
    const server = new ZcodeAcpServer();
    server.pendingTurns.set("t1", { zcodeSid: "sess_running", cancelled: false });

    const res = await fetch(`${await bootDelete(server)}/sessions/sess_running/delete`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(deleteMock.calls).toEqual([]);
  });

  it("rejects malformed session ids (400) and non-POST methods (405)", async () => {
    const server = new ZcodeAcpServer();
    const base = await bootDelete(server);

    const bad = await fetch(`${base}/sessions/bad!!id/delete`, { method: "POST" });
    expect(bad.status).toBe(400);

    const get = await fetch(`${base}/sessions/sess_x/delete`);
    expect(get.status).toBe(405);
    expect(deleteMock.calls).toEqual([]);
  });

  it("reports 503 when the tasks index is unavailable — never a silent success", async () => {
    deleteMock.available = false;
    const server = new ZcodeAcpServer();

    const res = await fetch(`${await bootDelete(server)}/sessions/sess_gone/delete`, {
      method: "POST",
    });
    expect(res.status).toBe(503);
    // The failed call still attempted the tombstone (the index vanished
    // underneath it), but the client must see the failure.
    expect(deleteMock.calls.length).toBe(1);
  });

  it("is idempotent — deleting an unknown history id still tombstones it", async () => {
    const server = new ZcodeAcpServer();

    const res = await fetch(`${await bootDelete(server)}/sessions/sess_never_seen/delete`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(deleteMock.calls.map((c) => c.taskId)).toEqual(["sess_never_seen"]);
  });
});
