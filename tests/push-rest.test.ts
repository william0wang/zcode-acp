/**
 * Push REST surface (push-backend-requirements §7):
 *  - the bridge loopback POST /push/test handler (method guard, body parsing,
 *    the house `{ok:false,...}` error shapes, status codes)
 *  - the hub's /api/instances/{id}/push/test forward-and-relay proxy
 *    (auth guard, path rewrite, status/body relay, 502 on unreachable).
 */

import { createServer, type Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("../src/push/push.js", async (orig) => {
  const actual = await orig<typeof import("../src/push/push.js")>();
  return { ...actual, sendTestPush: sendMock };
});

const { createPushTestHandler } = await import("../src/remote/push-test-endpoint.js");
const { startHub } = await import("../src/remote/hub-server.js");
type HubHandle = Awaited<ReturnType<typeof startHub>>;
const { ZcodeAcpServer } = await import("../src/server.js");

const TOKEN = "test-hub-token";
const cleanups: Array<() => Promise<void> | void> = [];

function track<T>(value: T, stop: (v: T) => Promise<void> | void): T {
  cleanups.push(() => stop(value));
  return value;
}

afterEach(async () => {
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
});

async function bootPushEndpoint(): Promise<string> {
  const server = new ZcodeAcpServer();
  const handler = createPushTestHandler(server);
  const httpServer: Server = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname === "/push/test") {
      handler(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  track(httpServer, (s) => new Promise<void>((resolve) => s.close(() => resolve())));
  const addr = httpServer.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

describe("bridge POST /push/test", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("rejects non-POST methods", async () => {
    const base = await bootPushEndpoint();
    const res = await fetch(`${base}/push/test`);
    expect(res.status).toBe(405);
  });

  it("sends with the default title when the body is empty", async () => {
    sendMock.mockResolvedValue({ ok: true, sent: 1 });
    const base = await bootPushEndpoint();
    const res = await fetch(`${base}/push/test`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: 1 });
    expect(sendMock).toHaveBeenCalledWith("Test push");
  });

  it("honours a provided title", async () => {
    sendMock.mockResolvedValue({ ok: true, sent: 1 });
    const base = await bootPushEndpoint();
    const res = await fetch(`${base}/push/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Custom" }),
    });
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledWith("Custom");
  });

  it("rejects a non-object body with 400", async () => {
    const base = await bootPushEndpoint();
    const res = await fetch(`${base}/push/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '"just a string"',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_body" });
  });

  it("maps push_disabled to 409 and send_failed to 502", async () => {
    const base = await bootPushEndpoint();
    sendMock.mockResolvedValueOnce({ ok: false, error: "push_disabled" });
    const disabled = await fetch(`${base}/push/test`, { method: "POST" });
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toEqual({ ok: false, error: "push_disabled" });

    sendMock.mockResolvedValueOnce({ ok: false, error: "send_failed", message: "boom" });
    const failed = await fetch(`${base}/push/test`, { method: "POST" });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ ok: false, error: "send_failed", message: "boom" });
  });
});

describe("hub push test proxy", () => {
  const BASE_PORT = 18540;

  /** Fake bridge loopback accepting POST /push/test. */
  function startPushBridge(
    status: number,
    body: string,
  ): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        if (req.method === "POST" && req.url === "/push/test") {
          req.resume();
          res.writeHead(status, { "Content-Type": "application/json" });
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

  async function startTestHub(): Promise<HubHandle> {
    const hub = await startHub({ port: 0, host: "127.0.0.1", token: TOKEN });
    cleanups.push(() => hub.close());
    return hub;
  }

  async function registerBridge(hub: HubHandle, port: number): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: TOKEN,
        id: "inst-1",
        port,
        pid: 123,
        workspace: "/tmp/proj",
        sessions: [{ sessionId: "s1", title: "hello", updatedAt: 1 }],
      }),
    });
    expect(res.status).toBe(200);
  }

  it("forwards to the bridge's /push/test and relays status + body", async () => {
    const hub = await startTestHub();
    const bridge = track(
      await startPushBridge(200, '{"ok":true,"sent":1}'),
      ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    await registerBridge(hub, bridge.port);

    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/push/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Hi" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: 1 });
  });

  it("relays the bridge's error status untouched", async () => {
    const hub = await startTestHub();
    const bridge = track(
      await startPushBridge(409, '{"ok":false,"error":"push_disabled"}'),
      ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    await registerBridge(hub, bridge.port);
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/push/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "push_disabled" });
  });

  it("guards the route like every hub route", async () => {
    const hub = await startTestHub();
    const bridge = track(
      await startPushBridge(200, '{"ok":true,"sent":1}'),
      ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    await registerBridge(hub, bridge.port);
    const url = `http://127.0.0.1:${hub.port}/api/instances/inst-1/push/test`;

    expect(
      (await fetch(url, { method: "POST", headers: { Authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect(
      (await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })).status,
    ).toBe(200); // registered above
    expect(
      (
        await fetch(`http://127.0.0.1:${hub.port}/api/instances/unknown/push/test`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(404);
    // Non-POST falls through to the catch-all 404.
    expect((await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
  });

  it("answers 502 when the bridge is unreachable", async () => {
    const hub = await startTestHub();
    await registerBridge(hub, BASE_PORT); // nothing listens there
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/push/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(502);
  });
});
