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

import { clientConnectionRoot, warn } from "../utils.js";

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
  /** clientInfo name per connection root (see `nameConnection`). */
  private readonly names = new WeakMap<object, string>();

  add(cx: ClientLike): void {
    this.clients.add(cx);
  }

  remove(cx: ClientLike): void {
    this.clients.delete(cx);
  }

  get size(): number {
    return this.clients.size;
  }

  /**
   * Record a connection's `initialize` clientInfo name, keyed by the SDK's
   * per-connection root (same identity `notifyOthers` filters on) so payloads
   * can be tailored per client (`notifyEach`). Unnamed clients (the remote
   * App sends no clientInfo) read as null — distinct from "" only in that an
   * initialize was never seen for the connection.
   */
  nameConnection(cx: ClientLike, name: string): void {
    const root = clientConnectionRoot(cx);
    if (typeof root === "object" && root !== null) this.names.set(root, name);
  }

  /** Name recorded at initialize for this connection, null when none. */
  nameOf(cx: ClientLike): string | null {
    const root = clientConnectionRoot(cx);
    if (typeof root !== "object" || root === null) return null;
    // "" (initialize seen, no clientInfo — the remote App) reads as null too.
    return this.names.get(root) || null;
  }

  /**
   * Fan out a notification whose payload is built PER CLIENT from its recorded
   * name (null payload = skip that client). Used for `available_commands_update`:
   * editors keep the `$` skill grouping, martty and unnamed clients get the
   * bare names so their `/` completion menu shows skills at all.
   */
  async notifyEach(
    method: string,
    build: (name: string | null) => Record<string, unknown> | null,
  ): Promise<void> {
    // racedNotify: per-client failure/stall isolation (see notifyAll).
    await Promise.all(
      this.snapshot().map((cx) => {
        const params = build(this.nameOf(cx));
        return params ? racedNotify(cx, method, cx.notify(method, params)) : Promise.resolve();
      }),
    );
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
    // racedNotify: a stuck target client must not hold the caller's chain.
    await Promise.all(targets.map((cx) => racedNotify(cx, method, cx.notify(method, params))));
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

/**
 * Per-client notify send timeout. The SDK's `sendWireMessage` awaits the
 * transport write, so a half-open WebSocket (phone slept, TCP not yet dead)
 * pends for minutes — and `notifyAll`'s allSettled, chained through the
 * per-session FIFO guard in io.ts, would freeze EVERY client's session/update
 * stream until the socket errors out. A send that exceeds the timeout is
 * abandoned to the background (the client may still drain it later); the
 * broadcast resolves and the guard moves on. Losing mid-stream updates on the
 * stuck client is accepted — clients that re-attach replay history; what must
 * never happen is one dead link silencing the others.
 */
const NOTIFY_SEND_TIMEOUT_MS = 5_000;

/** Clients whose send already timed out once — the stall warning fires once per client (cleared on a recovered send). */
const stalledClients = new WeakSet<ClientLike>();

/** Race one client send against the timeout; always resolves, never rejects. */
function racedNotify(cx: ClientLike, method: string, send: Promise<void>): Promise<void> {
  if (stalledClients.has(cx)) {
    // Already stalled once: fire-and-forget. Awaiting again would tax EVERY
    // fan-out with another full timeout (throttling all clients to ~1 update
    // per NOTIFY_SEND_TIMEOUT_MS while the dead link sits in the registry).
    // The send still goes out — if it completes, the client un-stalls.
    send.then(
      () => stalledClients.delete(cx),
      () => undefined,
    );
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (!stalledClients.has(cx)) {
        stalledClients.add(cx);
        warn(
          `broadcast: ${method} send stalled >${NOTIFY_SEND_TIMEOUT_MS}ms on one client ` +
            "(half-open connection?) — not waiting for it; other clients continue",
        );
      }
      done();
    }, NOTIFY_SEND_TIMEOUT_MS);
    timer.unref?.();
    send.then(
      () => {
        stalledClients.delete(cx);
        done();
      },
      (e) => {
        warn(
          `broadcast: ${method} failed on one client: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
        done();
      },
    );
  });
}

async function notifyAll(
  registry: ClientRegistry,
  method: string,
  params?: unknown,
): Promise<void> {
  await Promise.all(
    registry.snapshot().map((cx) => racedNotify(cx, method, cx.notify(method, params))),
  );
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
