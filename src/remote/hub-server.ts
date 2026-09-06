/**
 * Hub daemon — machine-level singleton for remote access.
 *
 * The hub is the ONLY public entry point (the port a tunnel maps). It does
 * token auth, instance discovery, and byte-level WebSocket proxying from a
 * remote client to one bridge's loopback ACP endpoint (ADR-0002), plus two
 * plain-HTTP conveniences that spare clients a full ACP round-trip (ADR-0005):
 * a proxied per-instance /status, and an account-level /api/quota queried
 * directly (quota belongs to the machine's credentials, not to any instance).
 * POST /api/upgrade lets a client TRIGGER a self-decided restart: the hub
 * re-checks whether the on-disk build is newer than the running process and,
 * only if so, re-spawns itself onto it — the decision is never the client's.
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

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  createServer,
  get as httpGet,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { AGENT_INFO, compareVersions, log, warn } from "../utils.js";
import type { TerminalPrefs } from "../config/user-config.js";
import { remoteTerminalPrefs } from "./config.js";
import { accountUsageStats, type UsageStatsResult } from "../handlers/account.js";
import { BOOT_RESUME_TRIGGER } from "../handlers/session.js";
import { formatQuotaDock } from "../quota/format.js";
import { queryQuota } from "../quota/index.js";
import { listKnownWorkspaces } from "../tasks-index.js";

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
  /**
   * Fires when the hub decided it should restart onto newer on-disk code
   * (a newer bridge registered, or POST /api/upgrade found the dist newer).
   * The standalone daemon re-spawns a replacement before exiting (see
   * bin/hub.ts); falls back to onIdleExit when unset.
   */
  onRestart?: () => void;
  /**
   * Override the on-disk locations /api/upgrade checks against (tests point
   * these at fixtures). Defaults: this package's package.json and the dist
   * directory this module runs from.
   */
  codePaths?: { packageJson: string; distDir: string };
  /**
   * Override where the remote session-create endpoints read the known-project
   * whitelist from (tests point this at a fixture sqlite). Default: the App's
   * tasks-index.sqlite (see listKnownWorkspaces).
   */
  projectsDbPath?: string;
  /**
   * Override how the remote session-create / session-resume endpoints spawn
   * a bridge (tests inject a fake). Default: this node + this package's
   * dist/cli.js — an interactive TUI in a visible terminal for
   * session-create and session-resume ("tui"; resume carries the requested
   * session in ZCODE_ACP_RESUME_SESSION), a detached headless serve bridge
   * for background queries ("serve").
   */
  spawnServe?: (opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    /** "tui" = visible terminal (session-create/-resume); "serve" = detached headless. */
    kind: "tui" | "serve";
  }) => ChildProcess | Promise<ChildProcess>;
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
  /** "editor" (stdio bridge) or "serve" (headless, hub-spawned, ADR-0014). */
  origin: "editor" | "serve";
  /**
   * Hub-incubation correlation (ADR-0016/0017): the nonce this bridge's
   * incubation spawned it with, echoed from ZCODE_ACP_SPAWN_NONCE. Absent on
   * bridges started by hand or by older hubs — the incubation poll falls back
   * to any nonce-less registration for them.
   */
  nonce?: string;
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

/** realpath spelling of p; a vanished path falls back to raw equality. */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
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

/** How long POST /api/instances waits for the spawned bridge to register. */
const SERVE_REGISTER_TIMEOUT_MS = 10_000;
const SERVE_REGISTER_POLL_MS = 300;

/** Register-origin parser: only "serve" is special; anything else is "editor". */
function parseOrigin(raw: unknown): "editor" | "serve" {
  return raw === "serve" ? "serve" : "editor";
}

/**
 * The TUI-in-a-terminal incubation budget (ADR-0016): a visible terminal
 * adds a GUI round-trip (Terminal app launch, TUI boot, its bridge child)
 * ahead of the hub registration — double the headless budget.
 */
const TUI_REGISTER_TIMEOUT_MS = 20_000;
/** `open -a <terminal>` must answer fast or the incubation falls back. */
const TERMINAL_OPEN_TIMEOUT_MS = 3_000;

/** Single-quote for sh: ' → '\'' . */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** How the hub hands the .command script to a terminal (ADR-0016). */
export type TerminalLaunch =
  /** ZCODE_ACP_HUB_TERMINAL_COMMAND: a shell command; `{script}` (if present)
   * is replaced by the quoted script path, else the path is appended. */
  | { kind: "shell"; command: string }
  /** `.command`-executing apps (Terminal, iTerm): `open -a <app> <script>`. */
  | { kind: "openApp"; app: string }
  /** Terminals driven by their own CLI: `open -na <app> --args <args> <sh>
   * <script>` — args come first, the script program is appended. */
  | { kind: "openAppArgs"; app: string; args: string[] }
  /** Warp: refuses `.command` files and its CLI is agent-only, but its URI
   * scheme EXECUTES a script handed to action/new_tab's path param
   * (app/src/uri/mod.rs → open_file; verified on 0.2026.09.02): the hub opens
   * `<scheme>://action/new_tab?path=<script>` and Warp runs it as a new tab
   * in its default mode. Preview uses the warppreview:// scheme. */
  | { kind: "warpUri"; app: string; scheme: string };

/**
 * Built-in launch recipes for well-known macOS terminals (ADR-0016 §5). Each
 * mechanism is the app's documented, verified way to run a command in a fresh
 * window: Terminal and iTerm execute `.command` files handed over via open;
 * WezTerm's `start --` runs an alternative program (wezterm.org/cli/start.html);
 * kitty takes the program as normal positional arguments
 * (sw.kovidgoyal.net/kitty/invocation); Alacritty and Ghostty support the
 * common `-e` flag; Warp rides its new_tab URI action (see warpUri above).
 * The script does its own `cd`, so no per-app cwd flags. Hyper is absent — no
 * programmatic command execution at all (vercel/hyper#3677).
 */
const TERMINAL_APP_LAUNCHERS: Record<string, TerminalLaunch> = {
  terminal: { kind: "openApp", app: "Terminal" },
  apple_terminal: { kind: "openApp", app: "Terminal" },
  iterm: { kind: "openApp", app: "iTerm" },
  iterm2: { kind: "openApp", app: "iTerm" },
  wezterm: { kind: "openAppArgs", app: "WezTerm", args: ["start", "--"] },
  kitty: { kind: "openAppArgs", app: "kitty", args: [] },
  alacritty: { kind: "openAppArgs", app: "Alacritty", args: ["-e"] },
  ghostty: { kind: "openAppArgs", app: "Ghostty", args: ["-e"] },
  warp: { kind: "warpUri", app: "Warp", scheme: "warp" },
  "warp-preview": { kind: "warpUri", app: "Warp Preview", scheme: "warppreview" },
  warp_preview: { kind: "warpUri", app: "Warp Preview", scheme: "warppreview" },
};

/**
 * Pick how to open the TUI script. Preferences arrive pre-merged from
 * `remoteTerminalPrefs` (config file first, env fallback — see config.ts);
 * only the app-name normalization lives here. Priority: the explicit command
 * template (the universal escape hatch) → a built-in launcher by app name
 * (aliases are case- and `.app`-suffix-insensitive) → plain Terminal.app
 * (macOS has no default-terminal setting to detect). Any other unmatched
 * name passes through to `open -a` unchanged.
 */
export function resolveTerminalLaunch(
  env: NodeJS.ProcessEnv,
  prefs: TerminalPrefs = remoteTerminalPrefs(env),
): {
  launch: TerminalLaunch;
  warning?: string;
} {
  if (prefs.command) return { launch: { kind: "shell", command: prefs.command } };
  const raw = prefs.app ?? "";
  const name = raw
    .toLowerCase()
    .replace(/\.app$/, "")
    .replace(/\s+/g, "-");
  const launcher = TERMINAL_APP_LAUNCHERS[name];
  if (launcher) return { launch: launcher };
  return { launch: { kind: "openApp", app: raw || "Terminal" } };
}

/**
 * The .command script body. The incubation env MUST be embedded as exports:
 * the script runs in a fresh shell spawned by the terminal app, which
 * inherits launchd's environment — NOT the hub's — so without them the TUI
 * would boot as a plain local session and never register back (the
 * incubation would stall into its timeout). Everything ZCODE_ACP_* travels;
 * values are single-quoted.
 */
export function terminalTuiScript(cwd: string, cliJs: string, env: NodeJS.ProcessEnv): string {
  const exports = Object.keys(env)
    // DSH_TUI_AUTOPROMPT is the one non-ZCODE_ACP_* passenger: the boot-resume
    // banner handshake (martty reads it at its own process start).
    .filter((k) => k.startsWith("ZCODE_ACP_") || k === "DSH_TUI_AUTOPROMPT")
    .map((k) => `export ${k}=${shQuote(String(env[k]))}`);
  return [
    "#!/bin/sh",
    `# Hub-incubated TUI session (ADR-0016): closing this window ends the bridge.`,
    `cd ${shQuote(cwd)} || exit 1`,
    ...exports,
    // OSC 0 names the tab after the conversation — without it terminals show
    // the running process ("node"). printf reads the \033/\007 escapes from
    // the format string; %s keeps the value itself shell-safe. martty never
    // sets a terminal title, so this survives until the window closes.
    ...(env.ZCODE_ACP_TAB_TITLE !== undefined
      ? [`printf '\\033]0;%s\\007' "$ZCODE_ACP_TAB_TITLE"`]
      : []),
    `exec ${shQuote(process.execPath)} ${shQuote(cliJs)}`,
    "",
  ].join("\n");
}

/**
 * Spawn session-create as a VISIBLE interactive TUI (ADR-0016): write a
 * throwaway .command script (`cd <project> && exec node cli.js`) and hand it
 * to a terminal (resolveTerminalLaunch) — the user gets a real terminal
 * window running the local CLI instead of an invisible daemon. The TUI's
 * bridge child inherits the remote ENV, so the incubation registers exactly
 * like a serve bridge; closing the window ends the bridge (its lifetime
 * follows the terminal, the ADR-0001 anchor). Returns null when a terminal
 * can't be used — platform, gated off via ZCODE_ACP_HUB_TERMINAL, or the
 * open failing (headless/SSH) — and the caller falls back to the detached
 * serve spawn.
 */
async function spawnTerminalTui(opts: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ChildProcess | null> {
  if (process.platform !== "darwin") return null;
  // Terminal prefs are read LIVE here (config file first, env fallback): the
  // hub outlives the shells that configured it, and its birth env rotates
  // between GUI editors and interactive shells — only the file is stable.
  // Set remote.terminal.enabled=false in ~/.config/zcode-acp/config.json (or
  // ZCODE_ACP_HUB_TERMINAL=0) to keep remote session-create headless.
  if (!remoteTerminalPrefs(process.env).enabled) return null;
  const cliJs = fileURLToPath(new URL("../cli.js", import.meta.url));
  const script = path.join(mkdtempSync(path.join(tmpdir(), "zcode-acp-term-")), "tui.command");
  writeFileSync(script, terminalTuiScript(opts.cwd, cliJs, opts.env), { mode: 0o700 });
  chmodSync(script, 0o700);
  const { launch, warning } = resolveTerminalLaunch(process.env);
  if (warning) warn(`hub: ${warning}`);
  let argv: string[];
  if (launch.kind === "shell") {
    const rendered = launch.command.includes("{script}")
      ? launch.command.replace("{script}", shQuote(script))
      : `${launch.command} ${shQuote(script)}`;
    argv = ["/bin/sh", "-c", rendered];
  } else if (launch.kind === "openApp") {
    argv = ["open", "-a", launch.app, script];
  } else if (launch.kind === "warpUri") {
    // new_tab = Warp's default open mode (like Cmd+T: a tab in the focused
    // window; Warp opens a window first if none exists).
    argv = [
      "open",
      "-a",
      launch.app,
      `${launch.scheme}://action/new_tab?path=${encodeURIComponent(script)}`,
    ];
  } else {
    argv = ["open", "-na", launch.app, "--args", ...launch.args, "/bin/sh", script];
  }
  // Async spawn — spawnSync would freeze the hub's event loop (WS proxying,
  // heartbeats for every live bridge) for up to the full timeout while a GUI
  // app cold-starts.
  const errChunks: Buffer[] = [];
  const opened = await new Promise<{ error?: Error; timedOut?: boolean; code?: number | null }>(
    (resolve) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr?.on("data", (c: Buffer) => errChunks.push(c));
      const timer = setTimeout(() => {
        child.kill();
        resolve({ timedOut: true });
      }, TERMINAL_OPEN_TIMEOUT_MS);
      child.once("error", (e: Error) => {
        clearTimeout(timer);
        resolve({ error: e });
      });
      child.once("exit", (code: number | null) => {
        clearTimeout(timer);
        resolve({ code });
      });
    },
  );
  if (opened.error || opened.timedOut || opened.code !== 0) {
    const detail = opened.timedOut
      ? `timed out after ${TERMINAL_OPEN_TIMEOUT_MS}ms`
      : (opened.error?.message ?? Buffer.concat(errChunks).toString("utf8").trim()) ||
        `exit ${opened.code ?? "?"}`;
    warn(`hub: no terminal window for ${opts.cwd} (${detail}) — falling back to a headless bridge`);
    return null;
  }
  log(`hub: opened a Terminal TUI for ${opts.cwd}`);
  // `open` has already exited; incubation only needs a child that reads as
  // alive until the bridge registers. A window that dies early surfaces as
  // the register timeout — the terminal window itself shows the reason.
  const fake = new EventEmitter() as ChildProcess & {
    pid: number;
    exitCode: number | null;
    signalCode: string | null;
  };
  fake.pid = -1;
  fake.exitCode = null;
  fake.signalCode = null;
  return fake as unknown as ChildProcess;
}

/**
 * Default bridge spawner for the remote session-create endpoints: a visible
 * terminal TUI for session-create (ADR-0016, macOS + not gated off), a
 * detached headless serve bridge otherwise (the ADR-0014 original — also the
 * fallback whenever the terminal window can't be opened).
 */
async function defaultSpawnServe(opts: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  kind: "tui" | "serve";
}): Promise<ChildProcess> {
  if (opts.kind === "tui") {
    const viaTerminal = await spawnTerminalTui(opts);
    if (viaTerminal) return viaTerminal;
  }
  // dist/remote/hub-server.js → dist/cli.js (one level up).
  const cliJs = fileURLToPath(new URL("../cli.js", import.meta.url));
  const child = spawn(process.execPath, [cliJs, "serve"], {
    cwd: opts.cwd,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: opts.env,
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => {
    for (const line of d.split("\n")) {
      if (line.trim()) warn(`serve-bridge[${opts.cwd}]: ${line}`);
    }
  });
  child.once("error", (e) => warn(`serve-bridge[${opts.cwd}] spawn failed: ${e.message}`));
  child.unref();
  return child;
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
 * Cached dock string for GET /api/quota/dock (ADR-0021) — the compact one-line
 * quota format consumed by the Martty TUI refresher. Shorter TTL than
 * /api/quota (15s): the dock is resident UI, freshness beats upstream load.
 * `formatted: null` (no data) is cached too, so a credentials-less machine
 * does not hammer the API on every 60s refresh.
 */
const DOCK_TTL_MS = 15_000;
let dockCache: { formatted: string | null; at: number } | null = null;

function getQuotaDock(): Promise<{ formatted: string | null; fetchedAt: number }> {
  if (dockCache && Date.now() - dockCache.at < DOCK_TTL_MS) {
    return Promise.resolve({ formatted: dockCache.formatted, fetchedAt: dockCache.at });
  }
  return queryQuota().then((result) => {
    dockCache = { formatted: formatQuotaDock(result), at: Date.now() };
    return { formatted: dockCache.formatted, fetchedAt: dockCache.at };
  });
}

/** Reset the dock cache (test helper). */
export function resetDockCacheForTest(): void {
  dockCache = null;
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

/** Body cap for a bridge's GET /sessions answer (session lists are small). */
const MAX_SESSION_LIST_BYTES = 4 * 1024 * 1024;
/**
 * A cold bridge must spawn its backend before the store answers, so the
 * budget covers an incubation plus one session/list round-trip (the bridge
 * gives its own query 15s).
 */
const SESSION_LIST_TIMEOUT_MS = 12_000;
/** Best-effort budget for the resume tab-title lookup — the window must
 *  never wait on a slow bridge (the 12s list budget is for listings, not
 *  for cosmetics). */
const TITLE_LOOKUP_BUDGET_MS = 2_000;

/**
 * Tab-title sanitizer: the value is printf'd into the terminal as an OSC
 * payload, so control characters (an ESC inside a model-generated summary
 * would inject terminal sequences) become spaces, whitespace collapses, and
 * the length caps at what a tab can usefully show. Empty/non-string →
 * undefined (the caller falls back to the project name).
 */
export function sanitizeTabTitle(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const clean = v
    .replace(/[\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return clean.length > 0 ? clean : undefined;
}

/** Resolve with undefined after `ms` — for best-effort lookups that must not
 *  stall their caller; the losing promise settles into the void (its own
 *  rejection is the caller's `.catch`, never unhandled). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  const timeout = new Promise<undefined>((resolve) => {
    setTimeout(() => resolve(undefined), ms).unref?.();
  });
  return Promise.race([p, timeout]);
}

/**
 * Fetch a bridge's GET /sessions payload (ADR-0015), forwarding the
 * pagination query ("?limit=..&before=.."). Resolves with the parsed JSON;
 * rejects on transport failure, a non-200 answer, truncation, or a non-JSON
 * body — the caller turns every rejection into a 502.
 */
function fetchBridgeSessions(
  port: number,
  query = "",
): Promise<{ sessions?: unknown[]; nextCursor?: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: "127.0.0.1", port, path: `/sessions${query}` }, (up) => {
      if ((up.statusCode ?? 500) !== 200) {
        up.resume();
        reject(new Error(`bridge answered ${up.statusCode ?? "?"}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      up.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_SESSION_LIST_BYTES) {
          up.destroy();
          reject(new Error("bridge session list too large"));
          return;
        }
        chunks.push(c);
      });
      up.on("end", () => {
        try {
          resolve(
            JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              sessions?: unknown[];
              nextCursor?: unknown;
            },
          );
        } catch {
          reject(new Error("bridge returned an invalid session list"));
        }
      });
      up.on("error", () => reject(new Error("bridge session list failed")));
    });
    req.on("error", () => reject(new Error("bridge unreachable")));
    req.setTimeout(SESSION_LIST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error("bridge session list timed out"));
    });
  });
}

/**
 * Where /api/upgrade looks for on-disk code: root package.json + dist/.
 */
function defaultCodePaths(): { packageJson: string; distDir: string } {
  // dist/remote/hub-server.js → ../../package.json and dist/ (src/ in dev
  // has no .js files, so the mtime signal simply stays silent there).
  return {
    packageJson: fileURLToPath(new URL("../../package.json", import.meta.url)),
    distDir: fileURLToPath(new URL("../", import.meta.url)),
  };
}

/** Newest mtime among .js files under dir (recursive); null when none found. */
async function newestJsMtime(dir: string): Promise<number | null> {
  let newest: number | null = null;
  const walk = async (current: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // unreadable subtree — skip it, don't fail the check
    }
    for (const entry of entries) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        try {
          // Floor to whole ms: APFS mtimes carry sub-ms fractions while
          // Date.now() truncates, and a same-ms write/start pair would
          // otherwise look "newer" than a hub started after it.
          const mtime = Math.floor((await stat(p)).mtimeMs);
          if (newest === null || mtime > newest) newest = mtime;
        } catch {
          /* raced deletion */
        }
      }
    }
  };
  await walk(dir);
  return newest;
}

/**
 * /api/upgrade staleness check: is the code on DISK newer than this running
 * process? Either signal suffices — the on-disk package.json version beats
 * the version frozen into this process at start (a release upgrade), or any
 * .js under dist was written after process start (a rebuild, even without a
 * version bump). A respawned process starts after the newest dist mtime, so
 * the condition self-negates: no restart loops.
 */
async function diskCodeIsNewer(
  paths: { packageJson: string; distDir: string },
  startedAt: number,
): Promise<{
  newer: boolean;
  reason: "version" | "mtime" | "up-to-date";
  diskVersion: string | null;
}> {
  let diskVersion: string | null = null;
  try {
    const pkg = JSON.parse(await readFile(paths.packageJson, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string") diskVersion = pkg.version;
  } catch {
    /* unreadable package.json — the mtime signal still applies */
  }
  if (diskVersion && compareVersions(diskVersion, AGENT_INFO.version) > 0) {
    return { newer: true, reason: "version", diskVersion };
  }
  const newest = await newestJsMtime(paths.distDir);
  if (newest !== null && newest > startedAt) {
    return { newer: true, reason: "mtime", diskVersion };
  }
  return { newer: false, reason: "up-to-date", diskVersion };
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
    onRestart,
    codePaths = defaultCodePaths(),
    projectsDbPath,
    spawnServe = defaultSpawnServe,
  } = options;

  /** Frozen at hub start — the anchor the /api/upgrade signals compare to. */
  const startedAt = Date.now();

  const instances = new Map<string, InstanceEntry>();
  const proxyPairs = new Set<{ client: WebSocket; bridge: WebSocket }>();
  const timers: Array<ReturnType<typeof setInterval>> = [];

  /**
   * Single-flight incubation per workspace (remote session-create,
   * ADR-0014): concurrent POSTs for the same project join the SAME
   * incubation instead of racing a second detached process past the
   * findServe check (check-then-act). Check-then-set is one synchronous
   * block, so requests can only ever observe "no entry" one at a time.
   * A resume incubation keys by session instead (ADR-0017) — concurrent
   * resumes of different sessions each get their own window.
   */
  // Single-flight incubation (see joinIncubation below).
  const serveIncubations = new Map<
    string,
    { kind: "tui" | "serve" | "resume"; promise: Promise<{ id: string; reused: boolean }> }
  >();

  /** Live serve instances for a workspace, oldest registration first. */
  const findServeInstances = (workspacePath: string): InstanceEntry[] => {
    // The dedupe key must be canonical: a whitelist row (or registration) can
    // carry a symlinked or otherwise non-canonical spelling while the serve
    // child registers with its RESOLVED process cwd — raw string equality
    // would never match, 502-ing every create and spawning a duplicate per
    // retry. realpath both sides; a vanished path falls back to raw equality.
    const wanted = canonicalPath(workspacePath);
    return Array.from(instances.values()).filter(
      (e) => e.origin === "serve" && canonicalPath(e.workspace) === wanted,
    );
  };

  /** The live serve instance for a workspace, if any (per-workspace dedupe). */
  const findServeInstance = (workspacePath: string): InstanceEntry | undefined =>
    findServeInstances(workspacePath)[0];

  /**
   * Spawn a bridge and poll until it registers (or fails fast on child exit /
   * timeout). Shared by every incubating endpoint for this workspace — all
   * joiners see the same outcome. Kind picks the spawn surface and the
   * payload: "tui" opens a visible terminal (remote session-create,
   * ADR-0016), "resume" a visible terminal that boots straight into the
   * requested session (ADR-0017), "serve" the detached headless bridge
   * (background listing, ADR-0015).
   */
  const incubateServe = async (
    workspacePath: string,
    kind: "tui" | "serve" | "resume",
    sessionId?: string,
    tabTitle?: string,
  ): Promise<{ id: string; reused: boolean }> => {
    // Async spawn failures (ENOENT — the dir vanished between the whitelist
    // check and the spawn) arrive as an 'error' event with exitCode still
    // null; without this flag the poll burns the full budget.
    let spawnError: Error | null = null;
    let child: ChildProcess;
    // Incubation correlation (ADR-0016/0017): the spawned bridge echoes this
    // back on every registration, so the poll pairs THIS spawn with ITS
    // registration even when several incubations race for one workspace.
    // terminalTuiScript exports the var into the terminal's fresh shell; the
    // detached serve spawn inherits it directly.
    const nonce = randomUUID();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ZCODE_ACP_REMOTE: "1",
      ZCODE_ACP_REMOTE_TOKEN: token,
      ZCODE_ACP_HUB_PORT: String(port),
      ZCODE_ACP_SPAWN_NONCE: nonce,
      // Parity with the bridge-side spawnHub: the serve child may have to
      // (re)spawn the hub itself, and must bind the same configured host.
      ZCODE_ACP_HUB_HOST: host,
      // ADR-0016: the incubated bridge registers as THIS project's serve
      // bridge (the hub's per-workspace dedupe matches it) and pins its
      // session roots to the project cwd, so ADR-0014's whitelist
      // semantics survive the visible-terminal lifecycle. The detached
      // serve path ignores both (it hardcodes origin/serveMode itself).
      ZCODE_ACP_REMOTE_ORIGIN: "serve",
      ZCODE_ACP_REMOTE_PIN_CWD: "1",
    };
    if (kind === "resume") {
      // ADR-0017: the requested session rides the env — terminalTuiScript
      // exports every ZCODE_ACP_* var into the terminal's fresh shell, so the
      // TUI boots into it. The detached serve fallback ignores it; the
      // client attaches to the serve bridge and session/loads there instead.
      env.ZCODE_ACP_RESUME_SESSION = sessionId;
      // Banner handshake (see BOOT_RESUME_TRIGGER): martty auto-submits this
      // text at boot, which drops its welcome banner and reveals the
      // boot-replayed history without waiting for the user's first message.
      // Must ride the env verbatim — martty reads it once at process start.
      env.DSH_TUI_AUTOPROMPT = BOOT_RESUME_TRIGGER;
    }
    if (kind !== "serve") {
      // Tab title (both visible-terminal kinds): a resume carries the
      // conversation's title when the hub resolved it; session-create and a
      // failed lookup fall back to the project name. Rides the env —
      // terminalTuiScript turns it into an OSC 0 before exec'ing the CLI
      // (terminals otherwise name the tab after the process, "node").
      env.ZCODE_ACP_TAB_TITLE = tabTitle ?? path.basename(workspacePath);
    }
    try {
      // Resume shares session-create's visible-terminal surface (and its
      // detached-serve fallback for headless machines); only a background
      // listing spawns the headless form — it must never pop a window.
      child = await spawnServe({
        cwd: workspacePath,
        kind: kind === "serve" ? "serve" : "tui",
        env,
      });
      child.once("error", (e: Error) => {
        spawnError = e;
      });
    } catch (e) {
      warn(`hub: serve spawn failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new Error("serve bridge spawn failed");
    }
    log(
      `hub: spawned ${
        kind === "resume" ? "resume TUI" : kind === "tui" ? "terminal TUI" : "serve bridge"
      } for ${workspacePath} (pid ${child.pid})`,
    );
    const budget = kind === "serve" ? SERVE_REGISTER_TIMEOUT_MS : TUI_REGISTER_TIMEOUT_MS;
    const deadline = Date.now() + budget;
    // A visible-terminal incubation (create OR resume) runs NEXT TO the serve
    // bridge the listing already incubated, and several incubations can race
    // for one workspace: the poll matches only a registration that is neither
    // a pre-existing instance nor another incubation's bridge — otherwise a
    // create would answer with the listing's headless bridge and the window
    // would never be the returned instance. Only "serve" (the ensure-a-bridge
    // listing) accepts any live registration. A nonce-less registration means
    // a bridge older than the nonce protocol — accept it, or a legacy spawn
    // could never satisfy its own incubation.
    const preexisting = new Set<string>(
      kind === "serve" ? [] : findServeInstances(workspacePath).map((e) => e.id),
    );
    for (;;) {
      await new Promise<void>((resolve) => setTimeout(resolve, SERVE_REGISTER_POLL_MS).unref?.());
      const candidates = findServeInstances(workspacePath).filter((e) => !preexisting.has(e.id));
      const entry = candidates.find((e) => e.nonce === nonce) ?? candidates.find((e) => !e.nonce);
      if (entry) return { id: entry.id, reused: false };
      // The child dying is the honest fast-fail (missing cwd perms, port
      // exhaustion, crash) — without this check the loop burns the full budget.
      // (A terminal TUI reports through the window itself, so only the
      // timeout applies there.)
      if (spawnError || child.exitCode !== null || child.signalCode !== null) {
        warn(`hub: serve bridge for ${workspacePath} exited during startup`);
        throw new Error("serve bridge exited during startup");
      }
      if (Date.now() > deadline) {
        warn(`hub: serve bridge for ${workspacePath} never registered`);
        throw new Error("serve bridge did not register in time");
      }
    }
  };

  /**
   * Single-flight incubation per workspace: concurrent endpoint calls join one
   * spawn instead of racing duplicates. A "serve" caller (the listing) joins
   * ANY in-flight incubation keyed to its workspace — the outcome it waits for
   * is "a serve bridge is registered", whichever surface spawned it. A "tui"
   * caller (session-create) joins only another tui: the visible window IS the
   * feature (ADR-0016), so it never piggybacks on an invisible listing spawn.
   * A "resume" caller joins only the exact same session (ADR-0017) — its map
   * key carries the session id, so resumes of different sessions each get
   * their own window.
   */
  const joinIncubation = (
    workspacePath: string,
    kind: "tui" | "serve" | "resume",
    sessionId?: string,
    tabTitle?: string,
  ): Promise<{ id: string; reused: boolean }> => {
    const mapKey =
      kind === "resume" ? `${workspacePath}\u0000resume\u0000${sessionId ?? ""}` : workspacePath;
    const inflight = serveIncubations.get(mapKey);
    if (inflight && (inflight.kind === kind || kind === "serve")) {
      log(`hub: joining the incubating serve bridge for ${workspacePath}`);
      return inflight.promise;
    }
    const promise = incubateServe(workspacePath, kind, sessionId, tabTitle);
    serveIncubations.set(mapKey, { kind, promise });
    // Drop the entry once settled (identity-checked — a newer incubation may
    // already have replaced it). The catch keeps the DERIVED promise handled;
    // the original is awaited by its creating request.
    promise
      .catch(() => undefined)
      .finally(() => {
        const current = serveIncubations.get(mapKey);
        if (current && current.promise === promise) serveIncubations.delete(mapKey);
      });
    return promise;
  };

  /**
   * Reply first, then gracefully stop (close() releases the port) and hand
   * over. `close` is declared below and hoisted — it only runs inside the
   * timer, long after this scope is fully initialised.
   */
  const restartSoon = (message: string): void => {
    log(message);
    const restart = setTimeout(() => {
      void close().finally(() => (onRestart ?? onIdleExit)?.());
    }, 500);
    restart.unref();
  };

  let idleSince: number | null = null;

  const wss = new WebSocketServer({ noServer: true });

  /**
   * Reject a WS upgrade with a real HTTP status before destroying. A bare
   * destroy leaves the client's upgrade request hanging on an opaque
   * ECONNRESET — the `ws` client surfaces that as an error on its internal
   * upgrade request with no clean signal, so machine clients (the TUI's hub
   * client included) hang or crash on it instead of reading the reason.
   */
  const rejectUpgrade = (socket: Duplex, status: number, reason: string): void => {
    try {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    } catch {
      // best-effort — the destroy below is the actual rejection
    }
    socket.destroy();
  };

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
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!authorized(req, url, token)) {
      warn("hub: unauthorized WS upgrade rejected");
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    const entry = instances.get(url.searchParams.get("instance") ?? "");
    if (!entry) {
      warn("hub: WS upgrade for unknown instance rejected");
      rejectUpgrade(socket, 404, "Unknown Instance");
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
      rejectUpgrade(socket, 502, "Bridge Unreachable");
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
          origin: e.origin,
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
    // GET /api/quota/dock — the compact quota-dock string for the TUI
    // refresher (ADR-0021). Account-level like /api/quota; hub-side cache is
    // the only caching layer, so clients must not store stale copies.
    if (url.pathname === "/api/quota/dock" && req.method === "GET") {
      if (!authorized(req, url, token)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      try {
        const { formatted, fetchedAt } = await getQuotaDock();
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ formatted, fetchedAt }));
      } catch {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("quota query failed");
      }
      return;
    }
    // GET /api/projects — the machine's known-project list (remote
    // session-create, ADR-0014). Sourced from the App's tasks index: every
    // workspace that ever ran a session. The list gates POST /api/instances
    // (paths outside it are refused) — a convenience bound, not a security
    // boundary: bridge-side session materialization also writes rows here,
    // and a token holder can already drive an editor-bridge session in any
    // cwd. The trust boundary is the token itself.
    if (url.pathname === "/api/projects" && req.method === "GET") {
      if (!authorized(req, url, token)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      const projects = await listKnownWorkspaces(projectsDbPath);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(projects));
      return;
    }
    // GET /api/projects/sessions?workspacePath=… — the project's backend
    // session store (ADR-0015), including closed ones no bridge advertises.
    // Discovery stays running-scoped by design; this is the deliberate
    // "resume an old session" surface. PAGINATED (long-lived projects hold
    // dozens of sessions): ?limit= (default 20, max 200) rows newest-first,
    // ?before=<ms> resumes an older page; the answer's nextCursor (null on
    // the last page) feeds the next call. Same whitelist gate as
    // POST /api/instances (the check bounds which cwds may incubate a serve
    // bridge), then the ADR-0014 incubation ensures a serve bridge and the
    // query proxies to its loopback /sessions. The answer wraps the bridge
    // payload with the instance a list-then-load client attaches to
    // (session/load reuses the same one).
    if (url.pathname === "/api/projects/sessions" && req.method === "GET") {
      if (!authorized(req, url, token)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      const workspacePath = (url.searchParams.get("workspacePath") ?? "").trim();
      if (!workspacePath) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("workspacePath required");
        return;
      }
      // Pagination forwarding: validate here so a bad page request fails
      // fast with 400 instead of surfacing as the bridge's 502.
      const pagination = new URLSearchParams();
      for (const name of ["limit", "before"]) {
        const raw = url.searchParams.get(name);
        if (raw === null) continue;
        if (!/^\d+$/.test(raw) || (name === "limit" && parseInt(raw, 10) < 1)) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`invalid ${name} — positive integer expected`);
          return;
        }
        pagination.set(name, raw);
      }
      const beforeId = url.searchParams.get("beforeId");
      if (beforeId !== null) {
        if (!/^[\w.:-]+$/.test(beforeId)) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("invalid beforeId — session id expected");
          return;
        }
        pagination.set("beforeId", beforeId);
      }
      const known = await listKnownWorkspaces(projectsDbPath);
      if (!known.some((p) => p.workspacePath === workspacePath)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("unknown project");
        return;
      }
      try {
        let entry = findServeInstance(workspacePath);
        if (!entry) {
          // "serve": a background listing must not pop a terminal window
          // (ADR-0015) — only session-create does (ADR-0016). joinIncubation
          // makes concurrent listings (and a listing racing a create) share
          // one spawn instead of doubling bridges.
          await joinIncubation(workspacePath, "serve");
          entry = findServeInstance(workspacePath);
        }
        if (!entry) {
          throw new Error("serve bridge did not register");
        }
        const qs = pagination.toString();
        const payload = await fetchBridgeSessions(entry.port, qs ? `?${qs}` : "");
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(
          JSON.stringify({
            workspacePath,
            instance: { id: entry.id, origin: entry.origin },
            ...(Array.isArray(payload.sessions)
              ? { sessions: payload.sessions }
              : { sessions: [] }),
            nextCursor: payload.nextCursor ?? null,
          }),
        );
      } catch (e) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(e instanceof Error ? e.message : "session list failed");
      }
      return;
    }
    // POST /api/instances — create a bridge for one known project, or RESUME
    // one of its closed sessions (optional sessionId, ADR-0017). BOTH paths
    // incubate a VISIBLE interactive TUI in the user's terminal (ADR-0016 as
    // amended, macOS; ZCODE_ACP_HUB_TERMINAL=0 / headless falls back to the
    // detached `zcode-acp serve` of ADR-0014). Without a sessionId the TUI
    // starts a fresh conversation; with one — the backend store id from the
    // ADR-0015 listing — it boots straight into that session. Neither path
    // reuses a live serve bridge: the App flow always runs the history
    // listing first, which incubates a headless serve instance, and reuse
    // would mean the window can never open (the pre-amendment behaviour).
    // The hub waits for the bridge's heartbeat registration; the bridge lives
    // its own life afterwards (a terminal TUI until the window closes, a
    // serve bridge on its idle timer). Concurrent identical POSTs join one
    // in-flight incubation; a create and a resume, or two different sessions,
    // each get their own window. Accepted bound: a hub restart clears the
    // instance table, so a POST inside the bridges' ≤10s re-registration
    // window may incubate a duplicate — harmless (the extra window is
    // closable; background serve bridges dedupe by workspace elsewhere).
    if (url.pathname === "/api/instances" && req.method === "POST") {
      if (!authorized(req, url, token)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      const body = await readJson(req);
      const rawPath = (body as { workspacePath?: unknown } | undefined)?.workspacePath;
      const workspacePath = typeof rawPath === "string" ? rawPath.trim() : "";
      if (!workspacePath) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("workspacePath required");
        return;
      }
      // Optional session resume (ADR-0017); the shape mirrors beforeId's.
      const rawSid = (body as { sessionId?: unknown } | undefined)?.sessionId;
      const resumeSid = typeof rawSid === "string" ? rawSid.trim() : "";
      if (resumeSid && !/^[\w.:-]+$/.test(resumeSid)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("invalid sessionId — session id expected");
        return;
      }
      const known = await listKnownWorkspaces(projectsDbPath);
      if (!known.some((p) => p.workspacePath === workspacePath)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("unknown project");
        return;
      }
      if (resumeSid) {
        // Tab title, best-effort: the App browsed this conversation through
        // the serve bridge's /sessions history, which is normally still live
        // and still holds the title. Every miss (no live instance, id beyond
        // the page, slow fetch) falls back to the project name inside
        // incubateServe — the window must never wait on this lookup.
        let tabTitle: string | undefined;
        const titleSource = findServeInstance(workspacePath);
        if (titleSource) {
          const row = await withTimeout(
            fetchBridgeSessions(titleSource.port, "?limit=200")
              .then((payload) =>
                (payload.sessions ?? []).find(
                  (s) => (s as { sessionId?: unknown }).sessionId === resumeSid,
                ),
              )
              .catch(() => undefined),
            TITLE_LOOKUP_BUDGET_MS,
          );
          tabTitle = sanitizeTabTitle((row as { title?: unknown } | undefined)?.title);
        }
        // Resume never reuses the live serve bridge: the window IS the
        // feature, and the answer must be the NEW instance so the attaching
        // client and the terminal share one bridge (and one backend process)
        // for the session. A bogus id still opens the window — the TUI
        // shows the load failure and falls back to a fresh session, the same
        // honesty as a window that dies early (ADR-0016 §4).
        const incubation = joinIncubation(workspacePath, "resume", resumeSid, tabTitle);
        try {
          const out = await incubation;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out));
        } catch (e) {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end(e instanceof Error ? e.message : "serve bridge failed");
        }
        return;
      }
      // Session-create ALWAYS incubates a VISIBLE terminal TUI (ADR-0016 as
      // amended): the App flow lists the project's history first, which
      // incubates a headless serve bridge — reusing that instance (the
      // original behaviour) meant a window could NEVER open once the project
      // was browsed, and every create ran invisibly in the background. The
      // answer is the NEW window's instance; concurrent identical POSTs join
      // one incubation, and the detached headless serve spawn remains the
      // fallback (no GUI / gated off / open failure). Clients that want a
      // headless attach use the listing's instance id instead of this POST.
      const incubation = joinIncubation(workspacePath, "tui");
      try {
        const out = await incubation;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(e instanceof Error ? e.message : "serve bridge failed");
      }
      return;
    }
    // POST /api/upgrade — a remote client may TRIGGER a staleness check but
    // never decide the restart: the hub compares its frozen running version
    // and process start time against the on-disk package.json and dist
    // mtimes, and only restarts onto code it judged newer (diskCodeIsNewer).
    if (url.pathname === "/api/upgrade" && req.method === "POST") {
      if (!authorized(req, url, token)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      const check = await diskCodeIsNewer(codePaths, startedAt);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          restarting: check.newer,
          reason: check.reason,
          runningVersion: AGENT_INFO.version,
          diskVersion: check.diskVersion,
        }),
      );
      if (check.newer) {
        restartSoon(
          `hub: on-disk code is newer (${check.reason}: ${check.diskVersion ?? "rebuilt dist"}) — restarting onto it`,
        );
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
    // POST /api/instances/{id}/sessions/{sid}/close|rename — the remote HTTP
    // write surface (ADR-0006): forward-and-relay to the bridge's loopback
    // route. The hub still routes by instance id only; semantics (running
    // guard / discovery retirement, title validation + pinning + broadcast)
    // stay in the bridge. Any request body pipes through untouched.
    const sessionOpMatch = url.pathname.match(
      /^\/api\/instances\/([^/]+)\/sessions\/([^/]+)\/(close|rename)$/,
    );
    if (sessionOpMatch && req.method === "POST") {
      const [, instId, sid, op] = sessionOpMatch;
      if (!authorized(req, url, token)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      const entry = instances.get(instId!);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("unknown instance");
        return;
      }
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: entry.port,
          path: `/sessions/${sid}/${op}`,
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
      // Relay any request body through (close sends none, rename carries the
      // JSON title — chunked, since the hub does not forward headers).
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
          origin: parseOrigin(body.origin),
          // Incubation correlation (ADR-0016/0017); absent for hand-started
          // bridges. A re-registration (heartbeat) refreshes it — a bridge's
          // nonce never changes, so this is inert in practice.
          ...(typeof body.nonce === "string" && body.nonce ? { nonce: body.nonce } : {}),
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
        restartSoon(
          `hub: bridge ${body.version} is newer than hub ${AGENT_INFO.version} — restarting to upgrade`,
        );
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
