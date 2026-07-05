/**
 * ZCode-specific session method handlers (non-standard ACP extensions).
 *
 * Thin passthroughs for the extended session/* methods (0.14.8+):
 * fork/rewind/rewindCascade/goal/compact/steer/cancelBackgroundTask +
 * 0.15.0+: setThoughtLevel/updateRuntimeModelConfig/setModel/setMode.
 *
 * These share a near-identical shape (resolve sid → build params → forward →
 * check error). Only the genuine per-method differences are spelled out:
 * fork's new sid mapping, compact/goal(set)'s internal-turn lock wait, and
 * setModel rerouting through updateRuntimeModelConfig.
 */

import type * as acp from "@agentclientprotocol/sdk";

import { emitInitialUsage } from "../config/model-cache.js";
import { applyModelSwitch } from "../config/runtime-model.js";
import { buildConfigOptions, buildModes } from "../config/options.js";
import { ProjectionDiffer } from "../translators/projection-differ.js";
import { log } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";
import { sendSessionUpdate } from "./io.js";

/** Build the zcode `target` object from ACP params (checkpoint or latest). */
function buildCheckpointTarget(params: ExtensionParams): unknown {
  if (params.checkpointId) return { kind: "checkpoint", checkpointId: params.checkpointId };
  if (params.target) return params.target;
  return { kind: "latestCheckpoint" };
}

/** Resolve zcode sid from ACP params; throw if unknown. */
function resolveSidOrThrow(server: ZcodeAcpServer, params: { sessionId: string }): string {
  const sid = server.resolveSid(params.sessionId);
  if (!sid) throw new Error(`session ${params.sessionId} not found`);
  return sid;
}

interface ExtensionParams {
  sessionId: string;
  [key: string]: unknown;
}

type Result = Record<string, unknown>;

/** session/fork → zcode session/fork: branch a new session from a checkpoint. */
export async function fork(server: ZcodeAcpServer, params: ExtensionParams): Promise<Result> {
  const zcodeSid = resolveSidOrThrow(server, params);
  const backend = server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    "session/fork",
    { sessionId: zcodeSid, target: buildCheckpointTarget(params) },
    15000,
  );
  if (resp.error) throw new Error(`fork failed: ${resp.error.message}`);
  const result = (resp.result ?? {}) as { sessionId?: string };
  if (result.sessionId) server.sessionMap.set(result.sessionId, result.sessionId);
  log(`session/fork → ${result.sessionId ?? "?"}`);
  return result;
}

/** session/rewind → zcode session/rewind: restore workspace files to a checkpoint. */
export async function rewind(server: ZcodeAcpServer, params: ExtensionParams): Promise<Result> {
  const zcodeSid = resolveSidOrThrow(server, params);
  const zcParams: Record<string, unknown> = {
    sessionId: zcodeSid,
    target: buildCheckpointTarget(params),
  };
  if (params.expectedRevision !== undefined) zcParams.expectedRevision = params.expectedRevision;
  const resp = await server
    .ensureBackend()
    .request(server.nextId(), "session/rewind", zcParams, 15000);
  if (resp.error) throw new Error(`rewind failed: ${resp.error.message}`);
  log("session/rewind → ok");
  return (resp.result ?? {}) as Result;
}

/** session/rewindCascade → zcode session/rewindCascade: cascade rewind. */
export async function rewindCascade(
  server: ZcodeAcpServer,
  params: ExtensionParams,
): Promise<Result> {
  const zcodeSid = resolveSidOrThrow(server, params);
  const zcParams: Record<string, unknown> = {
    sessionId: zcodeSid,
    target: buildCheckpointTarget(params),
  };
  if (params.scope) zcParams.scope = params.scope;
  if (params.expectedRevision !== undefined) zcParams.expectedRevision = params.expectedRevision;
  const resp = await server
    .ensureBackend()
    .request(server.nextId(), "session/rewindCascade", zcParams, 15000);
  if (resp.error) throw new Error(`rewindCascade failed: ${resp.error.message}`);
  log("session/rewindCascade → ok");
  return (resp.result ?? {}) as Result;
}

/** session/goal → zcode session/goal: read/set/replace/clear/pause/resume the goal. */
export async function goal(server: ZcodeAcpServer, params: ExtensionParams): Promise<Result> {
  const zcodeSid = resolveSidOrThrow(server, params);
  const action = (params.action as string) ?? "show";
  const zcParams: Record<string, unknown> = { sessionId: zcodeSid, action };
  if ((action === "set" || action === "replace") && params.objective !== undefined) {
    zcParams.objective = params.objective;
  }
  const resp = await server
    .ensureBackend()
    .request(server.nextId(), "session/goal", zcParams, 15000);
  if (resp.error) throw new Error(`goal failed: ${resp.error.message}`);
  // set/replace start an internal AI turn → wait for the prompt lock to release.
  if (action === "set" || action === "replace") {
    const released = await waitForTurnIdle(server, zcodeSid, 60, "session/goal", false);
    log(
      `session/goal action=${action} → ok (${released ? "lock released" : "⚠ lock wait timeout"})`,
    );
  } else {
    log(`session/goal action=${action} → ok`);
  }
  return (resp.result ?? {}) as Result;
}

/** session/compact → zcode session/compact + wait for the internal AI turn. */
export async function compact(
  server: ZcodeAcpServer,
  params: ExtensionParams,
  cx: acp.AgentContext,
): Promise<Result> {
  const acpSid = params.sessionId;
  const zcodeSid = resolveSidOrThrow(server, params);
  const resp = await server
    .ensureBackend()
    .request(server.nextId(), "session/compact", { sessionId: zcodeSid }, 30000);
  if (resp.error) throw new Error(`compact failed: ${resp.error.message}`);
  // compact's internal AI turn (read history → LLM compress → write back) can
  // take minutes; expectLock=true avoids the startup-delay false-success window.
  const released = await waitForTurnIdle(server, zcodeSid, 300, "session/goal", true);
  log(`session/compact → ok (${released ? "lock released" : "⚠ lock wait timeout"})`);
  if (released) {
    // Refresh usage so the UI reflects the reduced contextUsed post-compact.
    // Ensure a differ exists (compact may be the first action on a fresh session)
    // and sync its usage baseline so the next turn won't re-emit the same value.
    let differ = server.differs.get(zcodeSid);
    if (!differ) {
      differ = new ProjectionDiffer();
      server.differs.set(zcodeSid, differ);
    }
    await emitInitialUsage(server, cx, acpSid, zcodeSid, differ);
  }
  return (resp.result ?? {}) as Result;
}

/** session/steer → zcode session/steer: append instructions to a running turn. */
export async function steer(server: ZcodeAcpServer, params: ExtensionParams): Promise<Result> {
  const zcodeSid = resolveSidOrThrow(server, params);
  const content = String(params.content ?? "");
  if (!content.trim()) throw new Error("steer requires content");
  const resp = await server
    .ensureBackend()
    .request(server.nextId(), "session/steer", { sessionId: zcodeSid, content }, 15000);
  if (resp.error) throw new Error(`steer failed: ${resp.error.message}`);
  const result = (resp.result ?? {}) as { kind?: string };
  log(`session/steer → kind=${result.kind ?? "?"}`);
  return result;
}

/** session/cancelBackgroundTask → zcode session/cancelBackgroundTask. */
export async function cancelBackgroundTask(
  server: ZcodeAcpServer,
  params: ExtensionParams,
): Promise<Result> {
  const zcodeSid = resolveSidOrThrow(server, params);
  const taskId = params.taskId;
  if (!taskId) throw new Error("cancelBackgroundTask requires taskId");
  const resp = await server
    .ensureBackend()
    .request(
      server.nextId(),
      "session/cancelBackgroundTask",
      { sessionId: zcodeSid, taskId },
      15000,
    );
  if (resp.error) throw new Error(`cancelBackgroundTask failed: ${resp.error.message}`);
  log(
    `session/cancelBackgroundTask → cancelled=${(resp.result as { cancelled?: boolean })?.cancelled}`,
  );
  return (resp.result ?? {}) as Result;
}

/** session/setThoughtLevel → zcode session/setThoughtLevel. */
export async function setThoughtLevel(
  server: ZcodeAcpServer,
  params: ExtensionParams,
): Promise<Result> {
  const zcodeSid = resolveSidOrThrow(server, params);
  const thoughtLevel = params.thoughtLevel;
  if (!thoughtLevel) throw new Error("setThoughtLevel requires thoughtLevel");
  const resp = await server
    .ensureBackend()
    .request(
      server.nextId(),
      "session/setThoughtLevel",
      { sessionId: zcodeSid, thoughtLevel },
      15000,
    );
  if (resp.error) throw new Error(`setThoughtLevel failed: ${resp.error.message}`);
  log("session/setThoughtLevel → ok");
  return (resp.result ?? {}) as Result;
}

/** session/updateRuntimeModelConfig → same: runtime overlay of session model config. */
export async function updateRuntimeModelConfig(
  server: ZcodeAcpServer,
  params: ExtensionParams,
): Promise<Result> {
  const zcodeSid = resolveSidOrThrow(server, params);
  const runtimeModel = params.runtimeModel;
  if (!runtimeModel) throw new Error("updateRuntimeModelConfig requires runtimeModel");
  const zcParams: Record<string, unknown> = { sessionId: zcodeSid, runtimeModel };
  if (params.applyModelSelection !== undefined)
    zcParams.applyModelSelection = params.applyModelSelection;
  const resp = await server
    .ensureBackend()
    .request(server.nextId(), "session/updateRuntimeModelConfig", zcParams, 15000);
  if (resp.error) throw new Error(`updateRuntimeModelConfig failed: ${resp.error.message}`);
  log("session/updateRuntimeModelConfig → ok");
  return (resp.result ?? {}) as Result;
}

/** session/setModel → applyModelSwitch (runtime overlay, not persistence). */
export async function setModel(server: ZcodeAcpServer, params: ExtensionParams): Promise<Result> {
  const zcodeSid = resolveSidOrThrow(server, params);
  const modelId = params.modelId as string;
  if (!modelId) throw new Error("setModel requires modelId");
  const ok = await applyModelSwitch(server, zcodeSid, modelId);
  if (!ok) throw new Error("setModel failed (model switch rejected)");
  log(`session/setModel → ${modelId} (updateRuntimeModelConfig)`);
  return {};
}

/** session/setMode → zcode session/setMode + emit config_option/current_mode updates. */
export async function setMode(
  server: ZcodeAcpServer,
  params: ExtensionParams,
  cx: acp.AgentContext,
): Promise<Result> {
  const acpSid = params.sessionId;
  const zcodeSid = resolveSidOrThrow(server, params);
  const mode = params.mode;
  if (!mode) throw new Error("setMode requires mode");
  const resp = await server
    .ensureBackend()
    .request(server.nextId(), "session/setMode", { sessionId: zcodeSid, mode }, 15000);
  if (resp.error) throw new Error(`setMode failed: ${resp.error.message}`);
  log(`session/setMode → ${mode}`);
  // Re-build configOptions (settings.mode.current is now updated) and emit
  // config_option_update + current_mode_update so the editor UI reflects it.
  const options = await buildConfigOptions(server, zcodeSid);
  await sendSessionUpdate(cx, acpSid, {
    sessionUpdate: "config_option_update",
    configOptions: options,
  });
  const modes = await buildModes(server, zcodeSid);
  await sendSessionUpdate(cx, acpSid, {
    sessionUpdate: "current_mode_update",
    currentModeId: modes.currentModeId,
  });
  // Record the advertised mode so the turn-completion reconciliation knows the
  // client has already been told about this value.
  server.lastMode.set(acpSid, modes.currentModeId);
  return (resp.result ?? {}) as Result;
}

/**
 * Wait for a zcode session's internal AI turn to release its prompt lock.
 *
 * `session/goal(set)` and `session/compact` start an internal AI turn that
 * keeps running after the request() response. projection.status=idle does NOT
 * mean the lock is released (goal set often shows idle quickly while the lock
 * persists 10-25s). The reliable check: retry a probe call (goal show) until it
 * no longer reports "prompt is running".
 *
 * `expectLock` (compact): compact's turn has a startup delay — at this moment
 * the lock isn't held yet, so a probe succeeds immediately (false "released").
 * With expectLock=true, we first require observing "prompt is running" once
 * (proving the turn truly started) before trusting a later success.
 */
async function waitForTurnIdle(
  server: ZcodeAcpServer,
  zcodeSid: string,
  timeoutMs: number,
  probeMethod: string,
  expectLock: boolean,
): Promise<boolean> {
  const backend = server.ensureBackend();
  const t0 = Date.now();
  let lockSeen = !expectLock;
  while (Date.now() - t0 < timeoutMs) {
    const resp = await backend.request(
      server.nextId(),
      probeMethod,
      { sessionId: zcodeSid, action: "show" },
      10000,
    );
    const errMsg = resp.error?.message ?? "";
    if (errMsg.includes("prompt is running")) {
      lockSeen = true;
      await sleep(2000);
      continue;
    }
    if (errMsg.toLowerCase().includes("timeout")) {
      await sleep(2000);
      continue;
    }
    if (resp.error) {
      if (lockSeen) {
        log(`  [probe] lock released (non-lock error treated as released: ${errMsg.slice(0, 40)})`);
        return true;
      }
      await sleep(500);
      continue;
    }
    if (lockSeen) {
      log(`  [probe] lock released (elapsed ${Math.round((Date.now() - t0) / 1000)}s)`);
      return true;
    }
    await sleep(500);
  }
  log(`  [probe] wait timed out (${Math.round(timeoutMs / 1000)}s), lock may still be held`);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
