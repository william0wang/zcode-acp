/**
 * Remote Terminal relay (app ADR-0011): the hub is a DUMB AUTHENTICATED PIPE
 * between remote clients (phone/web) and the desktop workbench. The hub never
 * interprets terminal frames — the Remote Terminal object, event log, and
 * turn state machine live in the workbench (`.zcode/docs/remote-terminal-
 * requirements.md` in the app repo). Two WebSocket endpoints:
 *
 *   /api/desktop-control — the workbench's outbound control connection
 *     (auth + the x-zcode-client desktop header, checked by the caller).
 *     Counts as connection-tier Desktop Presence while open. Exactly one is
 *     kept: a second connection supersedes the first (app restart race).
 *   /api/terminals/ws — a remote client's terminal socket, frame-relayed
 *     onto the control connection verbatim, both directions.
 *
 * The only hub-consumed frames come FROM the workbench (never relayed):
 *   {type:"push", title, body} — the shared push pipeline (push.ts: per-kind
 *     switch push.notify.terminal, `contentDetail:"minimal"` strips the body
 *     — command output transits Tencent otherwise — and the delivered-diary
 *     trail records every send; best-effort like every push)
 *   {type:"audit", line} — one diary line per turn (warn(), NOT log(): the
 *     hub daemon's stderr is null in production, so the on-disk diary is the
 *     only record — this line is the compensating control ADR-0011 names
 *     for the arbitrary-execution capability)
 *
 * The one hub-GENERATED frame goes TO the workbench (never relayed from a
 * client): {type:"subs", count} whenever the relayed-client count changes —
 * the workbench's only signal for "nobody is watching" (it gates turn-done
 * pushes on count 0).
 *
 * The `remote.exec.enabled` gate (default false, live-read by the caller) is
 * enforced at client-socket accept, re-checked on every relayed frame, and
 * swept by the keepalive interval — so flipping the config tears down live
 * pairings (idle ones included) without a hub restart. The control
 * connection itself is never gated — it carries Desktop Presence
 * regardless, and its relay-side frames are dropped while disabled.
 *
 * Keepalive mirrors the hub's proxy pinger: ping every interval, terminate a
 * leg that missed one full interval of pongs — a half-open socket (laptop
 * sleep, NAT cut) would otherwise stay OPEN locally, keep `controlAlive()`
 * reporting presence on a dead workbench, and buffer frames into the void
 * while the phone waits forever.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { pushTerminalNotification } from "../push/push.js";
import { log, warn } from "../utils.js";

/** Frame cap: input lines and result tails are small; bigger is abuse or a bug. */
const MAX_FRAME_BYTES = 256 * 1024;
/** Keepalive cadence for both endpoints (tunnels drop idle links ~100s). */
export const PING_INTERVAL_MS = 30_000;
/** Audit line cap — the workbench composes the line, the hub just bounds it. */
const MAX_AUDIT_CHARS = 500;
const MAX_PUSH_TITLE = 200;
const MAX_PUSH_BODY = 1024;

export interface TerminalRelayOptions {
  /** Live `remote.exec.enabled` gate (default false — caller wires the live read). */
  enabled: () => boolean;
  /** Keepalive sweep cadence (tests shrink it); default PING_INTERVAL_MS. */
  pingIntervalMs?: number;
}

export interface TerminalRelay {
  /** Complete an authenticated upgrade onto one of the two relay endpoints. */
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    kind: "control" | "client",
  ): void;
  /** True while a workbench control connection is open (Desktop Presence). */
  controlAlive(): boolean;
  close(): void;
}

/** Normalize a ws message payload to one Buffer (forwarded verbatim, parsed for control). */
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

interface ParsedFrame {
  type?: unknown;
  title?: unknown;
  body?: unknown;
  line?: unknown;
}

function parseJsonFrame(data: RawData): ParsedFrame | null {
  try {
    const parsed: unknown = JSON.parse(toBuffer(data).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as ParsedFrame) : null;
  } catch {
    return null;
  }
}

function errorFrame(code: string, message: string): string {
  return JSON.stringify({ v: 1, type: "error", code, message });
}

/** Send one error frame, then close with a matching code — the client renders the reason. */
function errorClose(ws: WebSocket, code: string, message: string, closeCode = 4001): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(errorFrame(code, message));
    ws.close(closeCode, code);
  } catch {
    ws.terminate();
  }
}

export function createTerminalRelay(opts: TerminalRelayOptions): TerminalRelay {
  const { pingIntervalMs = PING_INTERVAL_MS } = opts;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  /** The single workbench control connection (superseded on a second one). */
  let control: WebSocket | null = null;
  /** Remote client sockets, all frame-relayed onto the control connection. */
  const clients = new Set<WebSocket>();
  /** Legs that answered the last ping (WeakSet: membership dies with the socket). */
  const pongResponsive = new WeakSet<WebSocket>();

  /** Arm keepalive supervision on one leg (grace until the first sweep — a fresh socket has not had a chance to pong yet). */
  function supervise(ws: WebSocket): void {
    pongResponsive.add(ws);
    ws.on("pong", () => pongResponsive.add(ws));
  }

  const ping = setInterval(() => {
    // Spec §Security sweep: the gate is live-read, so a flip must also reach
    // IDLE pairs — the per-frame checks only fire when something moves.
    if (!opts.enabled() && clients.size > 0) {
      dropClients("disabled", "remote terminal disabled (remote.exec.enabled)");
    }
    for (const ws of [control, ...clients]) {
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      if (pongResponsive.has(ws)) {
        pongResponsive.delete(ws);
        try {
          ws.ping();
        } catch {
          /* dead sockets surface via their own close/error handlers */
        }
      } else {
        log("terminal-relay: leg missed a keepalive pong — terminating (dead peer)");
        ws.terminate();
      }
    }
  }, pingIntervalMs);
  ping.unref();

  /** Hub-consumed workbench frames (push/audit); true when the frame was consumed. */
  function consumeHubFrame(frame: ParsedFrame): boolean {
    if (frame.type === "push") {
      const title =
        typeof frame.title === "string" && frame.title.trim()
          ? frame.title.trim().slice(0, MAX_PUSH_TITLE)
          : "Remote terminal";
      const body = typeof frame.body === "string" ? frame.body.slice(0, MAX_PUSH_BODY).trim() : "";
      pushTerminalNotification({ kind: "terminal", title, body: body || undefined });
      return true;
    }
    if (frame.type === "audit") {
      if (typeof frame.line === "string" && frame.line.trim()) {
        warn(`terminal: ${frame.line.slice(0, MAX_AUDIT_CHARS)}`);
      }
      return true;
    }
    return false;
  }

  function dropClients(code: string, message: string): void {
    for (const c of clients) errorClose(c, code, message);
    clients.clear();
  }

  /** Tell the workbench how many remote clients are attached (push gate). */
  function notifySubs(): void {
    if (!control || control.readyState !== WebSocket.OPEN) return;
    try {
      control.send(JSON.stringify({ v: 1, type: "subs", count: clients.size }));
    } catch {
      /* a dead control is reaped by its own close handler */
    }
  }

  function attachControl(ws: WebSocket): void {
    const prev = control;
    control = ws;
    supervise(ws);
    if (prev && prev.readyState === WebSocket.OPEN) {
      log("terminal-relay: new workbench control connection — superseding the previous one");
      prev.close(4000, "superseded");
    }
    log("terminal-relay: workbench control connected");
    if (!opts.enabled()) {
      warn(
        "terminal-relay: remote.exec disabled — control connection stays (presence), relay inert",
      );
    }
    ws.on("message", (data: RawData) => {
      // push/audit always land (they report turns that already ran); relaying
      // is the part the switch gates.
      const frame = parseJsonFrame(data);
      if (frame && consumeHubFrame(frame)) return;
      if (!opts.enabled()) {
        // Spec §Security: a gated frame means live pairs must go NOW — the
        // idle ones are swept by the keepalive interval above. A silent drop
        // here would freeze phone screens mid-turn with no error frame.
        dropClients("disabled", "remote terminal disabled (remote.exec.enabled)");
        return;
      }
      if (frame === null) {
        warn("terminal-relay: non-JSON frame from workbench — dropped");
        return;
      }
      const buf = toBuffer(data);
      for (const c of clients) {
        if (c.readyState === WebSocket.OPEN) {
          try {
            c.send(buf);
          } catch {
            /* a dead client is reaped by its own close handler */
          }
        }
      }
    });
    const gone = (): void => {
      if (control !== ws) return;
      control = null;
      log("terminal-relay: workbench control gone — dropping remote clients");
      dropClients("no_carrier", "desktop workbench disconnected");
    };
    ws.on("close", gone);
    ws.on("error", gone);
  }

  const relay = {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, kind: "control" | "client") {
      if (kind === "control") {
        wss.handleUpgrade(req, socket, head, attachControl);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        if (!opts.enabled()) {
          errorClose(ws, "disabled", "remote terminal disabled (remote.exec.enabled)");
          return;
        }
        if (!control || control.readyState !== WebSocket.OPEN) {
          errorClose(ws, "no_carrier", "no desktop workbench connected");
          return;
        }
        clients.add(ws);
        supervise(ws);
        notifySubs();
        ws.on("message", (data: RawData) => {
          if (!opts.enabled()) {
            errorClose(ws, "disabled", "remote terminal disabled (remote.exec.enabled)");
            return;
          }
          if (!control || control.readyState !== WebSocket.OPEN) {
            errorClose(ws, "no_carrier", "desktop workbench disconnected");
            return;
          }
          try {
            control.send(toBuffer(data));
          } catch {
            errorClose(ws, "no_carrier", "desktop workbench disconnected");
          }
        });
        const goneClient = (): void => {
          if (clients.delete(ws)) notifySubs();
        };
        ws.on("close", goneClient);
        ws.on("error", goneClient);
      });
    },

    controlAlive(): boolean {
      return control !== null && control.readyState === WebSocket.OPEN;
    },

    close(): void {
      clearInterval(ping);
      dropClients("no_carrier", "hub shutting down");
      control?.close(1001, "hub shutting down");
      control = null;
      wss.close();
    },
  };

  return relay;
}
