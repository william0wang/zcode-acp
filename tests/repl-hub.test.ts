/**
 * Tests for the REPL's hub client (src/repl/hub.ts): env resolution, pure
 * discovery helpers, instance listing against a real hub, and the
 * WebSocket→stream adapter exercised end-to-end — a scripted fake bridge
 * behind a real hub's WS proxy serves an SDK ACP client through
 * openHubSocket, walking the same initialize + session/load path the REPL's
 * remote attach uses (ADR-0018).
 */

import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type { ActiveSession } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

// The quota endpoint must not touch the real usage APIs in tests.
const { accountUsageStatsMock } = vi.hoisted(() => ({
  accountUsageStatsMock: vi.fn(),
}));
vi.mock("../src/handlers/account.js", () => ({
  accountUsageStats: accountUsageStatsMock,
}));

// Discovery helpers read the known-project whitelist from tasks-index; mock
// the module so no real sqlite/App store is touched.
vi.mock("../src/tasks-index.js", () => ({
  listKnownWorkspaces: vi.fn().mockReturnValue([]),
}));

import {
  fetchInstances,
  findInstanceForSession,
  openHubSocket,
  resolveHubClient,
  sameWorkspace,
  type HubInstance,
  type HubRef,
} from "../src/repl/hub.js";
import { startHub, type HubHandle } from "../src/remote/hub-server.js";

const TOKEN = "test-hub-token";

const cleanups: Array<() => Promise<void> | void> = [];

function track<T>(value: T, stop: (v: T) => Promise<void> | void): T {
  cleanups.push(() => stop(value));
  return value;
}

async function startTestHub(): Promise<HubHandle> {
  const hub = await startHub({ port: 0, host: "127.0.0.1", token: TOKEN });
  cleanups.push(() => hub.close());
  return hub;
}

function hubRefFor(port: number, token = TOKEN): HubRef {
  return {
    port,
    token,
    baseUrl: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
  };
}

function registerBody(overrides: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    id: "inst-1",
    port: 1, // nothing listens unless the test says otherwise
    pid: 123,
    workspace: "/tmp/proj",
    sessions: [{ sessionId: "s1", title: "hello", updatedAt: 1 }],
    ...overrides,
  };
}

async function register(hub: HubHandle, body: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

async function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

beforeEach(() => {
  cleanups.length = 0;
});

afterEach(async () => {
  while (cleanups.length > 0) {
    const stop = cleanups.pop();
    if (stop) await stop();
  }
});

describe("resolveHubClient", () => {
  it("returns null without a token", () => {
    expect(resolveHubClient({})).toBeNull();
  });

  it("defaults the port and dials loopback", () => {
    const hub = resolveHubClient({ ZCODE_ACP_REMOTE_TOKEN: "t" });
    expect(hub).toMatchObject({
      port: 8377,
      baseUrl: "http://127.0.0.1:8377",
      wsBase: "ws://127.0.0.1:8377",
    });
  });

  it("honors a numeric ZCODE_ACP_HUB_PORT and rejects garbage", () => {
    expect(
      resolveHubClient({ ZCODE_ACP_REMOTE_TOKEN: "t", ZCODE_ACP_HUB_PORT: "18377" })?.port,
    ).toBe(18377);
    expect(resolveHubClient({ ZCODE_ACP_REMOTE_TOKEN: "t", ZCODE_ACP_HUB_PORT: "abc" })?.port).toBe(
      8377,
    );
  });
});

describe("discovery helpers", () => {
  const instances: HubInstance[] = [
    {
      id: "a",
      port: 1,
      pid: 1,
      workspace: "/tmp/proj",
      sessions: [{ sessionId: "s1" }],
    },
    {
      id: "b",
      port: 2,
      pid: 2,
      workspace: "/tmp/other",
      sessions: [{ sessionId: "s2" }, { sessionId: "s3" }],
    },
  ];

  it("finds the instance owning a session", () => {
    expect(findInstanceForSession(instances, "s2")?.id).toBe("b");
    expect(findInstanceForSession(instances, "nope")).toBeNull();
  });

  it("matches instance workspace by resolved path", () => {
    expect(sameWorkspace("/tmp/proj/", "/tmp/proj")).toBe(true);
    expect(sameWorkspace("/tmp/other", "/tmp/proj")).toBe(false);
    expect(sameWorkspace(undefined, "/tmp/proj")).toBe(false);
  });
});

describe("fetchInstances", () => {
  it("lists registered instances with Bearer auth", async () => {
    const hub = await startTestHub();
    await register(hub, registerBody());
    const list = await fetchInstances(hubRefFor(hub.port));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "inst-1", workspace: "/tmp/proj" });
    expect(list[0]?.sessions?.[0]?.sessionId).toBe("s1");
  });

  it("rejects on bad auth", async () => {
    const hub = await startTestHub();
    await expect(fetchInstances(hubRefFor(hub.port, "wrong"))).rejects.toThrow("HTTP 401");
  });
});

describe("openHubSocket + wsToStream through the hub proxy", () => {
  /**
   * A scripted ACP agent behind the hub: answers initialize and session/load,
   * pushing one replayed update before the load response — the exact shape
   * the REPL's remote attach consumes.
   */
  function startScriptedBridge(): Promise<{ server: WebSocketServer; port: number }> {
    return new Promise((resolve) => {
      const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => {
        const addr = server.address();
        resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
      });
      server.on("connection", (ws) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString()) as {
            id?: number;
            method?: string;
            params?: { sessionId?: string };
          };
          if (msg.method === "initialize") {
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: { protocolVersion: 1, agentInfo: { name: "fake-bridge" } },
              }),
            );
          } else if (msg.method === "session/load") {
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: msg.params?.sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "replayed line" },
                  },
                },
              }),
            );
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  configOptions: [],
                  replayMeta: { replayedMessages: 1, totalMessages: 1, hasMore: false },
                },
              }),
            );
          } else {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
          }
        });
      });
    });
  }

  it("walks initialize + session/load + live updates through the proxy", async () => {
    const hub = await startTestHub();
    const bridge = track(
      await startScriptedBridge(),
      ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    await register(
      hub,
      registerBody({
        port: bridge.port,
        sessions: [{ sessionId: "s1", title: "t", updatedAt: 1 }],
      }),
    );

    const { ws, duplex } = await openHubSocket(hubRefFor(hub.port), "inst-1");
    track(ws, (w) => closeWs(w));

    const app = acp
      .client({ name: "zcode-acp" })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(duplex),
          Readable.toWeb(duplex) as ReadableStream<Uint8Array>,
        ),
      );
    const cx = app.agent;

    const init = (await withTimeout(
      cx.request("initialize", { protocolVersion: 1, clientCapabilities: {} }),
      5000,
      "initialize",
    )) as { agentInfo?: { name?: string } };
    expect(init.agentInfo?.name).toBe("fake-bridge");

    // Same @internal seam the local resume uses: attach before load, or the
    // SDK's update router drops the replay.
    const session = (
      cx as unknown as { attachSession(r: { sessionId: string }): ActiveSession }
    ).attachSession({ sessionId: "s1" });
    const resp = (await withTimeout(
      cx.request("session/load", { sessionId: "s1", cwd: "/tmp/proj", mcpServers: [] }),
      5000,
      "session/load",
    )) as { replayMeta?: { replayedMessages?: number } };
    expect(resp.replayMeta?.replayedMessages).toBe(1);

    const update = await withTimeout(session.nextUpdate(), 5000, "replayed update");
    expect(update.kind).toBe("session_update");
    if (update.kind === "session_update") {
      expect(update.update).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed line" },
      });
    }
  });

  it("rejects when the instance is unknown (hub destroys the socket)", async () => {
    const hub = await startTestHub();
    await expect(openHubSocket(hubRefFor(hub.port), "missing-instance", 3000)).rejects.toThrow();
  });
});
