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
  stdoutTail?: string;
  stderrTail?: string;
  outputTail?: string;
  terminalId?: string;
  pid?: number;
  startedAt?: string;
  completedAt?: string;
}

/** Tracked background task → the ACP tool_call_id we address its updates with. */
interface TrackedTask {
  /**
   * ACP tool_call_id for this task's card. For background Bash we reuse the
   * original launch card's id (from `session.updated.toolCallId`), so the
   * lifecycle attaches to the existing terminal card instead of spawning a
   * second `[background]` card. For sub-agents (no resolvable launch card) we
   * mint a fresh `bg_<uuid>` id.
   */
  acpCallId: string;
  /** Description shown in the card title (from the launch `session.updated`). */
  description: string;
  /** Last status we advertised to the client (to skip no-op updates). */
  lastStatus: string;
  /** messageId for the background-result message stream (allocated lazily). */
  messageId?: string;
  /**
   * The originating tool call id when this task reuses a launch card (background
   * Bash). Undefined for sub-agent tasks that mint their own `bg_*` card.
   */
  sourceToolCallId?: string;
  /**
   * True when acpCallId === sourceToolCallId (background Bash reusing the
   * launch terminal card). Drives the terminal_exit + terminalSentData cleanup
   * on completion so Zed's terminal UI closes cleanly.
   */
  reusesLaunchCard: boolean;
  /**
   * Cumulative output snapshot this listener has already streamed via
   * terminal_output for a reused launch card. Tracked SEPARATELY from
   * `server.terminalSentData` (which holds the launch acknowledgement text
   * written by the dispatcher) because the launch text and the real command
   * output are unrelated streams — they're not prefix-related, so diffing
   * against the launch text would drop or duplicate the real output. Only
   * `outputTail`/`stdoutTail` from `session.updated` events feeds this.
   */
  streamedOutput?: string;
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
      // First sighting → decide whether to reuse the launch card or mint a
      // fresh bg_* card. Background Bash: the dispatcher seeds
      // `terminalSentData[toolCallId]` when the launch card is created, so its
      // presence means the client already has a terminal card for this call —
      // route the lifecycle back to it instead of creating a duplicate. Sub-
      // agents (Agent/Task tool) have no such launch card → fall back to bg_*.
      const launchToolCallId = p.toolCallId;
      const reusesLaunchCard =
        !!launchToolCallId && this.server.terminalSentData.has(launchToolCallId);
      if (reusesLaunchCard) {
        task = {
          acpCallId: launchToolCallId!,
          sourceToolCallId: launchToolCallId!,
          reusesLaunchCard: true,
          description: p.description ?? "",
          lastStatus: "",
        };
        this.tasks.set(taskId, task);
        // The launch card already exists (dispatch created it in the main
        // turn). Don't emit a new tool_call — just push the first status update
        // so the card reflects "running in background" with task metadata.
        await this.emitStatusUpdate(task, acpStatus, p);
        log(
          `  [bg] reusing launch card ${launchToolCallId!.slice(-12)} for task ${taskId.slice(-12)}`,
        );
        return;
      }
      // No launch card to reuse → emit a fresh [background] tool_call card.
      task = {
        acpCallId: `bg_${randomUUID().slice(0, 12)}`,
        reusesLaunchCard: false,
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
    await this.emitStatusUpdate(task, acpStatus, p);
  }

  /**
   * Push a status update for an already-tracked task. For background Bash
   * (reusesLaunchCard), a terminal-state transition also streams the final
   * output via terminal_output and closes the terminal UI with terminal_exit
   * (mirroring dispatchTerminalUpdate's 2-notification split), then clears
   * terminalSentData so the launch card is fully retired.
   */
  private async emitStatusUpdate(
    task: TrackedTask,
    acpStatus: "in_progress" | "completed" | "failed",
    p: TaskStatusPayload,
  ): Promise<void> {
    // Skip no-op status updates (same as last advertised).
    if (task.lastStatus === acpStatus && !task.reusesLaunchCard) return;

    const meta: Record<string, unknown> = {
      backgroundTask: { taskId: p.taskId },
    };
    if (p.outputPath) (meta.backgroundTask as Record<string, unknown>)["outputPath"] = p.outputPath;

    const isTerminal = acpStatus === "completed" || acpStatus === "failed";

    // Background Bash closing a launch terminal card: stream final output +
    // emit terminal_exit so Zed's terminal UI finalises. The terminal_output
    // diff guard mirrors dispatchTerminalUpdate (only emit the suffix beyond
    // what was already streamed; for a background launch the launch text was
    // already sent, so outputTail here is the real command output).
    if (task.reusesLaunchCard && task.sourceToolCallId) {
      // Stream any new command output via terminal_output. The output is
      // tracked on `task.streamedOutput` (NOT server.terminalSentData) because
      // terminalSentData holds the launch acknowledgement text written by the
      // dispatcher, which is unrelated to the command's actual stdout — they
      // aren't prefix-related, so diffing against the launch text would drop
      // the real output entirely. Each session.updated carries a CUMULATIVE
      // outputTail snapshot, so we diff against what we last streamed and emit
      // only the suffix (mirrors dispatchTerminalUpdate's progress diffing).
      const finalOutput = p.outputTail ?? p.stdoutTail ?? "";
      const lastSent = task.streamedOutput ?? "";
      if (finalOutput) {
        const delta =
          lastSent && finalOutput.startsWith(lastSent)
            ? finalOutput.slice(lastSent.length)
            : finalOutput;
        if (delta) {
          task.streamedOutput = finalOutput;
          await this.server.notifyByZcodeSid(this.zcodeSid, {
            sessionUpdate: "tool_call_update",
            toolCallId: task.sourceToolCallId,
            _meta: { terminal_output: { terminal_id: task.sourceToolCallId, data: delta } },
          });
        }
      }
      // terminal_exit only fires on a terminal status. A non-terminal (running)
      // update has streamed its progress above; also push an in_progress status
      // update with backgroundTask metadata so the card reflects "running in
      // background" on first sighting (the launch card was left in_progress by
      // the dispatcher, but we still advertise the status to attach taskId).
      if (!isTerminal) {
        await this.server.notifyByZcodeSid(this.zcodeSid, {
          sessionUpdate: "tool_call_update",
          toolCallId: task.sourceToolCallId,
          status: acpStatus,
          _meta: meta,
        });
        task.lastStatus = acpStatus;
        return;
      }
      const exitCode = acpStatus === "failed" ? 1 : 0;
      (meta.backgroundTask as Record<string, unknown>)["completed"] = true;
      await this.server.notifyByZcodeSid(this.zcodeSid, {
        sessionUpdate: "tool_call_update",
        toolCallId: task.sourceToolCallId,
        status: acpStatus,
        content: [{ type: "terminal", terminalId: task.sourceToolCallId }],
        _meta: {
          ...meta,
          claudeCode: { toolName: "Bash" },
          terminal_exit: {
            terminal_id: task.sourceToolCallId,
            exit_code: exitCode,
            signal: null,
          },
        },
      });
      this.server.terminalSentData.delete(task.sourceToolCallId);
      task.lastStatus = acpStatus;
      log(`  [bg] launch card ${task.sourceToolCallId.slice(-12)} → ${acpStatus} (terminal_exit)`);
      return;
    }

    // Subsequent sighting (bg_* card) or non-terminal → status update only.
    if (task.lastStatus === acpStatus) return;
    const ok = await this.server.notifyByZcodeSid(this.zcodeSid, {
      sessionUpdate: "tool_call_update",
      toolCallId: task.acpCallId,
      status: acpStatus,
      _meta: meta,
    });
    task.lastStatus = acpStatus;
    if (ok) {
      log(`  [bg] task status update: ${p.taskId.slice(-12)} → ${acpStatus}`);
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
   * so the editor card reflects the cancellation, then drops local state. For
   * background Bash reusing a launch terminal card, also emits terminal_exit
   * and clears terminalSentData so the terminal UI closes cleanly.
   */
  async markCancelled(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.reusesLaunchCard && task.sourceToolCallId) {
      await this.server.notifyByZcodeSid(this.zcodeSid, {
        sessionUpdate: "tool_call_update",
        toolCallId: task.sourceToolCallId,
        status: "failed",
        content: [{ type: "terminal", terminalId: task.sourceToolCallId }],
        _meta: {
          backgroundTask: { taskId, cancelled: true },
          claudeCode: { toolName: "Bash" },
          terminal_exit: {
            terminal_id: task.sourceToolCallId,
            exit_code: 1,
            signal: null,
          },
        },
      });
      this.server.terminalSentData.delete(task.sourceToolCallId);
    } else {
      await this.server.notifyByZcodeSid(this.zcodeSid, {
        sessionUpdate: "tool_call_update",
        toolCallId: task.acpCallId,
        status: "failed",
        _meta: { backgroundTask: { taskId, cancelled: true } },
      });
    }
    this.tasks.delete(taskId);
    log(`  [bg] task cancelled: ${taskId.slice(-12)}`);
  }
}
