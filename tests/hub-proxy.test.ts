/**
 * Hub proxy integration tests — the WS byte proxy, remote session-create
 * incubation (ADR-0014), project session history (ADR-0015), terminal-TUI
 * resume/create incubation (ADR-0017), and the terminal launch/script
 * resolution (ADR-0016) those incubations build on.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { WebSocket, WebSocketServer } from "ws";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The session-create endpoints read the known-project whitelist from
// tasks-index; mock the module so no real sqlite/App store is touched.
// isTaskDeleted (resume tombstone guard) defaults to false — resume paths
// must behave exactly as before unless a test opts into a tombstone.
const { isTaskDeletedMock, listKnownWorkspacesMock } = vi.hoisted(() => ({
  listKnownWorkspacesMock: vi.fn(),
  isTaskDeletedMock: vi.fn(async () => false),
}));
vi.mock("../src/tasks-index.js", () => ({
  listKnownWorkspaces: listKnownWorkspacesMock,
  isTaskDeleted: isTaskDeletedMock,
}));

import {
  DESKTOP_CLIENT_NAME,
  resolveTerminalLaunch,
  sanitizeTabTitle,
  startHub,
  type HubHandle,
} from "../src/remote/hub-server.js";
import { isClosedSessionId } from "../src/closed-sessions.js";
import { zcodeHomeDir } from "../src/utils.js";

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
    // A registered instance, so the unknown-instance rejection has something
    // to list under "known:" — that list is what tells an operator whether the
    // client held a stale id or the bridge itself was pruned.
    await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody()),
    });
    // The rejection log must NAME the instance: diagnosing a live outage
    // (2026-10-21) meant guessing which instance a client was attached to,
    // because both rejections logged without an id.
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
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
    } finally {
      process.stderr.write = write;
    }
    const log = stderr.join("");
    // Unauthorized: names the requested instance.
    expect(log).toContain("unauthorized WS upgrade rejected");
    expect(log).toContain("instance=inst-1");
    // Unknown instance: names the requested id AND what IS registered.
    expect(log).toContain("unknown instance rejected");
    expect(log).toContain("id=unknown");
    expect(log).toMatch(/known: .*inst-1/);
  });

  it("a corpse instance: dial failure answers 502 and prunes the registration", async () => {
    // Regression (observed 2026-10-20): a serve bridge self-exits ~1.5s
    // after its last session closes, but the registration lives until the
    // heartbeat TTL — every attach in that window dialed the corpse, and
    // Bun's WebSocket reported the failed connect through a second dispatch
    // path that landed as an unhandled 'error' (uncaught exception in the
    // diary). The dial must fail cleanly (502, no throw) AND prune so the
    // client's next attempt reads "unknown instance" and re-incubates
    // instead of retrying the corpse for the whole TTL.
    const hub = await startTestHub();
    // A definitely-closed port: bind ephemeral, then release.
    const probe = createServer();
    const closedPort = await new Promise<number>((resolve) => {
      probe.listen(0, "127.0.0.1", () => {
        const addr = probe.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        probe.close(() => resolve(port));
      });
    });
    await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody({ port: closedPort })),
    });
    const before = (await (await listInstances(hub)).json()) as Array<{ id: string }>;
    expect(before.map((i) => i.id)).toContain("inst-1");

    const client = new WebSocket(`ws://127.0.0.1:${hub.port}/acp?instance=inst-1&token=${TOKEN}`);
    const failed = new Promise<void>((resolve, reject) => {
      client.once("error", (e: Error) => {
        // ws surfaces the written 502 as an unexpected server response.
        if (!e.message.includes("502")) reject(new Error(`expected 502, got: ${e.message}`));
        else resolve();
      });
    });
    await withTimeout(failed, 3000, "corpse dial 502");

    // The registration is gone — the next attempt reads "unknown instance".
    const after = (await (await listInstances(hub)).json()) as Array<{ id: string }>;
    expect(after.map((i) => i.id)).not.toContain("inst-1");
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
});

describe("hub terminal-TUI session resume (ADR-0017)", () => {
  const PROJECT = "/Users/dev/Develop/demo";
  const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

  /** The durable close record the shutdown-retirement tests write (hermetic HOME). */
  const closedSessionsStore = () => path.join(zcodeHomeDir(), "v2", "acp-closed-sessions.json");
  const post = (hub: HubHandle, body: Record<string, unknown>): Promise<Response> =>
    fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    });

  /** A real killable placeholder process standing in for a serve bridge. */
  async function startDummyBridge(): Promise<number> {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => {
      if (child.pid) resolve();
      else child.once("spawn", () => resolve());
    });
    cleanups.push(() => child.kill("SIGKILL"));
    return child.pid!;
  }

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
    rmSync(closedSessionsStore(), { force: true });
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

  it("refuses an AUTO resume of a remotely closed session (409) but lets a user resume through", async () => {
    // The resurrection bug (ADR-0006 follow-up): the phone closes a session,
    // the desktop tab's reconnect ladder finds its bridge gone and POSTs a
    // resume for the same sid seconds later — re-incubating what was just
    // closed. The hub records the proxied close: the cached entry drops the
    // sid at once (not one heartbeat later), AUTO resumes are refused, and a
    // user-intent resume (a human picking the session) passes and clears
    // the stone — close retires, it never deletes.
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const bridge = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    const bridgePort = await new Promise<number>((resolve) => {
      bridge.listen(0, "127.0.0.1", () => {
        const addr = bridge.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    track(bridge, (s) => new Promise<void>((resolve) => s.close(() => resolve())));
    const advertise = () =>
      fetch(`http://127.0.0.1:${hub.port}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          registerBody({
            id: "holder",
            workspace: PROJECT,
            origin: "serve",
            port: bridgePort,
            sessions: [{ sessionId: "sess_closed", title: "t", updatedAt: 1 }],
          }),
        ),
      });
    expect((await advertise()).ok).toBe(true);
    const sidsOf = async () => {
      const list = (await (await listInstances(hub)).json()) as Array<{
        id: string;
        sessions: Array<{ sessionId: string }>;
      }>;
      return list.find((e) => e.id === "holder")!.sessions.map((s) => s.sessionId);
    };
    expect(await sidsOf()).toEqual(["sess_closed"]);

    const closed = await fetch(
      `http://127.0.0.1:${hub.port}/api/instances/holder/sessions/sess_closed/close`,
      { method: "POST", headers: auth },
    );
    expect(closed.status).toBe(200);
    // Immediate: the listing no longer offers the sid before any heartbeat.
    expect(await sidsOf()).toEqual([]);

    const auto = await post(hub, {
      workspacePath: PROJECT,
      sessionId: "sess_closed",
      intent: "auto",
    });
    expect(auto.status).toBe(409);
    expect(await auto.text()).toBe("session closed");
    expect(spawnCalls).toHaveLength(0);

    // A heartbeat already in flight when the close landed still carries the
    // sid from its pre-close snapshot; it must not clear the fresh stone.
    expect((await advertise()).ok).toBe(true);
    const autoAgain = await post(hub, {
      workspacePath: PROJECT,
      sessionId: "sess_closed",
      intent: "auto",
    });
    expect(autoAgain.status).toBe(409);

    // User intent (the default — older clients send none) passes the gate
    // and incubates the resume as before.
    const user = post(hub, { workspacePath: PROJECT, sessionId: "sess_closed" });
    await new Promise((r) => setTimeout(r, 400)); // one poll tick
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.env.ZCODE_ACP_RESUME_SESSION).toBe("sess_closed");
    await registerServeBridge(hub, "resume-repl", spawnCalls[0]!.env.ZCODE_ACP_SPAWN_NONCE);
    expect((await user).status).toBe(200);

    // The stone is gone: an AUTO resume is honest again (the ladder may
    // re-incubate a session the user reopened on purpose).
    const afterReopen = post(hub, {
      workspacePath: PROJECT,
      sessionId: "sess_closed",
      intent: "auto",
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(spawnCalls).toHaveLength(2);
    await registerServeBridge(hub, "resume-repl-2", spawnCalls[1]!.env.ZCODE_ACP_SPAWN_NONCE);
    expect((await afterReopen).status).toBe(200);
  });

  it("tombstones EVERY spelling of the closed conversation, not just the URL's", async () => {
    // The sid-alias hole (review of the close-tombstone feature): the same
    // conversation is addressable under different spellings — discovery
    // shows the editor alias, a reconnect ladder may quote the backend
    // sess_ id. The close answer carries the bridge-resolved spelling set,
    // and the tombstone, the cached-entry drop, and every clear path operate
    // on the whole GROUP: autos are refused whichever id they quote, and a
    // user resume under ONE spelling revives them all.
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const bridge = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true,"sessionIds":["acp-alias-1","sess_backend_1"]}');
    });
    const bridgePort = await new Promise<number>((resolve) => {
      bridge.listen(0, "127.0.0.1", () => {
        const addr = bridge.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    track(bridge, (s) => new Promise<void>((resolve) => s.close(() => resolve())));
    const advertise = (sessionId: string) =>
      fetch(`http://127.0.0.1:${hub.port}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          registerBody({
            id: "holder",
            workspace: PROJECT,
            origin: "serve",
            port: bridgePort,
            sessions: [{ sessionId, title: "t", updatedAt: 1 }],
          }),
        ),
      });
    expect((await advertise("acp-alias-1")).ok).toBe(true);
    const sidsOf = async () => {
      const list = (await (await listInstances(hub)).json()) as Array<{
        id: string;
        sessions: Array<{ sessionId: string }>;
      }>;
      return list.find((e) => e.id === "holder")!.sessions.map((s) => s.sessionId);
    };
    expect(await sidsOf()).toEqual(["acp-alias-1"]);

    // Close by the ALIAS spelling (what the listing offered); the bridge's
    // 200 answer names the backend spelling too.
    const closed = await fetch(
      `http://127.0.0.1:${hub.port}/api/instances/holder/sessions/acp-alias-1/close`,
      { method: "POST", headers: auth },
    );
    expect(closed.status).toBe(200);
    expect(await sidsOf()).toEqual([]);

    // The ladder quoting the OTHER spelling is still refused — the single-
    // key tombstone used to let exactly this through.
    expect(
      (await post(hub, { workspacePath: PROJECT, sessionId: "sess_backend_1", intent: "auto" }))
        .status,
    ).toBe(409);
    expect(
      (await post(hub, { workspacePath: PROJECT, sessionId: "acp-alias-1", intent: "auto" }))
        .status,
    ).toBe(409);
    expect(spawnCalls).toHaveLength(0);

    // A user resume under the alias revives the whole group: the backend
    // spelling is honest again for autos too.
    const user = post(hub, { workspacePath: PROJECT, sessionId: "acp-alias-1" });
    await new Promise((r) => setTimeout(r, 400)); // one poll tick
    expect(spawnCalls).toHaveLength(1);
    await registerServeBridge(hub, "resume-repl", spawnCalls[0]!.env.ZCODE_ACP_SPAWN_NONCE);
    expect((await user).status).toBe(200);
    const auto = post(hub, {
      workspacePath: PROJECT,
      sessionId: "sess_backend_1",
      intent: "auto",
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(spawnCalls).toHaveLength(2);
    await registerServeBridge(hub, "resume-repl-2", spawnCalls[1]!.env.ZCODE_ACP_SPAWN_NONCE);
    expect((await auto).status).toBe(200);
  });

  it("shutdown retires every advertised session before the kill (ADR-0006 hardening)", async () => {
    // The old hole: /shutdown killed the pid and nothing else, so the
    // conversations died with NO retirement memory anywhere — an auto
    // reconnect ladder re-incubated the workspace and resurrected them
    // (old mobile clients still use the shutdown gesture instead of
    // per-session close). Shutdown must relay the bridge's own close route
    // per advertised session with force semantics FIRST, tombstone every
    // spelling the bridge reports, and write the durable close record so a
    // respawned serve bridge refuses the auto session/load too.
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const closes: Array<{ path: string; body: string }> = [];
    const bridge = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const sid = (req.url ?? "").split("/")[2];
        closes.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            sessionIds: sid === "alias-a" ? ["alias-a", "sess_backend_a"] : [sid],
          }),
        );
      });
    });
    const bridgePort = await new Promise<number>((resolve) => {
      bridge.listen(0, "127.0.0.1", () => {
        const addr = bridge.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    track(bridge, (s) => new Promise<void>((resolve) => s.close(() => resolve())));
    const pid = await startDummyBridge();
    const registered = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        registerBody({
          id: "inst-shutdown",
          workspace: PROJECT,
          origin: "serve",
          port: bridgePort,
          pid,
          sessions: [
            { sessionId: "alias-a", title: "t", updatedAt: 1 },
            { sessionId: "alias-b", title: "t", updatedAt: 1 },
          ],
        }),
      ),
    });
    expect(registered.ok).toBe(true);

    const shutdown = await fetch(
      `http://127.0.0.1:${hub.port}/api/instances/inst-shutdown/shutdown`,
      { method: "POST", headers: auth },
    );
    expect(shutdown.status).toBe(200);

    // Every advertised session went through the bridge's close route with
    // force semantics (the gesture is "end it"), BEFORE the kill.
    expect(closes.map((c) => c.path).sort()).toEqual([
      "/sessions/alias-a/close",
      "/sessions/alias-b/close",
    ]);
    expect(closes.every((c) => c.body === '{"force":true}')).toBe(true);

    // Auto resumes are refused under EVERY spelling — the alias the listing
    // showed AND the backend id a ladder may quote.
    for (const sid of ["alias-a", "sess_backend_a", "alias-b"]) {
      expect(
        (await post(hub, { workspacePath: PROJECT, sessionId: sid, intent: "auto" })).status,
      ).toBe(409);
    }
    expect(spawnCalls).toHaveLength(0);

    // The durable half: a respawned serve bridge reads this record to refuse
    // the auto session/load of the same conversation.
    expect(isClosedSessionId("alias-a")).toBe(true);
    expect(isClosedSessionId("sess_backend_a")).toBe(true);
    expect(isClosedSessionId("alias-b")).toBe(true);

    // Shutdown retires, never deletes: a user-intent resume still reopens.
    const user = post(hub, { workspacePath: PROJECT, sessionId: "sess_backend_a" });
    await new Promise((r) => setTimeout(r, 400)); // one poll tick
    expect(spawnCalls).toHaveLength(1);
    await registerServeBridge(hub, "resume-repl", spawnCalls[0]!.env.ZCODE_ACP_SPAWN_NONCE);
    expect((await user).status).toBe(200);
  });

  it("shutdown falls back to hub-side retirement when the bridge is unreachable", async () => {
    // A wedged or already-dead bridge must not dodge retirement: the relay
    // fails fast and the hub stamps the ADVERTISED spelling itself — the
    // tombstone still 409s the auto ladder, and the durable record keeps a
    // respawned bridge honest.
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const pid = await startDummyBridge();
    const registered = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        registerBody({
          id: "inst-wedged",
          workspace: PROJECT,
          origin: "serve",
          port: 1, // nothing listens — the relay dies with ECONNREFUSED
          pid,
          sessions: [{ sessionId: "alias-x", title: "t", updatedAt: 1 }],
        }),
      ),
    });
    expect(registered.ok).toBe(true);

    const shutdown = await fetch(
      `http://127.0.0.1:${hub.port}/api/instances/inst-wedged/shutdown`,
      { method: "POST", headers: auth },
    );
    expect(shutdown.status).toBe(200);
    expect(
      (await post(hub, { workspacePath: PROJECT, sessionId: "alias-x", intent: "auto" })).status,
    ).toBe(409);
    expect(isClosedSessionId("alias-x")).toBe(true);
    expect(spawnCalls).toHaveLength(0);
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
});

describe("hub Desktop Presence (ADR-0016 amendment)", () => {
  const PROJECT = "/Users/dev/Develop/demo";
  const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  const post = (
    hub: HubHandle,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
      method: "POST",
      headers: { ...auth, ...headers },
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

  function spawnServeSpy() {
    return (opts: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      kind: "tui" | "serve";
      launch?: unknown;
    }) => {
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

  /** Echo bridge as the attach target — the hub dials it on every WS upgrade. */
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

  /**
   * Attach a hub WS client and run its `initialize` — the frame the presence
   * watcher peeks at. Resolves once the initialize made the full round trip
   * (the echo bridge returns it), which guarantees the hub has seen it.
   */
  async function connectClient(hub: HubHandle, clientInfo?: { name: string }): Promise<WebSocket> {
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
    const echoed = withTimeout(
      new Promise<void>((resolve) => client.once("message", () => resolve())),
      3000,
      "initialize echo",
    );
    client.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          ...(clientInfo ? { clientInfo } : {}),
        },
      }),
    );
    await echoed;
    return client;
  }

  it("incubates session-create headlessly while a desktop client is connected", async () => {
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    const echo = track(
      await startEchoBridge(),
      ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody({ port: echo.port })),
    });
    await connectClient(hub, { name: DESKTOP_CLIENT_NAME });

    const pending = post(hub, { workspacePath: PROJECT });
    await new Promise((r) => setTimeout(r, 400)); // one poll tick
    // Desktop Presence: no terminal attempt at all — the FIRST spawn is the
    // detached headless serve form (the exhausted-preference-list fallback
    // shape, same as ZCODE_ACP_HUB_TERMINAL=0).
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.kind).toBe("serve");
    expect(spawnCalls[0]!.launch).toBeUndefined();
    // NO boot handshake on a headless spawn. A serve bridge does NOT ignore
    // these: the binding is per-bridge and permanent
    // (server.bootCreateBindSession), and Desktop Presence reuses this same
    // bridge for every later create — so an armed bind made each later
    // connection's first session/new return the conversation that was
    // already open, and the desktop app could not start a new session at all
    // while one existed (observed 2026-11-04).
    expect(spawnCalls[0]!.env.ZCODE_ACP_BOOT_CREATE_SESSION).toBeUndefined();
    expect(spawnCalls[0]!.env.ZCODE_ACP_RESUME_SESSION).toBeUndefined();
    expect(spawnCalls[0]!.env.DSH_TUI_AUTOPROMPT).toBeUndefined();
    await registerServeBridge(hub, "serve-headless", spawnCalls[0]!.env.ZCODE_ACP_SPAWN_NONCE);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "serve-headless", reused: false });
  });

  /** The desktop app's discovery poll: GET /api/instances stamped with its identity. */
  const desktopPoll = (hub: HubHandle, token = TOKEN): Promise<Response> =>
    fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
      headers: { Authorization: `Bearer ${token}`, "x-zcode-client": DESKTOP_CLIENT_NAME },
    });

  it("an unauthorized stamped call is not presence", async () => {
    // The header is a UX hint, the token is the boundary: a bare header on
    // the network must not be able to suppress the user's windows.
    const hub = await startTestHub({ spawnServe: spawnServeSpy() });
    expect((await desktopPoll(hub, "wrong-token")).status).toBe(401);

    const pending = post(hub, { workspacePath: PROJECT });
    await new Promise((r) => setTimeout(r, 400)); // one poll tick
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.kind).toBe("tui");
    await registerServeBridge(hub, "w-unauth", spawnCalls[0]!.env.ZCODE_ACP_SPAWN_NONCE);
    expect((await pending).status).toBe(200);
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
});

describe("terminal launch resolution (ADR-0016)", () => {
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
});

describe("remote projectRoots widening + GET /api/fs/list (browse-and-create)", () => {
  const auth = { Authorization: `Bearer ${TOKEN}` };
  // Real temp dirs; the hub's startable-dir gate only requires an existing
  // directory (the temp-tree exclusions guard the AUTO-discovered known
  // list, not explicitly configured roots), so tmpdir works fine here.
  // Assertions compare against realpathSync spellings: /api/fs/list answers
  // with the RESOLVED path (/var → /private/var on macOS).
  let roots: string;
  let outside: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    roots = await mkdtemp(path.join(tmpdir(), "zacp-hub-roots-"));
    outside = await mkdtemp(path.join(tmpdir(), "zacp-hub-outside-"));
    savedEnv.ZCODE_ACP_PROJECT_ROOTS = process.env.ZCODE_ACP_PROJECT_ROOTS;
    // The hermetic HOME has no config.json → the env var decides.
    process.env.ZCODE_ACP_PROJECT_ROOTS = roots;
    listKnownWorkspacesMock.mockReset();
    listKnownWorkspacesMock.mockResolvedValue([]);
  });

  afterEach(async () => {
    if (savedEnv.ZCODE_ACP_PROJECT_ROOTS === undefined) delete process.env.ZCODE_ACP_PROJECT_ROOTS;
    else process.env.ZCODE_ACP_PROJECT_ROOTS = savedEnv.ZCODE_ACP_PROJECT_ROOTS;
    await Promise.all([roots, outside].map((d) => rm(d, { recursive: true, force: true })));
  });

  it("POST /api/instances accepts a NEW subdirectory under a configured root", async () => {
    const target = path.join(roots, "fresh-project");
    await mkdir(target);
    const fakeChild = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: string | null;
    };
    fakeChild.pid = 4242;
    fakeChild.exitCode = null;
    fakeChild.signalCode = null;
    const spawns: Array<{ cwd: string; kind: string; env: NodeJS.ProcessEnv }> = [];
    const hub = await startTestHub({
      spawnServe: (opts) => {
        spawns.push(opts as { cwd: string; kind: string; env: NodeJS.ProcessEnv });
        return fakeChild as unknown as import("node:child_process").ChildProcess;
      },
    });
    const pending = fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath: target }),
    });
    await new Promise((r) => setTimeout(r, 400)); // one poll tick
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.cwd).toBe(target);
    expect(spawns[0]!.kind).toBe("tui");
    const reg = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        registerBody({
          id: "serve-window",
          workspace: target,
          origin: "serve",
          nonce: spawns[0]!.env.ZCODE_ACP_SPAWN_NONCE,
        }),
      ),
    });
    expect(reg.ok).toBe(true);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "serve-window", reused: false });
  });

  it("POST still refuses existing dirs outside every root and vanished paths under one", async () => {
    let spawnCount = 0;
    const hub = await startTestHub({
      spawnServe: () => {
        spawnCount++;
        return null;
      },
    });
    const url = `http://127.0.0.1:${hub.port}/api/instances`;
    for (const workspacePath of [outside, path.join(roots, "never-created")]) {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ workspacePath }),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("unknown project");
    }
    expect(spawnCount).toBe(0);
  });

  it("GET /api/fs/list requires auth and lists home by default", async () => {
    const hub = await startTestHub();
    expect((await fetch(`http://127.0.0.1:${hub.port}/api/fs/list`)).status).toBe(401);
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/fs/list`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe(realpathSync(homedir()));
  });
});

describe("hub stale-bridge reuse (new work never lands on old code)", () => {
  // Reported 2026-11-10: a Start Plan entitlement fix was released, rebuilt
  // and RELOADED locally, yet every "new" conversation still offered the old
  // model list. Cause: one serve bridge per workspace, reused forever — a
  // process loads its modules once, so its handlers and model list are frozen
  // at spawn time. Reuse therefore has to consider WHICH CODE the bridge runs,
  // not just whether it is alive.
  const PROJECT = "/Users/dev/Develop/demo";
  const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  const desktop = (hub: HubHandle, body: Record<string, unknown>): Promise<Response> =>
    fetch(`http://127.0.0.1:${hub.port}/api/instances`, {
      method: "POST",
      headers: { ...auth, "x-zcode-client": DESKTOP_CLIENT_NAME },
      body: JSON.stringify(body),
    });

  let fakeChild: EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null };
  let spawnCalls: Array<{
    cwd: string;
    env: NodeJS.ProcessEnv;
    kind: "tui" | "serve";
    launch?: unknown;
  }>;
  /** Fake dist: `code-fingerprint.json` + one .js whose mtime is the "build". */
  let distDir: string;

  beforeEach(async () => {
    listKnownWorkspacesMock.mockReset();
    listKnownWorkspacesMock.mockResolvedValue([
      { workspacePath: PROJECT, sessions: 3, lastActive: 1234 },
    ]);
    fakeChild = new EventEmitter() as typeof fakeChild;
    fakeChild.pid = 4242;
    fakeChild.exitCode = null;
    fakeChild.signalCode = null;
    spawnCalls = [];
    distDir = await mkdtemp(path.join(tmpdir(), "hub-stale-dist-"));
    cleanups.push(() => rm(distDir, { recursive: true, force: true }));
    await writeShip("current");
  });

  /** Publish a build to the fake dist: fingerprint + a freshly written .js. */
  async function writeShip(fingerprint: string): Promise<void> {
    await writeFile(path.join(distDir, "index.js"), `// ${fingerprint}\n`);
    await writeFile(
      path.join(distDir, "code-fingerprint.json"),
      JSON.stringify({ fingerprint, fileCount: 1 }),
    );
  }

  function spawnServeSpy() {
    return (opts: { cwd: string; env: NodeJS.ProcessEnv; kind: "tui" | "serve" }) => {
      spawnCalls.push(opts);
      return fakeChild as unknown as import("node:child_process").ChildProcess;
    };
  }

  async function register(
    hub: HubHandle,
    id: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        registerBody({
          id,
          workspace: PROJECT,
          origin: "serve",
          port: BASE_PORT + 70,
          pid: 4242,
          ...extra,
        }),
      ),
    });
    expect(res.ok).toBe(true);
  }

  /** A hub whose /api/upgrade-style disk view is the fake dist, not this repo. */
  const startStaleHub = (): Promise<HubHandle> =>
    startTestHub({
      spawnServe: spawnServeSpy(),
      codePaths: {
        packageJson: path.join(distDir, "package.json"),
        distDir,
      },
    });

  it("a create does not reuse a bridge running older code (it incubates a fresh one)", async () => {
    const hub = await startStaleHub();
    // Registered with the PREVIOUS build's fingerprint; the disk now has another.
    await register(hub, "serve-stale", { codeFingerprint: "previous" });
    const pending = desktop(hub, { workspacePath: PROJECT });
    await new Promise((r) => setTimeout(r, 400)); // one poll tick
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.kind).toBe("serve");
    await register(hub, "serve-fresh", {
      codeFingerprint: "current",
      nonce: spawnCalls[0]!.env.ZCODE_ACP_SPAWN_NONCE,
    });
    const res = await pending;
    expect(await res.json()).toEqual({ id: "serve-fresh", reused: false });
  });

  it("a resume of a live conversation still lands on its holder, stale or not", async () => {
    // Two bridges must never load one conversation. Code staleness justifies a
    // fresh bridge for NEW work only — never a second load of a live session.
    const hub = await startStaleHub();
    await register(hub, "serve-stale", {
      codeFingerprint: "previous",
      sessions: [{ sessionId: "sess_live", title: "live", updatedAt: 5 }],
    });
    const res = await desktop(hub, { workspacePath: PROJECT, sessionId: "sess_live" });
    expect(await res.json()).toEqual({ id: "serve-stale", reused: true });
    expect(spawnCalls).toHaveLength(0);
  });

  it("never kills the stale bridge — it stays registered with its sessions", async () => {
    // The old bridge may be mid-turn with clients attached. Only routing
    // changes: nothing here signals, prunes or shuts it down for being stale
    // (it exits on its own serve idle window once its work is done).
    const hub = await startStaleHub();
    await register(hub, "serve-stale", {
      codeFingerprint: "previous",
      sessions: [{ sessionId: "sess_busy", title: "busy", updatedAt: 9 }],
    });
    // Trigger the staleness verdict twice: a create and a history listing.
    const create = desktop(hub, { workspacePath: PROJECT });
    await new Promise((r) => setTimeout(r, 400));
    expect(spawnCalls).toHaveLength(1); // it WAS judged stale…
    const list = (await (await listInstances(hub)).json()) as Array<{
      id: string;
      sessions: Array<{ sessionId: string }>;
    }>;
    const stale = list.find((i) => i.id === "serve-stale");
    expect(stale).toBeDefined(); // …and still registered
    expect(stale!.sessions.map((s) => s.sessionId)).toContain("sess_busy");
    // Finish the incubation so the create does not dangle.
    await register(hub, "serve-fresh", {
      codeFingerprint: "current",
      nonce: spawnCalls[0]!.env.ZCODE_ACP_SPAWN_NONCE,
    });
    expect(await (await create).json()).toEqual({ id: "serve-fresh", reused: false });
  });
});
