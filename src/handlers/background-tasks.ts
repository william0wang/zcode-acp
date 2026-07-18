/**
 * Session-scoped background-task listener.
 *
 * Background sub-agents (the Agent/Task tool launched with `run_in_background:
 * true`) keep producing events AFTER `session/prompt` has returned: their
 * internal tool calls stream as `tool.updated`, and when they finish the
 * backend auto-triggers a notification turn (`turn.started` with
 * `inputSource:"background_task"`) whose `text_delta` carries the result.
 *
 * The per-prompt turn loop (`runEventTurn`) exits at `turn.completed` and
 * unregisters its listener, so without this module ALL of those post-turn
 * events are silently dropped — the user sees "background task launched" and
 * then nothing.
 *
 * This listener is registered once per session (lives across prompts) and
 * forwards a curated subset to the ACP client as out-of-band `session/update`
 * notifications:
 *
 *   - `session.updated` carrying `taskId`  → background task status change.
 *     First sighting emits a fresh `tool_call` card (`[background] …`);
 *     subsequent sightings emit `tool_call_update` with the new status.
 *   - `turn.started` with `inputSource:"background_task"` → marks the start
 *     of a notification turn; its `model.streaming text_delta` is forwarded
 *     as `agent_message_chunk` so the user sees the background result.
 *
 * Everything else is ignored — the turn loop handles normal turns and normal
 * tool calls. Per the design decision, background agents' INTERNAL tool calls
 * are NOT expanded here (only the task-level card + the final result message).
 *
 * All work is best-effort: failures are logged via `warn()` and never thrown
 * into the event loop (would crash the bridge, per AGENTS.md).
 */

import { randomUUID } from "node:crypto";

import type { EventListener } from "../backend/client.js";
import type { ZcodeEvent } from "../backend/types.js";
import { log, warn } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";

/** Shape of a `session.updated` payload that reports a background task state. */
interface TaskStatusPayload {
  taskId: string;
  toolCallId?: string;
  toolName?: string;
  status?: string;
  description?: string;
  cancellable?: boolean;
  outputPath?: string;
  terminalId?: string;
  startedAt?: string;
  completedAt?: string;
}

/** Tracked background task → the ACP tool_call_id we address its updates with. */
interface TrackedTask {
  /** ACP tool_call_id for this task's card. Prefixed so it can't collide with real tool call ids. */
  acpCallId: string;
  /** Description shown in the card title (from the launch `session.updated`). */
  description: string;
  /** Last status we advertised to the client (to skip no-op updates). */
  lastStatus: string;
  /** messageId for the background-result message stream (allocated lazily). */
  messageId?: string;
}

/** Map a zcode background task status string to an ACP ToolCallStatus. */
function toAcpStatus(status: string | undefined): "in_progress" | "completed" | "failed" {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "error" || status === "cancelled") return "failed";
  return "in_progress"; // running / pending / unknown
}

/** Build the card title for a background task. */
function cardTitle(description: string | undefined): string {
  const d = (description ?? "").trim();
  return d ? `[background] ${d}` : "[background] task";
}

export class BackgroundTaskListener implements EventListener {
  private readonly server: ZcodeAcpServer;
  readonly zcodeSid: string;
  /** taskId → tracked state. */
  private readonly tasks = new Map<string, TrackedTask>();
  /**
   * The turnId of the currently-active background notification turn, if any.
   * While set, that turn's `model.streaming text_delta` events are forwarded
   * to the client as `agent_message_chunk`.
   */
  private activeNotifyTurnId: string | null = null;

  constructor(server: ZcodeAcpServer, zcodeSid: string) {
    this.server = server;
    this.zcodeSid = zcodeSid;
  }

  handleEvent(event: ZcodeEvent): void {
    try {
      if (event.type === "session.updated") {
        const raw = event.payload as Partial<TaskStatusPayload> | undefined;
        if (raw && typeof raw.taskId === "string" && raw.taskId) {
          // taskId is verified string above; cast to the full shape (other
          // fields are optional and read defensively inside onTaskStatus).
          void this.onTaskStatus(raw as TaskStatusPayload);
        }
        return;
      }
      if (event.type === "turn.started") {
        const inputSource = event.payload?.["inputSource"];
        const turnId = (event.payload?.["turnId"] as string | undefined) ?? "";
        if (inputSource === "background_task") {
          this.activeNotifyTurnId = turnId || null;
          if (this.activeNotifyTurnId) {
            log(`  [bg] background notification turn started (${turnId.slice(-8)})`);
          }
        }
        return;
      }
      // Inside an active background notification turn → forward text deltas.
      if (this.activeNotifyTurnId) {
        if (event.type === "model.streaming") {
          const kind = event.payload?.["kind"];
          if (kind === "text_delta") {
            const delta = (event.payload?.["delta"] as string | undefined) ?? "";
            if (delta) void this.forwardText(delta);
          }
          return;
        }
        if (event.type === "turn.completed" || event.type === "turn.failed") {
          log(`  [bg] background notification turn ended (${event.type})`);
          this.activeNotifyTurnId = null;
          // Reset the result messageId so the NEXT background task in this
          // session gets its own — otherwise the editor would merge/overwrite
          // distinct tasks' outputs under one shared messageId.
          this.firstMessageId = null;
          return;
        }
      }
    } catch (e) {
      warn(
        `BackgroundTaskListener: event handling failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Handle a `session.updated` carrying a background task status. */
  private async onTaskStatus(p: TaskStatusPayload): Promise<void> {
    const taskId = p.taskId;
    const status = p.status ?? "running";
    const acpStatus = toAcpStatus(status);
    let task = this.tasks.get(taskId);
    if (!task) {
      // First sighting → emit a fresh tool_call card.
      task = {
        acpCallId: `bg_${randomUUID().slice(0, 12)}`,
        description: p.description ?? "",
        lastStatus: "",
      };
      this.tasks.set(taskId, task);
      const meta: Record<string, unknown> = {
        backgroundTask: {
          taskId,
          agentId: p.terminalId ?? undefined,
          outputPath: p.outputPath ?? undefined,
          sourceToolCallId: p.toolCallId ?? undefined,
        },
      };
      const ok = await this.server.notifyByZcodeSid(this.zcodeSid, {
        sessionUpdate: "tool_call",
        toolCallId: task.acpCallId,
        title: cardTitle(task.description),
        kind: "other",
        status: acpStatus,
        _meta: meta,
      });
      task.lastStatus = acpStatus;
      if (ok) {
        log(`  [bg] task card emitted: ${taskId.slice(-12)} status=${acpStatus}`);
      }
      return;
    }
    // Subsequent sighting → status update only (skip no-ops).
    if (task.lastStatus === acpStatus) return;
    const bgMeta: Record<string, unknown> = { taskId };
    if (p.outputPath) bgMeta["outputPath"] = p.outputPath;
    const meta: Record<string, unknown> = { backgroundTask: bgMeta };
    const ok = await this.server.notifyByZcodeSid(this.zcodeSid, {
      sessionUpdate: "tool_call_update",
      toolCallId: task.acpCallId,
      status: acpStatus,
      _meta: meta,
    });
    task.lastStatus = acpStatus;
    if (ok) {
      log(`  [bg] task status update: ${taskId.slice(-12)} → ${acpStatus}`);
    }
  }

  /** Forward a text delta from the active background notification turn. */
  private async forwardText(delta: string): Promise<void> {
    // Allocate the messageId lazily so an empty-result turn emits nothing.
    let msgId = this.activeMessageId();
    if (!msgId) {
      msgId = `bg_msg_${randomUUID().slice(0, 12)}`;
      this.firstMessageId = msgId;
    }
    await this.server.notifyByZcodeSid(this.zcodeSid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: delta },
      messageId: msgId,
    });
  }

  private firstMessageId: string | null = null;
  private activeMessageId(): string | null {
    return this.firstMessageId;
  }

  /**
   * Mark a tracked task as cancelled (used by `session/cancelBackgroundTask`).
   * Emits a final `failed` update with `_meta.backgroundTask.cancelled = true`
   * so the editor card reflects the cancellation, then drops local state.
   */
  async markCancelled(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    await this.server.notifyByZcodeSid(this.zcodeSid, {
      sessionUpdate: "tool_call_update",
      toolCallId: task.acpCallId,
      status: "failed",
      _meta: { backgroundTask: { taskId, cancelled: true } },
    });
    this.tasks.delete(taskId);
    log(`  [bg] task cancelled: ${taskId.slice(-12)}`);
  }
}
