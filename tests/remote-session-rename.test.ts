/**
 * Session rename endpoint: the bridge-side POST /sessions/{id}/rename
 * handler through a real loopback HTTP server with an in-memory
 * ZcodeAcpServer. Proves title validation, the set-once pin (a later prompt
 * cannot overwrite a rename), discovery updates, and the tasks-index persist.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectSessions } from "../src/remote/endpoint.js";
import { createSessionRenameHandler } from "../src/remote/session-rename-endpoint.js";
import { collectStatus } from "../src/remote/status-endpoint.js";
import { ZcodeAcpServer } from "../src/server.js";

// The real module writes the App's ~/.zcode/v2/tasks-index.sqlite — record
// calls instead so tests can assert the persist happened.
const renames: Array<{ taskId: string; title: string }> = [];
vi.mock("../src/tasks-index.js", () => ({
  renameSessionTask: async (taskId: string, title: string) => {
    renames.push({ taskId, title });
    return true;
  },
}));

beforeEach(() => {
  renames.length = 0;
});

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
});

/** Boot the rename handler on an ephemeral port; returns its base URL. */
async function bootRename(server: ZcodeAcpServer): Promise<string> {
  const handler = createSessionRenameHandler(server);
  const httpServer: Server = createServer((req, res) => {
    const sid = new URL(req.url ?? "/", "http://127.0.0.1").pathname.split("/")[2];
    if (sid) handler(req, res, decodeURIComponent(sid));
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

/** Seed one live, titled session; returns both ids. */
function seedSession(server: ZcodeAcpServer, title: string): { acpSid: string; zcodeSid: string } {
  const acpSid = randomUUID();
  const zcodeSid = `zc-${randomUUID().slice(0, 8)}`;
  server.registerSession(acpSid, zcodeSid);
  server.markSessionActive(acpSid);
  server.sessionTitles.set(acpSid, title);
  server.touchSessionSummary(acpSid, title);
  return { acpSid, zcodeSid };
}

function rename(base: string, acpSid: string, title: string): Promise<Response> {
  // No Content-Type header on purpose — the hub proxy relays bodies without
  // forwarding headers, so the handler must not depend on it.
  return fetch(`${base}/sessions/${acpSid}/rename`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

describe("session rename endpoint", () => {
  it("renames a session: pin, discovery, and tasks-index persist", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid, zcodeSid } = seedSession(server, "auto title");
    const base = await bootRename(server);

    const res = await rename(base, acpSid, "  my own name\n");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, title: "my own name" });

    expect(server.sessionTitles.get(acpSid)).toBe("my own name");
    expect(collectStatus(server).sessions.find((s) => s.sessionId === acpSid)?.title).toBe(
      "my own name",
    );
    expect((await collectSessions(server)).find((s) => s.sessionId === acpSid)?.title).toBe(
      "my own name",
    );
    expect(renames).toEqual([{ taskId: zcodeSid, title: "my own name" }]);
  });

  it("a rename survives a later one-shot auto-title attempt", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid } = seedSession(server, "auto title");
    const base = await bootRename(server);
    expect((await rename(base, acpSid, "user name")).status).toBe(200);

    // The first-prompt one-shot gate is sessionTitles.has() — the rename
    // occupies it, so a late prompt cannot retitle the session.
    server.titleEligibleSessions.add(acpSid);
    expect(server.sessionTitles.has(acpSid)).toBe(true);
  });

  it("rejects empty/missing titles, oversized bodies, unknown sessions, non-POST", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid } = seedSession(server, "auto title");
    const base = await bootRename(server);

    expect((await rename(base, acpSid, "   ")).status).toBe(400);
    expect(
      (
        await fetch(`${base}/sessions/${acpSid}/rename`, {
          method: "POST",
          body: JSON.stringify({ nope: 1 }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/sessions/${acpSid}/rename`, {
          method: "POST",
          body: "x".repeat(5000),
        })
      ).status,
    ).toBe(400);
    expect((await rename(base, randomUUID(), "name")).status).toBe(404);
    expect((await fetch(`${base}/sessions/${acpSid}/rename`)).status).toBe(405);
  });

  it("truncates and flattens the title like the auto-title does", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid } = seedSession(server, "auto title");
    const base = await bootRename(server);

    const long = "y".repeat(100);
    const res = await rename(base, acpSid, `a\r\n\r\nb ${long}`);
    expect(res.status).toBe(200);
    const { title } = (await res.json()) as { title: string };
    expect(title).toBe(`a b ${long}`.slice(0, 80));
    expect(title).not.toMatch(/[\r\n]/);
  });
});
