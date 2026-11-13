/**
 * Session delete endpoint (tombstone + opt-in purge semantics): the
 * bridge-side POST /sessions/{id}/delete handler through a real loopback
 * HTTP server. Proves: live/running conversations are refused (409 —
 * deleting history is this route's job, stopping a live one is stop's),
 * closed sessions get the tasks-index tombstone with the serve bridge's
 * pinned cwd as the workspace attribution, and the index being unavailable
 * degrades to 503, never a silent success. With `{"purge": true}` (and the
 * machine armed via ZCODE_ACP_DELETE_PURGE): the upstream v4 deletion face
 * runs preview→execute, a completed purge removes the tasks row, upstream
 * guards map to 409, and any degradation leaves the tombstone standing.
 */

import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

// softDeleteTask + the purge-path tasks-index helpers are behavior under
// test here — keep the rest of tasks-index real (its module graph is
// imported by the server).
const deleteMock = vi.hoisted(() => ({
  available: true,
  calls: [] as Array<{ taskId: string; workspacePath: string }>,
  workspacePath: null as string | null,
  retired: [] as string[][],
  removedRows: [] as string[][],
}));
vi.mock("../src/tasks-index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tasks-index.js")>();
  return {
    ...actual,
    softDeleteTask: async (opts: { taskId: string; workspacePath: string }) => {
      deleteMock.calls.push(opts);
      return deleteMock.available;
    },
    taskWorkspacePath: async () => deleteMock.workspacePath,
    retireTasks: async (ids: string[]) => {
      deleteMock.retired.push(ids);
      return ids.length;
    },
    deleteTaskRows: async (ids: string[]) => {
      deleteMock.removedRows.push(ids);
      return ids.length;
    },
  };
});

import { createSessionDeleteHandler } from "../src/remote/session-delete-endpoint.js";
import { ZcodeAcpServer } from "../src/server.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  deleteMock.available = true;
  deleteMock.calls = [];
  deleteMock.workspacePath = null;
  deleteMock.retired = [];
  deleteMock.removedRows = [];
  vi.unstubAllEnvs();
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

/** Fake backend scripting the v4 deletion face; records every frame. */
function deletionBackend(script: {
  preview: { revision?: string; blockedReason?: string; completed?: boolean } | { error: string };
  execute?: { status: string; reason?: string } | { error: string };
}): {
  backend: { isDead: boolean; request: unknown };
  frames: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const frames: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    frames,
    backend: {
      isDead: false,
      request: async (
        _id: number,
        method: string,
        params: Record<string, unknown>,
      ): Promise<{ result?: unknown; error?: { message: string } }> => {
        frames.push({ method, params });
        if (method === "v4/storage/sessionData/deletionPreview") {
          return "error" in script.preview
            ? { error: { message: script.preview.error } }
            : { result: script.preview };
        }
        if (method === "v4/storage/sessionData/deletionExecute") {
          if (!script.execute) throw new Error("unexpected execute call");
          return "error" in script.execute
            ? { error: { message: script.execute.error } }
            : { result: script.execute };
        }
        throw new Error(`unexpected method ${method}`);
      },
    },
  };
}

function purgeBody(): RequestInit {
  return { method: "POST", body: JSON.stringify({ purge: true }) };
}

describe("session delete endpoint — opt-in purge (v4 deletion face)", () => {
  it("refuses purge when the machine is not armed — before any tombstone write", async () => {
    const server = new ZcodeAcpServer();

    const res = await fetch(`${await bootDelete(server)}/sessions/sess_purge1/delete`, purgeBody());
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/purge disabled/);
    expect(deleteMock.calls).toEqual([]);
  });

  it("armed + happy path: tombstone first, then preview→execute, then the row goes", async () => {
    vi.stubEnv("ZCODE_ACP_DELETE_PURGE", "1");
    deleteMock.workspacePath = "/recorded/ws";
    const { backend, frames } = deletionBackend({
      preview: { revision: "rev-1" },
      execute: { status: "deleted" },
    });
    const server = new ZcodeAcpServer();
    server.backend = backend as never;

    const res = await fetch(`${await bootDelete(server)}/sessions/sess_purge2/delete`, purgeBody());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, deleted: true, purged: true });

    // Tombstone BEFORE the purge (hide first — a failed purge still hides).
    // The tombstone keeps the serve bridge's pinned cwd; the RECORDED
    // workspace feeds only the v4 face's identity check (asserted below).
    expect(deleteMock.calls).toEqual([
      { taskId: "sess_purge2", workspacePath: server.projectCwd() },
    ]);

    // The v4 face saw the recorded workspace, the echoed revision, and an
    // operationId (any string).
    expect(frames.map((f) => f.method)).toEqual([
      "v4/storage/sessionData/deletionPreview",
      "v4/storage/sessionData/deletionExecute",
    ]);
    expect(frames[0]!.params).toEqual({
      sessionId: "sess_purge2",
      workspace: { workspacePath: "/recorded/ws" },
    });
    expect(frames[1]!.params).toMatchObject({
      sessionId: "sess_purge2",
      workspace: { workspacePath: "/recorded/ws" },
      revision: "rev-1",
    });
    expect(typeof frames[1]!.params["operationId"]).toBe("string");
    expect(deleteMock.removedRows).toEqual([["sess_purge2"]]);
  });

  it("an upstream running/in-use block answers 409 while the tombstone stands", async () => {
    vi.stubEnv("ZCODE_ACP_DELETE_PURGE", "1");
    const { backend, frames } = deletionBackend({ preview: { blockedReason: "running" } });
    const server = new ZcodeAcpServer();
    server.backend = backend as never;

    const res = await fetch(`${await bootDelete(server)}/sessions/sess_busy/delete`, purgeBody());
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      deleted: true,
      purged: false,
      reason: "running",
    });
    expect(deleteMock.calls.map((c) => c.taskId)).toEqual(["sess_busy"]);
    expect(frames.map((f) => f.method)).toEqual(["v4/storage/sessionData/deletionPreview"]);
    expect(deleteMock.removedRows).toEqual([]);
  });

  it("not-found retires the tombstone instead of holding a revivable zombie", async () => {
    vi.stubEnv("ZCODE_ACP_DELETE_PURGE", "1");
    const { backend } = deletionBackend({ preview: { blockedReason: "not-found" } });
    const server = new ZcodeAcpServer();
    server.backend = backend as never;

    const res = await fetch(`${await bootDelete(server)}/sessions/sess_nf/delete`, purgeBody());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      deleted: true,
      purged: false,
      reason: "not-found",
    });
    expect(deleteMock.retired).toEqual([["sess_nf"]]);
    expect(deleteMock.removedRows).toEqual([]);
  });

  it("a preview transport failure degrades to the soft delete (200, purged:false)", async () => {
    vi.stubEnv("ZCODE_ACP_DELETE_PURGE", "1");
    const { backend } = deletionBackend({ preview: { error: "gateway went away" } });
    const server = new ZcodeAcpServer();
    server.backend = backend as never;

    const res = await fetch(`${await bootDelete(server)}/sessions/sess_flaky/delete`, purgeBody());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      deleted: true,
      purged: false,
      reason: expect.stringContaining("preview failed"),
    });
    expect(deleteMock.calls.map((c) => c.taskId)).toEqual(["sess_flaky"]);
  });

  it("an incomplete execution keeps the tombstone and reports the reason", async () => {
    vi.stubEnv("ZCODE_ACP_DELETE_PURGE", "1");
    const { backend } = deletionBackend({
      preview: { revision: "rev-2" },
      execute: { status: "incomplete", reason: "EACCES" },
    });
    const server = new ZcodeAcpServer();
    server.backend = backend as never;

    const res = await fetch(`${await bootDelete(server)}/sessions/sess_half/delete`, purgeBody());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      deleted: true,
      purged: false,
      reason: expect.stringContaining("incomplete"),
    });
    expect(deleteMock.removedRows).toEqual([]);
  });

  it("an already-completed deletion (preview completed) just removes the row", async () => {
    vi.stubEnv("ZCODE_ACP_DELETE_PURGE", "1");
    const { backend, frames } = deletionBackend({ preview: { completed: true } });
    const server = new ZcodeAcpServer();
    server.backend = backend as never;

    const res = await fetch(`${await bootDelete(server)}/sessions/sess_redo/delete`, purgeBody());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, purged: true });
    expect(frames.map((f) => f.method)).toEqual(["v4/storage/sessionData/deletionPreview"]);
    expect(deleteMock.removedRows).toEqual([["sess_redo"]]);
  });
});
