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
import { readFileSync, unlinkSync } from "node:fs";

import { compact } from "../handlers/extensions.js";
import {
  isBackendLostRequestError,
  preemptInFlightTurn,
  reloadBackendSession,
  runOneTurn,
  withPreemptLock,
} from "../handlers/session.js";
import { sendTextChunk } from "../handlers/io.js";
import { messages } from "../i18n.js";
import type { PendingTurn, ZcodeAcpServer } from "../server.js";
import { log, warn } from "../utils.js";
import {
  clearGoalState,
  type GoalLoopState,
  handoffPath,
  readGoalState,
  verifyPath,
  writeGoalState,
} from "./state.js";
import {
  decomposePrompt,
  dispatchPrompt,
  handoffPrompt,
  parseTickets,
  parseVerifyFile,
  parseVerifyReply,
  parseVerdict,
  strictVerifyPrompt,
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
/** How long a start waits for in-flight editor turns before pre-empting them. */
const EDITOR_TURN_WAIT_MS = 10_000;

interface ParkedPrompt {
  id: number;
  text: string;
  resolve: (r: acp.PromptResponse) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class GoalLoopDriver {
  readonly zcodeSid: string;
  private readonly server: ZcodeAcpServer;
  private readonly acpSid: string;
  private state: GoalLoopState;
  private pauseFlag = false;
  private stopFlag = false;
  private parked: ParkedPrompt[] = [];
  private parkSeq = 0;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private runId = 0;
  /** Set when the last goal turn was cancelled by the sandbox allow-restart. */
  private lastSandboxRestart = false;
  /**
   * Consecutive backend-lost recoveries by run()'s catch (the per-turn
   * recovery inside runOneTurn already respawns twice before giving up —
   * this counter only bounds the loop-level last resort). Reset on any
   * round that completes without losing the backend.
   */
  private backendRecoveries = 0;
  private static readonly MAX_BACKEND_RECOVERIES = 3;

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
        // Identity check: a NEWER driver for this sid (pause → fresh start in
        // the endLoop announce window) must not be unregistered by this one.
        if (server.goalLoops.get(zcodeSid) === driver) server.goalLoops.delete(zcodeSid);
      });
    return driver;
  }

  /** Pause at the next round boundary (the in-flight round keeps running). */
  pause(): void {
    this.pauseFlag = true;
  }

  /**
   * External pause request — session/cancel during a quiet window with no
   * registered turn (e.g. compact()'s internal wait): same flag as pause(),
   * consumed at the next boundary.
   */
  requestPause(): void {
    this.pauseFlag = true;
  }

  /** Clear a pending pause/stop (/auto resume before the boundary takes it). */
  resume(): void {
    this.pauseFlag = false;
    this.stopFlag = false;
  }

  /** Stop at the next boundary and clear persisted state. */
  stop(): void {
    this.stopFlag = true;
  }

  /** One-line status for /auto status. */
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
      this.parked.push({ id: ++this.parkSeq, text, resolve });
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

  /**
   * Resolve parked prompts. Without a `snapshot`, everything currently parked
   * settles (pause/stop/end-of-loop paths). With one, ONLY the snapshot's
   * entries resolve — prompts parked DURING a round (the common steering
   * window) stay parked and their text merges into the NEXT round instead of
   * being silently resolved-and-dropped (ADR-0022 §3).
   */
  private settleParked(r: acp.PromptResponse, keepText: boolean, snapshot?: ParkedPrompt[]): void {
    const resolving = snapshot ?? [...this.parked];
    if (resolving.length === 0) {
      if (this.parked.length === 0) this.disarmKeepalive();
      return;
    }
    const ids = new Set(resolving.map((p) => p.id));
    this.parked = this.parked.filter((p) => !ids.has(p.id));
    for (const p of resolving) p.resolve(r);
    if (keepText) {
      // Merge (not overwrite): text preserved across a resume may already be
      // on record when the loop pauses before this round's snapshot.
      this.state.parkedText =
        [this.state.parkedText, ...resolving.map((p) => p.text)].filter(Boolean).join("\n\n") ||
        undefined;
    }
    if (this.parked.length === 0) this.disarmKeepalive();
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
    // Mirror runPrompt's round-start indicator: remote clients would flip
    // idle between rounds (runOneTurn's finally emits running:false per round).
    for (const sid of server.sessionAliases(this.acpSid)) {
      void server.clients
        .broadcast()
        .notify("$/zcode/turnState", { sessionId: sid, running: true })
        .catch(() => undefined);
    }
    try {
      return await runOneTurn(server, {
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
    } finally {
      // flushSandboxGrants marks goalLoop turns it cancels so the round
      // boundary can tell a backend restart apart from a user ESC.
      this.lastSandboxRestart = turn.sandboxRestart === true;
    }
  }

  /** Consume the sandbox-restart mark set by the last runGoalTurn. */
  private consumeSandboxRestart(): boolean {
    const r = this.lastSandboxRestart;
    this.lastSandboxRestart = false;
    return r;
  }

  /**
   * Wait out in-flight NON-goal turns for this session before the first
   * round: a send landing mid-generation is accepted as steer input and its
   * text silently dropped when the old turn finishes (see AGENTS.md) — the
   * decompose prompt would be injected into the foreign conversation and the
   * tickets parsed from its reply. Real agent turns run minutes, so on timeout
   * the wait PRE-EMPTS the editor turn with the same semantics a normal
   * prompt uses (cancel flag + stop pair via preemptInFlightTurn) — proceeding
   * would land the decompose send as steer input into the live conversation.
   * runOneTurn's drain gate, armed by the pre-empt's lastCancelledAt mark,
   * settles the backend before the decompose send.
   */
  private async waitForEditorTurnsIdle(myRun: number): Promise<void> {
    const deadline = Date.now() + EDITOR_TURN_WAIT_MS;
    while (Date.now() < deadline) {
      if (this.runId !== myRun) return;
      const busy = [...this.server.pendingTurns.values()].some(
        (t) => t.zcodeSid === this.zcodeSid && !t.goalLoop,
      );
      if (!busy) return;
      await sleep(250);
    }
    warn("goal-loop: a normal turn is still in flight after 10s — pre-empting it");
    preemptInFlightTurn(this.server, this.zcodeSid, "");
  }

  /** Text of the last assistant reply at or after `since` (verdict parsing input). */
  private async lastAssistantText(since = 0): Promise<string> {
    const { fetchMessages } = await import("../handlers/replay.js");
    const msgs = await fetchMessages(this.server, this.zcodeSid);
    for (let i = msgs.length - 1; i >= Math.min(since, msgs.length); i--) {
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
    // Settle parked prompts BEFORE persisting: keepText stores their text in
    // the state that the persist below must include.
    this.settleParked({ stopReason: "cancelled" }, status.startsWith("paused"));
    this.persist();
    if (status === "stopped") clearGoalState(this.server.projectCwd(), this.zcodeSid);
    await this.announce(note ?? messages().goalPaused(reason));
    log(`goal-loop: ${this.zcodeSid.slice(0, 8)} → ${status} (${reason})`);
  }

  private async run(myRun: number): Promise<void> {
    // Any throw from the round machinery (runOneTurn permanent send errors,
    // auth/quota failures, a corrupt state read) must still settle parked
    // prompts, disarm the keepalive, and persist a paused status — the outer
    // .catch in start() only logs (ADR-0022 §4: unrecoverable errors end the
    // loop, they must not wedge the editor's prompt request forever).
    // Loop rather than recurse on backend-lost recovery: a re-thrown failure
    // from a recursive runRounds would escape this handler and reject run().
    for (;;) {
      try {
        await this.runRounds(myRun);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // A lost backend is recoverable at the loop level too: respawn,
        // reload the session, and re-enter the round machinery instead of
        // pausing — an unattended auto run must survive backend process
        // churn (observed 2026-09-11: "database is not open" during the
        // agent's own shutdown hard-stopped a night-long run). Bounded so a
        // persistently broken spawn still ends in a pause.
        if (
          isBackendLostRequestError(e) &&
          this.runId === myRun &&
          this.backendRecoveries < GoalLoopDriver.MAX_BACKEND_RECOVERIES
        ) {
          this.backendRecoveries++;
          warn(
            `goal-loop: backend lost — respawning and resuming (${this.backendRecoveries}/${GoalLoopDriver.MAX_BACKEND_RECOVERIES}, ${msg})`,
          );
          try {
            this.server.ensureBackend();
            await reloadBackendSession(this.server, this.acpSid, this.zcodeSid);
          } catch (e2) {
            warn(
              `goal-loop: backend recovery failed — pausing loop (${e2 instanceof Error ? e2.message : String(e2)})`,
            );
            if (this.runId !== myRun) return;
            try {
              await this.endLoop("paused-crash", msg);
            } catch (e3) {
              warn(
                `goal-loop: crash recovery failed (${e3 instanceof Error ? e3.message : String(e3)})`,
              );
            }
            return;
          }
          await this.announce(messages().goalBackendRecovered);
          continue;
        }
        warn(`goal-loop: round machinery failed — pausing loop (${msg})`);
        if (this.runId !== myRun) return;
        try {
          await this.endLoop("paused-crash", msg);
        } catch (e2) {
          warn(
            `goal-loop: crash recovery failed (${e2 instanceof Error ? e2.message : String(e2)})`,
          );
        }
        return;
      }
    }
  }

  private async runRounds(myRun: number): Promise<void> {
    const alive = (): boolean => this.runId === myRun && !this.server.backend?.isDead;

    await this.waitForEditorTurnsIdle(myRun);
    if (this.runId !== myRun) return;

    // Round 0 (uncounted): decompose the objective into tickets — unless
    // resuming with a ticket list already on record.
    if (this.state.tickets.length === 0) {
      await this.announce(messages().goalStarted(this.state.objective));
      const res = await this.runGoalTurn(decomposePrompt(this.state.objective));
      if (this.runId !== myRun) return;
      if (res.stopReason === "cancelled") {
        if (this.consumeSandboxRestart()) return this.runRounds(myRun);
        return void (await this.endLoop("paused", "cancelled"));
      }
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
        return void (await this.endLoop("stopped", "/auto stop", messages().goalStopped));
      if (this.pauseFlag) return void (await this.endLoop("paused", "/auto pause"));

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
      // round; ONLY the prompts parked before dispatch settle with it — text
      // parked DURING the round merges into the next one instead.
      const roundParked = [...this.parked];
      const userText =
        [this.state.parkedText, ...roundParked.map((p) => p.text)].filter(Boolean).join("\n\n") ||
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
        ticket.status = "pending";
        if (this.consumeSandboxRestart()) {
          // Sandbox allow-restart killed the backend mid-round: re-dispatch
          // the same ticket on the respawned backend (ensureBackend inside
          // runGoalTurn), don't pause — the user answered "allow" to keep
          // the loop going.
          await this.announce(messages().sandboxResumedStatus);
          continue;
        }
        // ESC / external cancel: the round was cut short — pause, keep text.
        return void (await this.endLoop("paused", "cancelled"));
      }
      this.state.rounds++;
      // A round completed against a live backend — the lost-backend streak
      // (if any) is broken, so the loop-level recovery budget resets.
      this.backendRecoveries = 0;

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
        // Verification turn (uncounted): re-run the acceptance criteria. The
        // verdict arrives as a model-WRITTEN file in a fixed format; the prose
        // reply is only a fallback (parsing prose looped forever on real
        // backends — observed 2026-09, 11 rounds of re-doing finished work).
        const vPath = verifyPath(this.server.projectCwd(), this.zcodeSid);
        const readVerify = (): { pass: boolean; reason?: string } | null => {
          try {
            return parseVerifyFile(readFileSync(vPath, "utf8"));
          } catch {
            return null;
          }
        };
        // Stale verdict from an earlier round must not be read as this one's.
        try {
          unlinkSync(vPath);
        } catch {
          /* absent — fine */
        }
        // Prose fallback reads ONLY messages appended by the verify turn: a
        // walk-back into the dispatch reply would let the worker's own "made
        // the tests pass" verify its own work.
        const vBefore = await this.messageCount();
        const vRes = await this.runGoalTurn(verifyPrompt(ticket, vPath));
        if (this.runId !== myRun) return;
        if (vRes.stopReason === "cancelled") {
          if (this.consumeSandboxRestart()) {
            await this.announce(messages().sandboxResumedStatus);
            this.persist();
            continue;
          }
          return void (await this.endLoop("paused", "cancelled"));
        }
        let v = readVerify() ?? parseVerifyReply(await this.lastAssistantText(vBefore));
        if (!v) {
          const rRes = await this.runGoalTurn(strictVerifyPrompt(ticket, vPath));
          if (this.runId !== myRun) return;
          if (rRes.stopReason === "cancelled") {
            if (this.consumeSandboxRestart()) {
              await this.announce(messages().sandboxResumedStatus);
              this.persist();
              continue;
            }
            return void (await this.endLoop("paused", "cancelled"));
          }
          v = readVerify() ?? parseVerifyReply(await this.lastAssistantText(vBefore));
        }
        if (!v) {
          // Still unreadable: pause for the user instead of looping or
          // blindly trusting the worker's claim.
          ticket.status = "pending";
          this.persist();
          return void (await this.endLoop(
            "paused",
            "verification unreadable",
            messages().goalVerifyUnreadable(ticket.title),
          ));
        }
        if (v.pass) {
          ticket.status = "done";
          ticket.feedback = undefined;
        } else {
          ticket.feedback = v.reason ?? messages().goalVerifyUnparsed;
          await this.announce(messages().goalVerifyFailed(ticket.title, ticket.feedback));
        }
      }

      this.persist();
      // Parked prompts merged into this round settle with it; ones parked
      // DURING the round stay for the next merge.
      this.settleParked({ stopReason: "end_turn" }, false, roundParked);

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
        const handoffCancelled = await this.compactBoundary();
        if (this.runId !== myRun) return;
        // ESC during the handoff turn pauses like any other round (a restart
        // cancel just skips this boundary's compaction).
        if (handoffCancelled && !this.consumeSandboxRestart()) {
          return void (await this.endLoop("paused", "cancelled"));
        }
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

  /**
   * Handoff turn → session/compact → mark handoffFresh for the next round.
   * Returns true when the handoff turn was cancelled (ESC / restart).
   */
  private async compactBoundary(): Promise<boolean> {
    const hPath = handoffPath(this.server.projectCwd(), this.zcodeSid);
    const used = await this.contextUsed();
    await this.announce(messages().autoCompactStart(used.toLocaleString(), "goal loop"));
    try {
      const hRes = await this.runGoalTurn(
        handoffPrompt({ objective: this.state.objective, handoffFile: hPath }),
      );
      if (hRes.stopReason === "cancelled") return true;
      // compact() waits out its internal turn itself; state rides along. Its
      // waitForTurnIdle window (up to 300s) runs with no pendingTurns entry,
      // so ESC there cannot flag a turn — cancel() parks the pause on the
      // driver instead (requestPause), consumed at the next round boundary.
      await compact(this.server, { sessionId: this.acpSid }, this.server.clients.broadcast());
      this.state.handoffFresh = true;
      this.persist();
      await this.announce(messages().autoCompactDone);
      return false;
    } catch (e) {
      warn(
        `goal-loop: compaction failed (${e instanceof Error ? e.message : String(e)}) — continuing without`,
      );
      await this.announce(messages().autoCompactFailed(e instanceof Error ? e.message : String(e)));
      return false;
    }
  }
}
