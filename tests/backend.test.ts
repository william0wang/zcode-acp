/**
 * Backend reader-routing logic tests.
 *
 * The routing rules (response correlation, server→client request queueing,
 * session/event fan-out, dead-backend fast-fail) are pure functions of the
 * inbound message shape. We drive `route()` directly with synthetic messages
 * rather than spawning subprocesses — faster, deterministic, and isolates the
 * reader-loop logic from process plumbing.
 *
 * The subprocess spawn/kill lifecycle is covered separately by a smoke test
 * against the real zcode binary in CI.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ZcodeBackend, type EventListener } from "../src/backend/client.js";
import type { ZcodeEvent, ZcodeInbound } from "../src/backend/types.js";

/**
 * Capture every frame written back to the backend stdin, then parse the one
 * carrying `id` (frames are newline-delimited JSON). Parsing the frame — not a
 * substring — keeps the assertions honest about the reply shape.
 */
function captureWrites(b: ZcodeBackend): { frames: () => Array<Record<string, unknown>> } {
  const chunks: string[] = [];
  const stdin = b.proc.stdin;
  if (!stdin) throw new Error("test backend has no stdin");
  const origWrite: typeof stdin.write = stdin.write.bind(stdin);
  stdin.write = ((chunk: unknown, ...args: unknown[]) => {
    chunks.push(String(chunk));
    return origWrite(chunk as never, ...(args as never[]));
  }) as typeof stdin.write;
  return {
    frames: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** Point `ZCODE_HOME` at a scratch dir with an optional v2/setting.json. */
async function withReplyLanguage(
  value: string | null,
  fn: () => Promise<void> | void,
): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), "backend-reply-language-"));
  try {
    if (value !== null) {
      const v2 = path.join(home, "v2");
      mkdirSync(v2, { recursive: true });
      writeFileSync(path.join(v2, "setting.json"), JSON.stringify({ replyLanguage: value }));
    }
    vi.stubEnv("ZCODE_HOME", home);
    await fn();
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
}

/** Wait a macrotick so a setImmediate-scheduled reply is written. */
function macrotick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * Test-only constructor: build a ZcodeBackend without spawning anything.
 * Reaches into the private routing surface to feed messages deterministically.
 */
function makeRoutingSubject(): ZcodeBackend & { route(msg: ZcodeInbound): void } {
  // Spawn a process that idles (holds stdin open) so the reader stays alive
  // while we drive routing via `route()` directly. We never read its stdout —
  // routing is fed synthetically.
  const backend = new ZcodeBackend([process.execPath, "-e", "process.stdin.resume()"], process.env);
  return backend as ZcodeBackend & { route(msg: ZcodeInbound): void };
}

describe("ZcodeBackend reader routing (unit)", () => {
  it("correlates a response by id to its pending request", async () => {
    const b = makeRoutingSubject();
    const pending = b.request(1, "ping", {}, 5000);
    // Simulate inbound response.
    b.route({ id: 1, result: { ok: true } });
    const resp = await pending;
    expect(resp.id).toBe(1);
    expect(resp.result).toEqual({ ok: true });
    b.close();
  });

  it("returns timeout when no matching response arrives in time", async () => {
    const b = makeRoutingSubject();
    const resp = await b.request(2, "ping", {}, 200);
    expect(resp.error?.message).toBe("timeout");
    b.close();
  });

  it("fails fast with pipe broken when stdin is already closed", async () => {
    const b = makeRoutingSubject();
    b.proc.stdin?.destroy();
    const resp = await b.request(3, "ping", {}, 5000);
    expect(resp.error?.message).toBe("zcode backend pipe broken: stdin closed");
    // readerDead was set by the pipe-broken path: the next request must
    // fast-fail instead of burning another full timeout window.
    const again = await b.request(4, "ping", {}, 5000);
    expect(again.error?.message).toBe("zcode backend reader exited (backend dead)");
    b.close();
  });

  it("routes id+method with an unregistered id to the server-request queue", () => {
    const b = makeRoutingSubject();
    b.route({
      id: 5000,
      method: "interaction/requestPermission",
      params: { requestId: "r1", toolCallId: "t1" },
    });
    expect(b.pollServerRequests()).toHaveLength(1);
    const req = b.pollServerRequests();
    expect(req).toHaveLength(0); // already drained
    b.close();
  });

  it("resolves a pending request even if the inbound carries id+method (race-safe)", async () => {
    const b = makeRoutingSubject();
    const pending = b.request(9, "ping", {}, 5000);
    // Inbound with both id+method: the registered id makes it our response.
    b.route({ id: 9, method: "ping", result: { raced: true } });
    const resp = await pending;
    expect(resp.result).toEqual({ raced: true });
    // Not also queued as a server request.
    expect(b.pollServerRequests()).toHaveLength(0);
    b.close();
  });

  it("routes session/event to the registered listener", () => {
    const b = makeRoutingSubject();
    const received: ZcodeEvent[] = [];
    const listener: EventListener = { handleEvent: (ev) => received.push(ev) };
    b.registerEventListener("sess_x", listener);
    b.route({
      method: "session/event",
      params: { sessionId: "sess_x", seq: 1, type: "turn.started", payload: {} },
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("turn.started");
    // No listener registered → silently ignored (no throw).
    b.route({
      method: "session/event",
      params: { sessionId: "other", seq: 1, type: "turn.started", payload: {} },
    });
    expect(received).toHaveLength(1);
    b.close();
  });

  it("fans session/event out to multiple registered listeners and isolates unregister", () => {
    const b = makeRoutingSubject();
    const gotA: ZcodeEvent[] = [];
    const gotB: ZcodeEvent[] = [];
    const listenerA: EventListener = { handleEvent: (ev) => gotA.push(ev) };
    const listenerB: EventListener = { handleEvent: (ev) => gotB.push(ev) };
    b.registerEventListener("sess_x", listenerA);
    b.registerEventListener("sess_x", listenerB);
    b.route({
      method: "session/event",
      params: { sessionId: "sess_x", seq: 1, type: "turn.started", payload: {} },
    });
    // Both listeners receive the event.
    expect(gotA).toHaveLength(1);
    expect(gotB).toHaveLength(1);
    // Unregistering one leaves the other intact.
    b.unregisterEventListener("sess_x", listenerA);
    b.route({
      method: "session/event",
      params: { sessionId: "sess_x", seq: 2, type: "turn.completed", payload: {} },
    });
    expect(gotA).toHaveLength(1); // no new event for A
    expect(gotB).toHaveLength(2); // B still receives
    b.close();
  });

  it("isolates listeners per session id", () => {
    const b = makeRoutingSubject();
    const gotX: ZcodeEvent[] = [];
    const gotY: ZcodeEvent[] = [];
    b.registerEventListener("sess_x", { handleEvent: (ev) => gotX.push(ev) });
    b.registerEventListener("sess_y", { handleEvent: (ev) => gotY.push(ev) });
    b.route({
      method: "session/event",
      params: { sessionId: "sess_x", seq: 1, type: "turn.started", payload: {} },
    });
    expect(gotX).toHaveLength(1);
    expect(gotY).toHaveLength(0);
    b.close();
  });

  it("drains pending requests with an error once the reader dies", async () => {
    const b = makeRoutingSubject();
    const pending = b.request(11, "ping", {}, 5000);
    // Force-mark dead via private seam (mirrors what stdout-close does).
    (b as unknown as { markReaderDead(reason: string): void }).markReaderDead("test");
    const resp = await pending;
    expect(resp.error?.message).toMatch(/reader exited/);
    expect(b.isDead).toBe(true);
    // New requests fast-fail.
    const resp2 = await b.request(12, "ping", {}, 1000);
    expect(resp2.error?.message).toMatch(/reader exited/);
    b.close();
  });

  it("requeueServerRequests prepends so re-drained requests keep their order", () => {
    const b = makeRoutingSubject();
    b.route({
      id: 5001,
      method: "interaction/requestPermission",
      params: { requestId: "r1", toolCallId: "t1", sessionId: "sess_a" },
    });
    b.route({
      id: 5002,
      method: "interaction/requestPermission",
      params: { requestId: "r2", toolCallId: "t2", sessionId: "sess_b" },
    });
    // Drain both, then requeue the second (simulating a session filter put-back).
    const all = b.pollServerRequests();
    expect(all).toHaveLength(2);
    b.requeueServerRequests([all[1]!]);
    const remaining = b.pollServerRequests();
    expect(remaining).toHaveLength(1);
    expect((remaining[0]!.params as { sessionId: string }).sessionId).toBe("sess_b");
    b.close();
  });

  it("auto-replies session/requestRuntimePreferences instead of queueing it", async () => {
    const b = makeRoutingSubject();
    // Spy on what gets written back to the backend.
    const writes: string[] = [];
    const stdin = b.proc.stdin;
    if (!stdin) throw new Error("test backend has no stdin");
    const origWrite: typeof stdin.write = stdin.write.bind(stdin);
    stdin.write = ((chunk: unknown, ...args: unknown[]) => {
      writes.push(String(chunk));
      return origWrite(chunk as never, ...(args as never[]));
    }) as typeof stdin.write;

    b.route({
      id: "server-1",
      method: "session/requestRuntimePreferences",
      params: { sessionId: "sess_x", scope: "runtime-materialization" },
    });

    // The handshake must NOT land in the server-request queue (create is
    // awaiting its response; nobody drains the queue during session/new).
    expect(b.pollServerRequests()).toHaveLength(0);
    // And a schema-valid default reply must be written back immediately.
    const written = writes.join("");
    expect(written).toContain('"id":"server-1"');
    expect(written).toContain('"nativeSearchEnhancementsEnabled":false');
    expect(written).toContain('"memoryEnabled":false');
    // Must stay false so AskUserQuestion keeps flowing through the bridge's
    // interaction path instead of being auto-resolved by the app-server.
    expect(written).toContain('"askUserQuestionAutoResolutionEnabled":false');
    b.close();
  });

  it("auto-replies session/readReplyLanguage with the live setting value", async () => {
    await withReplyLanguage("日本語", async () => {
      const b = makeRoutingSubject();
      const writes = captureWrites(b);
      b.route({
        id: "lang-1",
        method: "session/readReplyLanguage",
        params: { sessionId: "sess_x" },
      });
      expect(b.pollServerRequests()).toHaveLength(0);
      await macrotick(); // read + reply are deferred off the reader loop
      const reply = writes.frames().find((f) => f["id"] === "lang-1");
      expect(reply?.["result"]).toEqual({ language: "日本語" });
      b.close();
    });
  });

  it("auto-replies session/readReplyLanguage with null when unset", async () => {
    await withReplyLanguage(null, async () => {
      const b = makeRoutingSubject();
      const writes = captureWrites(b);
      b.route({
        id: "lang-2",
        method: "session/readReplyLanguage",
        params: { sessionId: "sess_x" },
      });
      expect(b.pollServerRequests()).toHaveLength(0);
      await macrotick();
      const reply = writes.frames().find((f) => f["id"] === "lang-2");
      expect(reply?.["result"]).toEqual({ language: null });
      b.close();
    });
  });

  it("includes agentAlwaysBackgroundEnabled in the preferences reply when set", async () => {
    const b = makeRoutingSubject();
    b.agentAlwaysBackgroundEnabled = false;
    const writes = captureWrites(b);
    b.route({
      id: "server-2",
      method: "session/requestRuntimePreferences",
      params: { sessionId: "sess_x" },
    });
    const reply = writes.frames().find((f) => f["id"] === "server-2");
    expect(reply?.["result"]).toMatchObject({ agentAlwaysBackgroundEnabled: false });
    b.close();
  });

  it("omits agentAlwaysBackgroundEnabled from the preferences reply when unset", async () => {
    const b = makeRoutingSubject();
    expect(b.agentAlwaysBackgroundEnabled).toBeUndefined();
    const writes = captureWrites(b);
    b.route({
      id: "server-3",
      method: "session/requestRuntimePreferences",
      params: { sessionId: "sess_x" },
    });
    const reply = writes.frames().find((f) => f["id"] === "server-3");
    expect(reply?.["result"]).not.toHaveProperty("agentAlwaysBackgroundEnabled");
    b.close();
  });

  it("still queues other server→client requests untouched", () => {
    const b = makeRoutingSubject();
    b.route({
      id: "server-9",
      method: "interaction/requestPermission",
      params: { requestId: "r9", toolCallId: "t9", sessionId: "sess_x" },
    });
    const reqs = b.pollServerRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.id).toBe("server-9");
    expect(reqs[0]!.method).toBe("interaction/requestPermission");
    b.close();
  });
});

describe("ZcodeBackend spawn failure (ENOENT)", () => {
  it("survives a missing binary: marks dead and fails requests instead of crashing", async () => {
    // Before the proc 'error' listener, a spawn ENOENT crashed the bridge with
    // an unhandled 'error' event; now it degrades to a dead backend.
    const b = new ZcodeBackend(["zcode-acp-test-missing-bin"], process.env);
    // The spawn 'error' event is asynchronous — let it fire before asserting.
    await new Promise((r) => setTimeout(r, 100));
    expect(b.isDead).toBe(true);
    const resp = await b.request(1, "ping", {}, 500);
    expect(resp.error).toBeDefined();
    await b.close();
  });
});
