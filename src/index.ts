#!/usr/bin/env node

/**
 * Entry point: wire the ZcodeAcpServer to a stdio ACP stream.
 *
 * The ACP SDK provides `ndJsonStream(output, input)` which frames newline-
 * delimited JSON-RPC over a pair of web streams. We convert Node's stdin/
 * stdout to web streams and hand them off. Everything else (request/response
 * correlation, param validation, AbortSignal plumbing) is handled by the SDK.
 */

import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";

import { accountUsageStats } from "./handlers/account.js";
import {
  cancel,
  listSessions,
  loadSession,
  newSession,
  prompt,
  resumeSession,
  setConfigOptionHandler,
} from "./handlers/session.js";
import {
  cancelBackgroundTask,
  compact,
  fork,
  goal,
  rewind,
  rewindCascade,
  setMode,
  setModel,
  setThoughtLevel,
  steer,
  updateRuntimeModelConfig,
} from "./handlers/extensions.js";
import { sendAvailableCommandsDeferred } from "./handlers/io.js";
import { loadEarlier } from "./handlers/replay.js";
import { loadPluginCommands } from "./config/plugin-commands.js";
import { loadSkillCommands } from "./config/skill-discovery.js";
import { trackConnections } from "./remote/broadcast.js";
import { parseRemoteConfig } from "./remote/config.js";
import { startRemoteEndpoint, type RemoteEndpointHandle } from "./remote/endpoint.js";
import { ZcodeAcpServer } from "./server.js";
import { AGENT_INFO, SLASH_COMMANDS, log, warn } from "./utils.js";

/**
 * Build the full slash-command list: static bridge commands + dynamic plugin
 * commands + discovered skills. Called once at startup (nothing changes
 * mid-session). Deduplicates by name — static commands take priority, then
 * plugins, then skills.
 */
function buildAllCommands() {
  const pluginCommands = loadPluginCommands();
  const skillCommands = loadSkillCommands();
  const seen = new Set<string>(SLASH_COMMANDS.map((c) => c.name));
  const merged: Array<{ name: string; description: string; input?: { hint: string } }> = [
    ...SLASH_COMMANDS,
  ];
  for (const c of [...pluginCommands, ...skillCommands]) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      merged.push(c);
    }
  }
  return merged;
}

async function main(): Promise<void> {
  // stdout is the outbound channel to the client; stdin is inbound.
  const outbound = Writable.toWeb(process.stdout);
  const inbound = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  const stream = acp.ndJsonStream(outbound, inbound);
  const server = new ZcodeAcpServer();

  // Load all commands once at startup (they don't change mid-session).
  const allCommands = buildAllCommands();

  /** Passthrough params parser for the ZCode-specific extension methods. */
  const extParams = z.object({ sessionId: z.string() }).passthrough();

  log(`starting ${AGENT_INFO.name} ${AGENT_INFO.version}, ACP protocol v${acp.PROTOCOL_VERSION}`);

  // Remote access handle (null unless ZCODE_ACP_REMOTE is enabled and the
  // loopback endpoint came up). Declared before shutdown so signal handlers
  // always see the initialized binding.
  let remoteHandle: RemoteEndpointHandle | null = null;

  // Graceful shutdown: ensure the zcode subprocess group is reaped on signal,
  // stdin close (Zed disconnect), or backend death (so no orphans survive).
  // Zed force-kills the bridge on reconnect; without this the SIGTERM handler
  // wouldn't run close() and the detached zcode process group would persist.
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    // Stop the remote endpoint first (bounded by its 1.5s unregister timeout);
    // the hub's heartbeat TTL also prunes us if this doesn't complete.
    if (remoteHandle) await remoteHandle.stop();
    if (server.backend) await server.backend.close();
    process.exit(0);
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => void shutdown(sig));
  }
  // Zed disconnects by closing the bridge's stdin.
  process.stdin.on("close", () => void shutdown("stdin closed"));
  // Backend reader died (zcode subprocess exited) — bridge is useless without it.
  const backendDeathInterval = setInterval(() => {
    if (server.backend?.isDead) void shutdown("backend dead");
  }, 2000);
  backendDeathInterval.unref();

  const app = acp
    .agent({ name: AGENT_INFO.name })
    .onRequest("initialize", (ctx) => server.initialize(ctx.params))
    .onRequest("session/new", async (ctx) => {
      const result = await newSession(server, ctx.params);
      sendAvailableCommandsDeferred(server.clients.broadcast(), result.sessionId, allCommands);
      return result;
    })
    .onRequest("session/list", (ctx) => listSessions(server, ctx.params))
    .onRequest("session/resume", async (ctx) => {
      const result = await resumeSession(server, ctx.params, server.clients.broadcast());
      sendAvailableCommandsDeferred(server.clients.broadcast(), ctx.params.sessionId, allCommands);
      return result;
    })
    .onRequest("session/load", async (ctx) => {
      const result = await loadSession(server, ctx.params, server.clients.broadcast());
      sendAvailableCommandsDeferred(server.clients.broadcast(), ctx.params.sessionId, allCommands);
      return result;
    })
    // Tail-replay pagination (non-standard; Proposal 0001) — params stay
    // top-level because the parser below is ours, unlike spec methods where
    // bridge extensions must ride in `_meta.zcode`.
    .onRequest(
      "session/load_earlier",
      z
        .object({ sessionId: z.string(), before: z.string(), limit: z.number().optional() })
        .passthrough(),
      (ctx) => loadEarlier(server, ctx.params, server.clients.broadcast()),
    )
    // Account-level plan quota for remote clients (non-standard; Proposal
    // 0002). Pull-only, no session required; errors carry the failure kind in
    // `data.kind` so clients can hide the quota UI.
    .onRequest("account/usage_stats", z.object({}).passthrough(), () => accountUsageStats())
    .onRequest("session/prompt", (ctx) =>
      prompt(server, ctx.params, server.clients.broadcast(), ctx.requestId as number),
    )
    .onRequest("session/set_config_option", (ctx) =>
      setConfigOptionHandler(server, ctx.params, server.clients.broadcast()),
    )
    // ZCode-specific extensions (non-standard ACP methods). Use a passthrough
    // zod parser so all param fields survive into the handler.
    .onRequest("session/fork", extParams, (ctx) => fork(server, ctx.params))
    .onRequest("session/rewind", extParams, (ctx) => rewind(server, ctx.params))
    .onRequest("session/rewindCascade", extParams, (ctx) => rewindCascade(server, ctx.params))
    .onRequest("session/goal", extParams, (ctx) => goal(server, ctx.params))
    .onRequest("session/compact", extParams, (ctx) =>
      compact(server, ctx.params, server.clients.broadcast()),
    )
    .onRequest("session/steer", extParams, (ctx) => steer(server, ctx.params))
    .onRequest("session/cancelBackgroundTask", extParams, (ctx) =>
      cancelBackgroundTask(server, ctx.params),
    )
    .onRequest("session/setThoughtLevel", extParams, (ctx) => setThoughtLevel(server, ctx.params))
    .onRequest("session/updateRuntimeModelConfig", extParams, (ctx) =>
      updateRuntimeModelConfig(server, ctx.params),
    )
    .onRequest("session/setModel", extParams, (ctx) => setModel(server, ctx.params))
    .onRequest("session/setMode", extParams, (ctx) =>
      setMode(server, ctx.params, server.clients.broadcast()),
    )
    // Spec spelling of the same call (ACP session-modes uses snake_case with
    // `modeId`); the handler normalizes the param. Without this route, spec-only
    // clients (e.g. Paseo) get -32601 and cannot create agents in a non-default
    // mode.
    .onRequest("session/set_mode", extParams, (ctx) =>
      setMode(server, ctx.params, server.clients.broadcast()),
    )
    .onNotification("session/cancel", (ctx) => cancel(server, ctx.params));

  // Register broadcast tracking BEFORE connect so the stdio connection is
  // captured, then wire the stdio transport. The same app is later shared
  // with the remote WS endpoint.
  trackConnections(app, server.clients);
  app.connect(stream);

  // Remote access (opt-in via ENV): serve the same app on a loopback WS/HTTP
  // endpoint and register with the machine-level hub. Failures warn and leave
  // the stdio link untouched.
  const remoteConfig = parseRemoteConfig();
  if (remoteConfig) {
    remoteHandle = await startRemoteEndpoint(server, app, remoteConfig);
  }
}

main().catch((err) => {
  warn(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
