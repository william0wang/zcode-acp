/**
 * Process-level crash guards + a diagnostic on-disk log for the bridge.
 *
 * The bridge is a LONG-LIVED process hosted inside an editor extension host,
 * a martty TUI, or a hub incubation — when it dies, the whole window dies
 * with it and its stderr vanishes with the terminal (observed 2026-09-23: a
 * bun-hosted bridge died ~25ms after issuing session/create in a fresh
 * workspace; the backend saw its stdin close, shut down, and martty exited —
 * and NOTHING remained to say why the bridge died). Two layers fix both
 * halves:
 *
 * 1. `unhandledRejection` / `uncaughtException` handlers that WARN instead of
 *    dying. Node ≥15 and Bun both crash the process on an unhandled rejection
 *    by default; the codebase's convention is already "best-effort in event
 *    handlers, failures are logged, never thrown into the event loop", but a
 *    single missed `.catch` anywhere still took the window down. Swallowing
 *    is the right trade for a stateless-per-request bridge: a dropped
 *    notification beats a dead session.
 * 2. A daily diary at `~/.zcode/cli/log/zcode-acp-YYYY-MM-DD.log` (next to
 *    the backend's own logs) that every `warn()` appends to. The diary is
 *    what survives the window: the next crash leaves its reason on disk.
 *
 * EPIPE on stdout is the one deliberate exit: the ACP client is gone, so the
 * process is an orphan holding a hub registration — record and exit cleanly.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Root of the ZCode data dir (mirrors utils.zcodeHomeDir — duplicated here so
 * utils can statically import the diary without an import cycle).
 */
function zcodeHomeDir(): string {
  const explicit = process.env.ZCODE_HOME;
  if (explicit) return explicit;
  return path.join(process.env.HOME || process.env.USERPROFILE || "~", ".zcode");
}

/** Diary directory, per ZCODE_HOME. Created lazily on the first append. */
function diaryDir(): string {
  return path.join(zcodeHomeDir(), "cli", "log");
}

/** Today's diary file name (UTC date, matching the backend's own naming). */
function diaryFile(now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return path.join(diaryDir(), `zcode-acp-${day}.log`);
}

/** Diary enabled? Tests run under a hermetic HOME; guard via env like TUI. */
function diaryEnabled(): boolean {
  return !process.env.VITEST;
}

/**
 * Append one line to the daily diary. Best-effort by design: a read-only or
 * unwritable HOME must never turn a warning into a crash (the append runs
 * inside warn() on hot paths). First use creates the directory.
 */
export function appendDiary(line: string): void {
  if (!diaryEnabled()) return;
  try {
    const file = diaryFile();
    mkdirSync(diaryDir(), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // Unwritable diary (permissions, sandbox) — stderr alone must still work.
  }
}

/** Extract a printable reason (message + stack head) from anything thrown. */
export function describeError(reason: unknown): string {
  if (reason instanceof Error) {
    const stack = (reason.stack ?? "").split("\n").slice(0, 4).join(" | ");
    return `${reason.name}: ${reason.message}${stack ? ` @ ${stack}` : ""}`;
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/** Is this the "ACP client is gone" pipe break that should end the process? */
export function isStdoutPipeBreak(reason: unknown): boolean {
  const err = reason as { code?: unknown; message?: unknown } | undefined;
  const code = err?.code;
  if (code === "EPIPE") return true;
  return typeof err?.message === "string" && /\bEPIPE\b/i.test(err.message);
}

let installed = false;
/** Unhandled-rejection flood control: at most one stack per second, counted. */
let lastRejectLogAt = 0;
let suppressedRejects = 0;

/**
 * Install the process-wide guards. Idempotent. Call at the top of every
 * long-lived entry point (the stdio bridge, the serve bridge, the hub) BEFORE
 * any I/O — a rejection racing the install would still kill the process.
 */
export function installCrashGuards(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    const now = Date.now();
    if (now - lastRejectLogAt < 1000) {
      suppressedRejects++;
      return;
    }
    const skipped = suppressedRejects;
    suppressedRejects = 0;
    lastRejectLogAt = now;
    const line = `unhandled rejection (suppressed ${skipped} earlier): ` + describeError(reason);
    appendDiary(line);
    process.stderr.write(`[zcode-acp] ⚠ ${line}\n`);
  });

  process.on("uncaughtException", (err) => {
    if (isStdoutPipeBreak(err)) {
      // The ACP client is gone (window closed / TUI exited). Staying alive
      // would just leak the process and its hub registration.
      appendDiary(`exiting: stdout pipe closed (${describeError(err)})`);
      process.exit(0);
    }
    appendDiary(`uncaught exception: ${describeError(err)}`);
    process.stderr.write(`[zcode-acp] ⚠ uncaught exception: ${describeError(err)}\n`);
  });
}

/** Test seam: allow re-installing into a fresh listener set. */
export function resetCrashGuardsForTest(): void {
  installed = false;
}
