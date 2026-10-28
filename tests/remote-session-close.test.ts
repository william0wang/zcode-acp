/**
 * Session close endpoint (ADR-0006): the bridge-side POST
 * /sessions/{id}/close handler through a real loopback HTTP server with an
 * in-memory ZcodeAcpServer. Proves the running guard, discovery retirement,
 * and the self-healing re-appearance when the editor touches a closed
 * session again.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSessionCloseHandler,
  serveTerminateDecision,
  setForceSettleMsForTests,
  tuiTeardownPids,
} from "../src/remote/session-close-endpoint.js";
import { isClosedSessionId } from "../src/closed-sessions.js";
import { collectStatus } from "../src/remote/status-endpoint.js";
import { collectSessions } from "../src/remote/endpoint.js";
import { ZcodeAcpServer } from "../src/server.js";

const cleanups: Array<() => Promise<void> | void> = [];

function trackStop(stop: () => Promise<void> | void): void {
  cleanups.push(stop);
}

afterEach(async () => {
  setForceSettleMsForTests(3_000);
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
    expect(await res.json()).toEqual({ ok: true, sessionIds: [acpSid] });

    expect(collectStatus(server).sessions.map((s) => s.sessionId)).not.toContain(acpSid);
    expect((await collectSessions(server)).map((s) => s.sessionId)).not.toContain(acpSid);
  });

  it("the close answer reports every alias spelling of the conversation", async () => {
    // The hub tombstones the conversation by this set (review of the
    // close-tombstone feature): one key per spelling, so an auto reconnect
    // ladder is refused whichever id it quotes — the backend sess_ id or the
    // editor alias.
    const server = new ZcodeAcpServer();
    const { acpSid, zcodeSid } = seedSession(server, { title: "t" });
    const acpSid2 = randomUUID();
    server.registerSession(acpSid2, zcodeSid);
    const base = await bootClose(server);

    const res = await fetch(`${base}/sessions/${acpSid}/close`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sessionIds: string[] };
    expect(body.ok).toBe(true);
    expect(body.sessionIds).toEqual([acpSid, acpSid2]);
    // The retirement stamp covers every spelling too (hub tombstone parity):
    // an auto session/load may quote either id.
    expect(server.discoveryRetiredAt.has(acpSid)).toBe(true);
    expect(server.discoveryRetiredAt.has(acpSid2)).toBe(true);
    // …and the DURABLE close record covers every spelling PLUS the backend
    // id: the stamp dies with this process (serve self-exit), so the
    // respawned bridge's auto-load gate reads this record instead — without
    // it, the conversation resurrected on every hub re-incubation (observed
    // 2026-10-28).
    expect(isClosedSessionId(acpSid)).toBe(true);
    expect(isClosedSessionId(acpSid2)).toBe(true);
    expect(isClosedSessionId(zcodeSid)).toBe(true);
  });

  it("a turn that settles after the close does not re-advertise the conversation", async () => {
    // The force-close waits a bounded ~3s for in-flight turns; one that
    // outlives the bound settles AFTER the summary was deleted. Its settle
    // path (the guarded markSessionActive in runPrompt's finally) must not
    // re-advertise — the desktop's row that vanished, resurrected, then
    // lingered (2026-10-22).
    const server = new ZcodeAcpServer();
    const { acpSid } = seedSession(server, { title: "running" });
    const base = await bootClose(server);
    const res = await fetch(`${base}/sessions/${acpSid}/close`, { method: "POST" });
    expect(res.status).toBe(200);

    // The turn started BEFORE the retirement (the close interrupted it); the
    // settle path's guard reads exactly this pair.
    const turnStartedAt = Date.now() - 60_000;
    expect(server.wasDiscoveryRetiredSince(acpSid, turnStartedAt)).toBe(true);
    if (!server.wasDiscoveryRetiredSince(acpSid, turnStartedAt)) {
      server.markSessionActive(acpSid);
    }
    expect(server.sessionSummaries.has(acpSid)).toBe(false);
    expect((await collectSessions(server)).map((s) => s.sessionId)).not.toContain(acpSid);

    // A turn STARTED after the retirement is genuine new use: ADR-0006's
    // re-arm must still bring the conversation back.
    const freshTurnAt = Date.now() + 1;
    expect(server.wasDiscoveryRetiredSince(acpSid, freshTurnAt)).toBe(false);
    server.markSessionActive(acpSid);
    expect((await collectSessions(server)).map((s) => s.sessionId)).toContain(acpSid);
  });

  it("notifies attached clients ($/zcode/session_closed) per alias on a serve-origin close", async () => {
    // The martty-quit channel: an incubated window showing the closed session
    // exits cleanly on this notification instead of waiting for terminate
    // signals. Serve-origin only — and one copy per session alias, because a
    // client may hold the conversation under a different acpSid.
    process.env.ZCODE_ACP_REMOTE_ORIGIN = "serve";
    try {
      const server = new ZcodeAcpServer();
      const { acpSid, zcodeSid } = seedSession(server, { title: "remote" });
      const altSid = randomUUID();
      server.registerSession(altSid, zcodeSid);
      const received: Array<{ method: string; params: Record<string, unknown> }> = [];
      server.clients.add({
        notify: async (method: string, params: unknown) => {
          received.push({ method, params: params as Record<string, unknown> });
        },
        request: async () => {
          throw new Error("no server→client requests expected");
        },
      });
      const base = await bootClose(server);

      const res = await fetch(`${base}/sessions/${acpSid}/close`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(received).toEqual([
        { method: "$/zcode/session_closed", params: { sessionId: acpSid } },
        { method: "$/zcode/session_closed", params: { sessionId: altSid } },
      ]);
    } finally {
      delete process.env.ZCODE_ACP_REMOTE_ORIGIN;
    }
  });

  it("stays silent on close for an editor-origin bridge (no window teardown hint)", async () => {
    // A remote retire must never hint a user-launched CLI window into
    // closing itself — ADR-0006's self-heal owns that case.
    const server = new ZcodeAcpServer();
    const { acpSid } = seedSession(server, { title: "editor" });
    const received: Array<{ method: string }> = [];
    server.clients.add({
      notify: async (method: string) => {
        received.push({ method });
      },
      request: async () => {
        throw new Error("no server→client requests expected");
      },
    });
    const base = await bootClose(server);

    expect((await fetch(`${base}/sessions/${acpSid}/close`, { method: "POST" })).status).toBe(200);
    expect(received).toEqual([]);
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

  it("force close cancels the in-flight turn (stop pair) and closes anyway", async () => {
    // The explicit terminate gesture (desktop "End session"): ESC semantics
    // without a client connection, then the runtime eviction finishes any
    // generation that ignored the stop.
    const server = new ZcodeAcpServer();
    const { acpSid, zcodeSid } = seedSession(server, { title: "busy" });
    const sent: Array<{ method: string; params: unknown }> = [];
    server.backend = {
      isDead: false,
      send: (method: string, params: unknown) => sent.push({ method, params }),
    } as unknown as typeof server.backend;
    const turn = { zcodeSid, cancelled: false };
    server.pendingTurns.set(7, turn);
    // Room for the async stop pair to land inside the settle window.
    setForceSettleMsForTests(200);
    const base = await bootClose(server);

    const res = await fetch(`${base}/sessions/${acpSid}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(res.status).toBe(200);
    expect(turn.cancelled).toBe(true);
    expect(turn.stopSent).toBe(true);
    expect(sent.map((s) => s.method)).toEqual(["session/stop", "v4/command", "session/close"]);
    expect(collectStatus(server).sessions.map((s) => s.sessionId)).not.toContain(acpSid);
  });

  it("force close stops waiting once the cancelled turn settles", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid, zcodeSid } = seedSession(server, { title: "settling" });
    const sent: Array<{ method: string }> = [];
    server.backend = {
      isDead: false,
      send: (method: string) => sent.push({ method }),
    } as unknown as typeof server.backend;
    const turn = { zcodeSid, cancelled: false };
    server.pendingTurns.set(7, turn);
    setForceSettleMsForTests(5_000);
    const base = await bootClose(server);

    // The turn loop's finally drops the pendingTurns entry while the close
    // is in its settle window — the close must proceed without burning the
    // full bound.
    const resPromise = fetch(`${base}/sessions/${acpSid}/close`, {
      method: "POST",
      body: JSON.stringify({ force: true }),
    });
    await vi.waitFor(() => expect(turn.cancelled).toBe(true));
    server.pendingTurns.delete(7);
    const startedAt = Date.now();
    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(sent.map((s) => s.method)).toContain("session/close");
  });

  it("answers 400 for a malformed close body", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid } = seedSession(server);
    const base = await bootClose(server);

    const res = await fetch(`${base}/sessions/${acpSid}/close`, {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
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
    expect(isClosedSessionId(acpSid)).toBe(true);

    // Editor side was actually still open: the next prompt/load re-registers
    // and marks active — the conversation returns to discovery.
    server.registerSession(acpSid, zcodeSid);
    server.markSessionActive(acpSid);
    const sessions = collectStatus(server).sessions;
    expect(sessions.map((s) => s.sessionId)).toContain(acpSid);
    expect(sessions[0]!.status).toBe("idle");
    // …and the durable record is cleared with it: a later respawn's auto
    // ladder must not re-retire a conversation the user reopened.
    expect(isClosedSessionId(acpSid)).toBe(false);
    expect(isClosedSessionId(zcodeSid)).toBe(false);
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
