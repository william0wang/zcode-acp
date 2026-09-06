#!/usr/bin/env node

/**
 * Entry point: wire the ZcodeAcpServer to a stdio ACP stream.
 *
 * The ACP SDK provides `ndJsonStream(output, input)` which frames newline-
 * delimited JSON-RPC over a pair of web streams. We convert Node's stdin/
 * stdout to web streams and hand them off. Everything else (request/response
 * correlation, param validation, AbortSignal plumbing) is handled by the SDK.
 *
 * Invoked directly (`node dist/index.js`) or via the Unified CLI's `server`
 * subcommand / the `zcode-acp-server` bin alias (both resolve to `dist/cli.js`).
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
  setMode,
  setModel,
  setThoughtLevel,
  updateRuntimeModelConfig,
} from "./handlers/extensions.js";
import { echoUserPromptToOthers, sendAvailableCommandsDeferred } from "./handlers/io.js";
import { loadEarlier } from "./handlers/replay.js";
import { resendPendingInteractions } from "./handlers/server-requests.js";
import { loadPluginCommands } from "./config/plugin-commands.js";
import { loadSkillCommands } from "./config/skill-discovery.js";
import { trackConnections } from "./remote/broadcast.js";
import { parseRemoteConfig } from "./remote/config.js";
import { startRemoteEndpoint, type RemoteEndpointHandle } from "./remote/endpoint.js";
import { reexecToBunIfEligible } from "./runtime.js";
import { messages } from "./i18n.js";
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
  // Localize the static commands' descriptions (names/hints stay as-is —
  // they are tokens); plugin/skill descriptions come from their own sources.
  const m = messages();
  const seen = new Set<string>(SLASH_COMMANDS.map((c) => c.name));
  const merged: Array<{ name: string; description: string; input?: { hint: string } }> = [
    ...SLASH_COMMANDS.map((c) => ({
      ...c,
      description: m.slashCommandDescriptions[c.name] ?? c.description,
    })),
  ];
  for (const c of [...pluginCommands, ...skillCommands]) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      merged.push(c);
    }
  }
  return merged;
}

export async function main(): Promise<void> {
  // Remote config is parsed BEFORE the server exists: a hub-incubated REPL
  // bridge (ADR-0016) arrives with ZCODE_ACP_REMOTE_PIN_CWD=1, and the pin
  // must hold from the very first session/new — not from the endpoint start.
  const remoteConfigEarly = parseRemoteConfig();
  // stdout is the outbound channel to the client; stdin is inbound.
  const outbound = Writable.toWeb(process.stdout);
  const inbound = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  const stream = acp.ndJsonStream(outbound, inbound);
  const server = new ZcodeAcpServer({ serveMode: remoteConfigEarly?.pinCwd === true });

  // Load all commands once at startup (they don't change mid-session).
  const allCommands = buildAllCommands();

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

  const app = buildAgentApp(server, allCommands);

  // Register broadcast tracking BEFORE connect so the stdio connection is
  // captured, then wire the stdio transport. The same app is later shared
  // with the remote WS endpoint.
  trackConnections(app, server.clients);
  app.connect(stream);

  // Remote access (opt-in via ENV): serve the same app on a loopback WS/HTTP
  // endpoint and register with the machine-level hub. Failures warn and leave
  // the stdio link untouched.
  if (remoteConfigEarly) {
    remoteHandle = await startRemoteEndpoint(server, app, remoteConfigEarly);
  }
}

/**
 * The full ACP method surface (spec + ZCode extensions), shared verbatim by
 * the stdio server (`main`) and the headless serve bridge (`runHeadless`) —
 * one build, two transports.
 */
function buildAgentApp(server: ZcodeAcpServer, allCommands: ReturnType<typeof buildAllCommands>) {
  /** Passthrough params parser for the ZCode-specific extension methods. */
  const extParams = z.object({ sessionId: z.string() }).passthrough();

  return (
    acp
      .agent({ name: AGENT_INFO.name })
      .onRequest("initialize", (ctx) => server.initialize(ctx.params, ctx.client))
      .onRequest("session/new", async (ctx) => {
        const result = await newSession(server, ctx.params, ctx.client);
        for (const sid of server.sessionAliases(result.sessionId)) {
          sendAvailableCommandsDeferred(server.clients.broadcast(), sid, allCommands);
        }
        return result;
      })
      .onRequest("session/list", (ctx) => listSessions(server, ctx.params))
      .onRequest("session/resume", async (ctx) => {
        const result = await resumeSession(server, ctx.params, server.clients.broadcast());
        for (const sid of server.sessionAliases(ctx.params.sessionId)) {
          sendAvailableCommandsDeferred(server.clients.broadcast(), sid, allCommands);
        }
        // A client that (re)connects catches up via resume/load; any interaction
        // request still waiting for an answer is re-sent to it so a question
        // fired while it was offline becomes answerable there.
        resendPendingInteractions(server, ctx.client, ctx.params.sessionId);
        return result;
      })
      .onRequest("session/load", async (ctx) => {
        const result = await loadSession(server, ctx.params, server.clients.broadcast());
        for (const sid of server.sessionAliases(ctx.params.sessionId)) {
          sendAvailableCommandsDeferred(server.clients.broadcast(), sid, allCommands);
        }
        resendPendingInteractions(server, ctx.client, ctx.params.sessionId);
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
      .onRequest("session/prompt", (ctx) => {
        // Mirror the user's message to every other client before the turn
        // starts — the prompting client renders it locally, the others only
        // ever see the agent's output.
        echoUserPromptToOthers(server, ctx.client, ctx.params);
        // JSON-RPC requests always carry a non-null id; the SDK types it as the
        // wider JsonRpcId, hence the narrowing cast.
        return prompt(
          server,
          ctx.params,
          server.clients.broadcast(),
          ctx.requestId as number | string,
          ctx.client,
        );
      })
      .onRequest("session/set_config_option", (ctx) =>
        setConfigOptionHandler(server, ctx.params, server.clients.broadcast()),
      )
      // ZCode-specific extensions (non-standard ACP methods). Use a passthrough
      // zod parser so all param fields survive into the handler.
      // session/steer, session/rewind, session/rewindCascade were removed in
      // zcode app-server 0.16+ (steer/rewind moved to the v4 conversation API);
      // the bridge dropped its passthroughs accordingly.
      .onRequest("session/fork", extParams, (ctx) => fork(server, ctx.params))
      .onRequest("session/goal", extParams, (ctx) => goal(server, ctx.params))
      .onRequest("session/compact", extParams, (ctx) =>
        compact(server, ctx.params, server.clients.broadcast()),
      )
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
      .onNotification("session/cancel", (ctx) => cancel(server, ctx.params))
  );
}

// ---------- headless serve bridge (remote session-create, ADR-0014) ----------

/** How long a serve bridge stays up with no clients attached and no turn running. */
const SERVE_IDLE_MS = 10 * 60_000;
const SERVE_IDLE_CHECK_MS = 30_000;

/**
 * Pure idle decision for the serve bridge: exit only when nothing is attached
 * (no ACP clients, no in-flight turns) AND that has been true for `idleMs`.
 * Busy ticks refresh `lastBusy` at the call site, so a long turn with all
 * clients gone still exits one idle window after it finishes — never mid-turn.
 */
export function serveIdleDecision(
  clients: number,
  pendingTurns: number,
  lastBusy: number,
  now: number,
  idleMs: number,
): boolean {
  if (clients > 0 || pendingTurns > 0) return false;
  return now - lastBusy >= idleMs;
}

/**
 * Headless bridge for remote session-create (`zcode-acp serve`): the same ACP
 * surface as `main`, minus the stdio editor. Spawned detached by the hub with
 * cwd = the chosen project; its lifecycle is the mirror of ADR-0001 — instead
 * of following the editor's stdio, it follows remote interest: stays alive
 * while any client is attached or any turn runs, exits SERVE_IDLE_MS after
 * the last of those ends. Remote access is not optional here — without the
 * endpoint the process has no reason to exist, so a missing config or failed
 * endpoint exits instead of degrading.
 */
export async function runHeadless(): Promise<void> {
  const remoteConfig = parseRemoteConfig();
  if (!remoteConfig) {
    warn(
      "serve: remote access is required for a headless bridge — set " +
        "ZCODE_ACP_REMOTE=1 and ZCODE_ACP_REMOTE_TOKEN",
    );
    process.exit(2);
  }
  const server = new ZcodeAcpServer({ serveMode: true });
  const allCommands = buildAllCommands();
  log(
    `starting ${AGENT_INFO.name} ${AGENT_INFO.version} serve (headless), project=${server.projectCwd()}`,
  );

  let remoteHandle: RemoteEndpointHandle | null = null;
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`serve: shutting down (${reason})`);
    if (remoteHandle) await remoteHandle.stop();
    if (server.backend) await server.backend.close();
    process.exit(0);
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => void shutdown(sig));
  }
  // Backend reader died (zcode subprocess exited) — bridge is useless without it.
  const backendDeathInterval = setInterval(() => {
    if (server.backend?.isDead) void shutdown("backend dead");
  }, 2000);
  backendDeathInterval.unref();
  // No stdin lifecycle here by design: the hub spawns the serve bridge with
  // stdin ignored, and ADR-0001's "editor closed stdin" signal has no editor
  // to come from — idle exit below is this mode's shutdown path.

  const app = buildAgentApp(server, allCommands);
  // Track connections BEFORE the endpoint accepts any WS client so every
  // remote connection lands in the broadcast registry from its first message.
  trackConnections(app, server.clients);

  remoteHandle = await startRemoteEndpoint(server, app, { ...remoteConfig, origin: "serve" });
  if (!remoteHandle) {
    warn("serve: remote endpoint failed to start — exiting");
    process.exit(1);
  }

  // Idle lifecycle + the process's only keep-alive: the endpoint's HTTP server
  // and heartbeat timers are all unref'd (ADR-0001), so without this interval
  // the process would exit immediately. Deliberately NOT unref'd.
  let lastBusy = Date.now();
  const idleCheck = setInterval(() => {
    if (server.clients.size > 0 || server.pendingTurns.size > 0) {
      lastBusy = Date.now();
      return;
    }
    if (
      serveIdleDecision(
        server.clients.size,
        server.pendingTurns.size,
        lastBusy,
        Date.now(),
        SERVE_IDLE_MS,
      )
    ) {
      void shutdown("idle — no clients attached and no turn running");
    }
  }, SERVE_IDLE_CHECK_MS);
  void idleCheck;
}

// Only auto-run when invoked directly (not when imported by the Unified CLI
// dispatcher). In an ESM build there is no `require.main`, so fall back to an
// entry-path heuristic like src/bin/quota.ts uses. Backslashes are normalized
// because argv[1] on Windows is a backslash path.
const invokedDirectly = (() => {
  const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
  return entry.endsWith("dist/index.js") || entry.endsWith("src/index.ts");
})();

if (invokedDirectly) {
  // Editors configured with `node dist/index.js` get the same Bun handover as
  // the Unified CLI entry (see src/runtime.ts) — no re-exec under Bun itself.
  reexecToBunIfEligible(process.argv[1] ?? "", process.argv.slice(2)).then((handed) => {
    if (handed) return;
    main().catch((err) => {
      warn(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exit(1);
    });
  });
}
