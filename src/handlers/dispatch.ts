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
import { modelContextWindow } from "../config/options.js";
import { extractExitCode, TOOL_KIND_MAP } from "../translators/tool-helpers.js";
import type { InternalEvent } from "../translators/types.js";
import type { ZcodeAcpServer } from "../server.js";
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
    // Bash terminal protocol (full 2-notification split arrives in Commit 5).
    // For now emit the terminal_output data + the standard update with status.
    return dispatchTerminalUpdate(server, cx, acpSid, ev, toolName);
  }

  const update: acp.SessionUpdate = {
    sessionUpdate: "tool_call_update",
    toolCallId: ev.callId,
    status: ev.status,
  };
  const meta: Record<string, unknown> = {};
  if (toolName) meta["claudeCode"] = { toolName };
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
 *   ① terminal_output — pure data, no status/content. Sent on BOTH progress and
 *      result states (whenever there's NEW data) so live output streams.
 *   ② terminal_exit — terminal state only: status + content[type:terminal] +
 *      _meta.terminal_exit (with exitCode) + rawOutput text fallback. Sent ONLY
 *      on completed/failed.
 *
 * Merging them into one notification causes Zed to clear the content once the
 * turn completes (the original bug); splitting keeps the output visible.
 *
 * DELTA DEDUP: zcode's `stdoutTail`/result `content` is a *snapshot* of the
 * accumulated stdout tail, but ACP `terminal_output.data` is *append* semantics
 * — each value is written to the terminal as new bytes. Without dedup, every
 * progress event replays the whole tail, and the result event replays it again,
 * so long-running commands show their output N times. We track the last-sent
 * snapshot per callId and emit only the suffix beyond it.
 */
async function dispatchTerminalUpdate(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  ev: Extract<InternalEvent, { kind: "ToolCallUpdate" }>,
  toolName: string,
): Promise<void> {
  // ① terminal_output (pure data, append semantics) — progress and result both
  //    emit it, but only the delta beyond the last-sent snapshot.
  let termData: unknown = ev.rawOutput ?? ev.rawResult;
  if (termData && typeof termData === "object" && !Array.isArray(termData)) {
    termData = (termData as Record<string, unknown>)["content"] ?? "";
  }
  const full = termData ? String(termData) : "";
  const lastSent = server.terminalSentData.get(ev.callId) ?? "";
  // Only the suffix past the previously-sent snapshot is new output. Guard
  // against a non-monotonic snapshot (tail rotated) by falling back to the full
  // value when the previous snapshot isn't a prefix of the current one.
  const delta = lastSent && full.startsWith(lastSent) ? full.slice(lastSent.length) : full;
  if (delta) {
    server.terminalSentData.set(ev.callId, full);
    await sendSessionUpdate(cx, acpSid, {
      sessionUpdate: "tool_call_update",
      toolCallId: ev.callId,
      _meta: { terminal_output: { terminal_id: ev.callId, data: delta } },
    });
  }

  // ② terminal_exit (terminal state) — only on completed/failed.
  if (ev.status === "completed" || ev.status === "failed") {
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
    // rawOutput gives Zed a text fallback outside the terminal render path.
    // This carries the FULL output (not the delta) so a non-terminal render
    // fallback shows everything once; the terminal_output stream already
    // appended it above via the dedup delta.
    if (ev.output !== undefined) exitUpdate.rawOutput = ev.output;
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
    const modelId = await currentModelCached(server, acpSid);
    size = modelContextWindow(modelId);
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
