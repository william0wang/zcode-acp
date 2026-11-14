/**
 * Remote Terminal relay (app ADR-0011): the hub as a dumb authenticated pipe
 * — endpoint auth, the exec gate (accept-time, per-frame, and the keepalive
 * sweep), control/client pairing, verbatim both-way relay, hub-consumed
 * push/audit frames (push through the shared push pipeline), control
 * supersession and loss. `utils.warn` is mocked to observe audit lines
 * (they ride warn for the on-disk diary) without touching stdout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebSocket } from "ws";

const logMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());
vi.mock("../src/utils.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  log: logMock,
  warn: warnMock,
}));

/** Per-test push config the shared pipeline reads (null = push inactive). */
const pushState = vi.hoisted(() => ({
  cfg: null as null | { contentDetail: "full" | "minimal"; notify: Record<string, boolean> },
}));
vi.mock("../src/push/config.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pushConfig: () => pushState.cfg,
  pushActive: () => pushState.cfg !== null,
}));

import {
  DESKTOP_CLIENT_NAME,
  startHub,
  type HubHandle,
  type HubOptions,
} from "../src/remote/hub-server.js";
import { resetPushSenderForTests, setPushSenderForTests } from "../src/push/push.js";

const TOKEN = "terminal-relay-token";
const CONTROL = `/api/desktop-control`;
const CLIENT = `/api/terminals/ws`;

/** The per-test exec-switch state the hub's gate reads through a closure. */
let execOn = true;

const cleanups: Array<() => Promise<void> | void> = [];

async function startTestHub(extra: HubOptions = {}): Promise<HubHandle> {
  const hub = await startHub({
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
    stayAliveCheck: () => false,
    execEnabled: () => execOn,
    ...extra,
  });
  cleanups.push(() => hub.close());
  return hub;
}

function connect(
  hub: HubHandle,
  path: string,
  opts: { token?: string; desktop?: boolean } = {},
): WebSocket {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.desktop) headers["x-zcode-client"] = DESKTOP_CLIENT_NAME;
  return new WebSocket(`ws://127.0.0.1:${hub.port}${path}`, { headers });
}

const controlWs = (hub: HubHandle): WebSocket =>
  connect(hub, CONTROL, { token: TOKEN, desktop: true });
const clientWs = (hub: HubHandle): WebSocket => connect(hub, CLIENT, { token: TOKEN });

const opened = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

const nextMessage = (ws: WebSocket): Promise<Record<string, unknown>> =>
  new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(String(data)))));

const nextClose = (ws: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise((resolve) =>
    ws.once("close", (code, reason) => resolve({ code, reason: String(reason) })),
  );

/** Read the hub-generated subscriber-count frame off the control wire. */
const expectSubs = async (ws: WebSocket, count: number): Promise<void> => {
  expect(await nextMessage(ws)).toEqual({ v: 1, type: "subs", count });
};

/** Resolve when the socket closes, or reject after `ms` (nothing should arrive). */
const nothingArrives = (ws: WebSocket, ms = 300): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(), ms);
    ws.once("message", (data) => {
      clearTimeout(t);
      reject(new Error(`unexpected frame: ${String(data)}`));
    });
    ws.once("close", () => {
      clearTimeout(t);
      resolve();
    });
  });

/** An upgrade rejected with an HTTP status surfaces as this client error. */
const rejectedWith = (ws: WebSocket, status: number): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.once("open", () => reject(new Error("upgrade unexpectedly accepted")));
    ws.once("error", (err: Error) => {
      // ws 8.x reports a non-101 as "Unexpected server response: <code>" with
      // no structured field to read.
      if (err.message.includes(`Unexpected server response: ${status}`)) resolve();
      else reject(new Error(`expected HTTP ${status}, got: ${err.message}`));
    });
  });

beforeEach(() => {
  execOn = true;
  logMock.mockClear();
  warnMock.mockClear();
  pushState.cfg = null;
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  resetPushSenderForTests();
});

describe("terminal relay endpoints", () => {
  it("rejects unauthorized upgrades on both endpoints", async () => {
    const hub = await startTestHub();
    await Promise.all([
      rejectedWith(connect(hub, CONTROL, { desktop: true }), 401),
      rejectedWith(connect(hub, CLIENT), 401),
    ]);
  });

  it("refuses a control connection without the desktop identity header", async () => {
    const hub = await startTestHub();
    // Token correct, but a browser/phone client cannot set x-zcode-client.
    await rejectedWith(connect(hub, CONTROL, { token: TOKEN }), 403);
  });

  it("refuses client sockets with no workbench connected (no_carrier)", async () => {
    const hub = await startTestHub();
    const ws = clientWs(hub);
    // Attach before awaiting open: the 101, error frame, and close often land
    // in one TCP segment — listeners attached after `open` would miss them.
    const first = nextMessage(ws);
    const gone = nextClose(ws);
    await opened(ws);
    expect(await first).toMatchObject({ type: "error", code: "no_carrier" });
    expect((await gone).code).toBe(4001);
  });

  it("refuses client sockets while the exec switch is off (disabled)", async () => {
    execOn = false;
    const hub = await startTestHub();
    const ws = clientWs(hub);
    const first = nextMessage(ws);
    const gone = nextClose(ws);
    await opened(ws);
    expect(await first).toMatchObject({ type: "error", code: "disabled" });
    expect((await gone).code).toBe(4001);
  });
});

describe("terminal relay pairing", () => {
  it("relays frames verbatim both ways", async () => {
    const hub = await startTestHub();
    const control = controlWs(hub);
    await opened(control);
    const client = clientWs(hub);
    await opened(client);
    await expectSubs(control, 1);

    const turn = { v: 1, type: "turn", command: "echo hi" };
    client.send(JSON.stringify(turn));
    expect(await nextMessage(control)).toEqual(turn);

    const state = { v: 1, type: "state", terminal: { state: "ready" } };
    control.send(JSON.stringify(state));
    expect(await nextMessage(client)).toEqual(state);
  });

  it("consumes push and audit frames at the hub, never relaying them", async () => {
    const hub = await startTestHub();
    const control = controlWs(hub);
    await opened(control);
    const client = clientWs(hub);
    await opened(client);

    control.send(JSON.stringify({ v: 1, type: "audit", line: "turn t1 exit 0 12ms: echo hi" }));
    control.send(JSON.stringify({ v: 1, type: "push", title: "done", body: "exit 0" }));
    // The next relayed frame proves the two above were consumed, not relayed.
    control.send(JSON.stringify({ v: 1, type: "state" }));
    expect(await nextMessage(client)).toEqual({ v: 1, type: "state" });
    await nothingArrives(client);
    // Audit rides warn (not log) — the on-disk diary is the only production
    // record for the daemon's null stderr.
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining("turn t1 exit 0"));
  });

  it("drops clients when the control connection goes", async () => {
    const hub = await startTestHub();
    const control = controlWs(hub);
    await opened(control);
    const client = clientWs(hub);
    await opened(client);

    control.close();
    const [frame, close] = await Promise.all([nextMessage(client), nextClose(client)]);
    expect(frame).toMatchObject({ type: "error", code: "no_carrier" });
    expect(close.code).toBe(4001);
  });

  it("supersedes a second control connection", async () => {
    const hub = await startTestHub();
    const first = controlWs(hub);
    await opened(first);
    // Attach the close listener BEFORE the superseding connection opens — the
    // close frame can land in the same event-loop batch as the second open,
    // and a listener attached after `await opened(second)` may already be late.
    const gone = nextClose(first);
    const second = controlWs(hub);
    await opened(second);

    const client = clientWs(hub);
    await opened(client); // pairs with the SECOND control
    const { code, reason } = await gone;
    expect(code).toBe(4000);
    expect(reason).toBe("superseded");

    // The surviving control still relays (after its own subs notice).
    await expectSubs(second, 1);
    client.send(JSON.stringify({ v: 1, type: "replay", afterSeq: 0 }));
    expect(await nextMessage(second)).toEqual({ v: 1, type: "replay", afterSeq: 0 });
  });

  it("signals the control connection as remote clients come and go", async () => {
    const hub = await startTestHub();
    const control = controlWs(hub);
    await opened(control);
    const a = clientWs(hub);
    await opened(a);
    await expectSubs(control, 1);
    const b = clientWs(hub);
    await opened(b);
    await expectSubs(control, 2);

    b.close();
    await expectSubs(control, 1);
    a.close();
    await expectSubs(control, 0);
  });

  it("tears down a live pairing when the exec switch flips off mid-session", async () => {
    const hub = await startTestHub();
    const control = controlWs(hub);
    await opened(control);
    const client = clientWs(hub);
    await opened(client);

    execOn = false;
    client.send(JSON.stringify({ v: 1, type: "turn", command: "echo x" }));
    const [frame, close] = await Promise.all([nextMessage(client), nextClose(client)]);
    expect(frame).toMatchObject({ type: "error", code: "disabled" });
    expect(close.code).toBe(4001);
    // The control connection itself survives (Desktop Presence is switch-free).
    expect(control.readyState).toBe(WebSocket.OPEN);
  });

  it("sweeps idle pairs down when the exec switch flips off — no frame needed", async () => {
    const hub = await startTestHub({ terminalPingIntervalMs: 60 });
    const control = controlWs(hub);
    await opened(control);
    const client = clientWs(hub);
    await opened(client);

    execOn = false;
    // Neither side sends anything — the keepalive sweep alone must tear the
    // pair down (spec §Security), instead of freezing an idle screen.
    const [frame, close] = await Promise.all([nextMessage(client), nextClose(client)]);
    expect(frame).toMatchObject({ type: "error", code: "disabled" });
    expect(close.code).toBe(4001);
    expect(control.readyState).toBe(WebSocket.OPEN);
  });

  it("drops clients on the first gated workbench frame after the switch flips off", async () => {
    const hub = await startTestHub();
    const control = controlWs(hub);
    await opened(control);
    const client = clientWs(hub);
    await opened(client);

    execOn = false;
    // A workbench→client frame while disabled must not be silently dropped —
    // the pairing is dead, the client gets the error frame.
    control.send(JSON.stringify({ v: 1, type: "state" }));
    const [frame, close] = await Promise.all([nextMessage(client), nextClose(client)]);
    expect(frame).toMatchObject({ type: "error", code: "disabled" });
    expect(close.code).toBe(4001);
  });

  it("keeps pong-responsive pairs alive across keepalive sweeps", async () => {
    const hub = await startTestHub({ terminalPingIntervalMs: 60 });
    const control = controlWs(hub);
    await opened(control);
    const client = clientWs(hub);
    await opened(client);
    await expectSubs(control, 1);

    // ~7 sweeps with both legs answering pings — none may be terminated
    // (fresh legs get the one-interval grace; a missed-pong leg would die).
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(control.readyState).toBe(WebSocket.OPEN);
    expect(client.readyState).toBe(WebSocket.OPEN);
    client.send(JSON.stringify({ v: 1, type: "replay", afterSeq: 0 }));
    expect(await nextMessage(control)).toEqual({ v: 1, type: "replay", afterSeq: 0 });
  });
});

describe("terminal relay push pipeline", () => {
  it("routes workbench push frames through the shared push pipeline (minimal strips the body)", async () => {
    pushState.cfg = { contentDetail: "minimal", notify: { terminal: true } };
    const pushed: string[] = [];
    setPushSenderForTests({
      sendText: async (c: string) => {
        pushed.push(c);
      },
    });
    const hub = await startTestHub();
    const control = controlWs(hub);
    await opened(control);
    const client = clientWs(hub);
    await opened(client);

    control.send(JSON.stringify({ v: 1, type: "push", title: "turn done", body: "secret output" }));
    // The next relayed frame proves the push was consumed, not relayed.
    control.send(JSON.stringify({ v: 1, type: "state" }));
    expect(await nextMessage(client)).toEqual({ v: 1, type: "state" });
    await vi.waitFor(() => expect(pushed).toEqual(["[terminal] turn done"]));
  });

  it("keeps the body under contentDetail full and suppresses on notify.terminal off", async () => {
    pushState.cfg = { contentDetail: "full", notify: { terminal: true } };
    const pushed: string[] = [];
    setPushSenderForTests({
      sendText: async (c: string) => {
        pushed.push(c);
      },
    });
    const hub = await startTestHub();
    const control = controlWs(hub);
    await opened(control);

    control.send(JSON.stringify({ v: 1, type: "push", title: "turn done", body: "exit 0" }));
    await vi.waitFor(() => expect(pushed).toEqual(["[terminal] turn done\nexit 0"]));

    pushState.cfg = { contentDetail: "full", notify: { terminal: false } };
    pushed.length = 0;
    control.send(JSON.stringify({ v: 1, type: "push", title: "another", body: "nope" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pushed).toEqual([]);
  });
});
