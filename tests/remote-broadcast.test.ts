/**
 * ClientRegistry broadcast semantics: notify fan-out with per-client failure
 * isolation, request first-response-wins with loser cancellation, outer-signal
 * linkage, and the empty/all-failed edge cases.
 */

import type * as acp from "@agentclientprotocol/sdk";

import { describe, expect, it, vi } from "vitest";

import { echoUserPromptToOthers } from "../src/handlers/io.js";
import { ClientRegistry, type ClientLike } from "../src/remote/broadcast.js";
import type { ZcodeAcpServer } from "../src/server.js";

interface FakeClient {
  cx: ClientLike & { connectionContext?: unknown };
  notifies: Array<[string, unknown]>;
  signals: Array<AbortSignal | undefined>;
  /** Registered per-request handler; defaults to resolving `{ default: true }`. */
  onRequest?: (method: string, signal: AbortSignal | undefined) => Promise<unknown>;
}

function fakeClient(opts: { failNotify?: boolean; root?: object } = {}): FakeClient {
  const notifies: Array<[string, unknown]> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const fake: FakeClient = {
    notifies,
    signals,
    onRequest: undefined,
  };
  const cx = {
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
  } as ClientLike & { connectionContext?: unknown };
  cx.connectionContext = opts.root ?? {};
  fake.cx = cx;
  return fake;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("ClientRegistry broadcast", () => {
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

  it("a stalled client cannot hold the notify fan-out (send timeout isolation)", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ClientRegistry();
      const cli = fakeClient();
      // Half-open connection: the SDK's sendWireMessage awaits the transport
      // write, which pends until TCP gives up. Before the timeout guard this
      // froze the per-session send chain for EVERY client.
      const stalled = fakeClient();
      stalled.cx.notify = () => new Promise<void>(() => undefined);
      registry.add(cli.cx);
      registry.add(stalled.cx);

      const sent = registry.broadcast().notify("session/update", { x: 1 });
      // Not resolved before the timeout elapses…
      let resolved = false;
      void sent.then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(resolved).toBe(false);
      // …resolves once the stall timeout fires, without waiting for the stuck write.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(resolved).toBe(true);
      // The healthy client got the message regardless.
      expect(cli.notifies).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends keep flowing to healthy clients after a stall (guard not poisoned)", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ClientRegistry();
      const cli = fakeClient();
      const stalled = fakeClient();
      stalled.cx.notify = () => new Promise<void>(() => undefined);
      registry.add(cli.cx);
      registry.add(stalled.cx);

      const first = registry.broadcast().notify("session/update", { x: 1 });
      await vi.advanceTimersByTimeAsync(6_000);
      await first;
      // A second send must ALSO settle — and immediately: a client already
      // marked stalled is fire-and-forget, so it must not cost another
      // full timeout (that would throttle every client to 1 update/5s).
      const second = registry.broadcast().notify("session/update", { x: 2 });
      let resolved = false;
      void second.then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(resolved).toBe(true);
      expect(cli.notifies).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("echoUserPromptToOthers", () => {
  function registryWithZedAndPhone(): {
    registry: ClientRegistry;
    zed: FakeClient;
    phone: FakeClient;
    prompter: acp.AgentContext;
  } {
    const registry = new ClientRegistry();
    const rootZed = {};
    const zed = fakeClient({ root: rootZed });
    const phone = fakeClient({ root: {} });
    registry.add(zed.cx);
    registry.add(phone.cx);
    return {
      registry,
      zed,
      phone,
      prompter: { connectionContext: rootZed } as unknown as acp.AgentContext,
    };
  }

  it("echoes the prompt text to other clients, never the prompter", async () => {
    const { registry, zed, phone, prompter } = registryWithZedAndPhone();
    const server = {
      clients: registry,
      sessionAliases: (sid: string) => [sid],
    } as unknown as ZcodeAcpServer;

    echoUserPromptToOthers(server, prompter, { sessionId: "s1", prompt: "hello from zed" });
    await sleep(0);
    await sleep(0);

    expect(zed.notifies).toHaveLength(0);
    expect(phone.notifies).toHaveLength(1);
    const [method, params] = phone.notifies[0]!;
    expect(method).toBe("session/update");
    const p = params as { sessionId: string; update: Record<string, unknown> };
    expect(p.sessionId).toBe("s1");
    expect(p.update.sessionUpdate).toBe("user_message_chunk");
    expect((p.update.content as { text: string }).text).toBe("hello from zed");
    expect(String(p.update.messageId)).toMatch(/^uprompt_/);
  });
});
