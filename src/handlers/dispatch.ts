/**
 * dispatchEvent — the single funnel that turns an InternalEvent into an ACP
 * `session/update` notification.
 *
 * Each event kind is serialised here so the translation layers stay focused
 * on producing the internal shape. The Bash terminal-output protocol (the
 * 2-notification split: terminal_output + terminal_exit) is fully implemented
 * below in dispatchTerminalUpdate.
 */

import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";

import { currentModelCached } from "../config/model-cache.js";
import {
  buildConfigOptions,
  formatModelValue,
  modelContextWindow,
  parseModelValue,
} from "../config/options.js";
import {
  extractExitCode,
  parseSubagentMetadata,
  TOOL_KIND_MAP,
} from "../translators/tool-helpers.js";
import type { InternalEvent } from "../translators/types.js";
import type { ZcodeAcpServer } from "../server.js";
import { warn } from "../utils.js";
import { sendSessionUpdate } from "./io.js";

/** Dispatch one internal event to the ACP client as a session/update. */
export async function dispatchEvent(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  ev: InternalEvent,
  chunkMsgId: string,
): Promise<void> {
  switch (ev.kind) {
    case "ToolCallNew":
      await dispatchToolCallNew(server, cx, acpSid, ev);
      break;
    case "ToolCallUpdate":
      await dispatchToolCallUpdate(server, cx, acpSid, ev);
      break;
    case "UsageDelta":
      await dispatchUsageDelta(server, cx, acpSid, ev);
      break;
    case "TextDelta":
      await sendSessionUpdate(cx, acpSid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: ev.text },
        messageId: chunkMsgId,
      });
      break;
    case "ReasoningDelta":
      await sendSessionUpdate(cx, acpSid, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: ev.text },
        messageId: `thought_${chunkMsgId}`,
      });
      break;
    case "PlanUpdate":
      await sendSessionUpdate(cx, acpSid, {
        sessionUpdate: "plan",
        entries: ev.entries,
      });
      break;
    case "FilesChanged":
      await dispatchFilesChanged(cx, acpSid, ev);
      break;
    case "ConfigChanged":
      await dispatchConfigChanged(server, cx, acpSid, ev);
      break;
  }
}

/**
 * Session settings changed (model/mode/thoughtLevel switch). Push the rebuilt
 * configOptions (+ current_mode_update for mode) so the editor UI follows the
 * switch immediately — even mid-turn, without waiting for turn completion.
 *
 * Builds the option structures from the session's authoritative settings
 * (`session/read` via buildConfigOptions), then overlays the values from the
 * event patch. A state.updated patch only carries the fields that actually
 * changed, so building from the null defaults instead would reset every
 * untouched field — most visibly the model dropdown jumping back to the
 * default model mid-conversation.
 * Best-effort: failures are logged and swallowed, never thrown into the loop.
 */
async function dispatchConfigChanged(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  ev: Extract<InternalEvent, { kind: "ConfigChanged" }>,
): Promise<void> {
  try {
    // Fall back to null (defaults) only if the session mapping isn't live yet —
    // events routed through a registered turn loop always have it.
    const zcodeSid = server.resolveSid(acpSid) ?? null;
    const options = await buildConfigOptions(server, zcodeSid);
    // Find by id — the array order buildConfigOptions returns is not a
    // contract; index-based writes would silently hit the wrong option if
    // that order ever changed (emitModeViaConfigOption already does this).
    const setById = (id: string, value: string) => {
      const opt = options.find((o) => o.id === id);
      if (opt) opt.currentValue = value;
    };
    if (ev.model) {
      setById("model", formatModelValue(ev.model.providerId, ev.model.modelId));
    }
    if (ev.mode !== undefined) setById("mode", ev.mode);
    if (ev.thought !== undefined) setById("thought", ev.thought);
    await sendSessionUpdate(cx, acpSid, {
      sessionUpdate: "config_option_update",
      configOptions: options,
    });
    if (ev.mode !== undefined) {
      // Mirror the advertised mode so turn-completion reconciliation
      // (emitModeIfChanged) doesn't re-emit the same value.
      server.lastMode.set(acpSid, ev.mode);
      await sendSessionUpdate(cx, acpSid, {
        sessionUpdate: "current_mode_update",
        currentModeId: ev.mode,
      });
    }
  } catch (e) {
    warn(`dispatch: ConfigChanged failed (${e instanceof Error ? e.message : String(e)})`);
  }
}

function dispatchToolCallNew(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  ev: Extract<InternalEvent, { kind: "ToolCallNew" }>,
): Promise<void> {
  const termSupported =
    server.supportsTerminalOutput() && (ev.tool === "Bash" || ev.tool === "bash");
  const meta: Record<string, unknown> = { claudeCode: { toolName: ev.tool } };
  if (termSupported) meta["terminal_info"] = { terminal_id: ev.callId };
  // Mark sub-agent dispatch cards so editors can badge them from creation.
  if (ev.tool === "Agent" || ev.tool === "Task") meta["subagent"] = true;

  const update: acp.SessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId: ev.callId,
    title: ev.title,
    kind: (TOOL_KIND_MAP[ev.tool] ?? "other") as acp.ToolKind,
    status: ev.status,
    rawInput: ev.input,
    _meta: meta,
  };
  if (termSupported) {
    update.content = [{ type: "terminal", terminalId: ev.callId }];
  } else if (ev.diffContent && ev.diffContent.length > 0) {
    update.content = ev.diffContent;
  } else if (ev.content && ev.content.length > 0) {
    update.content = ev.content;
  }
  if (ev.locations && ev.locations.length > 0) update.locations = ev.locations;
  return sendSessionUpdate(cx, acpSid, update);
}

function dispatchToolCallUpdate(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  ev: Extract<InternalEvent, { kind: "ToolCallUpdate" }>,
): Promise<void> {
  const toolName = ev.tool ?? "";
  const termSupported =
    server.supportsTerminalOutput() && (toolName === "Bash" || toolName === "bash");

  if (termSupported) {
    // Background Bash: the `result` event carries the launch acknowledgement
    // ("Command running in background with ID: exec_…"), NOT the final output.
    // Closing the card now (terminal_exit + status:completed) would make it
    // indistinguishable from a normal Bash call and steal the lifecycle from
    // the BackgroundTaskListener, which owns the real completion via
    // out-of-band `session.updated` events. So stream any launch text via
    // terminal_output and leave the card in_progress.
    if (ev.background) {
      return dispatchTerminalUpdate(server, cx, acpSid, ev, toolName, {
        skipExit: true,
      });
    }
    return dispatchTerminalUpdate(server, cx, acpSid, ev, toolName);
  }

  const update: acp.SessionUpdate = {
    sessionUpdate: "tool_call_update",
    toolCallId: ev.callId,
    status: ev.status,
  };
  const meta: Record<string, unknown> = {};
  if (toolName) meta["claudeCode"] = { toolName };
  // Sub-agent (Agent/Task tool) result: surface structured metadata so editors
  // can badge the card (agentId, background flag, token/tool/time usage). The
  // raw result text is left in `content` for the user-facing view.
  if (
    (toolName === "Agent" || toolName === "Task") &&
    (ev.status === "completed" || ev.status === "failed")
  ) {
    const sub = parseSubagentMetadata(ev.rawResult);
    if (sub) meta["subagent"] = sub;
  }
  if (ev.output !== undefined) update.rawOutput = ev.output;
  if (ev.diffContent && ev.diffContent.length > 0) {
    update.content = ev.diffContent;
  } else if (ev.content && ev.content.length > 0) {
    update.content = ev.content;
  }
  if (Object.keys(meta).length > 0) update._meta = meta;
  if (ev.locations && ev.locations.length > 0) update.locations = ev.locations;
  return sendSessionUpdate(cx, acpSid, update);
}

/**
 * Bash terminal update — the 2-notification split (matches acp-agent.ts:5061-5094
 * and the Python bridge's _dispatch_event). Zed correlates by terminal_id, so
 * the two notifications MUST be separate:
 *   ① terminal_output — pure data, no status/content. Streams live output.
 *   ② terminal_exit — terminal state only: status + content[type:terminal] +
 *      _meta.terminal_exit (with exitCode). Sent ONLY on completed/failed.
 *
 * Merging them into one notification causes Zed to clear the content once the
 * turn completes (the original bug); splitting keeps the output visible.
 *
 * OUTPUT DEDUP (two distinct hazards, both fixed here):
 *  - Progress replay: zcode's `stdoutTail` is a CUMULATIVE snapshot of the tail,
 *    but terminal_output.data is APPEND semantics. Without diffing, each progress
 *    event replays the whole tail → N× duplication. We track the last-sent
 *    snapshot per callId and emit only the suffix beyond it.
 *  - Result replay: zcode's result payload re-sends the COMPLETE output. Once
 *    progress has streamed it, emitting it again would duplicate every line.
 *    So on completed/failed we SKIP terminal_output IF any progress already
 *    streamed data for this callId; for short commands (scheduled → result, no
 *    progress) nothing was sent yet, so we emit the full output once.
 */
async function dispatchTerminalUpdate(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  ev: Extract<InternalEvent, { kind: "ToolCallUpdate" }>,
  toolName: string,
  opts: { skipExit?: boolean } = {},
): Promise<void> {
  // Extract the textual output from whichever payload field carries it.
  let termData: unknown = ev.rawOutput ?? ev.rawResult;
  if (termData && typeof termData === "object" && !Array.isArray(termData)) {
    termData = (termData as Record<string, unknown>)["content"] ?? "";
  }
  const full = termData ? String(termData) : "";
  const lastSent = server.terminalSentData.get(ev.callId) ?? "";

  // ① terminal_output (pure data, append semantics).
  //    - progress (in_progress): zcode's stdoutTail is a CUMULATIVE snapshot of
  //      the tail, but terminal_output.data is APPEND semantics, so we diff and
  //      emit only the suffix beyond the last-sent snapshot.
  //    - result (completed/failed): the full output was already streamed during
  //      progress, and zcode's result re-sends the complete tail → skip, UNLESS
  //      no progress ever fired (short command: scheduled → result). In that
  //      case nothing was streamed yet, so emit the full output once.
  const isResult = ev.status === "completed" || ev.status === "failed";
  const alreadyStreamed = server.terminalSentData.has(ev.callId);
  if (full && !(isResult && alreadyStreamed)) {
    const delta = lastSent && full.startsWith(lastSent) ? full.slice(lastSent.length) : full;
    if (delta) {
      server.terminalSentData.set(ev.callId, full);
      await sendSessionUpdate(cx, acpSid, {
        sessionUpdate: "tool_call_update",
        toolCallId: ev.callId,
        _meta: { terminal_output: { terminal_id: ev.callId, data: delta } },
      });
    }
  }

  // Background Bash launch: leave the card in_progress — BackgroundTaskListener
  // owns the final status + terminal_exit via out-of-band session.updated. We
  // MUST still seed terminalSentData with an empty entry (even when no launch
  // text was streamed) so the listener can recognise this callId as a tracked
  // launch card and route its updates back to the same card.
  if (opts.skipExit) {
    if (!server.terminalSentData.has(ev.callId)) {
      server.terminalSentData.set(ev.callId, "");
    }
    return;
  }

  // ② terminal_exit (terminal state) — only on completed/failed.
  //    Deliberately omits rawOutput: the output was already streamed via
  //    terminal_output.data above, and Zed renders BOTH the terminal buffer and
  //    the rawOutput fallback — including rawOutput here duplicates every line.
  if (isResult) {
    const exitCode = extractExitCode(ev.rawResult, ev.status === "failed");
    const exitUpdate: acp.SessionUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: ev.callId,
      status: ev.status,
      content: [{ type: "terminal", terminalId: ev.callId }],
      _meta: {
        claudeCode: { toolName },
        terminal_exit: { terminal_id: ev.callId, exit_code: exitCode, signal: null },
      },
    };
    await sendSessionUpdate(cx, acpSid, exitUpdate);
    // Terminal session ended — clear the snapshot so a future tool reusing this
    // callId (shouldn't happen, but defensively) starts fresh.
    server.terminalSentData.delete(ev.callId);
  }
}

async function dispatchUsageDelta(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  ev: Extract<InternalEvent, { kind: "UsageDelta" }>,
): Promise<void> {
  // The backend often returns contextWindow=0; fill from the model's
  // config.json limit.context so the editor can render the context bar.
  let size = ev.size;
  if (!size) {
    // Resolve to the real backend session id — `acpSid` may be a lazy
    // session/new placeholder that the backend rejects with "Session is not
    // active", wasting a 5s request timeout on every usage_update.
    const zcodeSid = server.resolveSid(acpSid) ?? acpSid;
    const { providerId, modelId } = parseModelValue(await currentModelCached(server, zcodeSid));
    size = modelContextWindow(providerId, modelId);
  }
  await sendSessionUpdate(cx, acpSid, {
    sessionUpdate: "usage_update",
    used: ev.used,
    size,
  });
}

function dispatchFilesChanged(
  cx: acp.AgentContext,
  acpSid: string,
  ev: Extract<InternalEvent, { kind: "FilesChanged" }>,
): Promise<void> {
  const files = ev.files;
  const preview = files.slice(0, 3).join(", ");
  const ellipsis = files.length > 3 ? "..." : "";
  return sendSessionUpdate(cx, acpSid, {
    sessionUpdate: "tool_call",
    toolCallId: `files_${randomUUID().slice(0, 8)}`,
    title: `changed files (${files.length}): ${preview}${ellipsis}`,
    kind: "edit",
    status: "completed",
    content: [
      { type: "content", content: { type: "text", text: "affected files:\n" + files.join("\n") } },
    ],
  });
}
