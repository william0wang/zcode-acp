/**
 * Remote endpoint integration: the bridge's loopback ACP endpoint (real
 * AgentApp + SDK AcpServer transport) joined with a real hub — registration,
 * discovery, and an end-to-end initialize handshake proxied through the hub.
 * The WS connection must also appear in the broadcast registry while open.
 */

import * as acp from "@agentclientprotocol/sdk";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RemoteConfig } from "../src/remote/config.js";
import { trackConnections } from "../src/remote/broadcast.js";
import type { ZcodeBackend } from "../src/backend/client.js";
import { collectSessions, startRemoteEndpoint } from "../src/remote/endpoint.js";
import { startHub } from "../src/remote/hub-server.js";
import { ZcodeAcpServer } from "../src/server.js";
import { AGENT_INFO } from "../src/utils.js";

// Intercept hub spawns (spawnHub has no injection point) so the 401 self-heal
// test can count attempts and inspect the injected env. The fake child needs
// just enough shape for spawnHub: unref(), pid, stderr?, once("error").
const childProcessSpawn = vi.hoisted(() =>
  vi.fn(() => {
    const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
    child.unref = () => undefined;
    child.pid = -1;
    child.stderr = null;
    return child;
  }),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: childProcessSpawn,
}));

// Hub + WS-proxy chains under full-suite parallel load can outrun vitest's 5s
// default — and the proxied-WS tests hold inner 5s withTimeout waits that can
// never win against an equal outer budget. 15s file-wide (the respawn test
// already used 15s explicitly).
vi.setConfig({ testTimeout: 15_000 });

const TOKEN = "test-endpoint-token";

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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

function testConfig(hubPort: number, bridgePort: number): RemoteConfig {
  return { token: TOKEN, hubPort, hubHost: "127.0.0.1", bridgePort };
}

/**
 * Minimal stand-in hub: records parsed /api/register bodies and replies with a
 * fixed JSON document. Used where the assertion is about the bridge's request
 * behaviour rather than a real hub's response logic.
 */
function startMockHub(
  bodies: Array<Record<string, unknown>>,
  reply: Record<string, unknown>,
): { port: number; ready: Promise<void>; server: Server } {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/api/register") {
        try {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          /* unreadable body — ignore */
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  const handle = { port: 0, ready: Promise.resolve(), server };
  // The port is only known once listen() completes — capture it in the
  // callback, not from an eagerly-read address().
  handle.ready = new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      handle.port = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
  return handle;
}

function stopMockHub(mock: { server: Server }): Promise<void> {
  return new Promise((resolve) => {
    mock.server.closeAllConnections?.();
    mock.server.close(() => resolve());
  });
}

/**
 * startMockHub variant with scripted /api/register status codes: call i gets
 * statuses[i]; once the script runs out, the last status repeats. Used to
 * replay token rotation (401s followed by a hub that accepts the token).
 */
function startScriptedMockHub(
  bodies: Array<Record<string, unknown>>,
  statuses: number[],
): { port: number; ready: Promise<void>; server: Server } {
  let calls = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/api/register") {
        try {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          /* unreadable body — ignore */
        }
        const status = statuses[Math.min(calls, statuses.length - 1)] ?? 200;
        calls++;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: status < 400 }));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
  });
  const handle = { port: 0, ready: Promise.resolve(), server };
  handle.ready = new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      handle.port = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
  return handle;
}

describe("remote endpoint", () => {
  it("registers with the hub and serves initialize over a proxied WS", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", token: TOKEN });
    trackStop(() => hub.close());

    const server = new ZcodeAcpServer();
    // Same wiring as index.ts: initialize is the only handler needed here (it
    // never touches the backend, so no zcode subprocess is spawned), and
    // connection tracking feeds the broadcast registry.
    const app = acp
      .agent({ name: AGENT_INFO.name })
      .onRequest("initialize", (ctx) => server.initialize(ctx.params));
    trackConnections(app, server.clients);

    const endpoint = await startRemoteEndpoint(server, app, testConfig(hub.port, 18500));
    expect(endpoint).not.toBeNull();
    trackStop(() => endpoint!.stop());

    // Registration is fired immediately; give the POST a beat to land.
    await new Promise((r) => setTimeout(r, 250));
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const list = (await res.json()) as Array<{ id: string; port: number }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.port).toBe(endpoint!.port);

    // End-to-end: WS client → hub proxy → loopback endpoint → initialize.
    const ws = new WebSocket(
      `ws://127.0.0.1:${hub.port}/acp?instance=${list[0]!.id}&token=${TOKEN}`,
    );
    trackStop(
      () =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          ws.close();
          ws.once("close", () => resolve());
        }),
    );
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", (e) => reject(e));
      }),
      5000,
      "ws open",
    );

    // The SDK promotes a WS connection to an app connection only after the
    // initialize handshake, so send it through the proxied pipe first.
    const reply = withTimeout(
      new Promise<string>((resolve) => ws.once("message", (d) => resolve(d.toString()))),
      5000,
      "initialize response",
    );
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} },
      }),
    );
    const response = JSON.parse(await reply) as {
      result?: { agentInfo?: { name?: string } };
      error?: { message?: string };
    };
    expect(response.error).toBeUndefined();
    expect(response.result?.agentInfo?.name).toBe(AGENT_INFO.name);

    // Once initialized, the WS connection is a full ACP client and joins the
    // broadcast registry (same path the stdio editor takes).
    expect(server.clients.size).toBe(1);

    ws.close();
    await withTimeout(
      new Promise<void>((resolve) => ws.once("close", () => resolve())),
      5000,
      "ws close",
    );
    // Closed connections leave the registry (give the close event a beat to
    // propagate through the hub proxy).
    await new Promise((r) => setTimeout(r, 200));
    expect(server.clients.size).toBe(0);
  });

  it("scans to the next free port when the configured one is taken", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", token: TOKEN });
    trackStop(() => hub.close());

    const server1 = new ZcodeAcpServer();
    const app1 = acp
      .agent({ name: "t1" })
      .onRequest("initialize", (ctx) => server1.initialize(ctx.params));
    const first = await startRemoteEndpoint(server1, app1, testConfig(hub.port, 18600));
    expect(first).not.toBeNull();
    trackStop(() => first!.stop());

    const server2 = new ZcodeAcpServer();
    const app2 = acp
      .agent({ name: "t2" })
      .onRequest("initialize", (ctx) => server2.initialize(ctx.params));
    const second = await startRemoteEndpoint(server2, app2, testConfig(hub.port, 18600));
    expect(second).not.toBeNull();
    trackStop(() => second!.stop());

    expect(second!.port).toBe(first!.port + 1);
  });
});

describe("hub version handshake (bridge side)", () => {
  it("sends its version in the register payload", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const mock = startMockHub(bodies, { ok: true });
    trackStop(() => stopMockHub(mock));
    await mock.ready;

    const server = new ZcodeAcpServer();
    const app = acp
      .agent({ name: AGENT_INFO.name })
      .onRequest("initialize", (ctx) => server.initialize(ctx.params));
    trackConnections(app, server.clients);
    const endpoint = await startRemoteEndpoint(server, app, testConfig(mock.port, 18510));
    trackStop(() => endpoint!.stop());
    await new Promise((r) => setTimeout(r, 300));

    expect(bodies.length).toBeGreaterThanOrEqual(1);
    expect(bodies[0]!.version).toBe(AGENT_INFO.version);
  });

  it("re-registers after a hub answers restarting (upgrade respawn)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const mock = startMockHub(bodies, { ok: true, restarting: true });
    trackStop(() => stopMockHub(mock));
    await mock.ready;

    const server = new ZcodeAcpServer();
    const app = acp
      .agent({ name: AGENT_INFO.name })
      .onRequest("initialize", (ctx) => server.initialize(ctx.params));
    trackConnections(app, server.clients);
    const endpoint = await startRemoteEndpoint(server, app, testConfig(mock.port, 18511));
    trackStop(() => endpoint!.stop());

    // First register lands immediately; the respawn-retry arrives ~3.5s later
    // (2s respawn delay + 1.5s re-register). The spawned hub cannot bind the
    // mock's port (EADDRINUSE → exit 0 by design), so the mock stays authoritative.
    await withTimeout(
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (bodies.length >= 2) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      }),
      8000,
      "second register after restarting reply",
    );
    expect(bodies.length).toBeGreaterThanOrEqual(2);
  }, 15000);
});

describe("hub 401 self-heal (token rotation)", () => {
  it("keeps heartbeating after 401s, spawns one hub with its own token, and recovers", async () => {
    childProcessSpawn.mockClear();
    const bodies: Array<Record<string, unknown>> = [];
    // Rotation replay: two 401s, then the hub accepts. The bridge must stay
    // registration-eligible (no permanent poison) and heal on its own.
    const mock = startScriptedMockHub(bodies, [401, 401, 200]);
    trackStop(() => stopMockHub(mock));
    await mock.ready;

    const server = new ZcodeAcpServer();
    const app = acp
      .agent({ name: AGENT_INFO.name })
      .onRequest("initialize", (ctx) => server.initialize(ctx.params));
    trackConnections(app, server.clients);
    const endpoint = await startRemoteEndpoint(server, app, testConfig(mock.port, 18512));
    expect(endpoint).not.toBeNull();
    trackStop(() => endpoint!.stop());

    // Timeline: register@0ms → 401 (warn + throttled hub spawn + retry@1.5s)
    // → 401 (spawn throttled: no second spawn, no retry) → heartbeat@10s →
    // 200, recovered. Only the 10s heartbeat can deliver body #3 — proof the
    // loop survived two rejections.
    await withTimeout(
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (bodies.length >= 3) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      }),
      13_000,
      "third register (heartbeat after repeated 401s)",
    );
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    // Exactly one hub spawn across both 401s (SPAWN_THROTTLE_MS holds) ...
    expect(childProcessSpawn).toHaveBeenCalledTimes(1);
    // ... and it carries THIS bridge's token, so the replacement hub — once
    // it wins the port — accepts this bridge's registrations.
    const opts = childProcessSpawn.mock.calls[0]![2] as { env: Record<string, string | undefined> };
    expect(opts.env.ZCODE_ACP_REMOTE_TOKEN).toBe(TOKEN);
    expect(opts.env.ZCODE_ACP_HUB_PORT).toBe(String(mock.port));
  }, 15_000);
});

describe("running-scoped discovery payload (collectSessions)", () => {
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

  it("lists only live sessions; retired store entries never join (same-title junk)", async () => {
    const server = new ZcodeAcpServer();
    server.sessionCwds.set("s-live", "/proj");
    server.backend = listBackend([
      { sessionId: "sess_live", title: "Store title", updatedAt: 900 },
      { sessionId: "sess_junk1", title: "Same title", updatedAt: 800 },
      { sessionId: "sess_junk2", title: "Same title", updatedAt: 700 },
      { sessionId: "sess_subagent_x", title: "sub", updatedAt: 600 },
    ]);
    server.registerSession("s-live", "sess_live");
    server.markSessionActive("s-live"); // summary updatedAt ≈ Date.now() > 900

    const out = await collectSessions(server);
    // Advertised id is the editor-facing acpSid, not the backend sess_* id —
    // a remote attach under it shares the editor tab's notification stream.
    expect(out.map((s) => s.sessionId)).toEqual(["s-live"]);
    // Enrichment: the store's title wins, updatedAt is the max of both.
    expect(out[0]).toMatchObject({ title: "Store title" });
    expect(out[0]!.updatedAt).toBeGreaterThan(900);
  });

  it("keeps the live summary's own values when the store lacks the session", async () => {
    const server = new ZcodeAcpServer();
    server.backend = listBackend([{ sessionId: "sess_other", title: "other", updatedAt: 999 }]);
    server.registerSession("s-tab", "sess_mine");
    server.markSessionActive("s-tab");
    server.touchSessionSummary("s-tab", "Bridge title");

    const out = await collectSessions(server);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sessionId: "s-tab", title: "Bridge title" });
  });

  it("a store updatedAt newer than the summary (another bridge drove it) is kept", async () => {
    const server = new ZcodeAcpServer();
    server.backend = listBackend([{ sessionId: "sess_x", title: "X", updatedAt: 5000 }]);
    server.registerSession("s-tab", "sess_x");
    server.markSessionActive("s-tab");
    server.sessionSummaries.get("s-tab")!.updatedAt = 100;

    expect((await collectSessions(server))[0]).toMatchObject({
      sessionId: "s-tab",
      updatedAt: 5000,
    });
  });

  it("excludes never-used sessions and pure placeholders (no backend session)", async () => {
    const server = new ZcodeAcpServer();
    // An editor restart auto-resumes its stored placeholder: the bridge
    // materializes an empty backend session and registers it — no turn ever ran.
    server.registerSession("s-artifact", "zc1");
    server.registerSession("s-live", "zc2");
    server.markSessionActive("s-live");
    // Placeholder summary with activity but no registered backend session.
    server.markSessionActive("s-pending");

    expect((await collectSessions(server)).map((s) => s.sessionId)).toEqual(["s-live"]);
  });

  it("degrades to summaries-only when session/list fails", async () => {
    const server = new ZcodeAcpServer();
    server.backend = listBackend([], () => ({ error: { message: "backend down" } }));
    server.registerSession("s-live", "zc2");
    server.markSessionActive("s-live");

    expect((await collectSessions(server)).map((s) => s.sessionId)).toEqual(["s-live"]);
  });

  it("a session known only under its backend id is advertised under that id", async () => {
    const server = new ZcodeAcpServer();
    // No editor placeholder for this conversation: the bridge itself holds it
    // under the backend id (remote-attached via pass-through resume).
    server.registerSession("sess_direct", "sess_direct");
    server.markSessionActive("sess_direct");

    expect((await collectSessions(server)).map((s) => s.sessionId)).toEqual(["sess_direct"]);
  });

  it("an omitted title/hasActivity never leaks onto the wire", async () => {
    const server = new ZcodeAcpServer();
    server.registerSession("s", "zc");
    server.markSessionActive("s");

    const [entry] = await collectSessions(server);
    expect(Object.keys(entry!).sort()).toEqual(["sessionId", "status", "updatedAt"]);
    expect(entry!.status).toBe("idle"); // no pending turn
  });
});

describe("hub cross-instance session dedupe", () => {
  async function register(hubPort: number, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${hubPort}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, ...body }),
    });
    expect(res.ok).toBe(true);
  }

  interface InstanceList {
    id: string;
    startedAt: number;
    sessions: Array<{ sessionId: string; updatedAt: number }>;
  }

  async function instances(hubPort: number): Promise<InstanceList[]> {
    const res = await fetch(`http://127.0.0.1:${hubPort}/api/instances`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    return (await res.json()) as InstanceList[];
  }

  it("keeps one copy of a session: freshest updatedAt, then newest instance", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", token: TOKEN });
    trackStop(() => hub.close());

    await register(hub.port, {
      id: "old",
      port: 18001,
      pid: 1,
      startedAt: 1000,
      workspace: "/proj",
      sessions: [
        { sessionId: "sess_x", updatedAt: 500 }, // stale copy of x
        { sessionId: "sess_only_old", updatedAt: 900 },
      ],
    });
    await register(hub.port, {
      id: "new",
      port: 18002,
      pid: 2,
      startedAt: 2000,
      workspace: "/proj",
      sessions: [
        { sessionId: "sess_x", updatedAt: 800 }, // driving x → wins by updatedAt
        { sessionId: "sess_tie", updatedAt: 700 },
      ],
    });
    await register(hub.port, {
      id: "newest",
      port: 18003,
      pid: 3,
      startedAt: 3000,
      workspace: "/proj",
      sessions: [{ sessionId: "sess_tie", updatedAt: 700 }], // tie → newest startedAt wins
    });

    const list = await instances(hub.port);
    const byId = new Map(list.map((i) => [i.id, i.sessions.map((s) => s.sessionId)]));
    expect(byId.get("old")).toEqual(["sess_only_old"]); // lost sess_x
    expect(byId.get("new")).toEqual(["sess_x"]); // won sess_x, lost sess_tie
    expect(byId.get("newest")).toEqual(["sess_tie"]); // won the tie
  });
});
