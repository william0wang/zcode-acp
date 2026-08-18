/**
 * Multi-client broadcast layer for remote access.
 *
 * The bridge historically served ONE ACP client (the editor over stdio). With
 * remote access enabled, additional clients attach over WebSocket; every
 * agent-originated message must reach all of them. This module owns the client
 * registry and a stable proxy that quacks like an `AgentContext`:
 *
 * - `notify` fans out to every client; a single dead/slow client is warned
 *   about and never fails the others.
 * - `request` (permission / elicitation) is sent to every client and the FIRST
 *   response wins. Losers are aborted via `cancellationSignal`, which makes
 *   the SDK emit `$/cancel_request` so the losing editor dismisses its dialog
 *   (verified against Zed's ACP client).
 *
 * Loser promises settle late (the peer answers the cancellation eventually) —
 * every raced promise carries a no-op catch so late settlements can't surface
 * as unhandledRejection (Node ≥15 crashes on those by default).
 */

import type * as acp from "@agentclientprotocol/sdk";

import { warn } from "../utils.js";

/** The AgentContext surface the bridge actually calls. */
export interface ClientLike {
  notify(method: string, params?: unknown): Promise<void>;
  request(method: string, params?: unknown, options?: acp.SendRequestOptions): Promise<unknown>;
}

/**
 * Track every connection opened on the app (stdio editor + remote WebSocket)
 * in the registry, removing each on close. Wired once by the entry point
 * BEFORE `connect()` so the stdio connection is captured too.
 */
export function trackConnections(app: acp.AgentApp, clients: ClientRegistry): void {
  app.onConnect((conn) => {
    clients.add(conn.client);
    void conn.closed.then(() => clients.remove(conn.client));
  });
}

/** One raced request outcome: which client won and what it answered. */
interface RaceWinner {
  value: unknown;
  index: number;
}

/**
 * Registry of connected ACP clients (stdio editor + remote WebSocket clients).
 * Membership is managed by the entry point via the SDK's per-connection
 * lifecycle; the broadcast proxy reads membership live on every call.
 */
export class ClientRegistry {
  private readonly clients = new Set<ClientLike>();
  private proxy: acp.AgentContext | null = null;

  add(cx: ClientLike): void {
    this.clients.add(cx);
  }

  remove(cx: ClientLike): void {
    this.clients.delete(cx);
  }

  get size(): number {
    return this.clients.size;
  }

  /** Stable broadcast proxy satisfying the `AgentContext` call surface. */
  broadcast(): acp.AgentContext {
    if (!this.proxy) this.proxy = createBroadcastProxy(this);
    return this.proxy;
  }

  /**
   * Notify every client EXCEPT the one whose connection issued the current
   * request (`exclude` is that connection's AgentContext — `ctx.client` from a
   * handler). Identity is by the shared per-connection context: each request
   * wraps it in a fresh AgentContext, so the wrappers never compare equal.
   * (`connectionContext` is the SDK's per-connection root — public at runtime,
   * @internal in the typings, hence the cast.) Used for the user-prompt echo:
   * the prompting client renders its own outgoing message locally and would
   * duplicate an echo.
   */
  async notifyOthers(exclude: acp.AgentContext, method: string, params?: unknown): Promise<void> {
    const root = (exclude as { connectionContext?: unknown }).connectionContext;
    const targets = this.snapshot().filter(
      (cx) => (cx as { connectionContext?: unknown }).connectionContext !== root,
    );
    const results = await Promise.allSettled(targets.map((cx) => cx.notify(method, params)));
    for (const r of results) {
      if (r.status === "rejected") {
        warn(
          `broadcast: notifyOthers ${method} failed on one client: ` +
            `${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        );
      }
    }
  }

  snapshot(): ClientLike[] {
    return Array.from(this.clients);
  }
}

/** Build the stable proxy once per registry (module factory: no `this` alias). */
function createBroadcastProxy(registry: ClientRegistry): acp.AgentContext {
  const proxy: Record<string, unknown> = Object.create(null);
  proxy.notify = (method: string, params?: unknown): Promise<void> =>
    notifyAll(registry, method, params);
  proxy.request = (
    method: string,
    params?: unknown,
    options?: acp.SendRequestOptions,
  ): Promise<unknown> => requestAny(registry, method, params, options);
  return proxy as unknown as acp.AgentContext;
}

async function notifyAll(
  registry: ClientRegistry,
  method: string,
  params?: unknown,
): Promise<void> {
  const results = await Promise.allSettled(
    registry.snapshot().map((cx) => cx.notify(method, params)),
  );
  for (const r of results) {
    if (r.status === "rejected") {
      warn(
        `broadcast: notify ${method} failed on one client: ` +
          `${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
    }
  }
}

async function requestAny(
  registry: ClientRegistry,
  method: string,
  params?: unknown,
  options?: acp.SendRequestOptions,
): Promise<unknown> {
  const clients = registry.snapshot();
  if (clients.length === 0) {
    throw new Error(`broadcast: no connected clients (${method})`);
  }
  const controllers = clients.map(() => new AbortController());
  // Link a caller-provided signal: aborting it cancels EVERY inner request.
  const outerSignal = options?.cancellationSignal;
  const onOuterAbort = () => {
    for (const c of controllers) c.abort();
  };
  if (outerSignal) {
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const attempts = clients.map((cx, i) => {
    const promise = cx.request(method, params, {
      ...options,
      cancellationSignal: controllers[i]!.signal,
    });
    // Mark handled: losing promises settle AFTER Promise.any is done.
    promise.catch(() => undefined);
    return promise.then((value): RaceWinner => ({ value, index: i }));
  });
  try {
    const winner = await Promise.any(attempts);
    for (let i = 0; i < controllers.length; i++) {
      if (i !== winner.index) controllers[i]!.abort();
    }
    return winner.value;
  } catch (e) {
    // All clients failed — surface the first error like a single client would.
    if (e instanceof AggregateError) throw e.errors[0] ?? e;
    throw e;
  } finally {
    if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);
  }
}
