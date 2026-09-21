/**
 * Hub proxy integration tests — the WS byte proxy, remote session-create
 * incubation (ADR-0014), project session history (ADR-0015), terminal-TUI
 * resume/create incubation (ADR-0017), and the terminal launch/script
 * resolution (ADR-0016) those incubations build on.
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebSocket, WebSocketServer } from "ws";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The session-create endpoints read the known-project whitelist from
// tasks-index; mock the module so no real sqlite/App store is touched.
const { listKnownWorkspacesMock } = vi.hoisted(() => ({
  listKnownWorkspacesMock: vi.fn(),
}));
vi.mock("../src/tasks-index.js", () => ({
  listKnownWorkspaces: listKnownWorkspacesMock,
}));

import {
  resolveTerminalLaunch,
  sanitizeTabTitle,
  startHub,
  terminalTuiScript,
  ghosttyTabAppleScript,
  type HubHandle,
} from "../src/remote/hub-server.js";
import { BOOT_RESUME_TRIGGER } from "../src/handlers/session.js";

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

  it("terminates a proxy leg that misses a keepalive pong (dead phone link)", async () => {
    // Regression (observed 2026-09): a phone whose TCP was silently cut keeps
    // readyState OPEN; without pong supervision the hub proxied session
    // updates into the void and the app showed a stale transcript until a
    // manual refresh. A leg that misses one full ping interval is terminated —
    // teardown drops the whole pair and the client's reconnect replays.
    const hub = await startTestHub({ pingIntervalMs: 100 });
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
    // A healthy ws auto-pongs; simulate the dead peer by swallowing the pong
    // frame writes (the ping is still received and answered — into /dev/null).
    const sender = (
      client as unknown as { _sender: { pong: (data: Buffer, cb: () => void) => void } }
    )._sender;
    sender.pong = () => undefined;

    const closed = withTimeout(
      new Promise<void>((resolve) => client.once("close", () => resolve())),
      3000,
      "dead leg terminated",
    );
    await closed;
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

describe("hub remote session-create (ADR-0014)", () => {
  const PROJECT = "/Users/dev/Develop/demo";
  const auth = { Authorization: `Bearer ${TOKEN}` };
  /**
   * Minimal ChildProcess stand-in: the hub reads pid/exitCode/signalCode and
   * subscribes to async 'error' (ENOENT after spawn). EventEmitter supplies
   * once(); the mutable exitCode/signalCode fields flip the death checks.
   */
  let fakeChild: EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null };
  let spawnCalls: Array<{
    cwd: string;
    env: NodeJS.ProcessEnv;
    kind: "tui" | "serve";
    launch?: unknown;
  }>;
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
    return (opts: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      kind: "tui" | "serve";
      launch?: unknown;
    }) => {
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
    // Simulate a hub born inside a TUI tree: the foreign CLI pid rides
    // process.env and the incubation must strip it (see assertion below).
    process.env.ZCODE_ACP_TUI_CLI_PID = "999999";
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    delete process.env.ZCODE_ACP_TUI_CLI_PID;
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
    // Tab title default: no conversation to name, so the project names it.
    expect(spawnCalls[0]!.env.ZCODE_ACP_TAB_TITLE).toBe("demo");
    // The TUI CLI pid is process-tree-local: a hub born inside one TUI tree
    // must not pass a foreign pid to bridges it incubates (a headless serve
    // bridge would SIGTERM that unrelated tree on its last session close).
    expect(spawnCalls[0]!.env.ZCODE_ACP_TUI_CLI_PID).toBeUndefined();
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
  let spawnCalls: Array<{
    cwd: string;
    env: NodeJS.ProcessEnv;
    kind: "tui" | "serve";
    launch?: unknown;
  }>;

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
    launch?: unknown;
  }) => import("node:child_process").ChildProcess | null {
    return (opts) => {
      spawnCalls.push(opts);
      return fakeChild as unknown as import("node:child_process").ChildProcess;
    };
  }

  async function registerServeBridge(
    hub: HubHandle,
    id: string,
    nonce?: string,
    port: number = BASE_PORT + 50,
  ): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        registerBody({
          id,
          workspace: PROJECT,
          origin: "serve",
          port,
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
    // Dead listing port → the title lookup fails fast → the project names
    // the tab (the lookup must never block or break the window).
    expect(spawnCalls[0]!.env.ZCODE_ACP_TAB_TITLE).toBe("demo");
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
    // the same channel (hub-server adds it to the incubation env). The
    // banner-handshake trigger travels as the one non-ZCODE_ACP_* passenger
    // (martty reads DSH_TUI_AUTOPROMPT at its own process start).
    const body = terminalTuiScript(PROJECT, "/opt/cli.js", {
      ZCODE_ACP_REMOTE: "1",
      ZCODE_ACP_RESUME_SESSION: "sess_closed",
      DSH_TUI_AUTOPROMPT: BOOT_RESUME_TRIGGER,
      DSH_IRRELEVANT: "dropped",
    });
    expect(body).toContain("export ZCODE_ACP_RESUME_SESSION='sess_closed'");
    expect(body).toContain(`export DSH_TUI_AUTOPROMPT='${BOOT_RESUME_TRIGGER}'`);
    expect(body).not.toContain("DSH_IRRELEVANT");
  });

  it("exports DSH_TUI_STATS so the incubated window honors the dock filter", () => {
    // Regression (2026-09-21): the terminal shell inherits launchd's
    // environment — NOT the hub's or the user's interactive shell — so a
    // stats filter that is not embedded as an export never reaches martty's
    // stats-view plugin, which then renders EVERY dock segment.
    const body = terminalTuiScript(PROJECT, "/opt/cli.js", {
      ZCODE_ACP_REMOTE: "1",
      DSH_TUI_STATS: "tokens,context",
      DSH_TUI_ATTACH_TOKEN: "internal",
    });
    expect(body).toContain("export DSH_TUI_STATS='tokens,context'");
    // martty's INTERNAL transport vars are not user preferences — the
    // allowlist must not widen to every DSH_TUI_* name.
    expect(body).not.toContain("DSH_TUI_ATTACH_TOKEN");
  });

  it("names the tab via OSC 0 when a title rides the incubation env", () => {
    // Terminals otherwise name the tab after the running process ("node");
    // the script emits OSC 0 before exec, and martty never sets a terminal
    // title itself, so the name survives until the window closes.
    const withTitle = terminalTuiScript(PROJECT, "/opt/cli.js", {
      ZCODE_ACP_TAB_TITLE: "Fix the login bug",
    });
    expect(withTitle).toContain("export ZCODE_ACP_TAB_TITLE='Fix the login bug'");
    expect(withTitle).toContain(`printf '\\033]0;%s\\007' "$ZCODE_ACP_TAB_TITLE"`);
    expect(terminalTuiScript(PROJECT, "/opt/cli.js", {})).not.toContain("033]0");
  });

  it("embeds the shell's pid as the TUI CLI pid for remote-close termination", () => {
    // $$ survives exec as the cli's pid — the terminal's foreground process-
    // group leader. Remote session-close SIGTERMs that group to end the whole
    // TUI tree (cli → martty → bridge) when the last conversation closes.
    const body = terminalTuiScript(PROJECT, "/opt/cli.js", {});
    expect(body).toContain("export ZCODE_ACP_TUI_CLI_PID=$$");
    expect(body.indexOf("ZCODE_ACP_TUI_CLI_PID")).toBeLessThan(body.indexOf("exec "));
  });

  it("titles the resume tab with the conversation title from the live serve bridge", async () => {
    // The App browses history through a serve bridge; the same /sessions
    // listing is the title source for the resumed tab (the conversation
    // title, sanitized — model-generated summaries must not carry escape
    // sequences into the terminal).
    let seenUrl = "";
    const bridge = createServer((req, res) => {
      seenUrl = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          sessions: [
            { sessionId: "sess_closed", title: "Fix the login bug", updatedAt: 2 },
            { sessionId: "sess_other", title: "Other", updatedAt: 1 },
          ],
        }),
      );
    });
    const bridgePort = await new Promise<number>((resolve) => {
      bridge.listen(0, "127.0.0.1", () => {
        const addr = bridge.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    await registerServeBridge(hub, "listing-serve", undefined, bridgePort);
    const pending = post(hub, { workspacePath: PROJECT, sessionId: "sess_closed" });
    await new Promise((r) => setTimeout(r, 400)); // one poll tick
    expect(spawnCalls).toHaveLength(1);
    // "project · conversation" — the same combined shape the bridge's live
    // title refresh uses (terminal-title.ts), so the printf and the first
    // bridge write agree.
    expect(spawnCalls[0]!.env.ZCODE_ACP_TAB_TITLE).toBe("demo · Fix the login bug");
    expect(seenUrl).toBe("/sessions?limit=200");
    await registerServeBridge(hub, "resume-repl", spawnCalls[0]!.env.ZCODE_ACP_SPAWN_NONCE);
    expect((await pending).status).toBe(200);
    await new Promise<void>((r) => bridge.close(() => r()));
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
    // No live serve bridge → no title lookup → the project names the tab.
    expect(spawnCalls[0]!.env.ZCODE_ACP_TAB_TITLE).toBe("demo");
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

describe("hub terminal-TUI session create (session binding + slow-window fallback)", () => {
  const PROJECT = "/Users/dev/Develop/demo";
  const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  const post = (hub: HubHandle, body: Record<string, unknown>): Promise<Response> =>
    fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    });

  let fakeChild: EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null };
  let spawnCalls: Array<{
    cwd: string;
    env: NodeJS.ProcessEnv;
    kind: "tui" | "serve";
    launch?: unknown;
  }>;

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

  function spawnServeSpy(
    /** When set, its return decides opened (child) vs failed launch (null). */
    respond?: (opts: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      kind: "tui" | "serve";
      launch?: unknown;
    }) => import("node:child_process").ChildProcess | null,
  ): (opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    kind: "tui" | "serve";
    launch?: unknown;
  }) => import("node:child_process").ChildProcess | null {
    return (opts) => {
      spawnCalls.push(opts);
      if (respond) return respond(opts);
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

  it("incubates the create TUI with the shared-session bind env", async () => {
    // P1 (2026-09-06 diagnosis): the create TUI and the attaching phone each
    // minted their own placeholder session — martty dropped every phone
    // update on the id mismatch and its banner never yielded. The hub now
    // pre-generates the session id and the bridge binds every first
    // session/new of the incubated connection pair to it.
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const pending = post(hub, { workspacePath: PROJECT });
    await new Promise((r) => setTimeout(r, 400)); // one poll tick
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.kind).toBe("tui");
    expect(spawnCalls[0]!.env.ZCODE_ACP_BOOT_CREATE_SESSION).toBe("1");
    // A hub-pre-generated placeholder id (UUID, same shape the bridge mints).
    expect(spawnCalls[0]!.env.ZCODE_ACP_RESUME_SESSION).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // Banner handshake: the auto-submitted trigger drops martty's welcome
    // banner so the window reveals the shared conversation.
    expect(spawnCalls[0]!.env.DSH_TUI_AUTOPROMPT).toBe(BOOT_RESUME_TRIGGER);
    await registerServeBridge(hub, "create-tui", spawnCalls[0]!.env.ZCODE_ACP_SPAWN_NONCE);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "create-tui", reused: false });
  });

  it("injects the user's dock filter into the incubation env from the config file", async () => {
    // The hub is a detached daemon whose birth env predates most shell
    // exports; tui.stats is resolved live from the user config file per
    // incubation so an edit reaches the next window without a hub restart.
    const cfgDir = await mkdtemp(path.join(tmpdir(), "zacp-tui-stats-"));
    track(cfgDir, (d) => rm(d, { recursive: true, force: true }));
    await mkdir(path.join(cfgDir, "zcode-acp"), { recursive: true });
    await writeFile(
      path.join(cfgDir, "zcode-acp", "config.json"),
      JSON.stringify({ tui: { stats: "tokens,context" } }),
    );
    vi.stubEnv("XDG_CONFIG_HOME", cfgDir);
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const pending = post(hub, { workspacePath: PROJECT });
    await new Promise((r) => setTimeout(r, 400)); // one poll tick
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.env.DSH_TUI_STATS).toBe("tokens,context");
    await registerServeBridge(hub, "stats-tui", spawnCalls[0]!.env.ZCODE_ACP_SPAWN_NONCE);
    const res = await pending;
    expect(res.status).toBe(200);
    vi.unstubAllEnvs();
  });

  it("answers a slow-to-register create with the live serve bridge instead of a 502", async () => {
    // P3: the 20s registration budget 502'd the POST and every App retry
    // incubated ANOTHER window (the observed placeholder storm). A live
    // headless serve bridge takes over the attach; the late window registers
    // on its own and is merely closable.
    const hub = await startTestHub({ spawnServe: spawnServeSpy(), tuiRegisterTimeoutMs: 700 });
    await registerServeBridge(hub, "listing-serve"); // the listing's headless bridge
    const res = await post(hub, { workspacePath: PROJECT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "listing-serve", reused: true });
  });

  it("still 502s a slow create when no serve bridge can take over", async () => {
    const hub = await startTestHub({ spawnServe: spawnServeSpy(), tuiRegisterTimeoutMs: 700 });
    const res = await post(hub, { workspacePath: PROJECT });
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("serve bridge did not register in time");
  });

  it("walks down the terminal list at the registration timeout before going headless", async () => {
    // Locked-screen Ghostty: the tab opens (launch succeeded) but its surface
    // init died, so the TUI never registers. The NEXT preference gets a fresh
    // budget; headless comes only after the list is exhausted (one rescue).
    const launches = [
      { kind: "openApp", app: "Ghostty" },
      { kind: "openApp", app: "Warp" },
    ];
    const hub = await startTestHub({
      spawnServe: spawnServeSpy(),
      tuiRegisterTimeoutMs: 500,
      terminalLaunches: launches as never,
    });
    const pending = post(hub, { workspacePath: PROJECT });
    await new Promise((r) => setTimeout(r, 700)); // first budget burns out
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]!.kind).toBe("tui");
    expect(spawnCalls[0]!.launch).toEqual(launches[0]);
    expect(spawnCalls[1]!.kind).toBe("tui");
    expect(spawnCalls[1]!.launch).toEqual(launches[1]);
    // The second window registers: the SAME nonce satisfies the incubation.
    await registerServeBridge(hub, "window-2", spawnCalls[1]!.env.ZCODE_ACP_SPAWN_NONCE);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "window-2", reused: false });
  });

  it("rescues headlessly only once after every terminal preference failed", async () => {
    const launches = [{ kind: "openApp", app: "Ghostty" }];
    const hub = await startTestHub({
      spawnServe: spawnServeSpy(),
      tuiRegisterTimeoutMs: 500,
      terminalLaunches: launches as never,
    });
    const pending = post(hub, { workspacePath: PROJECT });
    // First timeout: list exhausted → headless rescue (2nd spawn, kind serve).
    await new Promise((r) => setTimeout(r, 700));
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]!.kind).toBe("serve");
    // Rescue registers → answered; the incubation is settled, so no third
    // spawn even though the rescue's own budget also expires unanswered.
    await registerServeBridge(hub, "rescued", spawnCalls[1]!.env.ZCODE_ACP_SPAWN_NONCE);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "rescued", reused: false });
    await new Promise((r) => setTimeout(r, 700));
    expect(spawnCalls).toHaveLength(2);
  });

  it("skips a terminal whose launch fails and answers with a later preference", async () => {
    const launches = [
      { kind: "openApp", app: "Broken" },
      { kind: "openApp", app: "Warp" },
    ];
    const hub = await startTestHub({
      // First launch fails to open (null) — the walk continues at once,
      // without waiting for any registration budget.
      spawnServe: spawnServeSpy((opts) =>
        opts.launch && (opts.launch as { app: string }).app === "Broken"
          ? null
          : (fakeChild as unknown as import("node:child_process").ChildProcess),
      ),
      tuiRegisterTimeoutMs: 5_000,
      terminalLaunches: launches as never,
    });
    const pending = post(hub, { workspacePath: PROJECT });
    await new Promise((r) => setTimeout(r, 400));
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]!.launch).toEqual(launches[0]);
    expect(spawnCalls[1]!.launch).toEqual(launches[1]);
    await registerServeBridge(hub, "warp-window", spawnCalls[1]!.env.ZCODE_ACP_SPAWN_NONCE);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "warp-window", reused: false });
  });
});

describe("tab title sanitization", () => {
  it("strips control chars (no OSC/CSI injection), collapses whitespace, caps length", () => {
    // An ESC in a model-generated summary would otherwise inject terminal
    // sequences through the tab-title printf.
    expect(sanitizeTabTitle("Fix\u001b]0;evil\u0007 tab")).toBe("Fix ]0;evil tab");
    expect(sanitizeTabTitle(" a \n\t b ")).toBe("a b");
    expect(sanitizeTabTitle("x".repeat(120))).toHaveLength(80);
  });

  it("empty or non-string values read as undefined (caller falls back)", () => {
    expect(sanitizeTabTitle("   ")).toBeUndefined();
    expect(sanitizeTabTitle("")).toBeUndefined();
    expect(sanitizeTabTitle(undefined)).toBeUndefined();
    expect(sanitizeTabTitle(42)).toBeUndefined();
  });
});

describe("terminal launch resolution (ADR-0016)", () => {
  it("prefers the explicit command template over everything", () => {
    const out = resolveTerminalLaunch({}, { command: "my-term --run {script}", app: "iTerm" });
    expect(out.launch).toEqual({ kind: "shell", command: "my-term --run {script}" });
    expect(out.warning).toBeUndefined();
  });

  it("maps well-known apps to their verified launch mechanism", () => {
    expect(resolveTerminalLaunch({}, { app: "WezTerm" }).launch).toEqual({
      kind: "openAppArgs",
      app: "WezTerm",
      args: ["start", "--"],
    });
    expect(resolveTerminalLaunch({}, { app: "kitty" }).launch).toEqual({
      kind: "openAppArgs",
      app: "kitty",
      args: [],
    });
    expect(resolveTerminalLaunch({}, { app: "ghostty" }).launch).toEqual({
      kind: "ghosttyScript",
      app: "Ghostty",
    });
    expect(resolveTerminalLaunch({}, { app: "Alacritty" }).launch).toEqual({
      kind: "openAppArgs",
      app: "Alacritty",
      args: ["-e"],
    });
    // .command executors; aliases are case- and .app-suffix-insensitive.
    expect(resolveTerminalLaunch({}, { app: "iTerm.app" }).launch).toEqual({
      kind: "openApp",
      app: "iTerm",
    });
    expect(resolveTerminalLaunch({}, { app: "iterm2" }).launch).toEqual({
      kind: "openApp",
      app: "iTerm",
    });
    expect(resolveTerminalLaunch({}, { app: "Apple_Terminal" }).launch).toEqual({
      kind: "openApp",
      app: "Terminal",
    });
  });

  it("maps Warp onto its URI-scheme launcher (new_tab executes the script)", () => {
    expect(resolveTerminalLaunch({}, { app: "Warp" }).launch).toEqual({
      kind: "warpUri",
      app: "Warp",
      scheme: "warp",
    });
    // Preview channel: different app bundle AND scheme.
    expect(resolveTerminalLaunch({}, { app: "Warp Preview" }).launch).toEqual({
      kind: "warpUri",
      app: "Warp Preview",
      scheme: "warppreview",
    });
  });

  it("passes unknown apps through to open -a and defaults to Terminal.app", () => {
    expect(resolveTerminalLaunch({}, { app: "MyTerm" }).launch).toEqual({
      kind: "openApp",
      app: "MyTerm",
    });
    expect(resolveTerminalLaunch({}, {}).launch).toEqual({ kind: "openApp", app: "Terminal" });
    // The hub is a background process — its own env has no terminal, and
    // TERM_PROGRAM (at best an accident of how the hub was launched) is
    // never consulted.
    expect(resolveTerminalLaunch({ TERM_PROGRAM: "iTerm.app" }, {}).launch).toEqual({
      kind: "openApp",
      app: "Terminal",
    });
  });

  it("ghostty rides AppleScript: new tab in the front window, prompt-free command", () => {
    const src = ghosttyTabAppleScript("Ghostty", '/ws/.zcode/tmp/tui-ab12"cd.command');
    expect(src).toContain('tell application "Ghostty"');
    // activate is best-effort (try): on a LOCKED screen it fails with a
    // permission violation and would otherwise abort the whole tell block.
    expect(src).toContain("try\nactivate\nend try");
    // No windows → a fresh one; otherwise reuse the front window (no -n spawn).
    expect(src).toContain("if (count of windows) = 0 then");
    expect(src).toContain("set tgt to front window");
    // The script runs via a surface configuration command — never `-e`, which
    // trips Ghostty's per-launch "Allow Ghostty to Execute" gate.
    expect(src).not.toContain("-e ");
    expect(src).toContain('set command of cfg to "/bin/sh " &');
    // AppleScript string escaping: backslash and double-quote survive.
    expect(src).toContain('\\"cd.command');
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
