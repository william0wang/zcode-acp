/**
 * Session close endpoint (ADR-0006): the bridge-side POST
 * /sessions/{id}/close handler through a real loopback HTTP server with an
 * in-memory ZcodeAcpServer. Proves the running guard, discovery retirement,
 * and the self-healing re-appearance when the editor touches a closed
 * session again.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSessionCloseHandler,
  serveTerminateDecision,
  tuiTeardownPids,
} from "../src/remote/session-close-endpoint.js";
import { collectStatus } from "../src/remote/status-endpoint.js";
import { collectSessions } from "../src/remote/endpoint.js";
import { ZcodeAcpServer } from "../src/server.js";

const cleanups: Array<() => Promise<void> | void> = [];

function trackStop(stop: () => Promise<void> | void): void {
  cleanups.push(stop);
}

afterEach(async () => {
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
});

/** Boot the close handler on an ephemeral port; returns its base URL. */
async function bootClose(server: ZcodeAcpServer): Promise<string> {
  const handler = createSessionCloseHandler(server);
  const httpServer: Server = createServer((req, res) => {
    const sid = new URL(req.url ?? "/", "http://127.0.0.1").pathname.split("/")[2];
    if (sid) handler(req, res, decodeURIComponent(sid));
    else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  trackStop(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
  const addr = httpServer.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

/** Seed one live session; returns both ids so tests can drive pendingTurns. */
function seedSession(
  server: ZcodeAcpServer,
  opts: { title?: string } = {},
): { acpSid: string; zcodeSid: string } {
  const acpSid = randomUUID();
  const zcodeSid = `zc-${randomUUID().slice(0, 8)}`;
  server.registerSession(acpSid, zcodeSid);
  server.markSessionActive(acpSid);
  if (opts.title !== undefined) server.touchSessionSummary(acpSid, opts.title);
  return { acpSid, zcodeSid };
}

describe("session close endpoint", () => {
  it("retires an idle session from discovery and status", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid } = seedSession(server, { title: "stale" });
    const base = await bootClose(server);
    expect(collectStatus(server).sessions.map((s) => s.sessionId)).toContain(acpSid);

    const res = await fetch(`${base}/sessions/${acpSid}/close`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(collectStatus(server).sessions.map((s) => s.sessionId)).not.toContain(acpSid);
    expect((await collectSessions(server)).map((s) => s.sessionId)).not.toContain(acpSid);
  });

  it("rejects closing a session with a running turn", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid, zcodeSid } = seedSession(server);
    server.pendingTurns.set(7, { zcodeSid, cancelled: false });
    const base = await bootClose(server);

    const res = await fetch(`${base}/sessions/${acpSid}/close`, { method: "POST" });
    expect(res.status).toBe(409);
    // Still advertised — the close was refused.
    expect(collectStatus(server).sessions.map((s) => s.sessionId)).toContain(acpSid);
  });

  it("answers 404 for an unknown session and 405 for non-POST", async () => {
    const server = new ZcodeAcpServer();
    const base = await bootClose(server);

    expect((await fetch(`${base}/sessions/${randomUUID()}/close`, { method: "POST" })).status).toBe(
      404,
    );
    expect((await fetch(`${base}/sessions/whatever/close`)).status).toBe(405);
  });

  it("evicts the backend resident runtime (session/close) and clears the liveness cache", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid, zcodeSid } = seedSession(server);
    const sent: Array<{ method: string; params: unknown }> = [];
    server.backend = {
      isDead: false,
      send: (method: string, params: unknown) => sent.push({ method, params }),
    } as unknown as typeof server.backend;
    server.markBackendLoaded(acpSid);
    const base = await bootClose(server);

    const res = await fetch(`${base}/sessions/${acpSid}/close`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(sent).toEqual([{ method: "session/close", params: { sessionId: zcodeSid } }]);
    // Stale "still loaded" trust must go, or a later resume would skip the
    // backend's session/resume RPC.
    expect(server.isBackendSessionLive(acpSid)).toBe(false);
  });

  it("closes without a live backend (no spawn, discovery still retired)", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid } = seedSession(server);
    const base = await bootClose(server);

    const res = await fetch(`${base}/sessions/${acpSid}/close`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(server.backend).toBeNull(); // close never spawned one
  });

  it("closes an empty remote-created placeholder (no summary, still advertised)", async () => {
    // Regression: the 404 guard only checked sessionSummaries, so a
    // phone-minted placeholder could never be closed — it stayed advertised
    // forever and blocked the serve-origin last-close CLI termination.
    const server = new ZcodeAcpServer();
    const acpSid = randomUUID();
    server.remoteCreatedSessions.add(acpSid);
    const base = await bootClose(server);

    expect((await fetch(`${base}/sessions/${acpSid}/close`, { method: "POST" })).status).toBe(200);
    expect(server.remoteCreatedSessions.has(acpSid)).toBe(false);
    // With nothing else advertised, a serve-origin bridge WOULD now terminate.
    expect(serveTerminateDecision(0, { ZCODE_ACP_REMOTE_ORIGIN: "serve" })).toEqual({
      terminate: true,
    });
  });

  it("a closed session reappears once the editor touches it again (self-healing)", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid, zcodeSid } = seedSession(server, { title: "still open in editor" });
    const base = await bootClose(server);

    expect((await fetch(`${base}/sessions/${acpSid}/close`, { method: "POST" })).status).toBe(200);
    expect(collectStatus(server).sessions).toHaveLength(0);

    // Editor side was actually still open: the next prompt/load re-registers
    // and marks active — the conversation returns to discovery.
    server.registerSession(acpSid, zcodeSid);
    server.markSessionActive(acpSid);
    const sessions = collectStatus(server).sessions;
    expect(sessions.map((s) => s.sessionId)).toContain(acpSid);
    expect(sessions[0]!.status).toBe("idle");
  });

  it("a mere registration (editor restart auto-resume) does NOT resurrect a closed session", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid, zcodeSid } = seedSession(server);
    const base = await bootClose(server);

    expect((await fetch(`${base}/sessions/${acpSid}/close`, { method: "POST" })).status).toBe(200);

    // Zed restart re-opens the placeholder (registerSession → summary with
    // hasActivity unset) — the session must stay hidden until real use.
    server.registerSession(acpSid, zcodeSid);
    expect(collectStatus(server).sessions).toHaveLength(0);
  });
});

describe("serve-origin termination decision (remote close ends the CLI)", () => {
  it("editor-origin bridges never terminate — retire-only semantics hold", () => {
    expect(serveTerminateDecision(0, { ZCODE_ACP_TUI_CLI_PID: "4242" })).toBeNull();
  });

  it("a TUI bridge terminates on the LAST close, targeting its process group", () => {
    expect(
      serveTerminateDecision(1, {
        ZCODE_ACP_REMOTE_ORIGIN: "serve",
        ZCODE_ACP_TUI_CLI_PID: "4242",
      }),
    ).toEqual({ terminate: false });

    expect(
      serveTerminateDecision(0, {
        ZCODE_ACP_REMOTE_ORIGIN: "serve",
        ZCODE_ACP_TUI_CLI_PID: "4242",
      }),
    ).toEqual({ terminate: true, tuiPgid: 4242 });
  });

  it("a headless serve bridge self-exits (no TUI pid) and a stale pid is ignored", () => {
    expect(serveTerminateDecision(0, { ZCODE_ACP_REMOTE_ORIGIN: "serve" })).toEqual({
      terminate: true,
    });
    expect(
      serveTerminateDecision(0, {
        ZCODE_ACP_REMOTE_ORIGIN: "serve",
        ZCODE_ACP_TUI_CLI_PID: "not-a-pid",
      }),
    ).toEqual({ terminate: true });
  });

  it("teardown targets the CLI pid and the bridge's parent, deduped", () => {
    // Ghostty's AppleScript tab and Warp's URI tab run the script WITHOUT a
    // new session: the process group never exists and the direct pids are
    // the only signal that lands (verified live 2026-09-08).
    expect(tuiTeardownPids(100, 200)).toEqual([100, 200]);
    // Same process hosting both roles (bridge spawned by the CLI itself).
    expect(tuiTeardownPids(100, 100)).toEqual([100]);
    // launchd (1) never gets signalled; malformed values drop out.
    expect(tuiTeardownPids(1, 200)).toEqual([200]);
    expect(tuiTeardownPids(100, 1)).toEqual([100]);
    expect(tuiTeardownPids(Number.NaN, 200)).toEqual([200]);
  });

  it("remote-created empty placeholders count as advertised — close keeps the CLI alive", async () => {
    const server = new ZcodeAcpServer();
    // One live TUI conversation + one phone-created empty session.
    const live = seedSession(server);
    const empty = randomUUID();
    server.remoteCreatedSessions.add(empty);
    const base = await bootClose(server);

    expect((await fetch(`${base}/sessions/${live.acpSid}/close`, { method: "POST" })).status).toBe(
      200,
    );
    // The empty placeholder still holds the CLI up.
    expect(serveTerminateDecision(1, { ZCODE_ACP_REMOTE_ORIGIN: "serve" })).toEqual({
      terminate: false,
    });
    expect(server.remoteCreatedSessions.has(empty)).toBe(true);
  });
});
