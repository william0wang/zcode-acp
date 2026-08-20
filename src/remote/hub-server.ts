/**
 * zcode-acp-hub — machine-level singleton for remote access.
 *
 * The hub is the ONLY public entry point (the port a tunnel maps). It does
 * token auth, instance discovery, and byte-level WebSocket proxying from a
 * remote client to one bridge's loopback ACP endpoint (ADR-0002), plus two
 * plain-HTTP conveniences that spare clients a full ACP round-trip (ADR-0005):
 * a proxied per-instance /status, and an account-level /api/quota queried
 * directly (quota belongs to the machine's credentials, not to any instance).
 * It holds no session state and understands no ACP — a proxied connection
 * stays bound to one instance for its whole lifetime.
 *
 * Bridges register via POST /api/register every 10s (the registration doubles
 * as the heartbeat; entries older than the heartbeat TTL are pruned). A client
 * that needs an immediately-honest list (e.g. a phone app's pull-to-refresh)
 * passes ?probe=1 to /api/instances: the hub TCP-probes each registered
 * loopback port and prunes unreachable bridges before answering — no periodic
 * probing, the cost is paid only when someone refreshes. When no instance is
 * registered and no proxy is active for `idleExitMs`, the hub exits — the
 * next bridge re-spawns it on demand.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  get as httpGet,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import net from "node:net";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { AGENT_INFO, compareVersions, log, warn } from "../utils.js";
import { accountUsageStats, type UsageStatsResult } from "../handlers/account.js";

export interface HubOptions {
  port: number;
  host: string;
  token: string;
  /** Registration TTL before an instance is pruned (default 30s). */
  heartbeatTimeoutMs?: number;
  /** Idle time with zero instances and zero proxies before exit (default 10min). */
  idleExitMs?: number;
  /** WebSocket keepalive ping interval (default 30s; tunnels drop idle links). */
  pingIntervalMs?: number;
}

export interface HubHandle {
  port: number;
  close(): Promise<void>;
}

interface SessionSummary {
  sessionId: string;
  title?: string;
  updatedAt: number;
  /** Coarse running indicator from the bridge heartbeat (ADR-0005); absent on older bridges. */
  status?: "running" | "idle";
}

interface InstanceEntry {
  id: string;
  port: number;
  pid: number;
  startedAt: number;
  workspace: string;
  sessions: SessionSummary[];
  lastSeen: number;
}

const HEARTBEAT_TIMEOUT_MS = 30_000;
const IDLE_EXIT_MS = 10 * 60_000;
const PING_INTERVAL_MS = 30_000;
/** Per-instance TCP probe timeout for /api/instances?probe=1. */
const PROBE_TIMEOUT_MS = 500;
const MAX_BODY_BYTES = 1024 * 1024;

/** Constant-time token compare (hash both to equal length first). */
function tokenEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function authorized(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return tokenEquals(header.slice(7), token);
  const query = url.searchParams.get("token");
  return query !== null && tokenEquals(query, token);
}

function setCors(res: ServerResponse): void {
  // The web UI is deployed as a separate origin; the token is the boundary.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  // Custom response headers JS may read cross-origin; without this the file
  // viewer's line-window fetches cannot see X-Zcode-First-Line at all.
  res.setHeader("Access-Control-Expose-Headers", "X-Zcode-First-Line");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    // The async iterator rejects when the client aborts mid-body — a truncated
    // POST must degrade to "invalid body", not reject into the event loop.
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(chunk as Buffer);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function validSessions(raw: unknown): SessionSummary[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SessionSummary[] = [];
  for (const s of raw) {
    const rec = s as {
      sessionId?: unknown;
      title?: unknown;
      updatedAt?: unknown;
      status?: unknown;
    };
    if (typeof rec?.sessionId !== "string") return null;
    out.push({
      sessionId: rec.sessionId,
      ...(typeof rec.title === "string" ? { title: rec.title } : {}),
      updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : Date.now(),
      // Unknown values drop the field entirely (older bridges send none).
      ...(rec.status === "running" || rec.status === "idle" ? { status: rec.status } : {}),
    });
  }
  return out;
}

/**
 * Cached quota for GET /api/quota. Quota is account-level — it belongs to the
 * machine's configured credentials, not to any bridge instance — so the hub
 * queries it directly (ADR-0005) instead of proxying an ACP round-trip. The
 * TTL + single in-flight slot keep polling clients from hammering the
 * upstream usage APIs.
 */
const QUOTA_TTL_MS = 30_000;
let quotaCache: { result: UsageStatsResult; at: number } | null = null;
let quotaInflight: Promise<UsageStatsResult> | null = null;

function getQuota(): Promise<UsageStatsResult> {
  if (quotaCache && Date.now() - quotaCache.at < QUOTA_TTL_MS)
    return Promise.resolve(quotaCache.result);
  if (!quotaInflight) {
    quotaInflight = accountUsageStats()
      .then((result) => {
        quotaCache = { result, at: Date.now() };
        return result;
      })
      .finally(() => {
        quotaInflight = null;
      });
  }
  return quotaInflight;
}

/** Reset the quota cache (test helper). */
export function resetQuotaCacheForTest(): void {
  quotaCache = null;
  quotaInflight = null;
}

/**
 * TCP-probe a bridge's loopback endpoint. Loopback refusals are instant, so
 * the timeout only guards pathological cases; a bare connect+destroy is
 * harmless to the bridge's HTTP server.
 */
function portOpen(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

/**
 * Start the hub. Resolves once listening; rejects on bind failure (including
 * EADDRINUSE when another hub already owns the port).
 */
export function startHub(options: HubOptions & { onIdleExit?: () => void }): Promise<HubHandle> {
  const {
    port,
    host,
    token,
    heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
    idleExitMs = IDLE_EXIT_MS,
    pingIntervalMs = PING_INTERVAL_MS,
    onIdleExit,
  } = options;

  const instances = new Map<string, InstanceEntry>();
  const proxyPairs = new Set<{ client: WebSocket; bridge: WebSocket }>();
  const timers: Array<ReturnType<typeof setInterval>> = [];

  let idleSince: number | null = null;

  const wss = new WebSocketServer({ noServer: true });

  const server: Server = createServer((req, res) => {
    // Async handler failures (malformed URL, aborted body) must never escape
    // into the event loop — warn and drop the connection.
    void handleHttp(req, res).catch((e) => {
      warn(`hub: request failed: ${e instanceof Error ? e.message : String(e)}`);
      res.destroy();
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/acp") {
      socket.destroy();
      return;
    }
    if (!authorized(req, url, token)) {
      warn("hub: unauthorized WS upgrade rejected");
      socket.destroy();
      return;
    }
    const entry = instances.get(url.searchParams.get("instance") ?? "");
    if (!entry) {
      warn("hub: WS upgrade for unknown instance rejected");
      socket.destroy();
      return;
    }
    // Dial the bridge's loopback endpoint before accepting the client side,
    // so a dead bridge fails the upgrade instead of half-opening a pipe.
    const bridge = new WebSocket(`ws://127.0.0.1:${entry.port}/acp`);
    // The client socket can die while we dial; without this guard
    // handleUpgrade would run against a dead socket.
    let clientGone = false;
    const onClientGone = () => {
      clientGone = true;
      bridge.terminate();
    };
    socket.once("close", onClientGone);
    socket.once("error", onClientGone);
    bridge.once("open", () => {
      if (clientGone) return; // terminated above; "open" can no longer fire
      socket.removeListener("close", onClientGone);
      socket.removeListener("error", onClientGone);
      wss.handleUpgrade(req, socket, head, (client) => startProxy(client, bridge));
    });
    bridge.once("error", (e) => {
      warn(`hub: dial bridge :${entry.port} failed: ${e.message}`);
      socket.destroy();
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    if (url.pathname === "/api/instances" && req.method === "GET") {
      if (!authorized(req, url, token)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      // On-demand liveness probe (?probe=1): verify every registered bridge's
      // loopback port and prune the unreachable ones before answering, so a
      // client refresh gets an honest list instead of waiting out the
      // heartbeat TTL (hard-killed bridges never unregister).
      if (["1", "true"].includes((url.searchParams.get("probe") ?? "").toLowerCase())) {
        const probes = await Promise.all(
          Array.from(instances.entries(), async ([id, entry]) => ({
            id,
            ok: await portOpen(entry.port, PROBE_TIMEOUT_MS),
          })),
        );
        for (const { id, ok } of probes) {
          if (!ok) {
            instances.delete(id);
            idleSince = null; // re-arm the idle clock on membership change
            log(`hub: pruned instance ${id} (probe: endpoint unreachable)`);
          }
        }
      }
      // Cross-instance session dedupe: every bridge of a workspace lists the
      // same shared backend session store, so one conversation can appear on
      // several instances. Keep exactly one copy — the freshest session
      // updatedAt (the bridge actually driving the conversation wins; a
      // leaked older bridge's stale copy loses), tie-broken by the
      // newest-started instance — so clients see each conversation once and
      // attach where it is live.
      const winners = new Map<string, { updatedAt: number; instance: InstanceEntry }>();
      for (const entry of instances.values()) {
        for (const s of entry.sessions) {
          const prev = winners.get(s.sessionId);
          if (
            !prev ||
            s.updatedAt > prev.updatedAt ||
            (s.updatedAt === prev.updatedAt && entry.startedAt > prev.instance.startedAt)
          ) {
            winners.set(s.sessionId, { updatedAt: s.updatedAt, instance: entry });
          }
        }
      }
      const list = Array.from(instances.values())
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((e) => ({
          id: e.id,
          port: e.port,
          pid: e.pid,
          startedAt: e.startedAt,
          workspace: e.workspace,
          sessions: e.sessions.filter((s) => winners.get(s.sessionId)?.instance === e),
        }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }
    if (url.pathname === "/api/quota" && req.method === "GET") {
      if (!authorized(req, url, token)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      try {
        const result = await getQuota();
        res.writeHead(200, {
          "Content-Type": "application/json",
          // The hub-side TTL is the only caching layer; clients must not see stale copies.
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("quota query failed");
      }
      return;
    }
    // /api/instances/{id}/fs/... and /status — byte-level proxy to the
    // instance's loopback file/status endpoint (ADR-0004, ADR-0005). The hub
    // routes by instance id only; sessionId, path semantics, and scope checks
    // stay in the bridge.
    const fsMatch = url.pathname.match(/^\/api\/instances\/([^/]+)(\/fs\/.*|\/status)$/);
    if (fsMatch && (req.method === "GET" || req.method === "HEAD")) {
      if (!authorized(req, url, token)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      const entry = instances.get(fsMatch[1]!);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("unknown instance");
        return;
      }
      const upstream = httpGet(
        { host: "127.0.0.1", port: entry.port, path: fsMatch[2]! + url.search },
        (up) => {
          // Strip hop-by-hop headers; Node re-frames the proxied body.
          const headers = { ...up.headers };
          delete headers["transfer-encoding"];
          delete headers.connection;
          res.writeHead(up.statusCode ?? 502, headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (res.headersSent) res.destroy();
        else {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("bridge unreachable");
        }
      });
      req.on("close", () => upstream.destroy());
      return;
    }
    // POST /api/instances/{id}/sessions/{sid}/close — the remote HTTP
    // surface's first write op (ADR-0006): forward-and-relay to the bridge's
    // loopback close route. The hub still routes by instance id only; close
    // semantics (running guard, discovery retirement) stay in the bridge.
    const closeMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/sessions\/([^/]+)\/close$/);
    if (closeMatch && req.method === "POST") {
      if (!authorized(req, url, token)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      const entry = instances.get(closeMatch[1]!);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("unknown instance");
        return;
      }
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: entry.port,
          path: `/sessions/${closeMatch[2]}/close`,
          method: "POST",
        },
        (up) => {
          const headers = { ...up.headers };
          delete headers["transfer-encoding"];
          delete headers.connection;
          res.writeHead(up.statusCode ?? 502, headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (res.headersSent) res.destroy();
        else {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("bridge unreachable");
        }
      });
      // Abort the upstream only when the CLIENT side dies mid-response.
      // `req`'s own 'close' fires once the (usually empty) body is drained —
      // typically BEFORE the relayed response finishes writing — so keying on
      // it resets the bridge socket on every request (ECONNRESET → 502).
      res.on("close", () => {
        if (!res.writableEnded) upstream.destroy();
      });
      // Relay any request body through (clients normally send none).
      req.pipe(upstream);
      return;
    }
    if (
      (url.pathname === "/api/register" || url.pathname === "/api/unregister") &&
      req.method === "POST"
    ) {
      const body = await readJson(req);
      if (!body || typeof body.token !== "string" || !tokenEquals(body.token, token)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("missing id");
        return;
      }
      if (url.pathname === "/api/register") {
        const bridgePort = typeof body.port === "number" ? body.port : 0;
        const sessions = validSessions(body.sessions);
        if (!(bridgePort >= 1 && bridgePort <= 65535) || !sessions) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("invalid register payload");
          return;
        }
        const prev = instances.get(id);
        instances.set(id, {
          id,
          port: bridgePort,
          pid: typeof body.pid === "number" ? body.pid : 0,
          startedAt: prev?.startedAt ?? Date.now(),
          workspace: typeof body.workspace === "string" ? body.workspace : "",
          sessions,
          lastSeen: Date.now(),
        });
      } else {
        instances.delete(id);
        idleSince = null; // re-arm the idle clock on membership change
      }
      // Version self-upgrade: a bridge NEWER than this hub just registered,
      // so this process is running stale code. Reply first (the bridge
      // re-spawns the hub from its own, newer dist when it sees `restarting`),
      // then exit. Equal/older/absent versions never trigger a restart.
      const stale =
        url.pathname === "/api/register" &&
        typeof body.version === "string" &&
        compareVersions(body.version, AGENT_INFO.version) > 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stale ? { ok: true, restarting: true } : { ok: true }));
      if (stale) {
        log(
          `hub: bridge ${body.version} is newer than hub ${AGENT_INFO.version} — restarting to upgrade`,
        );
        const restart = setTimeout(() => {
          void close().finally(() => onIdleExit?.());
        }, 500);
        restart.unref();
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }

  function startProxy(client: WebSocket, bridge: WebSocket): void {
    const pair = { client, bridge };
    proxyPairs.add(pair);
    const teardown = (): void => {
      if (!proxyPairs.delete(pair)) return;
      client.close();
      bridge.close();
    };
    // Forward with the frame's binary flag intact: `ws.send(buffer)` defaults
    // to a BINARY frame, and the SDK's WS server drops non-text frames.
    const forward =
      (to: WebSocket) =>
      (data: RawData, isBinary: boolean): void => {
        if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
      };
    client.on("message", forward(bridge));
    bridge.on("message", forward(client));
    client.on("close", teardown);
    client.on("error", teardown);
    bridge.on("close", teardown);
    bridge.on("error", teardown);
  }

  // Prune instances whose bridge stopped heartbeating (crash or Zed exit).
  const pruner = setInterval(
    () => {
      const now = Date.now();
      for (const [id, entry] of instances) {
        if (now - entry.lastSeen > heartbeatTimeoutMs) {
          instances.delete(id);
          idleSince = null;
          log(`hub: pruned instance ${id} (heartbeat timeout)`);
        }
      }
    },
    Math.min(heartbeatTimeoutMs / 2, 5_000),
  );
  pruner.unref();
  timers.push(pruner);

  // Keepalive pings on both legs — tunnels (notably Cloudflare) drop idle WS.
  const pinger = setInterval(() => {
    for (const { client, bridge } of proxyPairs) {
      if (client.readyState === WebSocket.OPEN) client.ping();
      if (bridge.readyState === WebSocket.OPEN) bridge.ping();
    }
  }, pingIntervalMs);
  pinger.unref();
  timers.push(pinger);

  // Idle exit: with nothing registered and nobody proxied, the hub exits; the
  // next bridge re-spawns it on demand (see endpoint.ts).
  const idleCheck = setInterval(
    () => {
      if (instances.size > 0 || proxyPairs.size > 0) {
        idleSince = null;
        return;
      }
      if (idleSince === null) idleSince = Date.now();
      if (Date.now() - idleSince >= idleExitMs) {
        log("hub: idle for too long with no instances — exiting");
        clearInterval(idleCheck);
        void close().finally(() => onIdleExit?.());
      }
    },
    Math.min(idleExitMs / 4, 10_000),
  );
  idleCheck.unref();
  timers.push(idleCheck);

  async function close(): Promise<void> {
    for (const t of timers) clearInterval(t);
    for (const { client, bridge } of proxyPairs) {
      client.terminate();
      bridge.terminate();
    }
    proxyPairs.clear();
    wss.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return new Promise<HubHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      // port 0 binds an ephemeral port — report the actual one (used by tests).
      const addr = server.address();
      const bound = typeof addr === "object" && addr !== null ? addr.port : port;
      log(`hub: listening on ${host}:${bound} (instances: 0)`);
      resolve({ port: bound, close });
    });
  });
}
