/**
 * Goal-loop driver (ADR-0022): the bridge-driven autonomous turn chain.
 *
 * Round shape: one ticket per `session/send` turn via the shared
 * {@link runOneTurn} machinery, a worker self-report VERDICT, and — only on a
 * claimed `met` — one verification turn that re-runs the acceptance criteria
 * (never trust the worker's report). Compaction runs at round boundaries
 * (handoff turn → session/compact → the next dispatch reads the handoff doc).
 *
 * User interaction: rounds register in `pendingTurns` with `goalLoop: true`
 * INSIDE withPreemptLock — `preemptInFlightTurn` skips them and the prompt
 * path parks the incoming prompt on the driver instead (merge at the next
 * boundary). ESC/cancel still cancels the in-flight round (pause follows).
 * While prompts are parked, a 60s keepalive keeps clients from hitting their
 * idle deadlines during the quiet judge/compaction windows.
 */

import type * as acp from "@agentclientprotocol/sdk";

import { compact } from "../handlers/extensions.js";
import { runOneTurn, withPreemptLock } from "../handlers/session.js";
import { sendTextChunk } from "../handlers/io.js";
import { messages } from "../i18n.js";
import type { PendingTurn, ZcodeAcpServer } from "../server.js";
import { log, warn } from "../utils.js";
import {
  clearGoalState,
  type GoalLoopState,
  handoffPath,
  readGoalState,
  writeGoalState,
} from "./state.js";
import {
  decomposePrompt,
  dispatchPrompt,
  handoffPrompt,
  parseTickets,
  parseVerifyReply,
  parseVerdict,
  verifyPrompt,
} from "./templates.js";

/** ENV: ZCODE_ACP_GOAL_MAX_TURNS — hard round budget before a pause. */
export function goalMaxTurns(): number {
  const raw = Number(process.env.ZCODE_ACP_GOAL_MAX_TURNS ?? "0");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
}

/** Goal-loop compaction threshold: the shared env var, else 80% of window. */
export function goalCompactThreshold(contextWindow: number): number {
  const raw = Number(process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD ?? "0");
  if (Number.isFinite(raw) && raw > 0) return raw;
  return Math.floor(contextWindow * 0.8);
}

/** Consecutive dispatch rounds with no tool activity before a stall pause. */
const STALL_ROUND_LIMIT = 3;
/** Keepalive cadence while a user prompt is parked (client deadlines ~300s). */
const KEEPALIVE_INTERVAL_MS = 60_000;

interface ParkedPrompt {
  text: string;
  resolve: (r: acp.PromptResponse) => void;
}

export class GoalLoopDriver {
  readonly zcodeSid: string;
  private readonly server: ZcodeAcpServer;
  private readonly acpSid: string;
  private state: GoalLoopState;
  private pauseFlag = false;
  private stopFlag = false;
  private parked: ParkedPrompt[] = [];
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private runId = 0;

  private constructor(
    server: ZcodeAcpServer,
    acpSid: string,
    zcodeSid: string,
    state: GoalLoopState,
  ) {
    this.server = server;
    this.acpSid = acpSid;
    this.zcodeSid = zcodeSid;
    this.state = state;
  }

  /** Live driver for a session, when a loop is running. */
  static live(server: ZcodeAcpServer, zcodeSid: string): GoalLoopDriver | undefined {
    // Optional chaining: unit-test servers predate the registry field.
    return server.goalLoops?.get(zcodeSid);
  }

  /**
   * Start (or resume) the loop for a session. Resuming adopts the persisted
   * state (round count, tickets, parked text); a fresh start decomposes the
   * objective into tickets first.
   */
  static start(
    server: ZcodeAcpServer,
    acpSid: string,
    zcodeSid: string,
    objective: string,
    opts: { resume?: boolean } = {},
  ): GoalLoopDriver {
    const existing = server.goalLoops.get(zcodeSid);
    if (existing && existing.state.status === "running") return existing;
    const prior = opts.resume ? readGoalState(server.projectCwd(), zcodeSid) : null;
    const state: GoalLoopState = prior ?? {
      objective,
      status: "running",
      rounds: 0,
      tickets: [],
      handoffFresh: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.status = "running";
    if (!opts.resume) state.objective = objective;
    const driver = new GoalLoopDriver(server, acpSid, zcodeSid, state);
    server.goalLoops.set(zcodeSid, driver);
    const myRun = ++driver.runId;
    void driver
      .run(myRun)
      .catch((e) =>
        warn(`goal-loop: driver crashed (${e instanceof Error ? e.message : String(e)})`),
      )
      .finally(() => {
        if (driver.runId === myRun) server.goalLoops.delete(zcodeSid);
      });
    return driver;
  }

  /** Pause at the next round boundary (the in-flight round keeps running). */
  pause(): void {
    this.pauseFlag = true;
  }

  /** Stop at the next boundary and clear persisted state. */
  stop(): void {
    this.stopFlag = true;
  }

  /** One-line status for /goal status. */
  statusText(): string {
    const s = this.state;
    const current = s.tickets.find((t) => t.status === "in_progress" || t.status === "pending");
    const done = s.tickets.filter((t) => t.status === "done").length;
    return messages().goalStatus(
      s.status,
      s.rounds,
      goalMaxTurns(),
      done,
      s.tickets.length,
      current?.title,
    );
  }

  /**
   * Park an incoming user prompt (called by the prompt path when a goalLoop
   * turn is in flight). Resolves when the merged round completes — or
   * `cancelled` if the loop pauses/stops first (text preserved in state).
   */
  parkPrompt(text: string): Promise<acp.PromptResponse> {
    return new Promise<acp.PromptResponse>((resolve) => {
      this.parked.push({ text, resolve });
      this.armKeepalive();
    });
  }

  private armKeepalive(): void {
    if (this.keepalive) return;
    this.keepalive = setInterval(() => {
      if (this.parked.length === 0) {
        this.disarmKeepalive();
        return;
      }
      for (const sid of this.server.sessionAliases(this.acpSid)) {
        void this.server.clients
          .broadcast()
          .notify("$/zcode/turnState", { sessionId: sid, running: true })
          .catch(() => undefined);
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private disarmKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  private settleParked(r: acp.PromptResponse, keepText: boolean): void {
    this.disarmKeepalive();
    for (const p of this.parked) p.resolve(r);
    if (keepText && this.parked.length > 0) {
      this.state.parkedText = this.parked.map((p) => p.text).join("\n\n");
    }
    this.parked = [];
  }

  // ---------- round machinery ----------

  /** One goal-loop turn through the shared runOneTurn (goalLoop-marked). */
  private async runGoalTurn(prompt: string): Promise<acp.PromptResponse> {
    const server = this.server;
    const backend = server.ensureBackend();
    const turn: PendingTurn = { zcodeSid: this.zcodeSid, cancelled: false, goalLoop: true };
    const requestId = `goal-${this.zcodeSid}-${this.state.rounds}-${Date.now()}`;
    await withPreemptLock(server, this.zcodeSid, async () => {
      server.pendingTurns.set(requestId, turn);
    });
    return runOneTurn(server, {
      backend,
      cx: server.clients.broadcast(),
      acpSid: this.acpSid,
      zcodeSid: this.zcodeSid,
      requestId,
      turn,
      preempted: false,
      sendText: prompt,
      autoCompact: false,
    });
  }

  /** Text of the last assistant reply (verdict parsing input). */
  private async lastAssistantText(): Promise<string> {
    const { fetchMessages } = await import("../handlers/replay.js");
    const msgs = await fetchMessages(this.server, this.zcodeSid);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.info.role !== "assistant") continue;
      const text = m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }

  /** Tool-part count in the messages appended since `before` (stall signal). */
  private async toolActivitySince(before: number): Promise<number> {
    const { fetchMessages } = await import("../handlers/replay.js");
    const msgs = await fetchMessages(this.server, this.zcodeSid);
    let tools = 0;
    for (let i = Math.min(before, msgs.length); i < msgs.length; i++) {
      if (msgs[i]!.parts.some((p) => p.type === "tool")) tools++;
    }
    return tools;
  }

  private async messageCount(): Promise<number> {
    const { fetchMessages } = await import("../handlers/replay.js");
    return (await fetchMessages(this.server, this.zcodeSid)).length;
  }

  private async contextUsed(): Promise<number> {
    const resp = await this.server
      .ensureBackend()
      .request(this.server.nextId(), "session/read", { sessionId: this.zcodeSid }, 5000);
    if (resp.error) return 0;
    return (
      ((resp.result ?? {}) as { projection?: { contextUsed?: number } }).projection?.contextUsed ??
      0
    );
  }

  private async announce(text: string): Promise<void> {
    await sendTextChunk(
      this.server.clients.broadcast(),
      this.acpSid,
      text,
      `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ).catch(() => undefined);
  }

  private persist(): void {
    writeGoalState(this.server.projectCwd(), this.zcodeSid, this.state);
  }

  private async endLoop(
    status: GoalLoopState["status"],
    reason: string,
    note?: string,
  ): Promise<void> {
    this.state.status = status;
    this.state.endedReason = reason;
    this.persist();
    if (status === "stopped") clearGoalState(this.server.projectCwd(), this.zcodeSid);
    this.settleParked({ stopReason: "cancelled" }, status.startsWith("paused"));
    await this.announce(note ?? messages().goalPaused(reason));
    log(`goal-loop: ${this.zcodeSid.slice(0, 8)} → ${status} (${reason})`);
  }

  private async run(myRun: number): Promise<void> {
    const alive = (): boolean => this.runId === myRun && !this.server.backend?.isDead;

    // Round 0 (uncounted): decompose the objective into tickets — unless
    // resuming with a ticket list already on record.
    if (this.state.tickets.length === 0) {
      await this.announce(messages().goalStarted(this.state.objective));
      const res = await this.runGoalTurn(decomposePrompt(this.state.objective));
      if (this.runId !== myRun) return;
      if (res.stopReason === "cancelled") return void (await this.endLoop("paused", "cancelled"));
      const parsed = parseTickets(await this.lastAssistantText());
      this.state.tickets = (
        parsed ?? [{ title: this.state.objective, acceptance: this.state.objective }]
      ).map((t, i) => ({
        id: `t${i + 1}`,
        title: t.title,
        acceptance: t.acceptance,
        status: "pending" as const,
      }));
      this.persist();
    } else {
      await this.announce(messages().goalResumed(this.state.rounds));
    }

    let stallCount = 0;
    while (alive()) {
      if (this.stopFlag)
        return void (await this.endLoop("stopped", "/goal stop", messages().goalStopped));
      if (this.pauseFlag) return void (await this.endLoop("paused", "/goal pause"));

      const ticket = this.state.tickets.find(
        (t) => t.status === "pending" || t.status === "in_progress",
      );
      if (!ticket)
        return void (await this.endLoop(
          "complete",
          "all tickets done",
          messages().goalComplete(this.state.rounds),
        ));
      ticket.status = "in_progress";

      if (this.state.rounds >= goalMaxTurns()) {
        return void (await this.endLoop("paused-budget", `round budget ${goalMaxTurns()}`));
      }

      // Merge parked user text (plus any preserved across a resume) into this
      // round; the parked prompts settle when the round completes.
      const userText =
        [this.state.parkedText, ...this.parked.map((p) => p.text)].filter(Boolean).join("\n\n") ||
        undefined;
      this.state.parkedText = undefined;

      const before = await this.messageCount();
      const result = await this.runGoalTurn(
        dispatchPrompt({
          objective: this.state.objective,
          ticket,
          ticketIndex: this.state.tickets.indexOf(ticket) + 1,
          ticketCount: this.state.tickets.length,
          handoffFile: this.state.handoffFresh
            ? handoffPath(this.server.projectCwd(), this.zcodeSid)
            : undefined,
          userText,
        }),
      );
      if (this.runId !== myRun) return;

      if (result.stopReason === "cancelled") {
        // ESC / external cancel: the round was cut short — pause, keep text.
        ticket.status = "pending";
        this.settleParked({ stopReason: "cancelled" }, true);
        return void (await this.endLoop("paused", "cancelled"));
      }
      this.state.rounds++;

      // Stall detection: rounds with zero tool activity accumulate to a pause.
      const tools = await this.toolActivitySince(before);
      stallCount = tools > 0 ? 0 : stallCount + 1;

      const verdict = parseVerdict(await this.lastAssistantText());
      if (verdict?.kind === "impossible") {
        return void (await this.endLoop(
          "impossible",
          verdict.why ?? "reported impossible",
          messages().goalImpossible(verdict.why ?? ""),
        ));
      }

      if (verdict?.kind === "met") {
        // Verification turn (uncounted): re-run the acceptance criteria.
        const vRes = await this.runGoalTurn(verifyPrompt(ticket));
        if (this.runId !== myRun) return;
        const v = parseVerifyReply(await this.lastAssistantText());
        if (vRes.stopReason === "cancelled") {
          return void (await this.endLoop("paused", "cancelled"));
        }
        if (v?.pass) {
          ticket.status = "done";
          ticket.feedback = undefined;
        } else {
          ticket.feedback = v?.reason ?? messages().goalVerifyUnparsed;
          await this.announce(messages().goalVerifyFailed(ticket.title, ticket.feedback));
        }
      }

      this.persist();
      // Parked prompts merged into this round settle with it.
      this.settleParked({ stopReason: "end_turn" }, false);

      if (stallCount >= STALL_ROUND_LIMIT) {
        return void (await this.endLoop(
          "paused-stall",
          "no tool activity",
          messages().goalStallPaused,
        ));
      }

      // Compaction at the round boundary (ADR-0022 §2).
      const { currentModelCached } = await import("../config/model-cache.js");
      const { modelContextWindow, parseModelValue } = await import("../config/options.js");
      const cur = parseModelValue(await currentModelCached(this.server, this.zcodeSid));
      const window =
        modelContextWindow(cur?.providerId ?? "", cur?.modelId ?? "") ||
        (await this.contextWindowFromRead());
      const used = await this.contextUsed();
      if (window > 0 && used >= goalCompactThreshold(window)) {
        await this.compactBoundary();
        if (this.runId !== myRun) return;
      }

      await this.announce(
        messages().goalReport(
          this.state.rounds,
          goalMaxTurns(),
          ticket.title,
          ticket.status === "done",
        ),
      );
    }
  }

  private async contextWindowFromRead(): Promise<number> {
    const resp = await this.server
      .ensureBackend()
      .request(this.server.nextId(), "session/read", { sessionId: this.zcodeSid }, 5000);
    if (resp.error) return 0;
    return (
      ((resp.result ?? {}) as { projection?: { contextWindow?: number } }).projection
        ?.contextWindow ?? 0
    );
  }

  /** Handoff turn → session/compact → mark handoffFresh for the next round. */
  private async compactBoundary(): Promise<void> {
    const hPath = handoffPath(this.server.projectCwd(), this.zcodeSid);
    const used = await this.contextUsed();
    await this.announce(messages().autoCompactStart(used.toLocaleString(), "goal loop"));
    try {
      const hRes = await this.runGoalTurn(
        handoffPrompt({ objective: this.state.objective, handoffFile: hPath }),
      );
      if (hRes.stopReason === "cancelled") return;
      // compact() waits out its internal turn itself; state rides along.
      await compact(this.server, { sessionId: this.acpSid }, this.server.clients.broadcast());
      this.state.handoffFresh = true;
      this.persist();
      await this.announce(messages().autoCompactDone);
    } catch (e) {
      warn(
        `goal-loop: compaction failed (${e instanceof Error ? e.message : String(e)}) — continuing without`,
      );
      await this.announce(messages().autoCompactFailed(e instanceof Error ? e.message : String(e)));
    }
  }
}
