/**
 * Hub integration tests — real hub on an ephemeral port: auth, discovery,
 * register/unregister lifecycle, heartbeat pruning, WS byte proxying, and the
 * idle-exit policy.
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebSocket, WebSocketServer } from "ws";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The quota endpoint must not touch the real usage APIs in tests.
const { accountUsageStatsMock } = vi.hoisted(() => ({
  accountUsageStatsMock: vi.fn(),
}));
vi.mock("../src/handlers/account.js", () => ({
  accountUsageStats: accountUsageStatsMock,
}));

// The session-create endpoints read the known-project whitelist from
// tasks-index; mock the module so no real sqlite/App store is touched.
const { listKnownWorkspacesMock } = vi.hoisted(() => ({
  listKnownWorkspacesMock: vi.fn(),
}));
vi.mock("../src/tasks-index.js", () => ({
  listKnownWorkspaces: listKnownWorkspacesMock,
}));

import {
  resetQuotaCacheForTest,
  resolveTerminalLaunch,
  startHub,
  terminalTuiScript,
  type HubHandle,
} from "../src/remote/hub-server.js";
import { AGENT_INFO } from "../src/utils.js";

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

describe("hub session close proxy", () => {
  /** Fake bridge loopback HTTP server accepting POST /sessions/{id}/close. */
  function startCloseBridge(): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        const sid = new URL(req.url ?? "/", "http://127.0.0.1").pathname.split("/")[2];
        if (req.method === "POST" && req.url === `/sessions/${sid}/close`) {
          req.resume();
          res.writeHead(sid === "s-busy" ? 409 : 200, { "Content-Type": "application/json" });
          res.end(sid === "s-busy" ? "session is running" : '{"ok":true}');
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

  it("forwards the close POST and relays the bridge's response", async () => {
    const hub = await startTestHub();
    const bridge = track(
      await startCloseBridge(),
      ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    await registerBridge(hub, bridge.port);

    const ok = await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/sessions/s1/close`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });

    const busy = await fetch(
      `http://127.0.0.1:${hub.port}/api/instances/inst-1/sessions/s-busy/close`,
      { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(busy.status).toBe(409);
  });

  it("guards the close proxy like the read routes", async () => {
    const hub = await startTestHub();
    const close = (sid: string, token: string | null) =>
      fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/sessions/${sid}/close`, {
        method: "POST",
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });

    expect((await close("s1", null)).status).toBe(401); // no token
    expect((await close("s1", "wrong")).status).toBe(401); // bad token
    expect((await close("s1", TOKEN)).status).toBe(404); // unknown instance
    // Non-POST falls through to the catch-all 404.
    const get = await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/sessions/s1/close`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(404);
  });

  it("answers 502 when the bridge is unreachable", async () => {
    const hub = await startTestHub();
    await registerBridge(hub, BASE_PORT); // nothing listens there
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/sessions/s1/close`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(502);
  });
});

describe("hub session rename proxy", () => {
  /** Fake bridge loopback HTTP server accepting POST /sessions/{id}/rename. */
  function startRenameBridge(): Promise<{
    server: Server;
    port: number;
    seen: Array<{ sid: string; body: string }>;
  }> {
    return new Promise((resolve) => {
      const seen: Array<{ sid: string; body: string }> = [];
      const server = createServer((req, res) => {
        const sid = new URL(req.url ?? "/", "http://127.0.0.1").pathname.split("/")[2];
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          seen.push({ sid: sid ?? "", body: Buffer.concat(chunks).toString("utf8") });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true,"title":"renamed"}');
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, seen });
      });
    });
  }

  it("relays the rename POST with its JSON body to the bridge", async () => {
    const hub = await startTestHub();
    const bridge = track(
      await startRenameBridge(),
      ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody({ port: bridge.port })),
    });
    expect(res.status).toBe(200);

    const ok = await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/sessions/s1/rename`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "my name" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, title: "renamed" });
    expect(bridge.seen).toEqual([{ sid: "s1", body: '{"title":"my name"}' }]);
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

describe("hub /api/upgrade (self-decided restart)", () => {
  const upgradeUrl = (hub: HubHandle) => `http://127.0.0.1:${hub.port}/api/upgrade`;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  /**
   * Fixture on-disk code: package.json + dist/remote/hub-server.js. Written
   * BEFORE the hub starts, so its mtimes sit below the hub's startedAt —
   * exactly like a build that predates the running process.
   */
  async function writeCodeFixture(
    version: string,
  ): Promise<{ packageJson: string; distDir: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "hub-upgrade-"));
    const packageJson = path.join(root, "package.json");
    const distDir = path.join(root, "dist");
    await mkdir(path.join(distDir, "remote"), { recursive: true });
    await writeFile(packageJson, JSON.stringify({ version }));
    await writeFile(path.join(distDir, "remote", "hub-server.js"), "// code\n");
    return { packageJson, distDir };
  }

  /** Poll a flag until true or fail (the restart fires ~500ms after replying). */
  async function until(flag: () => boolean, label: string): Promise<void> {
    await withTimeout(
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (flag()) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      }),
      5000,
      label,
    );
  }

  it("rejects /api/upgrade without or with a wrong token", async () => {
    const hub = await startTestHub();
    expect((await fetch(upgradeUrl(hub), { method: "POST" })).status).toBe(401);
    expect(
      (await fetch(upgradeUrl(hub), { method: "POST", headers: { Authorization: "Bearer nope" } }))
        .status,
    ).toBe(401);
  });

  it("stays put when the on-disk code matches the running version", async () => {
    const paths = await writeCodeFixture(AGENT_INFO.version);
    let restarted = false;
    const hub = await startTestHub({
      codePaths: paths,
      onRestart: () => {
        restarted = true;
      },
    });
    const res = await fetch(upgradeUrl(hub), { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      restarting: false,
      reason: "up-to-date",
      runningVersion: AGENT_INFO.version,
      diskVersion: AGENT_INFO.version,
    });
    await new Promise((r) => setTimeout(r, 800));
    expect(restarted).toBe(false);
    expect((await fetch(`http://127.0.0.1:${hub.port}/api/health`)).status).toBe(200);
  });

  it("does not restart onto an OLDER on-disk version", async () => {
    const paths = await writeCodeFixture("0.0.1");
    let restarted = false;
    const hub = await startTestHub({
      codePaths: paths,
      onRestart: () => {
        restarted = true;
      },
    });
    const res = await fetch(upgradeUrl(hub), { method: "POST", headers: auth });
    expect(await res.json()).toMatchObject({ restarting: false, reason: "up-to-date" });
    await new Promise((r) => setTimeout(r, 800));
    expect(restarted).toBe(false);
  });

  it("restarts onto a newer on-disk version", async () => {
    const paths = await writeCodeFixture("9999.0.0");
    let restarted = false;
    const hub = await startTestHub({
      codePaths: paths,
      onRestart: () => {
        restarted = true;
      },
    });
    const res = await fetch(upgradeUrl(hub), { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      restarting: true,
      reason: "version",
      runningVersion: AGENT_INFO.version,
      diskVersion: "9999.0.0",
    });
    await until(() => restarted, "hub restart onto newer version");
  });

  it("restarts when dist was rebuilt without a version bump", async () => {
    const paths = await writeCodeFixture(AGENT_INFO.version);
    let restarted = false;
    const hub = await startTestHub({
      codePaths: paths,
      onRestart: () => {
        restarted = true;
      },
    });
    // Let startedAt settle strictly below the rewrite's mtime, then "rebuild".
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(path.join(paths.distDir, "remote", "hub-server.js"), "// rebuilt\n");
    const res = await fetch(upgradeUrl(hub), { method: "POST", headers: auth });
    expect(await res.json()).toMatchObject({ restarting: true, reason: "mtime" });
    await until(() => restarted, "hub restart onto rebuilt dist");
  });

  it("checks the real repo layout safely when nothing is injected", async () => {
    let restarted = false;
    const hub = await startTestHub({
      onRestart: () => {
        restarted = true;
      },
    });
    // Under vitest the defaults resolve to the repo root: package.json reads
    // the same version frozen into AGENT_INFO, and src/ holds no .js files —
    // so the answer must be a calm no-op, never a crash.
    const res = await fetch(upgradeUrl(hub), { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restarting: false, reason: "up-to-date" });
    await new Promise((r) => setTimeout(r, 800));
    expect(restarted).toBe(false);
  });
});

describe("hub remote session-create (ADR-0014)", () => {
  const PROJECT = "/Users/dev/Develop/demo";
  const auth = { Authorization: `Bearer ${TOKEN}` };
  /**
   * Minimal ChildProcess stand-in: the hub reads pid/exitCode/signalCode and
   * subscribes to async 'error' (ENOENT after spawn). EventEmitter supplies
   * once(); the mutable exitCode/signalCode fields flip the death checks.
   */
  let fakeChild: EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null };
  let spawnCalls: Array<{ cwd: string; env: NodeJS.ProcessEnv; kind: "tui" | "serve" }>;
  let spawnCount: number;

  beforeEach(() => {
    listKnownWorkspacesMock.mockReset();
    listKnownWorkspacesMock.mockResolvedValue([
      { workspacePath: PROJECT, sessions: 3, lastActive: 1234 },
      { workspacePath: "/Users/dev/Develop/other", sessions: 1, lastActive: 999 },
    ]);
    fakeChild = new EventEmitter() as typeof fakeChild;
    fakeChild.pid = 4242;
    fakeChild.exitCode = null;
    fakeChild.signalCode = null;
    spawnCalls = [];
    spawnCount = 0;
  });

  function spawnServeSpy() {
    return (opts: { cwd: string; env: NodeJS.ProcessEnv; kind: "tui" | "serve" }) => {
      spawnCount++;
      spawnCalls.push(opts);
      return fakeChild as unknown as import("node:child_process").ChildProcess;
    };
  }

  async function registerServeBridge(
    hub: HubHandle,
    workspace: string,
    opts: { id?: string; nonce?: string } = {},
  ): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        registerBody({
          id: opts.id ?? `serve-${workspace}`,
          workspace,
          origin: "serve",
          port: BASE_PORT + 50,
          pid: 4242,
          ...(opts.nonce ? { nonce: opts.nonce } : {}),
        }),
      ),
    });
    expect(res.ok).toBe(true);
  }

  it("GET /api/projects requires auth and returns the whitelist", async () => {
    const hub = await startTestHub();
    expect((await fetch(`http://127.0.0.1:${hub.port}/api/projects`)).status).toBe(401);
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/projects`, { headers: auth });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ workspacePath: string }>;
    expect(list.map((p) => p.workspacePath)).toEqual([PROJECT, "/Users/dev/Develop/other"]);
  });

  it("POST /api/instances rejects unauthorized / missing / unknown projects", async () => {
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const url = `http://127.0.0.1:${hub.port}/api/instances`;
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: auth, body: "{}" })).status).toBe(400);
    const res = await fetch(url, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath: "/etc" }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("unknown project");
    expect(spawnCount).toBe(0);
  });

  it("spawns a serve bridge in the project cwd and returns its instance once registered", async () => {
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const pending = fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath: PROJECT }),
    });
    // The hub polls every 300ms — give it one tick, then let the bridge register.
    await new Promise((r) => setTimeout(r, 400));
    expect(spawnCount).toBe(1);
    expect(spawnCalls[0]!.cwd).toBe(PROJECT);
    // Session-create incubates a VISIBLE terminal TUI (ADR-0016); the stub
    // stands in for whichever surface the platform picked.
    expect(spawnCalls[0]!.kind).toBe("tui");
    expect(spawnCalls[0]!.env.ZCODE_ACP_REMOTE).toBe("1");
    expect(spawnCalls[0]!.env.ZCODE_ACP_REMOTE_TOKEN).toBe(TOKEN);
    // ADR-0016 ENV: register as the project's serve bridge + pin session
    // roots to the project cwd (ADR-0014 whitelist semantics).
    expect(spawnCalls[0]!.env.ZCODE_ACP_REMOTE_ORIGIN).toBe("serve");
    expect(spawnCalls[0]!.env.ZCODE_ACP_REMOTE_PIN_CWD).toBe("1");
    await registerServeBridge(hub, PROJECT);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: `serve-${PROJECT}`, reused: false });
  });

  it("create ALWAYS incubates a visible TUI even when a serve bridge is already live", async () => {
    // Regression (ADR-0016 amendment): the App flow lists project history
    // first, which incubates a headless serve bridge — the old reuse made
    // every subsequent create answer reused:true and run invisibly in the
    // background, so the promised terminal window could never open. The POST
    // must spawn a terminal surface and answer with ITS new instance.
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    await registerServeBridge(hub, PROJECT); // the listing's headless bridge
    const pending = fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath: PROJECT }),
    });
    await new Promise((r) => setTimeout(r, 400)); // one poll tick
    expect(spawnCount).toBe(1);
    expect(spawnCalls[0]!.kind).toBe("tui");
    // The window's bridge registers with its incubation nonce: the poll pairs
    // with it, never with the pre-existing headless listing bridge.
    await registerServeBridge(hub, PROJECT, {
      id: "serve-window",
      nonce: spawnCalls[0]!.env.ZCODE_ACP_SPAWN_NONCE,
    });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "serve-window", reused: false });
  });

  it("concurrent POSTs for the same workspace join one incubation (no double spawn)", async () => {
    // Regression: findServe() and the spawn used to race across concurrent
    // requests — both spawned a serve bridge and both answered 200.
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const url = `http://127.0.0.1:${hub.port}/api/instances`;
    const post = () =>
      fetch(url, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ workspacePath: PROJECT }),
      });
    const [a, b] = [post(), post()];
    // One poll tick in — both requests must already share the incubation.
    await new Promise((r) => setTimeout(r, 400));
    expect(spawnCount).toBe(1);
    await registerServeBridge(hub, PROJECT);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(await ra.json()).toEqual({ id: `serve-${PROJECT}`, reused: false });
    expect(await rb.json()).toEqual({ id: `serve-${PROJECT}`, reused: false });
    // Settled incubation is gone, and create never reuses: the next POST
    // incubates a second window of its own (nonce-paired, so the answer is
    // the new registration, not the bridge above).
    const next = post();
    await new Promise((r) => setTimeout(r, 400));
    expect(spawnCount).toBe(2);
    await registerServeBridge(hub, PROJECT, {
      id: "serve-window-2",
      nonce: spawnCalls[1]!.env.ZCODE_ACP_SPAWN_NONCE,
    });
    expect(await (await next).json()).toEqual({ id: "serve-window-2", reused: false });
  });

  it("dedupes across path spellings: a symlinked row matches the resolved registration", async () => {
    // Regression: raw string equality never matched a whitelist row carrying
    // a symlink spelling against the serve child's RESOLVED process cwd —
    // every create 502'd after 10s and each retry spawned a duplicate.
    const real = await mkdtemp(path.join(tmpdir(), "hub-dedupe-"));
    const link = path.join(path.dirname(real), `${path.basename(real)}-link`);
    await symlink(real, link);
    // The listing proxies the bridge's /sessions — a bare fake server stands
    // in for the loopback endpoint the reused instance would answer on.
    const sessions = track(
      await new Promise<{ server: Server; port: number }>((resolve) => {
        const server = createServer((_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sessions: [], nextCursor: null }));
        });
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
        });
      }),
      ({ server }) => new Promise<void>((r) => server.close(() => r())),
    );
    try {
      listKnownWorkspacesMock.mockResolvedValue([
        { workspacePath: link, sessions: 1, lastActive: 1 },
      ]);
      const hub = await startTestHub({ spawnServe: spawnServeSpy() });
      // The bridge registers with its resolved cwd spelling; the listing is
      // asked with the symlinked whitelist spelling.
      const reg = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          registerBody({
            id: `serve-${real}`,
            workspace: real,
            origin: "serve",
            port: sessions.port,
            pid: 4242,
          }),
        ),
      });
      expect(reg.ok).toBe(true);
      const res = await fetch(
        `http://127.0.0.1:${hub.port}/api/projects/sessions?workspacePath=${encodeURIComponent(link)}`,
        { headers: auth },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { instance: { id: string } };
      expect(body.instance).toEqual({ id: `serve-${real}`, origin: "serve" });
      expect(spawnCount).toBe(0);
    } finally {
      await rm(link, { force: true });
      await rm(real, { recursive: true, force: true });
    }
  });

  it("fails with 502 when the spawned bridge dies during startup", async () => {
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const pending = fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath: PROJECT }),
    });
    await new Promise((r) => setTimeout(r, 400));
    fakeChild.exitCode = 1; // bridge crashed before registering
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("serve bridge exited during startup");
  });

  it("labels instances with the register origin (default editor)", async () => {
    const hub = await startTestHub();
    await registerServeBridge(hub, PROJECT);
    // Legacy register (no origin field) — older bridges must read as editor.
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody({ id: "editor-1" })),
    });
    expect(res.ok).toBe(true);

    const list = (await (await listInstances(hub)).json()) as Array<{
      id: string;
      origin: string;
    }>;
    const byId = Object.fromEntries(list.map((e) => [e.id, e.origin]));
    expect(byId[`serve-${PROJECT}`]).toBe("serve");
    expect(byId["editor-1"]).toBe("editor");
  });
});

describe("hub project session history (ADR-0015)", () => {
  const PROJECT = "/Users/dev/Develop/demo";
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const STORE = [
    {
      sessionId: "sess_closed",
      title: "Old work",
      updatedAt: "2026-08-01T10:00:00.000Z",
      live: false,
      running: false,
    },
    {
      sessionId: "sess_live",
      title: "Current",
      updatedAt: "2026-09-01T10:00:00.000Z",
      live: true,
      running: false,
    },
  ];

  let fakeChild: EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null };
  let spawnCount: number;

  beforeEach(() => {
    listKnownWorkspacesMock.mockReset();
    listKnownWorkspacesMock.mockResolvedValue([
      { workspacePath: PROJECT, sessions: 3, lastActive: 1234 },
    ]);
    fakeChild = new EventEmitter() as typeof fakeChild;
    fakeChild.pid = 4242;
    fakeChild.exitCode = null;
    fakeChild.signalCode = null;
    spawnCount = 0;
  });

  /** Fake bridge loopback HTTP server serving GET /sessions (records the URL). */
  function startSessionsBridge(
    status = 200,
  ): Promise<{ port: number; seenUrl: () => string | null }> {
    return new Promise((resolve) => {
      let seen: string | null = null;
      const server = createServer((req, res) => {
        seen = req.url ?? "";
        res.writeHead(status, { "Content-Type": "application/json" });
        // Real bridge semantics: a continued page carries the next cursor,
        // an under-limit first page has none.
        const cursor = (req.url ?? "").includes("before=") ? 1234 : null;
        res.end(JSON.stringify({ sessions: STORE, nextCursor: cursor }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve({
          port: typeof addr === "object" && addr ? addr.port : 0,
          seenUrl: () => seen,
        });
      });
      track(server, (s) => new Promise<void>((r) => s.close(() => r())));
    });
  }

  async function registerServeBridge(hub: HubHandle, port: number): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        registerBody({
          id: `serve-${PROJECT}`,
          workspace: PROJECT,
          origin: "serve",
          port,
          pid: 4242,
        }),
      ),
    });
    expect(res.ok).toBe(true);
  }

  it("requires auth, a workspacePath, and a whitelisted project", async () => {
    const hub = await startTestHub();
    const url = `http://127.0.0.1:${hub.port}/api/projects/sessions`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: auth })).status).toBe(400);
    const res = await fetch(`${url}?workspacePath=${encodeURIComponent("/etc")}`, {
      headers: auth,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("unknown project");
  });

  it("proxies the live serve bridge's list and wraps it with the instance", async () => {
    const bridge = await startSessionsBridge();
    const hub = await startTestHub();
    await registerServeBridge(hub, bridge.port);

    const res = await fetch(
      `http://127.0.0.1:${hub.port}/api/projects/sessions?workspacePath=${encodeURIComponent(PROJECT)}`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspacePath: PROJECT,
      instance: { id: `serve-${PROJECT}`, origin: "serve" },
      sessions: STORE,
      nextCursor: null,
    });
    // No pagination params — the bridge gets a bare /sessions.
    expect(bridge.seenUrl()).toBe("/sessions");
  });

  it("forwards pagination params to the bridge and passes nextCursor through", async () => {
    const bridge = await startSessionsBridge();
    const hub = await startTestHub();
    await registerServeBridge(hub, bridge.port);

    const res = await fetch(
      `http://127.0.0.1:${hub.port}/api/projects/sessions?workspacePath=${encodeURIComponent(PROJECT)}&limit=5&before=1000&beforeId=sess_004`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextCursor: unknown };
    expect(bridge.seenUrl()).toBe("/sessions?limit=5&before=1000&beforeId=sess_004");
    expect(body.nextCursor).toBe(1234);
  });

  it("answers 400 for malformed pagination params without spawning", async () => {
    const bridge = await startSessionsBridge();
    const hub = await startTestHub();
    await registerServeBridge(hub, bridge.port);
    const url = `http://127.0.0.1:${hub.port}/api/projects/sessions`;

    expect(
      (
        await fetch(`${url}?workspacePath=${encodeURIComponent(PROJECT)}&limit=0`, {
          headers: auth,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}?workspacePath=${encodeURIComponent(PROJECT)}&limit=00`, {
          headers: auth,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}?workspacePath=${encodeURIComponent(PROJECT)}&before=abc`, {
          headers: auth,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${url}?workspacePath=${encodeURIComponent(PROJECT)}&beforeId=bad%20id`, {
          headers: auth,
        })
      ).status,
    ).toBe(400);
    expect(bridge.seenUrl()).toBeNull();
  });

  it("incubates a serve bridge when none is live, then reuses it", async () => {
    const bridge = await startSessionsBridge();
    let seenKind: "tui" | "serve" | null = null;
    const hub = await startTestHub({
      spawnServe: (opts: { cwd: string; env: NodeJS.ProcessEnv; kind: "tui" | "serve" }) => {
        spawnCount++;
        seenKind = opts.kind;
        // The spawned bridge registers itself moments after boot.
        void fetch(`http://127.0.0.1:${hub.port}/api/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            registerBody({
              id: `serve-${opts.cwd}`,
              workspace: opts.cwd,
              origin: "serve",
              port: bridge.port,
              pid: 4242,
            }),
          ),
        });
        return fakeChild as unknown as import("node:child_process").ChildProcess;
      },
    });
    const url = `http://127.0.0.1:${hub.port}/api/projects/sessions?workspacePath=${encodeURIComponent(PROJECT)}`;

    const res = await fetch(url, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instance: { id: string }; sessions: unknown[] };
    expect(body.instance).toEqual({ id: `serve-${PROJECT}`, origin: "serve" });
    expect(body.sessions).toEqual(STORE);
    expect(spawnCount).toBe(1);
    // A background listing must not pop a terminal window — detached serve only.
    expect(seenKind).toBe("serve");

    // A second listing joins the now-registered bridge — no second spawn.
    expect((await fetch(url, { headers: auth })).status).toBe(200);
    expect(spawnCount).toBe(1);
  });

  it("joins one incubation when two listings race (no double spawn)", async () => {
    const bridge = await startSessionsBridge();
    const hub = await startTestHub({
      spawnServe: (opts: { cwd: string; env: NodeJS.ProcessEnv; kind: "tui" | "serve" }) => {
        spawnCount++;
        // Register late enough that BOTH listings find no live instance and
        // must join the in-flight incubation instead of spawning their own.
        const timer = setTimeout(() => {
          void fetch(`http://127.0.0.1:${hub.port}/api/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              registerBody({
                id: `serve-${opts.cwd}`,
                workspace: opts.cwd,
                origin: "serve",
                port: bridge.port,
                pid: 4242,
              }),
            ),
          });
        }, 700);
        timer.unref?.();
        return fakeChild as unknown as import("node:child_process").ChildProcess;
      },
    });
    const url = `http://127.0.0.1:${hub.port}/api/projects/sessions?workspacePath=${encodeURIComponent(PROJECT)}`;

    const [a, b] = await Promise.all([
      fetch(url, { headers: auth }),
      fetch(url, { headers: auth }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(spawnCount).toBe(1);
  });

  it("answers 502 when the bridge serves a broken list", async () => {
    const bridge = await startSessionsBridge(500);
    const hub = await startTestHub();
    await registerServeBridge(hub, bridge.port);

    const res = await fetch(
      `http://127.0.0.1:${hub.port}/api/projects/sessions?workspacePath=${encodeURIComponent(PROJECT)}`,
      { headers: auth },
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("bridge answered 500");
  });
});

describe("hub terminal-TUI session resume (ADR-0017)", () => {
  const PROJECT = "/Users/dev/Develop/demo";
  const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  const post = (hub: HubHandle, body: Record<string, unknown>): Promise<Response> =>
    fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    });

  let fakeChild: EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null };
  let spawnCalls: Array<{ cwd: string; env: NodeJS.ProcessEnv; kind: "tui" | "serve" }>;

  beforeEach(() => {
    listKnownWorkspacesMock.mockReset();
    listKnownWorkspacesMock.mockResolvedValue([
      { workspacePath: PROJECT, sessions: 3, lastActive: 1234 },
    ]);
    fakeChild = new EventEmitter() as typeof fakeChild;
    fakeChild.pid = 4242;
    fakeChild.exitCode = null;
    fakeChild.signalCode = null;
    spawnCalls = [];
  });

  function spawnServeSpy(): (opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    kind: "tui" | "serve";
  }) => import("node:child_process").ChildProcess {
    return (opts) => {
      spawnCalls.push(opts);
      return fakeChild as unknown as import("node:child_process").ChildProcess;
    };
  }

  async function registerServeBridge(hub: HubHandle, id: string, nonce?: string): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        registerBody({
          id,
          workspace: PROJECT,
          origin: "serve",
          port: BASE_PORT + 50,
          pid: 4242,
          ...(nonce ? { nonce } : {}),
        }),
      ),
    });
    expect(res.ok).toBe(true);
  }

  it("incubates a visible resume TUI even when a serve bridge is already live", async () => {
    // The ADR-0015 listing always incubates a headless serve bridge first —
    // reusing it here (the old behaviour) is exactly why a resume never
    // surfaced on the desktop. The POST must spawn a terminal surface with
    // the requested session in the env, and answer with the NEW instance.
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    await registerServeBridge(hub, "listing-serve");
    const pending = post(hub, { workspacePath: PROJECT, sessionId: "sess_closed" });
    await new Promise((r) => setTimeout(r, 400)); // one poll tick
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.kind).toBe("tui");
    expect(spawnCalls[0]!.env.ZCODE_ACP_RESUME_SESSION).toBe("sess_closed");
    // The fresh bridge registers with its incubation nonce: the poll pairs
    // with it, never with the pre-existing listing bridge (whose id would
    // put the client's session/load on a different process than the window).
    await registerServeBridge(hub, "resume-repl", spawnCalls[0]!.env.ZCODE_ACP_SPAWN_NONCE);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "resume-repl", reused: false });
  });

  it("carries the resume env into the .command script so the terminal shell boots into the session", () => {
    // terminalTuiScript exports every ZCODE_ACP_* var; the resume id rides
    // the same channel (hub-server adds it to the incubation env).
    const body = terminalTuiScript(PROJECT, "/opt/cli.js", {
      ZCODE_ACP_REMOTE: "1",
      ZCODE_ACP_RESUME_SESSION: "sess_closed",
    });
    expect(body).toContain("export ZCODE_ACP_RESUME_SESSION='sess_closed'");
  });

  it("joins one incubation for identical concurrent resumes, but not a different session", async () => {
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const first = post(hub, { workspacePath: PROJECT, sessionId: "sess_a" });
    const sameSid = post(hub, { workspacePath: PROJECT, sessionId: "sess_a" });
    const otherSid = post(hub, { workspacePath: PROJECT, sessionId: "sess_b" });
    await new Promise((r) => setTimeout(r, 400)); // one poll tick
    expect(spawnCalls).toHaveLength(2); // sess_a shares one spawn; sess_b is its own
    expect(spawnCalls[0]!.env.ZCODE_ACP_RESUME_SESSION).toBe("sess_a");
    expect(spawnCalls[1]!.env.ZCODE_ACP_RESUME_SESSION).toBe("sess_b");
    // Each window's bridge registers with its OWN nonce — the polls must not
    // cross-claim (a crossed answer would attach the client to the wrong
    // bridge and load the session on two backend processes).
    await registerServeBridge(hub, "resume-a", spawnCalls[0]!.env.ZCODE_ACP_SPAWN_NONCE);
    await registerServeBridge(hub, "resume-b", spawnCalls[1]!.env.ZCODE_ACP_SPAWN_NONCE);
    const [ra, rs, ro] = await Promise.all([first, sameSid, otherSid]);
    expect(await ra.json()).toEqual({ id: "resume-a", reused: false });
    expect(await rs.json()).toEqual({ id: "resume-a", reused: false });
    expect(await ro.json()).toEqual({ id: "resume-b", reused: false });
  });

  it("rejects a malformed sessionId without spawning", async () => {
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const res = await post(hub, { workspacePath: PROJECT, sessionId: "bad id" });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid sessionId — session id expected");
    expect(spawnCalls).toHaveLength(0);
    // Unknown projects still gate the resume spawn like a create.
    const unknown = await post(hub, { workspacePath: "/etc", sessionId: "sess_x" });
    expect(unknown.status).toBe(403);
  });

  it("answers 502 when the resume TUI never registers", async () => {
    // The child-death fast-fail fires on the first poll tick — no need to
    // wait out the full 20s GUI budget.
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const pending = post(hub, { workspacePath: PROJECT, sessionId: "sess_closed" });
    await new Promise((r) => setTimeout(r, 400));
    fakeChild.exitCode = 1; // the window died before its bridge registered
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("serve bridge exited during startup");
  });
});

describe("terminal launch resolution (ADR-0016)", () => {
  it("prefers the explicit command template over everything", () => {
    const out = resolveTerminalLaunch({
      ZCODE_ACP_HUB_TERMINAL_COMMAND: "my-term --run {script}",
      ZCODE_ACP_HUB_TERMINAL_APP: "iTerm",
    });
    expect(out.launch).toEqual({ kind: "shell", command: "my-term --run {script}" });
    expect(out.warning).toBeUndefined();
  });

  it("maps well-known apps to their verified launch mechanism", () => {
    expect(resolveTerminalLaunch({ ZCODE_ACP_HUB_TERMINAL_APP: "WezTerm" }).launch).toEqual({
      kind: "openAppArgs",
      app: "WezTerm",
      args: ["start", "--"],
    });
    expect(resolveTerminalLaunch({ ZCODE_ACP_HUB_TERMINAL_APP: "kitty" }).launch).toEqual({
      kind: "openAppArgs",
      app: "kitty",
      args: [],
    });
    expect(resolveTerminalLaunch({ ZCODE_ACP_HUB_TERMINAL_APP: "ghostty" }).launch).toEqual({
      kind: "openAppArgs",
      app: "Ghostty",
      args: ["-e"],
    });
    expect(resolveTerminalLaunch({ ZCODE_ACP_HUB_TERMINAL_APP: "Alacritty" }).launch).toEqual({
      kind: "openAppArgs",
      app: "Alacritty",
      args: ["-e"],
    });
    // .command executors; aliases are case- and .app-suffix-insensitive.
    expect(resolveTerminalLaunch({ ZCODE_ACP_HUB_TERMINAL_APP: "iTerm.app" }).launch).toEqual({
      kind: "openApp",
      app: "iTerm",
    });
    expect(resolveTerminalLaunch({ ZCODE_ACP_HUB_TERMINAL_APP: "iterm2" }).launch).toEqual({
      kind: "openApp",
      app: "iTerm",
    });
    expect(resolveTerminalLaunch({ ZCODE_ACP_HUB_TERMINAL_APP: "Apple_Terminal" }).launch).toEqual({
      kind: "openApp",
      app: "Terminal",
    });
  });

  it("warns on Warp — it cannot run scripts or commands programmatically", () => {
    const out = resolveTerminalLaunch({ ZCODE_ACP_HUB_TERMINAL_APP: "Warp" });
    expect(out.launch).toEqual({ kind: "openApp", app: "Warp" });
    expect(out.warning).toContain("warpdotdev/warp#1917");
    expect(out.warning).toContain("ZCODE_ACP_HUB_TERMINAL_COMMAND");
  });

  it("passes unknown apps through to open -a and defaults to Terminal.app", () => {
    expect(resolveTerminalLaunch({ ZCODE_ACP_HUB_TERMINAL_APP: "MyTerm" }).launch).toEqual({
      kind: "openApp",
      app: "MyTerm",
    });
    expect(resolveTerminalLaunch({}).launch).toEqual({ kind: "openApp", app: "Terminal" });
    // The hub is a background process — its own env has no terminal, and
    // TERM_PROGRAM (at best an accident of how the hub was launched) is
    // never consulted.
    expect(resolveTerminalLaunch({ TERM_PROGRAM: "iTerm.app" }).launch).toEqual({
      kind: "openApp",
      app: "Terminal",
    });
  });
});

describe("terminal TUI script (ADR-0016)", () => {
  it("embeds the hub's ZCODE_ACP_* env so the fresh terminal shell registers", () => {
    const body = terminalTuiScript("/Users/me/proj", "/opt/cli.js", {
      PATH: "/usr/bin",
      ZCODE_ACP_REMOTE: "1",
      ZCODE_ACP_REMOTE_TOKEN: "tok it's",
      ZCODE_ACP_REMOTE_ORIGIN: "serve",
    });
    expect(body).toContain("cd '/Users/me/proj' || exit 1");
    expect(body).toContain("export ZCODE_ACP_REMOTE='1'");
    expect(body).toContain("export ZCODE_ACP_REMOTE_TOKEN='tok it'\\''s'");
    expect(body).toContain("export ZCODE_ACP_REMOTE_ORIGIN='serve'");
    expect(body).toContain("exec '");
    expect(body).not.toContain("PATH=");
  });
});
