/**
 * ZCode subprocess client: the zcode dialect over the shared JSON-RPC transport.
 *
 * The ZCode app-server is launched as a subprocess (`zcode app-server --stdio`)
 * speaking line-delimited JSON over stdio. It deliberately omits the `jsonrpc`
 * field (its strict validator rejects it — see AGENTS.md), and pushes events
 * via the `session/event` notification plus `state.updated` settings patches.
 *
 * The generic transport (read-loop multiplexer, pending-request map, watchdog,
 * process-group lifecycle) lives in {@link JsonRpcChild}; this class only
 * supplies the zcode dialect.
 */

import { log } from "../utils.js";
import { backendCapabilities, type BackendCapabilities, type ServerRequest } from "./adapter.js";
import { JsonRpcChild } from "./jsonrpc-child.js";
import type { ZcodeEvent } from "./types.js";

// The generic wire vocabulary (ServerRequest, EventListener) lives in
// adapter.ts now; re-exported here so existing `backend/client.js` import
// paths keep working.
export type { EventListener, ServerRequest } from "./adapter.js";

export class ZcodeBackend extends JsonRpcChild {
  readonly capabilities: BackendCapabilities = backendCapabilities("zcode");

  /**
   * Arrival-time responder for `interaction/requestProviderRuntimeHeaders`.
   * The backend asks before EVERY model request on a zhipu-account provider,
   * and a request that lands while no turn loop is polling the server-request
   * queue (compact's internal turn, session/goal set, any backend-owned
   * generation) dies at the backend's 180s cap as "Captcha verification
   * request timed out" — auto-compact silently failed that way (observed
   * 2026-09-19). Wired by ZcodeAcpServer.ensureBackend to the coding-plan key
   * answer; returning false falls back to queueing (turn-loop handling).
   */
  providerRuntimeHeadersResponder?: (id: number, params: Record<string, unknown>) => boolean;
  /**
   * Arrival-time hook for compact terminal states. `session/compact` runs its
   * internal turn in the background and NEVER reports failure on the RPC —
   * the outcome only surfaces as a `state.updated` notification whose reason
   * is one of `session_compacted` / `session_compact_cancelled` /
   * `session_compact_failed` (source: server-operations.ts
   * `runCompactTurnInBackground` → `afterStateMutation`). Wired by
   * ZcodeAcpServer.ensureBackend to record per-session outcomes so compact()
   * can report real failure instead of assuming success from the RPC ack.
   */
  onCompactOutcome?: (sessionId: string, reason: string) => void;

  constructor(argv: string[], env: NodeJS.ProcessEnv) {
    super({
      argv,
      env,
      name: "zcode",
      logLabel: "zcode app-server",
      cliLabel: "zcode CLI",
      binEnvVar: "ZCODE_BIN",
    });
  }

  protected handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === "session/event") {
      this.dispatchEvent(params as unknown as ZcodeEvent);
      return;
    }
    if (method === "state.updated") {
      // Session settings changed (model/mode/thoughtLevel switch, incl.
      // mid-turn). The params carry the authoritative full settings patch:
      //   { patch: {mode, model, thoughtLevel, …}, reason, revision, sessionId }
      // Wrap as a ZcodeEvent so it flows through the same listener pipeline.
      const reason = typeof params["reason"] === "string" ? params["reason"] : "";
      if (reason.startsWith("session_compact_") && params["sessionId"] !== undefined) {
        this.onCompactOutcome?.(String(params["sessionId"]), reason);
      }
      const ev: ZcodeEvent = {
        sessionId: String(params.sessionId ?? ""),
        seq: 0,
        type: "state.updated",
        payload: params,
      };
      this.dispatchEvent(ev);
      return;
    }
    if (method === "interaction/providerRuntimeHeadersCancelled") {
      // The backend aborted a pending runtime-headers refresh (turn cancel,
      // 180s cap). Our responder answers at frame arrival, so the reply is
      // already out and there is nothing to un-answer — acknowledge only.
      log(`provider runtime headers ask cancelled by backend: ${JSON.stringify(params)}`);
      return;
    }
    // Other notifications are currently ignored (process/resourceSample, …).
  }

  protected handleServerRequest(req: ServerRequest): boolean {
    if (req.method === "session/requestRuntimePreferences") {
      // Newer app-servers block `session/create` until this handshake is
      // answered. Reply with defaults — no editor interaction needed.
      // Keep askUserQuestionAutoResolutionEnabled false so AskUserQuestion
      // still flows through the bridge's interaction path instead of being
      // auto-resolved server-side. Without this reply, create hangs.
      log(`backend: auto-replying ${req.method} (id=${String(req.id)}) with default preferences`);
      this.sendReply(req.id, {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      });
      return true;
    }
    if (
      req.method === "interaction/requestProviderRuntimeHeaders" &&
      this.providerRuntimeHeadersResponder?.(
        req.id as number,
        req.params as Record<string, unknown>,
      )
    ) {
      // Answered at arrival — see providerRuntimeHeadersResponder. This is
      // what keeps compact's internal model turn alive outside any turn loop.
      return true;
    }
    return false;
  }
}
