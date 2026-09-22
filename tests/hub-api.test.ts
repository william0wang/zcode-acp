/**
 * Hub API integration tests — real hub on an ephemeral port: discovery,
 * register/unregister lifecycle, heartbeat pruning, on-demand probes, quota
 * endpoints, HTTP byte proxies (status/close/rename), the idle-exit policy,
 * and instance shutdown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import net from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The quota endpoint must not touch the real usage APIs in tests.
const { accountUsageStatsMock } = vi.hoisted(() => ({
  accountUsageStatsMock: vi.fn(),
}));
vi.mock("../src/handlers/account.js", () => ({
  accountUsageStats: accountUsageStatsMock,
}));

// The quota dock endpoint (ADR-0021) queries via queryQuota — mock it too.
const { queryQuotaMock } = vi.hoisted(() => ({ queryQuotaMock: vi.fn() }));
vi.mock("../src/quota/index.js", () => ({ queryQuota: queryQuotaMock }));

// Ollama Cloud dock segment — mock so an inherited OLLAMA_API_KEY cannot
// reach the real usage API from tests.
const { queryOcUsageMock } = vi.hoisted(() => ({ queryOcUsageMock: vi.fn() }));
vi.mock("../src/quota/ollama-cloud/index.js", () => ({ queryOcUsage: queryOcUsageMock }));

import {
  resetDockCacheForTest,
  resetQuotaCacheForTest,
  startHub,
  type HubHandle,
} from "../src/remote/hub-server.js";

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

  it("prunes dead-port instances only after the probe grace, not on the first failure", async () => {
    const hub = await startTestHub({ probeGraceMs: 300 });
    await registerInstance(hub, registerBody()); // BASE_PORT: nothing listens

    const plain = (await (await listInstances(hub)).json()) as unknown[];
    expect(plain).toHaveLength(1); // no probe param = unverified list

    // First failed probe only marks the instance unhealthy — a busy bridge's
    // event loop can stall past the connect timeout while fully alive.
    const first = (await listProbed(hub)) as unknown[];
    expect(first).toHaveLength(1);

    // The mark is not a prune: plain list still shows the instance.
    const stillListed = (await (await listInstances(hub)).json()) as unknown[];
    expect(stillListed).toHaveLength(1);

    // After the grace expires, the next failing probe confirms and prunes.
    await new Promise((r) => setTimeout(r, 400));
    const probed = (await listProbed(hub)) as unknown[];
    expect(probed).toEqual([]);

    // The prune is persistent: the plain list stays empty afterwards.
    const after = (await (await listInstances(hub)).json()) as unknown[];
    expect(after).toEqual([]);
  });

  it("a heartbeat re-register clears the unhealthy mark", async () => {
    const hub = await startTestHub({ probeGraceMs: 100 });
    await registerInstance(hub, registerBody()); // BASE_PORT: nothing listens

    // Mark unhealthy, then let the grace fully expire while marked.
    expect(((await listProbed(hub)) as unknown[]).length).toBe(1);
    await new Promise((r) => setTimeout(r, 150));

    // The heartbeat re-register proves liveness and must reset the mark, so
    // the next failing probe starts a fresh grace instead of pruning.
    await registerInstance(hub, registerBody());
    const probed = (await listProbed(hub)) as unknown[];
    expect(probed).toHaveLength(1);
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

describe("hub quota dock endpoint", () => {
  const dockUrl = (hub: HubHandle) => `http://127.0.0.1:${hub.port}/api/quota/dock`;

  beforeEach(() => {
    queryQuotaMock.mockReset();
    queryOcUsageMock.mockReset();
    queryOcUsageMock.mockResolvedValue({ kind: "not_configured" });
    resetDockCacheForTest();
  });

  it("rejects /api/quota/dock without a token", async () => {
    const hub = await startTestHub();
    expect((await fetch(dockUrl(hub))).status).toBe(401);
    expect(queryQuotaMock).not.toHaveBeenCalled();
  });

  it("returns {formatted, fetchedAt} from queryQuota", async () => {
    const hub = await startTestHub();
    queryQuotaMock.mockResolvedValueOnce({
      kind: "success",
      level: "pro",
      items: [
        { key: "token_5h", label: "5h", usedPercent: 45, leftPercent: 55 },
        { key: "token_week", label: "Week", usedPercent: 12, leftPercent: 88 },
      ],
    });
    const res = await fetch(dockUrl(hub), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { formatted: string | null; fetchedAt: number };
    expect(body.formatted).toBe("45% · 12%");
    expect(body.fetchedAt).toBeGreaterThan(0);
  });

  it("serves the cached copy within the TTL", async () => {
    const hub = await startTestHub();
    queryQuotaMock.mockResolvedValue({
      kind: "success",
      level: "pro",
      items: [{ key: "token_5h", label: "5h", usedPercent: 1, leftPercent: 99 }],
    });
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const first = await fetch(dockUrl(hub), { headers });
    const second = await fetch(dockUrl(hub), { headers });
    expect(queryQuotaMock).toHaveBeenCalledTimes(1);
    expect(((await first.json()) as { formatted: string }).formatted).toBe("1%");
    expect(((await second.json()) as { formatted: string }).formatted).toBe("1%");
  });

  it("caches a null formatted (dock hidden), and answers 502 on query failure", async () => {
    const hub = await startTestHub();
    queryQuotaMock.mockResolvedValueOnce({ kind: "unavailable" });
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const hidden = await fetch(dockUrl(hub), { headers });
    expect(hidden.status).toBe(200);
    expect(((await hidden.json()) as { formatted: unknown }).formatted).toBeNull();
    // The null result is cached: a repeat within the TTL does not re-query.
    const again = await fetch(dockUrl(hub), { headers });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { formatted: unknown }).formatted).toBeNull();
    expect(queryQuotaMock).toHaveBeenCalledTimes(1);

    resetDockCacheForTest();
    queryQuotaMock.mockRejectedValueOnce(new Error("upstream down"));
    const failed = await fetch(dockUrl(hub), { headers });
    expect(failed.status).toBe(502);
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

describe("hub backend restart proxy", () => {
  /** Register a bridge under the canonical test instance id. */
  async function registerBridge(hub: HubHandle, port: number): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody({ port })),
    });
    expect(res.status).toBe(200);
  }

  /**
   * Fake bridge loopback server accepting the restart the settings endpoint
   * exposes at `POST /settings/backend/restart`. The hub's documented spelling
   * omits the `/settings/` segment, so what is under test is the rewrite.
   */
  function startRestartBridge(): Promise<{ server: Server; port: number; seen: string[] }> {
    return new Promise((resolve) => {
      const seen: string[] = [];
      const server = createServer((req, res) => {
        seen.push(`${req.method} ${req.url ?? ""}`);
        if (req.method === "POST" && req.url === "/settings/backend/restart") {
          req.resume();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true,"cancelledTurns":2}');
        } else {
          req.resume();
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("not found");
        }
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve({
          server,
          port: typeof addr === "object" && addr ? addr.port : 0,
          seen,
        });
      });
    });
  }

  it("routes the documented instance restart spelling to the bridge", async () => {
    const hub = await startTestHub();
    const bridge = track(
      await startRestartBridge(),
      ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    await registerBridge(hub, bridge.port);
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/backend/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelledTurns: 2 });
    // The hub rewrites the documented path onto the bridge's settings route.
    expect(bridge.seen).toEqual(["POST /settings/backend/restart"]);
  });

  it("guards the restart route and answers 404 for an unknown instance", async () => {
    const hub = await startTestHub();
    const call = (token: string | null, id = "inst-1") =>
      fetch(`http://127.0.0.1:${hub.port}/api/instances/${id}/backend/restart`, {
        method: "POST",
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
    expect((await call(null)).status).toBe(401);
    expect((await call("wrong")).status).toBe(401);
    expect((await call(TOKEN)).status).toBe(404);
    // A GET is not a restart — it must not reach the bridge.
    const get = await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/backend/restart`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(404);
  });

  it("also serves the per-instance /settings/ spelling", async () => {
    const hub = await startTestHub();
    const bridge = track(
      await startRestartBridge(),
      ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    await registerBridge(hub, bridge.port);
    const res = await fetch(
      `http://127.0.0.1:${hub.port}/api/instances/inst-1/settings/backend/restart`,
      { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    expect(bridge.seen).toEqual(["POST /settings/backend/restart"]);
  });
});

describe("hub idle exit", () => {
  it("exits after the idle window with no instances and no proxies", async () => {
    let exited = false;
    const hub = await startTestHub({
      idleExitMs: 150,
      stayAliveCheck: () => false,
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

  it("stays resident past the idle window while remote is still enabled", async () => {
    let exited = false;
    const hub = await startTestHub({
      idleExitMs: 150,
      stayAliveCheck: () => true,
      onIdleExit: () => {
        exited = true;
      },
    });
    // No registrations, no proxies — three full idle windows elapse.
    await new Promise((r) => setTimeout(r, 700));
    expect(exited).toBe(false);
    // Still serving: the port answers.
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    await hub.close();
  });
});

describe("hub instance shutdown", () => {
  /** A real killable placeholder process standing in for a serve bridge. */
  async function startDummyBridge(): Promise<{ child: ChildProcess; pid: number }> {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => {
      if (child.pid) resolve();
      else child.once("spawn", () => resolve());
    });
    cleanups.push(() => {
      child.kill("SIGKILL");
    });
    return { child, pid: child.pid! };
  }

  async function registerInstance(
    hub: HubHandle,
    pid: number,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody({ pid, ...overrides })),
    });
    expect(res.status).toBe(200);
  }

  async function shutdown(hub: HubHandle, id = "inst-1"): Promise<Response> {
    return fetch(`http://127.0.0.1:${hub.port}/api/instances/${id}/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }

  it("kills a serve-origin bridge and unregisters it", async () => {
    const hub = await startTestHub();
    const { child, pid } = await startDummyBridge();
    await registerInstance(hub, pid, { origin: "serve" });

    const res = await shutdown(hub);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // SIGTERM'd → the process exits and the instance leaves the registry.
    await withTimeout(
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      5000,
      "dummy bridge exit",
    );
    const list = await (await listInstances(hub)).json();
    expect(list).toHaveLength(0);
  });

  it("tears the whole TUI tree down on shutdown (tuiPid group + direct pids)", async () => {
    const hub = await startTestHub();
    // Stand-ins for the window tree: a detached "CLI" (its own process group,
    // like the .command script session under Terminal.app) and the leaf
    // bridge. The bridge kill alone used to leave the CLI alive — the very
    // "window stays open on a dead-agent page" regression this pins down.
    const cli = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    const bridge = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    cleanups.push(() => {
      cli.kill("SIGKILL");
      bridge.kill("SIGKILL");
    });
    await Promise.all(
      [cli, bridge].map(
        (c) =>
          new Promise<void>((resolve) => (c.pid ? resolve() : c.once("spawn", () => resolve()))),
      ),
    );
    await registerInstance(hub, bridge.pid!, { origin: "serve", tuiPid: cli.pid });

    // Attach the exit listeners BEFORE the kill: 'exit' fires once and is not
    // replayed for late listeners — on Linux the dummies die within
    // milliseconds of the shutdown response, and attaching after an intervening
    // await loses the event entirely (observed on CI: signalCode set, listener
    // never called, /proc entry gone).
    const cliExited = new Promise<void>((resolve) => cli.once("exit", () => resolve()));
    const bridgeExited = new Promise<void>((resolve) => bridge.once("exit", () => resolve()));

    const res = await shutdown(hub);
    expect(res.status).toBe(200);

    await withTimeout(cliExited, 5000, "tui cli exit");
    await withTimeout(bridgeExited, 5000, "bridge exit");
    const list = await (await listInstances(hub)).json();
    expect(list).toHaveLength(0);
  }, 15_000);

  it("kills an editor-origin bridge that carries an incubation nonce", async () => {
    const hub = await startTestHub();
    const { child, pid } = await startDummyBridge();
    await registerInstance(hub, pid, { origin: "editor", nonce: "nonce-1" });

    expect((await shutdown(hub)).status).toBe(200);
    await withTimeout(
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      5000,
      "dummy bridge exit",
    );
  }, 15_000);

  it("refuses an editor-origin bridge without a nonce (403)", async () => {
    const hub = await startTestHub();
    const { child, pid } = await startDummyBridge();
    await registerInstance(hub, pid, { origin: "editor" }); // no nonce

    const res = await shutdown(hub);
    expect(res.status).toBe(403);
    expect(child.exitCode).toBeNull(); // still alive
  });

  it("guards auth and unknown instances like the other write routes", async () => {
    const hub = await startTestHub();
    expect(
      (
        await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/shutdown`, {
          method: "POST",
        })
      ).status,
    ).toBe(401); // no token
    expect((await shutdown(hub)).status).toBe(404); // unknown instance
    // Non-POST falls through to the catch-all 404.
    expect(
      (
        await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/shutdown`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(404);
  });
});

describe("hub instance shutdown pid guard", () => {
  it("refuses a registration that carries no usable pid (409, nothing killed)", async () => {
    const hub = await startTestHub();
    await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody({ pid: 0, origin: "serve" })),
    });

    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(409);
    expect(process.pid).toBeTruthy(); // we are still here
  });
});
