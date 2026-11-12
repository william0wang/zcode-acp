/**
 * Session status endpoint (ADR-0005): the bridge-side /status handler,
 * exercised through a real loopback HTTP server backed by an in-memory
 * ZcodeAcpServer. Proves the running/idle derivation from pendingTurns and
 * foreignActiveTurns and the membership gates (hasActivity, resolvable sid),
 * plus the handler's method handling.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createStatusHandler } from "../src/remote/status-endpoint.js";
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

/** Boot the status handler on an ephemeral port; returns its base URL. */
async function bootStatus(server: ZcodeAcpServer): Promise<string> {
  const handler = createStatusHandler(server);
  const httpServer: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  trackStop(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
  const addr = httpServer.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

/** Seed one live session; returns both ids so tests can drive pendingTurns. */
function seedSession(
  server: ZcodeAcpServer,
  opts: { title?: string; updatedAt?: number } = {},
): { acpSid: string; zcodeSid: string } {
  const acpSid = randomUUID();
  const zcodeSid = `zc-${randomUUID().slice(0, 8)}`;
  server.registerSession(acpSid, zcodeSid);
  server.markSessionActive(acpSid);
  if (opts.title !== undefined) server.touchSessionSummary(acpSid, opts.title);
  if (opts.updatedAt !== undefined) {
    const summary = server.sessionSummaries.get(acpSid)!;
    server.sessionSummaries.set(acpSid, { ...summary, updatedAt: opts.updatedAt });
  }
  return { acpSid, zcodeSid };
}

interface StatusBody {
  sessions: Array<{ sessionId: string; title?: string; status: string; updatedAt: number }>;
}

async function getStatus(base: string): Promise<StatusBody> {
  const res = await fetch(base + "/status");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("application/json");
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return (await res.json()) as StatusBody;
}

describe("status endpoint derivation", () => {
  it("reports idle for a live session with no in-flight turn", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid } = seedSession(server, { title: "hello" });
    const base = await bootStatus(server);

    const body = await getStatus(base);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ sessionId: acpSid, title: "hello", status: "idle" });
  });

  it("reports running while a turn is pending for the session", async () => {
    const server = new ZcodeAcpServer();
    const { zcodeSid } = seedSession(server);
    server.pendingTurns.set(42, { zcodeSid, cancelled: false });
    const base = await bootStatus(server);

    expect((await getStatus(base)).sessions[0]!.status).toBe("running");
  });

  it("counts a cancelled-but-finalising turn as running (turnActive parity)", async () => {
    const server = new ZcodeAcpServer();
    const { zcodeSid } = seedSession(server);
    server.pendingTurns.set(42, { zcodeSid, cancelled: true, stopSent: true });
    const base = await bootStatus(server);

    expect((await getStatus(base)).sessions[0]!.status).toBe("running");
  });

  it("reports running for a FOREIGN backend turn (no bridge turn loop)", async () => {
    // Upstream taskActivityTracker parity: a background-subagent wake turn
    // runs with no pendingTurns entry — /status must still say running.
    const server = new ZcodeAcpServer();
    const { zcodeSid, acpSid } = seedSession(server, { title: "wake" });
    server.foreignActiveTurns.set(zcodeSid, "turn_wake");
    const base = await bootStatus(server);

    const body = await getStatus(base);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ sessionId: acpSid, status: "running" });
  });

  it("hides sessions without activity or without a backend mapping", async () => {
    const server = new ZcodeAcpServer();
    seedSession(server, { title: "live" });
    // Registered but never used: hasActivity stays false.
    const unused = randomUUID();
    server.registerSession(unused, "zc-unused");
    // Active summary with no acp→zcode mapping (pure placeholder).
    const placeholder = randomUUID();
    server.sessionSummaries.set(placeholder, { title: "ghost", updatedAt: 1, hasActivity: true });
    const base = await bootStatus(server);

    const body = await getStatus(base);
    expect(body.sessions.map((s) => s.title)).toEqual(["live"]);
  });

  it("lists newest-updated sessions first and omits an unset title", async () => {
    const server = new ZcodeAcpServer();
    seedSession(server, { title: "older", updatedAt: 1000 });
    seedSession(server, { updatedAt: 2000 }); // no title
    const base = await bootStatus(server);

    const body = await getStatus(base);
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]!.updatedAt).toBeGreaterThanOrEqual(body.sessions[1]!.updatedAt);
    expect(body.sessions.find((s) => s.updatedAt === 2000)).not.toHaveProperty("title");
  });

  it("answers an empty list when nothing is live", async () => {
    const base = await bootStatus(new ZcodeAcpServer());
    expect(await getStatus(base)).toEqual({ sessions: [] });
  });

  it("advertises REMOTE-created pure placeholders, then de-duplicates once materialized", async () => {
    const server = new ZcodeAcpServer();
    seedSession(server, { title: "live" });
    // A phone-created session: pure placeholder, no backend session yet.
    const remote = randomUUID();
    server.remoteCreatedSessions.add(remote);
    server.sessionSummaries.set(remote, { updatedAt: Date.now() });
    const base = await bootStatus(server);

    const body = await getStatus(base);
    expect(body.sessions.map((s) => s.sessionId)).toContain(remote);

    // First turn materializes it: the normal path takes over under the
    // zcodeSid key and the placeholder row must not duplicate it.
    server.registerSession(remote, "zc-remote");
    server.markSessionActive(remote);
    const after = await getStatus(base);
    expect(after.sessions.filter((s) => s.sessionId === remote)).toHaveLength(1);
  });

  it("keeps advertising a remote session after incidental MATERIALIZATION (attach-load, no prompt)", async () => {
    const server = new ZcodeAcpServer();
    const remote = randomUUID();
    server.remoteCreatedSessions.add(remote);
    server.sessionSummaries.set(remote, { updatedAt: Date.now() });
    // A phone attach-load materializes the empty backend session
    // (registerSession / touchSessionSummary) without ever prompting —
    // hasActivity stays false and the row must NOT vanish between the
    // placeholder and main loops.
    server.registerSession(remote, "zc-empty");
    const base = await bootStatus(server);

    const body = await getStatus(base);
    expect(body.sessions.filter((s) => s.sessionId === remote)).toHaveLength(1);
  });

  it("keeps a LOCAL never-used placeholder invisible", async () => {
    const server = new ZcodeAcpServer();
    const local = randomUUID();
    server.sessionSummaries.set(local, { updatedAt: Date.now() });
    const base = await bootStatus(server);

    expect(await getStatus(base)).toEqual({ sessions: [] });
  });
});

describe("status endpoint HTTP handling", () => {
  it("serves HEAD with headers but no body", async () => {
    const server = new ZcodeAcpServer();
    seedSession(server, { title: "x" });
    const base = await bootStatus(server);

    const res = await fetch(base + "/status", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.text()).toBe("");
  });

  it("rejects non-GET methods with 405", async () => {
    const base = await bootStatus(new ZcodeAcpServer());

    const res = await fetch(base + "/status", { method: "POST" });
    expect(res.status).toBe(405);
  });
});
