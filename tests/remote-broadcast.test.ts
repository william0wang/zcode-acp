/**
 * ClientRegistry broadcast semantics: notify fan-out with per-client failure
 * isolation, request first-response-wins with loser cancellation, outer-signal
 * linkage, and the empty/all-failed edge cases.
 */

import type * as acp from "@agentclientprotocol/sdk";

import { describe, expect, it } from "vitest";

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

  it("notifyOthers reaches every connection except the prompter's", async () => {
    const registry = new ClientRegistry();
    const rootZed = {};
    const zed = fakeClient({ root: rootZed });
    const phone = fakeClient({ root: {} });
    registry.add(zed.cx);
    registry.add(phone.cx);
    // A fresh wrapper over the prompter's connection — how the SDK hands a
    // per-request context to handlers.
    const prompter = { connectionContext: rootZed } as unknown as acp.AgentContext;

    await registry.notifyOthers(prompter, "session/update", { x: 1 });

    expect(zed.notifies).toHaveLength(0);
    expect(phone.notifies).toHaveLength(1);
    expect(phone.notifies[0]![1]).toEqual({ x: 1 });
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
    const server = { clients: registry } as unknown as ZcodeAcpServer;

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

  it("joins text blocks of a structured prompt and skips non-text ones", async () => {
    const { registry, phone, prompter } = registryWithZedAndPhone();
    const server = { clients: registry } as unknown as ZcodeAcpServer;
    const prompt = [
      { type: "text", text: "look at this" },
      { type: "image", data: "…" },
      { type: "text", text: "screenshot" },
    ] as unknown as acp.PromptRequest["prompt"];

    echoUserPromptToOthers(server, prompter, { sessionId: "s1", prompt });
    await sleep(0);
    await sleep(0);

    expect(phone.notifies).toHaveLength(1);
    const p = phone.notifies[0]![1] as { update: { content: { text: string } } };
    expect(p.update.content.text).toBe("look at this\nscreenshot");
  });

  it("sends nothing for an empty prompt", async () => {
    const { registry, phone, prompter } = registryWithZedAndPhone();
    const server = { clients: registry } as unknown as ZcodeAcpServer;

    echoUserPromptToOthers(server, prompter, { sessionId: "s1", prompt: "  " });
    await sleep(0);
    await sleep(0);

    expect(phone.notifies).toHaveLength(0);
  });
});
