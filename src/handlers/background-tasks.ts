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
 * It is ALSO the running-state authority for turns this bridge did not drive
 * (`server.foreignActiveTurns`): the turn loop only exists while a
 * bridge-initiated prompt is registered, so a background-subagent wake, a
 * `subagent_message` turn or a control-only turn would otherwise stream
 * messages into a session every consumer reports as idle. Upstream keys its
 * own running indicators off `turn.started` / `turn.terminal` facts
 * regardless of origin (taskActivityTracker), so the listener mirrors that:
 * foreign `turn.started` → `$/zcode/turnState running:true` broadcast +
 * `/status` running + `replayMeta.turnActive`; the terminal clears it.
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
import { messages } from "../i18n.js";
import { log, warn } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";
import { armWorkflowRunPoller, stopWorkflowRunPoller } from "../workflow/poller.js";
import { pushSettled, pushSourceLabel } from "../push/push.js";
import { echoSteeredInputs, emitSessionTurnState } from "./io.js";
import { dispatchEvent } from "./dispatch.js";

/** Shape of a `session.updated` payload that reports a background task state. */
interface TaskStatusPayload {
  taskId: string;
  toolCallId?: string;
  toolName?: string;
  taskKind?: string;
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
   * Backend task kind from the first `session.updated` sighting
   * (`taskKind`), verbatim: "subagent" (Agent/Task runs — the held-prompt
   * chain waits on these), "workflow", "bash", … Undefined on entries
   * created before the field existed.
   */
  taskKind?: string;
  /**
   * True when acpCallId === sourceToolCallId (background Bash reusing the
   * launch terminal card). Drives the terminal_exit + terminalSentData cleanup
   * on completion so Zed's terminal UI closes cleanly.
   */
  reusesLaunchCard: boolean;
  /**
   * Workflow-run task (taskKind "workflow") folded into the visible
   * CreateWorkflow tool card (acpCallId = that card's id). The entry exists
   * ONLY to make the fold decision sticky — no [background] card was minted
   * and no status updates are forwarded (the tool card's own events own its
   * lifecycle); the run poller addresses progress to acpCallId.
   */
  foldedIntoToolCard?: boolean;
  /** Terminal-status offline push already sent (§5.3 dedup). */
  terminalPushed?: boolean;
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
  return messages().backgroundTaskTitle((description ?? "").trim());
}

/**
 * How long a rewind claim stays claimable. The replacement turn follows its
 * admission within seconds (upstream command FIFO); anything starting later
 * is an unrelated foreign turn and must not be misclaimed.
 */
const REWIND_CLAIM_TTL_MS = 90_000;

/** Ownership-token sequence for the single rewind-claim slot (per process). */
let rewindClaimTokenSeq = 0;

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
  /**
   * The turnId that opened the notification busy window
   * (`server.notifyTurnActiveSince`). Tracked SEPARATELY from
   * `activeNotifyTurnId` because the two arms split (held prompt turn): the
   * window is published on EVERY notification turn (the prompt path's send
   * busy budget, the load/resume wait and steering liveness depend on it),
   * while the text-forwarding arm (`activeNotifyTurnId`) is suppressed when a
   * held prompt turn owns the session — the loop dispatches that turn itself.
   * The window's turn terminal settles it even when forwarding never armed.
   */
  private windowTurnId: string | null = null;
  /**
   * Rewind claim (rewind.ts): a bridge-sent v4 editUserQuery/retryTurn admits
   * its replacement turn through the command channel — no turn loop ever owns
   * it, so without a claim its text would be silently dropped. Non-null while
   * a rewind command is in flight or admitted-but-not-yet-started; the first
   * non-background `turn.started` after it claims the notification-turn
   * forwarding path. Timestamp (not boolean) so the TTL backstop can expire a
   * claim whose turn never started (queue-admission edge).
   */
  private rewindClaimAt: number | null = null;
  private rewindClaimToken: number | null = null;
  private rewindClaimTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(server: ZcodeAcpServer, zcodeSid: string) {
    this.server = server;
    this.zcodeSid = zcodeSid;
  }

  /**
   * Pre-claim the replacement turn of a rewind command (called by rewind.ts
   * BEFORE the v4 command is sent, so a turn starting while the ack is still
   * settling is caught too). The claim arms the notification-turn forwarding
   * path — the busy window is held by `notifyTurnActiveSince` + foreign-turn
   * tracking, and settles at the turn's terminal. Returns an ownership
   * token: the claim is single-slot, and a concurrent rewind's claim
   * supersedes an earlier one — `releaseRewindClaim(token)` is a no-op when
   * the slot belongs to a newer claim, so a FAILED concurrent call cannot
   * drop the claim of the one still in flight.
   */
  claimRewindTurn(): number {
    const token = ++rewindClaimTokenSeq;
    this.rewindClaimAt = Date.now();
    this.rewindClaimToken = token;
    if (this.rewindClaimTimer) clearTimeout(this.rewindClaimTimer);
    // Backstop: an accepted rewind whose replacement turn never starts (queue
    // admission edge) would otherwise leave the busy window open forever —
    // the handler deliberately does not settle the accepted path.
    this.rewindClaimTimer = setTimeout(() => {
      this.rewindClaimTimer = null;
      if (this.rewindClaimAt === null) return;
      this.rewindClaimAt = null;
      this.rewindClaimToken = null;
      warn(`  [bg] rewind claim expired without a turn — settling busy state`);
      // Settle only when nothing else holds the session busy: a later
      // legitimate turn (prompted while our claim sat unarmed) must not be
      // unlocked by OUR expired claim.
      if (this.sessionBusyElsewhere()) return;
      const acpSid = this.server.acpSidByZcodeSid.get(this.zcodeSid);
      if (acpSid) void emitSessionTurnState(this.server, acpSid, false);
    }, REWIND_CLAIM_TTL_MS).unref();
    return token;
  }

  /** True while a turn OTHER than our (expired) claim holds the session. */
  private sessionBusyElsewhere(): boolean {
    return (
      [...this.server.pendingTurns.values()].some((t) => t.zcodeSid === this.zcodeSid) ||
      this.server.foreignActiveTurns.has(this.zcodeSid) ||
      this.server.notifyTurnActiveSince.has(this.zcodeSid)
    );
  }

  /** Drop a claim that never armed (command rejected / errored). No-op when
   * the slot was re-claimed by a newer rewind call. */
  releaseRewindClaim(token: number): void {
    if (this.rewindClaimToken !== token) return;
    this.rewindClaimAt = null;
    this.rewindClaimToken = null;
    if (this.rewindClaimTimer) {
      clearTimeout(this.rewindClaimTimer);
      this.rewindClaimTimer = null;
    }
  }

  /**
   * True while at least one SUBAGENT-kind background task is still running:
   * the held-prompt turn loop keeps `session/prompt` open for exactly this
   * work (the backend auto-triggers a result turn per finished task). Terminal
   * states are the ACP spellings `lastStatus` stores ("completed"/"failed");
   * a fresh card with no status yet ("") counts as running.
   */
  subagentWorkOutstanding(): boolean {
    for (const task of this.tasks.values()) {
      if (task.taskKind !== "subagent") continue;
      if (task.lastStatus !== "completed" && task.lastStatus !== "failed") return true;
    }
    return false;
  }

  /** acpCallIds of the outstanding subagent tasks — the held loop's heartbeat
   * re-emits `in_progress` for these cards so client idle deadlines stay fed. */
  outstandingSubagentCallIds(): string[] {
    const ids: string[] = [];
    for (const task of this.tasks.values()) {
      if (task.taskKind !== "subagent") continue;
      if (task.lastStatus === "completed" || task.lastStatus === "failed") continue;
      ids.push(task.acpCallId);
    }
    return ids;
  }

  /**
   * Safety-net writer for a DROPPED task-terminal event (one that would
   * otherwise hold a prompt open for the rest of the process): flips every
   * running subagent-kind task to a terminal tracked state and returns how
   * many were flipped. "failed" mirrors the other bridge-side inferred
   * terminals (markCancelled / shutdown records); the warn line is the audit
   * trail. Called only after the subagent roster twice reported empty while
   * the tracked state still said outstanding.
   */
  markOutstandingSubagentsTerminal(): number {
    let flipped = 0;
    for (const task of this.tasks.values()) {
      if (task.taskKind !== "subagent") continue;
      if (task.lastStatus === "completed" || task.lastStatus === "failed") continue;
      task.lastStatus = "failed";
      flipped++;
    }
    if (flipped > 0) {
      warn(
        `  [bg] ${flipped} outstanding subagent task(s) marked terminal without a status event ` +
          `(dropped terminal suspected; roster twice reported empty)`,
      );
    }
    return flipped;
  }

  /** Read-only forwarding probe for the held loop: true while `turnId` is the
   * turn the notification-forwarding path currently owns (a rewind-claimed
   * replacement turn) — such a turn must NOT be adopted into the chain. */
  isForwardingTurn(turnId: string): boolean {
    return this.activeNotifyTurnId === turnId;
  }

  handleEvent(event: ZcodeEvent): void {
    try {
      if (event.type === "session.updated") {
        const raw = event.payload as Partial<TaskStatusPayload> | undefined;
        if (raw && typeof raw.taskId === "string" && raw.taskId) {
          // taskId is verified string above; cast to the full shape (other
          // fields are optional and read defensively inside onTaskStatus).
          void this.onTaskStatus(raw as TaskStatusPayload);
          return;
        }
        // Out-of-turn mode transitions (SessionModeChanged rides this generic
        // wire type with a raw {mode, planEnabled} payload): record the
        // runtime-confirmed Plan state for the read paths, and — when NO
        // bridge prompt turn is registered — refresh the clients' mode
        // display through the same ConfigChanged dispatch the turn-path
        // translator feeds. During a turn the turn loop's own translator
        // publishes the transition; dispatching here too would double-send.
        const p = (raw ?? {}) as Record<string, unknown>;
        if (typeof p["mode"] === "string" && typeof p["planEnabled"] === "boolean") {
          const planEnabled = p["planEnabled"] === true;
          this.server.notePlanState(this.zcodeSid, planEnabled);
          this.server.noteBaseMode(this.zcodeSid, p["mode"]);
          log(`  [bg] mode transition: ${p["mode"]} plan=${planEnabled}`);
          const turnLoopActive = [...this.server.pendingTurns.values()].some(
            (t) => t.zcodeSid === this.zcodeSid,
          );
          if (!turnLoopActive) {
            const acpSid = this.server.resolveAcpSid(this.zcodeSid);
            if (acpSid) {
              void dispatchEvent(
                this.server,
                this.server.clients.broadcast(),
                acpSid,
                { kind: "ConfigChanged", mode: p["mode"], planEnabled },
                `bgmode_${Date.now()}`,
              ).catch((e: unknown) =>
                log(
                  `  [bg] mode transition display refresh failed: ` +
                    `${e instanceof Error ? e.message : String(e)}`,
                ),
              );
            }
          }
        }
        return;
      }
      if (event.type === "turn.started") {
        const inputSource = event.payload?.["inputSource"];
        // Envelope-first (0.16.9); the payload spelling is the legacy fallback.
        const turnId =
          (event.turnId as string | undefined) ??
          (event.payload?.["turnId"] as string | undefined) ??
          "";
        if (inputSource === "background_task") {
          // Busy window: publish on EVERY notification turn — the prompt path
          // extends its send busy-retry budget while a notification turn (a
          // real model turn) holds the prompt lock, and the load/resume wait
          // + steering liveness read the same map.
          this.windowTurnId = turnId || null;
          this.server.notifyTurnActiveSince.set(this.zcodeSid, Date.now());
          // Text forwarding arms ONLY when no held prompt turn is registered:
          // the held loop adopts that turn and dispatches it through the full
          // prompt path — forwarding here would render it twice.
          const heldPrompt = [...this.server.pendingTurns.values()].some(
            (t) => t.zcodeSid === this.zcodeSid && t.holding,
          );
          if (heldPrompt) {
            if (this.activeNotifyTurnId) {
              // The held prompt adopted the chain: drop any forwarding state
              // so the loop's dispatch is the only path to the client.
              this.activeNotifyTurnId = null;
              this.firstMessageId = null;
            }
            log(
              `  [bg] background notification turn started (${turnId.slice(-8)}); forwarding held by prompt loop`,
            );
          } else {
            if (this.activeNotifyTurnId !== (turnId || null)) {
              // A replacement notification started without the previous one's
              // terminal ever arriving: drop the unfinished turn's generated
              // message id so the new turn's text does not append to it.
              this.firstMessageId = null;
              this.activeNotifyTurnId = turnId || null;
            }
            if (this.activeNotifyTurnId) {
              log(`  [bg] background notification turn started (${turnId.slice(-8)})`);
            }
          }
        } else if (this.rewindClaimAt !== null && !this.activeNotifyTurnId) {
          // The replacement turn of a bridge-sent v4 editUserQuery/retryTurn:
          // admitted through the command channel, so no turn loop owns it and
          // its inputSource is not "background_task". Claim it into the
          // notification-turn forwarding path so its text streams to clients;
          // the busy window and running transitions ride the foreign-turn
          // tracking below (this branch only owns the text forwarding).
          //
          // A registered-but-not-started pendingTurn does NOT block the
          // claim: upstream serializes turns FIFO, so the replacement always
          // runs BEFORE a prompt queued behind it — and that prompt's turn
          // loop drops foreign-turn events anyway (skippingForeignTurn), so
          // forwarding here can never double-render. Skipping instead would
          // LOSE the replacement text and strand the claim until the TTL
          // backstop misfires its busy settle.
          this.activeNotifyTurnId = turnId || null;
          this.firstMessageId = null;
          // The rewind claim arms BOTH arms (window + forwarding) for a
          // non-background turn — unchanged by the held-prompt split.
          this.windowTurnId = turnId || null;
          this.server.notifyTurnActiveSince.set(this.zcodeSid, Date.now());
          this.releaseRewindClaim(this.rewindClaimToken!);
          log(`  [bg] rewind replacement turn claimed (${(turnId || "?").slice(-8)})`);
        } else if (this.activeNotifyTurnId) {
          // A non-background turn starting while a notification is marked
          // active means the notification's terminal event was never observed
          // (dropped stream / superseded — v3 sends cannot start mid-turn on
          // 0.16.9+). Clear the stale state: the prompt translator owns normal
          // turns, and a stale marker would forward THEIR text as duplicated
          // background output and hold the busy window open (#351).
          log(`  [bg] stale notification state cleared by normal turn (${turnId.slice(-8)})`);
          this.activeNotifyTurnId = null;
          this.firstMessageId = null;
          this.server.notifyTurnActiveSince.delete(this.zcodeSid);
        }
        // Foreign-turn running state (upstream taskActivityTracker parity):
        // a turn.started from ANY source — background_task wake, subagent_message,
        // control-only — marks the session running for every consumer that has
        // no turn loop of its own to derive it from.
        this.trackForeignTurn(turnId, true);
        return;
      }
      if (event.type === "turn.steerDrained") {
        // Mirror drained steer inputs in the no-turn-loop window (the zombie
        // after a bridge-side cancel: the backend turn keeps generating, a
        // steer drained then has no runEventTurn to echo it — without this
        // the injected user text stays invisible until the next replay).
        // While a turn loop is live it owns the echo; both listeners receive
        // every event, so the pendingTurns gate is what keeps the two paths
        // from double-echoing.
        const turnLive = [...this.server.pendingTurns.values()].some(
          (t) => t.zcodeSid === this.zcodeSid,
        );
        if (!turnLive) {
          const acpSid = this.server.acpSidByZcodeSid.get(this.zcodeSid);
          if (acpSid) echoSteeredInputs(this.server, acpSid, event.payload);
        }
        return;
      }
      // Terminal: settle the busy WINDOW for the turn that opened it, even
      // when text forwarding was never armed (held prompt turn suppressed it)
      // — the window turn's terminal is what releases the prompt path's
      // extended busy budget. When forwarding IS armed, the block below owns
      // the whole settlement (foreign-turn guard + firstMessageId reset tied
      // to the forwarding path, exactly as before the held-prompt split).
      if (
        (event.type === "turn.completed" || event.type === "turn.failed") &&
        this.activeNotifyTurnId === null
      ) {
        const settleTurnId =
          (event.turnId as string | undefined) ??
          (event.payload?.["turnId"] as string | undefined) ??
          "";
        if (
          this.windowTurnId !== null &&
          this.server.notifyTurnActiveSince.has(this.zcodeSid) &&
          (!settleTurnId || settleTurnId === this.windowTurnId)
        ) {
          this.server.notifyTurnActiveSince.delete(this.zcodeSid);
          this.windowTurnId = null;
          log(`  [bg] notification busy window settled (${event.type})`);
        }
      }
      // Inside an active background notification turn → forward its text.
      if (this.activeNotifyTurnId) {
        // Envelope-first turn attribution: an event naming a DIFFERENT turnId
        // belongs to another turn (the user's foreground reply above all) —
        // never forward it as background output and never let it close the
        // busy window (#351). Events without any turnId (legacy backends)
        // keep the window-open forwarding behavior.
        const eventTurnId =
          (event.turnId as string | undefined) ??
          (event.payload?.["turnId"] as string | undefined) ??
          "";
        const foreignTurn = !!eventTurnId && eventTurnId !== this.activeNotifyTurnId;
        if (event.type === "model.streaming") {
          if (foreignTurn) return;
          const kind = event.payload?.["kind"];
          if (kind === "text_delta") {
            const delta = (event.payload?.["delta"] as string | undefined) ?? "";
            if (delta) {
              // Prefer the backend's assistantMessageId — replay/history
              // surfaces key on it; the generated id covers legacy events.
              const backendMessageId = event.payload?.["assistantMessageId"];
              const messageId =
                typeof backendMessageId === "string" && backendMessageId
                  ? backendMessageId
                  : undefined;
              void this.forwardText(delta, messageId);
            }
          }
          return;
        }
        if (event.type === "turn.completed" || event.type === "turn.failed") {
          if (foreignTurn) return;
          log(`  [bg] background notification turn ended (${event.type})`);
          this.activeNotifyTurnId = null;
          this.server.notifyTurnActiveSince.delete(this.zcodeSid);
          // Reset the result messageId so the NEXT background task in this
          // session gets its own — otherwise the editor would merge/overwrite
          // distinct tasks' outputs under one shared messageId.
          this.firstMessageId = null;
          this.trackForeignTurn(eventTurnId, false);
          return;
        }
      }
      // Terminal outside any active notification turn: a pure foreign turn
      // (subagent_message wake, control-only) ending — close its running
      // state the same way.
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        const eventTurnId =
          (event.turnId as string | undefined) ??
          (event.payload?.["turnId"] as string | undefined) ??
          "";
        this.trackForeignTurn(eventTurnId, false);
      }
    } catch (e) {
      warn(
        `BackgroundTaskListener: event handling failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Maintain `server.foreignActiveTurns` for a turn this bridge did not drive
   * (no `pendingTurns` entry exists for it) and broadcast the matching
   * `turnState` transition when no bridge turn loop owns the session.
   *
   * OWNERSHIP IS DECIDED AT START: a turn.started arriving while a
   * bridge-driven turn is registered belongs to the turn loop — it is neither
   * tracked here nor emitted. Tracking it would poison the loop's finally
   * (its stillBusy re-check reads this map): after an ESC cancel whose
   * terminal never arrives, the map would hold the cancelled turn's own id
   * and the session would report running forever (observed in review with a
   * [true, true] broadcast sequence). The pendingTurns entry is registered
   * before the send, so every bridge-driven turn's own turn.started lands
   * behind it. A genuinely foreign start (background wake, subagent_message)
   * can only begin when no bridge turn is registered — turns are serialized
   * upstream-side.
   *
   * Terminal deletion is per turnId: interleaved turns' terminals must not
   * clear a newer active entry; legacy envelopes without a turnId clear
   * unconditionally. Emission stays gated on the pendingTurns emptiness —
   * while a turn loop owns the session, its own start/finally emissions are
   * the only transitions clients see.
   */
  private trackForeignTurn(turnId: string, started: boolean): void {
    const turnLoopLive = [...this.server.pendingTurns.values()].some(
      (t) => t.zcodeSid === this.zcodeSid,
    );
    if (started) {
      if (turnLoopLive) return;
      this.server.foreignActiveTurns.set(this.zcodeSid, turnId);
    } else {
      const current = this.server.foreignActiveTurns.get(this.zcodeSid);
      if (turnId && current && current !== turnId) return;
      this.server.foreignActiveTurns.delete(this.zcodeSid);
    }
    if (turnLoopLive) return;
    const acpSid = this.server.acpSidByZcodeSid.get(this.zcodeSid);
    if (!acpSid) return;
    void emitSessionTurnState(this.server, acpSid, started);
  }

  /** Handle a `session.updated` carrying a background task status. */
  private async onTaskStatus(p: TaskStatusPayload): Promise<void> {
    const taskId = p.taskId;
    const status = p.status ?? "running";
    const acpStatus = toAcpStatus(status);
    // Dynamic-workflow run (taskKind "workflow"; taskId ≡ runId upstream).
    // The fold-vs-fallback decision is made ONCE at first sight and stored on
    // the tracked task — never re-evaluated against dispatchedToolCalls on
    // later events: that registry is a bounded FIFO (2048) whose entries age
    // out mid-run, and re-evaluating would mint a second card beside the
    // CreateWorkflow one. Settings-launched runs dispatch NO live tool event
    // (their CreateWorkflow call is synthetic upstream), so the fallback
    // [background] card is a first-class fold target too: the poller arms
    // against whichever card exists — this listener is the single arm point
    // for both launch paths.
    if (p.taskKind === "workflow") {
      const tracked = this.tasks.get(taskId);
      if (tracked?.foldedIntoToolCard) {
        if (acpStatus !== "in_progress") stopWorkflowRunPoller(taskId);
        // Sticky: the CreateWorkflow card's own tool events own the lifecycle;
        // no [background] card now or later.
        return;
      }
      if (!tracked) {
        const cardId = p.toolCallId ? this.server.dispatchedToolCalls.get(p.toolCallId) : undefined;
        if (cardId) {
          this.tasks.set(taskId, {
            acpCallId: cardId,
            foldedIntoToolCard: true,
            reusesLaunchCard: false,
            description: p.description ?? "",
            lastStatus: "",
            taskKind: p.taskKind,
          });
          if (acpStatus !== "in_progress") stopWorkflowRunPoller(taskId);
          else {
            armWorkflowRunPoller(this.server, this.zcodeSid, {
              runId: taskId,
              toolCallId: cardId,
              name: this.server.workflowRunNames.get(taskId),
            });
          }
          log(
            `  [bg] workflow run ${taskId.slice(-12)} → progress folded into card ${cardId.slice(-12)}`,
          );
          return;
        }
      }
      if (acpStatus !== "in_progress") stopWorkflowRunPoller(taskId);
      // Not folded (no visible card at first sight, or already tracked as a
      // background card) → fall through to the generic background-card path;
      // the mint site arms the poller against the bg card's own id.
    }
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
          taskKind: p.taskKind,
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
        taskKind: p.taskKind,
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
      // Workflow run with no visible tool card (settings-launched runs never
      // dispatch one): the bg card IS the progress surface — arm the poller
      // against its own acpCallId so the run's journal lines land on it.
      // In-progress only: a first sighting that is already terminal has
      // nothing left to poll.
      if (p.taskKind === "workflow" && acpStatus === "in_progress") {
        armWorkflowRunPoller(this.server, this.zcodeSid, {
          runId: taskId,
          toolCallId: task.acpCallId,
          name: this.server.workflowRunNames.get(taskId),
        });
      }
      if (acpStatus !== "in_progress") this.pushTaskTerminal(task, p, acpStatus);
      return;
    }
    await this.emitStatusUpdate(task, acpStatus, p);
  }

  /**
   * Offline push for a terminal background-task status (§5.3). Workflow runs
   * are excluded — they push via the poller's `kind:"run"` hook, and pushing
   * here too would notify twice for one run. One push per task: terminal
   * status events can repeat (reusesLaunchCard updates are not deduped), so
   * the sent flag lives on the tracked task.
   */
  private pushTaskTerminal(
    task: TrackedTask,
    p: TaskStatusPayload,
    acpStatus: "completed" | "failed",
    exitCode?: number,
  ): void {
    if (task.terminalPushed || p.taskKind === "workflow") return;
    task.terminalPushed = true;
    pushSettled(this.server, {
      kind: "task",
      label: pushSourceLabel(this.server),
      title: "background task done",
      body: exitCode !== undefined ? `exit ${exitCode} · ${acpStatus}` : acpStatus,
    });
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
      this.pushTaskTerminal(task, p, acpStatus, exitCode);
      log(`  [bg] launch card ${task.sourceToolCallId.slice(-12)} → ${acpStatus} (terminal_exit)`);
      return;
    }

    // Subsequent sighting (bg_* card) or non-terminal → status update only.
    if (task.lastStatus === acpStatus) return;
    if (isTerminal) this.pushTaskTerminal(task, p, acpStatus);
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

  /**
   * Forward a text delta from the active background notification turn.
   * `backendMessageId` (the payload's assistantMessageId) wins when present;
   * otherwise the lazily-allocated generated id keeps one id per turn.
   */
  private async forwardText(delta: string, backendMessageId?: string): Promise<void> {
    // Register on the session differ's live-delivery tracker so the in-flight
    // user turn's completion diff (the notification turn's journal rows land
    // after its anchor) doesn't replay this text over the forwarded copy.
    this.server.differs?.get(this.zcodeSid)?.noteLiveTextDelta("text", delta, backendMessageId);
    // Allocate the messageId lazily so an empty-result turn emits nothing.
    let msgId = backendMessageId ?? this.activeMessageId();
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

  /**
   * Terminal record for tasks still in flight when the bridge (or its backend
   * subprocess) shuts down. The CLI runtime keeps its task registry in memory
   * and aborts silently on adapter close — no completion/termination event is
   * ever emitted, so the client's card would stay in_progress forever. Emit a
   * `failed` update with `shutdown: true` metadata instead (#194). Best-effort;
   * called from the bridge shutdown paths before the backend pipe closes.
   */
  async emitShutdownRecords(): Promise<void> {
    for (const [taskId, task] of [...this.tasks]) {
      if (task.lastStatus === "completed" || task.lastStatus === "failed") continue;
      if (task.reusesLaunchCard && task.sourceToolCallId) {
        await this.server.notifyByZcodeSid(this.zcodeSid, {
          sessionUpdate: "tool_call_update",
          toolCallId: task.sourceToolCallId,
          status: "failed",
          content: [{ type: "terminal", terminalId: task.sourceToolCallId }],
          _meta: {
            backgroundTask: { taskId, shutdown: true },
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
          _meta: { backgroundTask: { taskId, shutdown: true } },
        });
      }
      task.lastStatus = "failed";
      log(`  [bg] shutdown record emitted for task ${taskId.slice(-12)}`);
    }
  }
}
