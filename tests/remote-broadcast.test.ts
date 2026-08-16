/**
 * ClientRegistry broadcast semantics: notify fan-out with per-client failure
 * isolation, request first-response-wins with loser cancellation, outer-signal
 * linkage, and the empty/all-failed edge cases.
 */

import type * as acp from "@agentclientprotocol/sdk";

import { describe, expect, it } from "vitest";

import { ClientRegistry, type ClientLike } from "../src/remote/broadcast.js";

interface FakeClient {
  cx: ClientLike;
  notifies: Array<[string, unknown]>;
  signals: Array<AbortSignal | undefined>;
  /** Registered per-request handler; defaults to resolving `{ default: true }`. */
  onRequest?: (method: string, signal: AbortSignal | undefined) => Promise<unknown>;
}

function fakeClient(opts: { failNotify?: boolean } = {}): FakeClient {
  const notifies: Array<[string, unknown]> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const fake: FakeClient = {
    notifies,
    signals,
    onRequest: undefined,
  };
  fake.cx = {
    notify(method: string, params?: unknown): Promise<void> {
      notifies.push([method, params]);
      return opts.failNotify ? Promise.reject(new Error("dead client")) : Promise.resolve();
    },
    async request(
      method: string,
      _params?: unknown,
      options?: acp.SendRequestOptions,
    ): Promise<unknown> {
      signals.push(options?.cancellationSignal);
      if (fake.onRequest) return fake.onRequest(method, options?.cancellationSignal);
      return { default: true };
    },
  };
  return fake;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("ClientRegistry broadcast", () => {
  it("fans notify out to every client", async () => {
    const registry = new ClientRegistry();
    const a = fakeClient();
    const b = fakeClient();
    registry.add(a.cx);
    registry.add(b.cx);
    expect(registry.size).toBe(2);

    await registry.broadcast().notify("session/update", { x: 1 });

    expect(a.notifies).toHaveLength(1);
    expect(b.notifies).toHaveLength(1);
    expect(a.notifies[0]![0]).toBe("session/update");
  });

  it("isolates a failing client on notify", async () => {
    const registry = new ClientRegistry();
    const ok = fakeClient();
    const dead = fakeClient({ failNotify: true });
    registry.add(ok.cx);
    registry.add(dead.cx);

    await expect(registry.broadcast().notify("session/update", {})).resolves.toBeUndefined();
    expect(ok.notifies).toHaveLength(1);
  });

  it("first response wins and losers are cancelled", async () => {
    const registry = new ClientRegistry();
    const slow = fakeClient();
    const fast = fakeClient();
    slow.onRequest = () => sleep(30).then(() => "slow");
    fast.onRequest = () => Promise.resolve("fast");
    registry.add(slow.cx);
    registry.add(fast.cx);

    const result = await registry.broadcast().request("session/request_permission", {});

    expect(result).toBe("fast");
    // Loser got aborted so the SDK emits $/cancel_request; winner untouched.
    expect(slow.signals[0]!.aborted).toBe(true);
    expect(fast.signals[0]!.aborted).toBe(false);
  });

  it("links an outer cancellation signal to all clients", async () => {
    const registry = new ClientRegistry();
    const a = fakeClient();
    const b = fakeClient();
    a.onRequest = (_m, signal) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("outer abort")), { once: true }),
      );
    b.onRequest = a.onRequest;
    registry.add(a.cx);
    registry.add(b.cx);

    const outer = new AbortController();
    const pending = registry.broadcast().request("m", {}, { cancellationSignal: outer.signal });
    outer.abort();
    await expect(pending).rejects.toThrow("outer abort");
    expect(a.signals[0]!.aborted).toBe(true);
    expect(b.signals[0]!.aborted).toBe(true);
  });

  it("rejects when every client fails, surfacing the first error", async () => {
    const registry = new ClientRegistry();
    const a = fakeClient();
    const b = fakeClient();
    a.onRequest = () => Promise.reject(new Error("boom-a"));
    b.onRequest = () => Promise.reject(new Error("boom-b"));
    registry.add(a.cx);
    registry.add(b.cx);

    await expect(registry.broadcast().request("m", {})).rejects.toThrow(/boom-/);
  });

  it("rejects immediately with no clients", async () => {
    const registry = new ClientRegistry();
    await expect(registry.broadcast().request("m", {})).rejects.toThrow(/no connected clients/);
  });

  it("removes clients from the fan-out", async () => {
    const registry = new ClientRegistry();
    const a = fakeClient();
    registry.add(a.cx);
    registry.remove(a.cx);
    expect(registry.size).toBe(0);
    await expect(registry.broadcast().request("m", {})).rejects.toThrow();
  });
});
