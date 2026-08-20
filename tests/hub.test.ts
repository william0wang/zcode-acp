/**
 * Hub integration tests — real hub on an ephemeral port: auth, discovery,
 * register/unregister lifecycle, heartbeat pruning, WS byte proxying, and the
 * idle-exit policy.
 */

import { createServer, type Server } from "node:http";
import net from "node:net";

import { WebSocket, WebSocketServer } from "ws";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The quota endpoint must not touch the real usage APIs in tests.
const { accountUsageStatsMock } = vi.hoisted(() => ({
  accountUsageStatsMock: vi.fn(),
}));
vi.mock("../src/handlers/account.js", () => ({
  accountUsageStats: accountUsageStatsMock,
}));

import { resetQuotaCacheForTest, startHub, type HubHandle } from "../src/remote/hub-server.js";

const TOKEN = "test-hub-token";
const BASE_PORT = 18400; // bridge ports start here; ephemeral hub uses port 0

const cleanups: Array<() => Promise<void> | void> = [];

function track<T>(value: T, stop: (v: T) => Promise<void> | void): T {
  cleanups.push(() => stop(value));
  return value;
}

async function startTestHub(
  opts: Partial<Parameters<typeof startHub>[0]> = {},
): Promise<HubHandle> {
  const hub = await startHub({ port: 0, host: "127.0.0.1", token: TOKEN, ...opts });
  cleanups.push(() => hub.close());
  return hub;
}

afterEach(async () => {
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
});

function registerBody(overrides: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    id: "inst-1",
    port: BASE_PORT,
    pid: 123,
    workspace: "/tmp/proj",
    sessions: [{ sessionId: "s1", title: "hello", updatedAt: 1 }],
    ...overrides,
  };
}

async function listInstances(hub: HubHandle, token = TOKEN): Promise<Response> {
  return fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

const QUOTA_FIXTURE = {
  glm: { kind: "success", level: "Max", items: [] },
  opencode: { kind: "not_configured" },
};

describe("hub discovery API", () => {
  it("answers health without auth", async () => {
    const hub = await startTestHub();
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("rejects /api/instances without or with a wrong token", async () => {
    const hub = await startTestHub();
    expect((await fetch(`http://127.0.0.1:${hub.port}/api/instances`)).status).toBe(401);
    expect((await listInstances(hub, "wrong")).status).toBe(401);
  });

  it("returns CORS headers and handles preflight", async () => {
    const hub = await startTestHub();
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("survives a client aborting mid-POST (no unhandled rejection)", async () => {
    const hub = await startTestHub();
    await new Promise<void>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port: hub.port }, () => {
        // Announce more body bytes than are sent, then drop the connection —
        // readJson's async iterator rejects on the aborted request body.
        sock.write(
          "POST /api/register HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
            "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n" +
            '{"token":"test-hub-token"',
        );
        sock.destroy();
        resolve();
      });
    });
    // Give the aborted request's rejection a beat to surface, then confirm the
    // hub is still serving.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/health`);
    expect(res.status).toBe(200);
  });

  it("lists registered instances with their sessions", async () => {
    const hub = await startTestHub();
    const reg = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody()),
    });
    expect(reg.status).toBe(200);

    const res = await listInstances(hub);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "inst-1",
      port: BASE_PORT,
      workspace: "/tmp/proj",
      sessions: [{ sessionId: "s1", title: "hello", updatedAt: 1 }],
    });
    expect(list[0]!["lastSeen"]).toBeUndefined();
  });

  it("rejects a register with a wrong body token or bad payload", async () => {
    const hub = await startTestHub();
    const wrongToken = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody({ token: "nope" })),
    });
    expect(wrongToken.status).toBe(401);

    const badPayload = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody({ port: 0, sessions: "x" })),
    });
    expect(badPayload.status).toBe(400);
    expect((await listInstances(hub)).status === 200).toBe(true);
  });

  it("preserves startedAt across heartbeats and removes on unregister", async () => {
    const hub = await startTestHub();
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${hub.port}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    await post(registerBody());
    await new Promise((r) => setTimeout(r, 30));
    await post(registerBody({ sessions: [] })); // heartbeat re-register

    const list1 = (await (await listInstances(hub)).json()) as Array<{
      startedAt: number;
      sessions: unknown[];
    }>;
    expect(list1).toHaveLength(1);
    const startedAt = list1[0]!.startedAt;
    expect(list1[0]!.sessions).toEqual([]);

    const unreg = await fetch(`http://127.0.0.1:${hub.port}/api/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, id: "inst-1" }),
    });
    expect(unreg.status).toBe(200);
    const list2 = (await (await listInstances(hub)).json()) as unknown[];
    expect(list2).toEqual([]);
    expect(startedAt).toBeGreaterThan(0);
  });

  it("prunes instances whose heartbeat stopped", async () => {
    const hub = await startTestHub({ heartbeatTimeoutMs: 250 });
    await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody()),
    });
    const before = (await (await listInstances(hub)).json()) as unknown[];
    expect(before).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 700)); // > TTL + prune interval
    const after = (await (await listInstances(hub)).json()) as unknown[];
    expect(after).toEqual([]);
  });
});

describe("hub on-demand probe", () => {
  /** Bare TCP listener — enough for the probe's connect check. */
  function startTcpListener(): Promise<{ server: net.Server; port: number }> {
    return new Promise((resolve) => {
      const server = net.createServer(() => {});
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
      });
    });
  }

  async function registerInstance(hub: HubHandle, body: unknown): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  }

  async function listProbed(hub: HubHandle): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances?probe=1`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    return res.json();
  }

  it("prunes dead-port instances on ?probe=1 but not on a plain list", async () => {
    const hub = await startTestHub();
    await registerInstance(hub, registerBody()); // BASE_PORT: nothing listens

    const plain = (await (await listInstances(hub)).json()) as unknown[];
    expect(plain).toHaveLength(1); // no probe param = unverified list

    const probed = (await listProbed(hub)) as unknown[];
    expect(probed).toEqual([]);

    // The prune is persistent: the plain list stays empty afterwards.
    const after = (await (await listInstances(hub)).json()) as unknown[];
    expect(after).toEqual([]);
  });

  it("keeps live instances when probing", async () => {
    const hub = await startTestHub();
    const listener = track(
      await startTcpListener(),
      ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    await registerInstance(hub, registerBody({ port: listener.port }));

    const probed = (await listProbed(hub)) as Array<Record<string, unknown>>;
    expect(probed).toHaveLength(1);
    expect(probed[0]).toMatchObject({ id: "inst-1", port: listener.port });
  });
});

describe("hub WS proxy", () => {
  function startEchoBridge(): Promise<{ server: WebSocketServer; port: number }> {
    return new Promise((resolve) => {
      const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => {
        const addr = server.address();
        resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
      });
      server.on("connection", (ws) => {
        ws.on("message", (data) => ws.send(data));
      });
    });
  }

  it("proxies bytes between a remote client and the bridge endpoint", async () => {
    const hub = await startTestHub();
    const echo = track(
      await startEchoBridge(),
      ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody({ port: echo.port })),
    });

    const client = track(
      new WebSocket(`ws://127.0.0.1:${hub.port}/acp?instance=inst-1&token=${TOKEN}`),
      (ws) =>
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
        client.once("open", () => resolve());
        client.once("error", (e) => reject(e));
      }),
      3000,
      "ws open",
    );

    const reply = withTimeout(
      new Promise<string>((resolve) => client.once("message", (d) => resolve(d.toString()))),
      3000,
      "ws echo",
    );
    client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(JSON.parse(await reply)).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
  });

  it("refuses WS upgrades with a bad token or unknown instance", async () => {
    const hub = await startTestHub();
    const cases = [
      `ws://127.0.0.1:${hub.port}/acp?instance=inst-1&token=wrong`,
      `ws://127.0.0.1:${hub.port}/acp?instance=unknown&token=${TOKEN}`,
    ];
    for (const url of cases) {
      const client = new WebSocket(url);
      const closed = new Promise<void>((resolve) => {
        client.once("error", () => resolve());
        client.once("close", () => resolve());
      });
      await withTimeout(closed, 3000, "ws reject");
      expect(client.readyState).not.toBe(WebSocket.OPEN);
    }
  });
});

describe("hub quota endpoint", () => {
  const quotaUrl = (hub: HubHandle) => `http://127.0.0.1:${hub.port}/api/quota`;

  beforeEach(() => {
    accountUsageStatsMock.mockReset();
    resetQuotaCacheForTest();
  });

  it("rejects /api/quota without or with a wrong token", async () => {
    const hub = await startTestHub();
    expect((await fetch(quotaUrl(hub))).status).toBe(401);
    expect(
      (await fetch(quotaUrl(hub), { headers: { Authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect(accountUsageStatsMock).not.toHaveBeenCalled();
  });

  it("returns the usage-stats payload verbatim", async () => {
    const hub = await startTestHub();
    accountUsageStatsMock.mockResolvedValueOnce(QUOTA_FIXTURE);
    const res = await fetch(quotaUrl(hub), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual(QUOTA_FIXTURE);
    expect(accountUsageStatsMock).toHaveBeenCalledTimes(1);
  });

  it("serves the cached copy within the TTL", async () => {
    const hub = await startTestHub();
    accountUsageStatsMock.mockResolvedValue(QUOTA_FIXTURE);
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const first = await fetch(quotaUrl(hub), { headers });
    const second = await fetch(quotaUrl(hub), { headers });
    expect(await first.json()).toEqual(QUOTA_FIXTURE);
    expect(await second.json()).toEqual(QUOTA_FIXTURE);
    expect(accountUsageStatsMock).toHaveBeenCalledTimes(1);
  });

  it("answers 502 when the quota query fails, without caching the failure", async () => {
    const hub = await startTestHub();
    accountUsageStatsMock.mockRejectedValueOnce(new Error("upstream down"));
    const res = await fetch(quotaUrl(hub), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(502);

    accountUsageStatsMock.mockResolvedValueOnce(QUOTA_FIXTURE);
    const retry = await fetch(quotaUrl(hub), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(retry.status).toBe(200);
  });

  it("falls through to 404 for non-GET methods", async () => {
    const hub = await startTestHub();
    const res = await fetch(quotaUrl(hub), {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    expect(accountUsageStatsMock).not.toHaveBeenCalled();
  });
});

describe("hub status proxy", () => {
  /** Fake bridge loopback HTTP server serving GET /status. */
  function startStatusBridge(body: string): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/status") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("not found");
        }
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
      });
    });
  }

  async function registerBridge(hub: HubHandle, port: number): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody({ port })),
    });
    expect(res.status).toBe(200);
  }

  it("byte-proxies /api/instances/{id}/status to the bridge", async () => {
    const hub = await startTestHub();
    const bridge = track(
      await startStatusBridge(
        JSON.stringify({ sessions: [{ sessionId: "s1", status: "running" }] }),
      ),
      ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    await registerBridge(hub, bridge.port);

    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual({ sessions: [{ sessionId: "s1", status: "running" }] });
  });

  it("rejects the status proxy without a token", async () => {
    const hub = await startTestHub();
    expect((await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/status`)).status).toBe(
      401,
    );
  });

  it("answers 404 for an unknown instance", async () => {
    const hub = await startTestHub();
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances/nope/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it("answers 502 when the bridge is unreachable", async () => {
    const hub = await startTestHub();
    await registerBridge(hub, BASE_PORT); // nothing listens there
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(502);
  });
});

describe("hub discovery status field", () => {
  it("passes a valid session status through and strips an invalid one", async () => {
    const hub = await startTestHub();
    const post = (sessions: unknown) =>
      fetch(`http://127.0.0.1:${hub.port}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registerBody({ sessions })),
      });

    await post([{ sessionId: "s1", title: "hello", updatedAt: 1, status: "running" }]);
    const list = () =>
      listInstances(hub).then(
        (r) => r.json() as Promise<Array<{ sessions: Array<Record<string, unknown>> }>>,
      );
    expect((await list())[0]!.sessions[0]).toMatchObject({ sessionId: "s1", status: "running" });

    await post([{ sessionId: "s1", title: "hello", updatedAt: 1, status: "bogus" }]);
    expect((await list())[0]!.sessions[0]!["status"]).toBeUndefined();
  });
});

describe("hub idle exit", () => {
  it("exits after the idle window with no instances and no proxies", async () => {
    let exited = false;
    const hub = await startTestHub({
      idleExitMs: 150,
      onIdleExit: () => {
        exited = true;
      },
    });
    await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody()),
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(exited).toBe(false); // busy: one instance registered

    await fetch(`http://127.0.0.1:${hub.port}/api/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, id: "inst-1" }),
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(exited).toBe(true);
  });
});

describe("hub version self-upgrade", () => {
  it("restarts when a newer bridge registers", async () => {
    let exited = false;
    const hub = await startTestHub({
      onIdleExit: () => {
        exited = true;
      },
    });
    const res = await withTimeout(
      fetch(`http://127.0.0.1:${hub.port}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registerBody({ version: "9999.0.0" })),
      }),
      3000,
      "register with newer version",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, restarting: true });

    // The hub exits ~500ms after replying so the response flushes first.
    await withTimeout(
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (exited) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      }),
      5000,
      "hub self-exit after newer-bridge register",
    );
    expect(exited).toBe(true);
  });

  it("does not restart for the same version or when no version is sent", async () => {
    let exited = false;
    const hub = await startTestHub({
      onIdleExit: () => {
        exited = true;
      },
    });
    const { AGENT_INFO } = await import("../src/utils.js");
    for (const version of [AGENT_INFO.version, undefined, "0.0.1"]) {
      const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registerBody(version === undefined ? {} : { version })),
      });
      expect(await res.json()).toEqual({ ok: true });
    }
    await new Promise((r) => setTimeout(r, 800));
    expect(exited).toBe(false);
    const health = await fetch(`http://127.0.0.1:${hub.port}/api/health`);
    expect(health.status).toBe(200);
  });
});
