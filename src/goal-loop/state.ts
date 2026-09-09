/**
 * Goal-loop persistent state (ADR-0022).
 *
 * Artifacts live under `.zcode/scratch/goals/<zcodeSid>/` keyed by the backend
 * session id (stable across bridge restarts, unlike the per-attach ACP id).
 * Rich context (progress, next steps) is NOT stored here by design — it lives
 * in the model-written handoff document (`.zcode/handoff/goal-<sid>.md`); this
 * file only holds what the DRIVER needs to resume: objective, round count,
 * ticket checklist, and the parked user text across a pause.
 *
 * Writes are temp-file + rename (the same discipline as the lazy-alias store,
 * though the sharing surface is much smaller: one writer per session loop).
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { log } from "../utils.js";

export type GoalTicketStatus = "pending" | "in_progress" | "done" | "blocked";

export interface GoalTicket {
  id: string;
  title: string;
  /** How to verify the ticket is done (rendered into dispatch + verify prompts). */
  acceptance: string;
  status: GoalTicketStatus;
  /** Last verification failure feedback (feeds the next dispatch round). */
  feedback?: string;
}

export type GoalLoopStatus =
  | "running"
  | "paused"
  | "paused-budget"
  | "paused-stall"
  | "paused-crash"
  | "complete"
  | "impossible"
  | "stopped";

export interface GoalLoopState {
  objective: string;
  status: GoalLoopStatus;
  /** Completed dispatch rounds (verification/handoff/decompose turns excluded). */
  rounds: number;
  tickets: GoalTicket[];
  /** True right after compaction — the next dispatch must read the handoff doc. */
  handoffFresh: boolean;
  /** User text preserved across a pause, merged into the next dispatch. */
  parkedText?: string;
  createdAt: number;
  updatedAt: number;
  /** Final round count / reason when the loop reached a terminal status. */
  endedReason?: string;
}

/** Directory holding a session's goal artifacts (spec/tickets/state). */
export function goalDir(projectRoot: string, zcodeSid: string): string {
  return path.join(projectRoot, ".zcode", "scratch", "goals", zcodeSid);
}

/** Handoff document path (model-written, read back after compaction). */
export function handoffPath(projectRoot: string, zcodeSid: string): string {
  return path.join(projectRoot, ".zcode", "handoff", `goal-${zcodeSid}.md`);
}

export function statePath(projectRoot: string, zcodeSid: string): string {
  return path.join(goalDir(projectRoot, zcodeSid), "state.json");
}

/** Read a session's goal state; null when none exists or it is unreadable. */
export function readGoalState(projectRoot: string, zcodeSid: string): GoalLoopState | null {
  try {
    const raw = JSON.parse(readFileSync(statePath(projectRoot, zcodeSid), "utf8"));
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof raw.objective !== "string" ||
      !Array.isArray(raw.tickets)
    ) {
      // Corrupt/hand-edited state reads as absent — a malformed tickets list
      // would otherwise throw inside the driver's round loop.
      return null;
    }
    return raw as GoalLoopState;
  } catch {
    return null;
  }
}

/** Atomically persist the goal state (temp file + rename). */
export function writeGoalState(projectRoot: string, zcodeSid: string, state: GoalLoopState): void {
  state.updatedAt = Date.now();
  const dir = goalDir(projectRoot, zcodeSid);
  const target = statePath(projectRoot, zcodeSid);
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, target);
  } catch (e) {
    log(
      `goal-loop: state write failed (${e instanceof Error ? e.message : String(e)}) — continuing`,
    );
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to sweep */
    }
  }
}

/** Best-effort removal on /auto stop (terminal states keep the record). */
export function clearGoalState(projectRoot: string, zcodeSid: string): void {
  try {
    unlinkSync(statePath(projectRoot, zcodeSid));
  } catch {
    /* absent — fine */
  }
}
