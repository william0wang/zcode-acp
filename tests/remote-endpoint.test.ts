/**
 * Remote endpoint integration: the bridge's loopback ACP endpoint (real
 * AgentApp + SDK AcpServer transport) joined with a real hub — registration,
 * discovery, and an end-to-end initialize handshake proxied through the hub.
 * The WS connection must also appear in the broadcast registry while open.
 */

import * as acp from "@agentclientprotocol/sdk";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";

import { afterEach, describe, expect, it } from "vitest";

import type { RemoteConfig } from "../src/remote/config.js";
import { trackConnections } from "../src/remote/broadcast.js";
import { startRemoteEndpoint } from "../src/remote/endpoint.js";
import { startHub } from "../src/remote/hub-server.js";
import { ZcodeAcpServer } from "../src/server.js";
import { AGENT_INFO } from "../src/utils.js";

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
