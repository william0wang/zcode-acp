/**
 * Session close endpoint (ADR-0006): the bridge-side POST
 * /sessions/{id}/close handler through a real loopback HTTP server with an
 * in-memory ZcodeAcpServer. Proves the running guard, discovery retirement,
 * and the self-healing re-appearance when the editor touches a closed
 * session again.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it} from "vitest";

import {
  createSessionCloseHandler,
  serveTerminateDecision,
  setForceSettleMsForTests
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
});
