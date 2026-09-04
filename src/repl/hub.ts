/**
 * REPL-side hub client (ADR-0018): discover bridge instances through the hub
 * daemon and open a proxied WebSocket to a session-owning bridge, so the REPL
 * can attach to a session ANOTHER process is driving (mobile via a serve
 * bridge) and receive its updates live. The CLI's own backend sees only a
 * frozen resident snapshot of such sessions — cross-process pushes do not
 * exist — so live watching requires attaching at the owner, exactly like the
 * mobile App does.
 *
 * Everything here is best-effort discovery plumbing: the REPL degrades to its
 * plain local-bridge behaviour whenever the hub is unconfigured, unreachable,
 * or the picked session is not live anywhere.
 */

import { Duplex } from "node:stream";
import path from "node:path";
import process from "node:process";

import { WebSocket } from "ws";

/** Where to reach the hub. The hub itself is what binds and authenticates. */
export interface HubRef {
  port: number;
  token: string;
  /** http://127.0.0.1:<port> — /api/instances and friends. */
  baseUrl: string;
  /** ws://127.0.0.1:<port> — the /acp proxy upgrade endpoint. */
  wsBase: string;
}

/**
 * Resolve the hub from the same env the bridges and hub process use. The
 * REMOTE gate is deliberately NOT required: this is a client, not a bridge —
 * the token plus port are enough to talk to an existing hub. Loopback only,
 * matching bridge registration (remote/endpoint.ts): ZCODE_ACP_HUB_HOST is a
 * bind address, not a dial address.
 */
export function resolveHubClient(env: NodeJS.ProcessEnv = process.env): HubRef | null {
  const token = env.ZCODE_ACP_REMOTE_TOKEN;
  if (!token) return null;
  const parsed = Number.parseInt(env.ZCODE_ACP_HUB_PORT ?? "", 10);
  const port = Number.isFinite(parsed) && parsed > 0 ? parsed : 8377;
  return {
    port,
    token,
    baseUrl: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
  };
}

/** One registered bridge instance as /api/instances returns it (additive-only). */
export interface HubInstance {
  id: string;
  port: number;
  pid: number;
  startedAt?: string;
  workspace?: string;
  origin?: string;
  sessions?: Array<{
    sessionId: string;
    title?: string;
    updatedAt?: string;
    status?: string;
  }>;
}

/** GET /api/instances (Bearer auth). Rejects on non-2xx, timeout, bad payload. */
export async function fetchInstances(
  hub: HubRef,
  opts: { probe?: boolean; timeoutMs?: number } = {},
): Promise<HubInstance[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2000);
  try {
    const res = await fetch(`${hub.baseUrl}/api/instances${opts.probe ? "?probe=1" : ""}`, {
      headers: { Authorization: `Bearer ${hub.token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: unknown = await res.json();
    if (!Array.isArray(data)) throw new Error("unexpected payload");
    return data as HubInstance[];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The instance currently owning a session. The hub dedupes sessions across
 * instances on write (same session stays only on the freshest instance), so
 * the first hit is the right one.
 */
export function findInstanceForSession(
  instances: HubInstance[],
  sessionId: string,
): HubInstance | null {
  for (const inst of instances) {
    if ((inst.sessions ?? []).some((s) => s.sessionId === sessionId)) return inst;
  }
  return null;
}

/**
 * Whether a hub instance's workspace is the given project directory. Pure
 * path-resolution compare — a remote attach is only offered for the REPL's
 * own project, matching what the local session/list already shows.
 */
export function sameWorkspace(a: string | undefined, b: string): boolean {
  if (!a) return false;
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return false;
  }
}

/**
 * Bridge a WebSocket to the byte streams `acp.ndJsonStream` expects. Outgoing
 * bytes are buffered and each "\n"-terminated line is sent as one WS message;
 * each incoming WS message is re-terminated with "\n" (ACP frames are single
 * JSON documents — 1 message = 1 frame, the newline is for ndJsonStream's
 * parser). Close/error end or destroy the stream so the SDK's pending reads
 * surface the loss instead of hanging.
 */
export function wsToStream(ws: WebSocket): Duplex {
  let pending = "";
  let ended = false;
  const duplex = new Duplex({
    read() {},
    write(chunk: Buffer | string, _enc, cb) {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let idx: number;
      while ((idx = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (line) ws.send(line);
      }
      cb();
    },
    final(cb) {
      ws.close();
      cb();
    },
  });
  ws.on("message", (data: WebSocket.RawData) => {
    if (ended) return;
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
    duplex.push(Buffer.concat([bytes, Buffer.from("\n")]));
  });
  ws.on("close", () => {
    if (ended) return;
    ended = true;
    duplex.push(null);
  });
  ws.on("error", (err: Error) => {
    if (ended) return;
    ended = true;
    duplex.destroy(err);
  });
  return duplex;
}

export interface HubSocket {
  /** Raw socket — attach close/error listeners for loss detection. */
  ws: WebSocket;
  /** ndJson-ready byte stream pair feeding `acp.ndJsonStream`. */
  duplex: Duplex;
}

/**
 * Open the hub's proxied ACP WebSocket to one bridge instance. The hub
 * destroys the socket without an HTTP error on unknown instance or bad token,
 * so failures surface as a close/error rather than an HTTP status. Rejects on
 * open timeout.
 */
export async function openHubSocket(
  hub: HubRef,
  instanceId: string,
  timeoutMs = 5000,
): Promise<HubSocket> {
  const ws = new WebSocket(
    `${hub.wsBase}/acp?instance=${encodeURIComponent(instanceId)}&token=${encodeURIComponent(hub.token)}`,
  );
  const duplex = wsToStream(ws);
  await new Promise<void>((resolve, reject) => {
    // The hub rejects an upgrade with an HTTP status and then destroys the
    // socket, so an ECONNRESET and the error response can arrive in either
    // order — two error events on the same ws. The error listener therefore
    // stays attached for the socket's lifetime and settles once; anything
    // after the handshake resolved or rejected is swallowed here instead of
    // reaching the process as an uncaught 'error'.
    let done = false;
    const timer = setTimeout(() => {
      finish(new Error(`hub ws open timeout (${timeoutMs}ms)`));
      ws.terminate();
    }, timeoutMs);
    const onOpen = (): void => finish(null);
    const onClose = (): void => finish(new Error("hub ws closed during open"));
    const onError = (err: Error): void => finish(err);
    const finish = (err: Error | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.removeListener("open", onOpen);
      ws.removeListener("close", onClose);
      if (err) reject(err);
      else resolve();
    };
    ws.once("open", onOpen);
    ws.once("close", onClose);
    ws.on("error", onError);
    // The hub rejects upgrades with a real HTTP status (401/404/502). ws only
    // surfaces those as `unexpected-response`; with nobody listening it falls
    // back to abortHandshake, which fires an uncaught error on the upgrade
    // request. Consume the pair here and settle with a readable reason.
    ws.on("unexpected-response", (_req, res) => {
      res.destroy();
      finish(new Error(`hub rejected the upgrade (HTTP ${res.statusCode})`));
    });
  });
  return { ws, duplex };
}
