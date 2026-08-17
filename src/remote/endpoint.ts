/**
 * Loopback ACP endpoint + hub registration for remote access.
 *
 * When ZCODE_ACP_REMOTE is enabled, the bridge serves the SAME AgentApp that
 * handles the stdio editor connection on a loopback HTTP/WebSocket endpoint
 * (SDK AcpServer transport). Each remote connection gets its own JSON-RPC id
 * space; fan-out to all clients is handled by the broadcast registry, not
 * here. This endpoint is intentionally NOT exposed to the network — the hub
 * (`zcode-acp-hub`) is the single public entry and proxies into it.
 *
 * The bridge also registers itself with the hub (spawning one if none is
 * listening) and re-registers every 10s as a heartbeat carrying fresh session
 * summaries. Everything here is best-effort: any failure warns and disables
 * the remote side without touching the stdio link.
 */

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

import type * as acp from "@agentclientprotocol/sdk";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import {
  createNodeHttpHandler,
  createNodeWebSocketUpgradeHandler,
} from "@agentclientprotocol/sdk/experimental/node";
import { WebSocketServer } from "ws";

import type { ZcodeAcpServer } from "../server.js";
import { AGENT_INFO, log, warn } from "../utils.js";
import type { RemoteConfig } from "./config.js";

/** How often the bridge re-registers with the hub (also the heartbeat). */
const HEARTBEAT_MS = 10_000;
/** Minimum spacing between hub spawn attempts (avoids spawn storms). */
const SPAWN_THROTTLE_MS = 60_000;
/** Max ports probed above ZCODE_ACP_REMOTE_PORT before giving up. */
const MAX_PORT_PROBES = 100;

export interface RemoteEndpointHandle {
  /** Actual loopback port the endpoint bound (may differ from config). */
  port: number;
  /** Stop the endpoint and unregister from the hub (best-effort). */
  stop(): Promise<void>;
}

/** Probe one loopback port; false = taken or otherwise unusable. */
function tryListen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
}

/**
 * Session summaries for the hub's discovery API. Only sessions with real
 * interaction (`hasActivity`) are pushed: an editor restart auto-resumes its
 * stored placeholder, materializing an empty backend session — pushing that
 * would make remote clients list (and open) a conversation that never
 * happened. The hub replaces the whole list on every register, so a session
 * that gains activity shows up within one heartbeat (~10s).
 */
export function sessionsPayload(
  server: ZcodeAcpServer,
): Array<{ sessionId: string; title?: string; updatedAt: number }> {
  return Array.from(server.sessionSummaries.entries())
    .filter(([, s]) => s.hasActivity)
    .map(([sessionId, s]) => ({
      sessionId,
      ...(s.title !== undefined ? { title: s.title } : {}),
      updatedAt: s.updatedAt,
    }));
}

async function postJson(url: string, body: unknown, timeoutMs = 3000): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Start the loopback endpoint and hub registration. Never throws — failures
 * warn and leave the bridge running stdio-only.
 */
export async function startRemoteEndpoint(
  server: ZcodeAcpServer,
  app: acp.AgentApp,
  config: RemoteConfig,
): Promise<RemoteEndpointHandle | null> {
  const acpServer = new AcpServer({ agent: app });
  const acpHttpHandler = createNodeHttpHandler(acpServer);
  const wss = new WebSocketServer({ noServer: true });
  const upgradeHandler = createNodeWebSocketUpgradeHandler(acpServer, wss);

  const httpServer = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/acp") acpHttpHandler(req, res);
    else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  httpServer.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/acp") upgradeHandler(req, socket, head);
    else socket.destroy();
  });

  // Port scan: several Zed windows spawn several bridges, each takes the next
  // free port starting at ZCODE_ACP_REMOTE_PORT.
  let port = 0;
  for (let probe = 0; probe < MAX_PORT_PROBES; probe++) {
    if (await tryListen(httpServer, config.bridgePort + probe)) {
      port = config.bridgePort + probe;
      break;
    }
  }
  if (!port) {
    warn(
      `remote: no free loopback port in ${config.bridgePort}..${config.bridgePort + MAX_PORT_PROBES - 1} — remote disabled`,
    );
    wss.close();
    return null;
  }
  // The listener must not keep the process alive on its own (ADR-0001: the
  // bridge's lifetime follows the stdio editor, not remote clients).
  httpServer.unref();
  httpServer.on("error", (e) => warn(`remote: endpoint error: ${e.message}`));
  log(`remote: ACP endpoint listening on 127.0.0.1:${port}/acp`);

  // ---- hub registration (heartbeat loop) ----
  const instanceId = String(process.pid);
  let stopped = false;
  let authRejected = false;
  let spawnThrottledUntil = 0;

  const payload = () => ({
    token: config.token,
    id: instanceId,
    port,
    pid: process.pid,
    workspace: server.workspaceLabel(),
    sessions: sessionsPayload(server),
    // Lets the hub detect that it is older than this bridge and restart
    // itself (we then re-spawn it from this dist — see registerOnce).
    version: AGENT_INFO.version,
  });

  const spawnHub = (): void => {
    try {
      // dist/remote/endpoint.js → dist/bin/hub.js (one level up, then bin/).
      const hubJs = fileURLToPath(new URL("../bin/hub.js", import.meta.url));
      const child = spawn(process.execPath, [hubJs], {
        detached: true,
        // Surface the daemon's stderr through the bridge's diagnostics — a
        // detached "ignore" pipe silently eats startup failures.
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          ZCODE_ACP_HUB_PORT: String(config.hubPort),
          ZCODE_ACP_HUB_HOST: config.hubHost,
          ZCODE_ACP_REMOTE_TOKEN: config.token,
        },
      });
      child.stderr?.on("data", (d: Buffer) => {
        for (const line of d.toString().split("\n")) {
          if (line.trim()) warn(`remote: hub: ${line}`);
        }
      });
      // Spawn failures (ENOENT when run from src without a build) arrive as an
      // async 'error' event — without a listener Node crashes the bridge.
      child.once("error", (e) => {
        warn(`remote: hub spawn failed: ${e.message}`);
      });
      child.unref();
      log(`remote: spawned hub on port ${config.hubPort} (pid ${child.pid})`);
    } catch (e) {
      warn(`remote: hub spawn failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const registerOnce = async (): Promise<void> => {
    if (stopped || authRejected) return;
    try {
      const res = await postJson(`http://127.0.0.1:${config.hubPort}/api/register`, payload());
      if (res.status === 401) {
        authRejected = true;
        warn(
          "remote: hub rejected the token (401) — registration stopped, check ZCODE_ACP_REMOTE_TOKEN",
        );
        return;
      }
      // Version handshake: the hub saw a newer bridge and is exiting. It is
      // gone by now (it exits ~0.5s after replying) — re-spawn it from THIS
      // dist (the upgraded code) and re-register. Throttled like the spawn
      // below so a hub that keeps answering `restarting` can't loop us.
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { restarting?: boolean } | null;
        if (body?.restarting) {
          log("remote: hub is older than this bridge — respawning upgraded hub");
          const respawn = setTimeout(() => {
            if (stopped || authRejected) return;
            if (Date.now() < spawnThrottledUntil) return;
            spawnThrottledUntil = Date.now() + SPAWN_THROTTLE_MS;
            spawnHub();
            const retry = setTimeout(() => void registerOnce(), 1500);
            retry.unref();
          }, 2000);
          respawn.unref();
        }
      }
    } catch {
      // Hub unreachable: (re)spawn it, throttled so a failing spawn can't
      // storm, then retry registration shortly after the daemon warms up
      // instead of waiting a full heartbeat cycle.
      if (Date.now() >= spawnThrottledUntil) {
        spawnThrottledUntil = Date.now() + SPAWN_THROTTLE_MS;
        spawnHub();
        const retry = setTimeout(() => void registerOnce(), 1500);
        retry.unref();
      }
    }
  };

  void registerOnce();
  const heartbeat = setInterval(() => void registerOnce(), HEARTBEAT_MS);
  heartbeat.unref();

  return {
    port,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(heartbeat);
      try {
        await postJson(
          `http://127.0.0.1:${config.hubPort}/api/unregister`,
          { token: config.token, id: instanceId },
          1500,
        );
      } catch {
        // Hub gone or unreachable — its heartbeat TTL will drop us anyway.
      }
      for (const client of wss.clients) client.terminate();
      wss.close();
      await acpServer.close().catch(() => undefined);
      httpServer.closeAllConnections?.();
      httpServer.close();
    },
  };
}
