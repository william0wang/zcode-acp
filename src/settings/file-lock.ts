/**
 * Cross-process file lock — the same protocol the ZCode desktop app uses.
 *
 * The settings API writes config files the desktop app also writes. An atomic
 * rename makes each individual write safe, but it does NOT make two writers
 * mutually exclusive: a settings write that lands while the app is writing the
 * same file silently discards the app's change. Sharing the app's lock is the
 * only way to avoid that, so this module re-implements its protocol exactly
 * (ADR-0026):
 *
 *   - lock directory `<path>.lock`, created with `mkdir` (atomic on POSIX)
 *   - one `owner-<pid>-<ts>-<rand>.json` per holder, written `wx`
 *   - a holder is authoritative only while its own owner file is the sole
 *     entry and the directory identity (dev+ino) has not changed
 *   - stale reclaim: owner pid no longer alive, or an ownerless lock past the
 *     grace window. Never steal from a live holder.
 *
 * Timestamps in owner files are validated against a clock-skew ceiling so a
 * malformed or future-dated `createdAt` cannot keep a lock permanently
 * unreclaimable.
 *
 * Everything is best-effort in the caller's favour: reaching the wait cap
 * throws a lock-timeout error rather than deleting a newer writer's lock.
 */

import { mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Retry ladder while waiting for a contended lock (ms, last value repeats). */
const LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
/** How long an ownerless lock (no pid) must sit before it is considered stale. */
const DEFAULT_OWNERLESS_GRACE_MS = 100;
/** Total wait before giving up. Mirrors the upstream's 8s. */
const DEFAULT_MAX_WAIT_MS = 8_000;
/** Timestamps further in the future than this are treated as unusable. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface FileLockOptions {
  lockRetryDelaysMs?: readonly number[];
  lockOwnerlessGraceMs?: number;
  lockMaxWaitMs?: number;
}

/** Error code for a lock that could not be acquired within the wait cap. */
export const FILE_LOCK_TIMEOUT_ERROR_CODE = "ZCODE_FILE_LOCK_TIMEOUT";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isFileExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

interface LockMetadata {
  createdAt: number | null;
  pid: number | null;
}

/**
 * A usable timestamp: finite, non-negative, not beyond the skew ceiling. A
 * garbage `createdAt` makes the caller fall back to the file's mtime.
 */
function parseLockTimestamp(value: unknown, observedAt: number): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value) || value < 0) return null;
  if (value > observedAt + MAX_CLOCK_SKEW_MS) return null;
  return value;
}

function parseLockMetadata(raw: string, observedAt: number): LockMetadata {
  try {
    const parsed = JSON.parse(raw) as { createdAt?: unknown; pid?: unknown };
    return {
      createdAt: parseLockTimestamp(parsed.createdAt, observedAt),
      // Only a positive safe integer carries owner semantics: 0, negatives and
      // fractions reach process.kill as junk and a dead lock would look alive.
      pid:
        typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
          ? parsed.pid
          : null,
    };
  } catch {
    return { createdAt: null, pid: null };
  }
}

/** `process.kill(pid, 0)` liveness probe; EPERM means the process exists. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function isOwnerFileReclaimable(
  ownerFile: string,
  ownerlessGraceMs: number,
  observedAt: number,
): Promise<boolean> {
  const raw = await readFile(ownerFile, "utf-8");
  const metadata = parseLockMetadata(raw, observedAt);
  let createdAt = metadata.createdAt;
  if (createdAt === null) {
    const ownerStat = await stat(ownerFile);
    createdAt = parseLockTimestamp(ownerStat.mtimeMs, observedAt) ?? observedAt;
  }
  const ownerExited = metadata.pid !== null && !isProcessAlive(metadata.pid);
  const ownerlessLockIsStale = metadata.pid === null && observedAt - createdAt >= ownerlessGraceMs;
  return ownerExited || ownerlessLockIsStale;
}

interface RemovalAttempt {
  removed: boolean;
  error?: unknown;
}

/**
 * Reclaim an abandoned lock. Conservative by construction: it only removes
 * entries it has positively determined to be stale, and any read/stat failure
 * reads as "not removed" so the caller keeps waiting instead of destroying a
 * lock it does not understand.
 */
async function removeAbandonedLock(
  lockFile: string,
  ownerlessGraceMs: number,
): Promise<RemovalAttempt> {
  const observedAt = Date.now();
  try {
    const lockStat = await stat(lockFile);
    if (lockStat.isDirectory()) {
      const entries = await readdir(lockFile);
      const owners = entries.filter((e) => e.startsWith("owner-") && e.endsWith(".json"));
      if (owners.length === 1) {
        // A single owner file is the ownership check: deleting it plus the
        // directory can only ever reclaim that holder's lock.
        if (
          !(await isOwnerFileReclaimable(join(lockFile, owners[0]!), ownerlessGraceMs, observedAt))
        ) {
          return { removed: false };
        }
        await rm(join(lockFile, owners[0]!), { force: true });
        await rmdir(lockFile);
        return { removed: true };
      }

      const directoryTimestamp = parseLockTimestamp(lockStat.mtimeMs, observedAt) ?? observedAt;
      if (observedAt - directoryTimestamp < ownerlessGraceMs) {
        return { removed: false };
      }
      for (const owner of owners) {
        if (!(await isOwnerFileReclaimable(join(lockFile, owner), ownerlessGraceMs, observedAt))) {
          return { removed: false };
        }
      }
      // An empty directory (crash between mkdir and owner write) or a corrupt
      // directory with several owners. Only the entries observed as stale are
      // removed; a concurrent new owner makes the rmdir fail harmlessly.
      await Promise.all(entries.map((e) => rm(join(lockFile, e), { force: true })));
      await rmdir(lockFile);
      return { removed: true };
    }

    // Legacy single-file lock from before the directory form. Re-read before
    // deleting so a lock replaced meanwhile is not the one removed.
    const raw = await readFile(lockFile, "utf-8");
    if (!(await isOwnerFileReclaimable(lockFile, ownerlessGraceMs, observedAt))) {
      return { removed: false };
    }
    if ((await readFile(lockFile, "utf-8")) !== raw) return { removed: false };
    await rm(lockFile, { force: true });
    return { removed: true };
  } catch (error) {
    // ENOENT: somebody else already reclaimed it — retry the acquire.
    // ENOTEMPTY: a new owner appeared mid-sweep — keep waiting.
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTEMPTY") {
      return { removed: false };
    }
    return { removed: false, error };
  }
}

function createLockTimeoutError(filePath: string, waitedMs: number, cause?: unknown): Error {
  const error = new Error(
    `Timed out after ${waitedMs}ms waiting for the ZCode file lock: ${filePath}`,
  ) as Error & { code?: string; cause?: unknown };
  error.code = FILE_LOCK_TIMEOUT_ERROR_CODE;
  error.cause = cause;
  return error;
}

// Process-internal FIFO in front of the OS lock: dozens of in-process callers
// polling a directory lock is a thundering herd, and the back of the queue
// would keep hitting the wait cap long after the actual write finished.
const processFileLockTails = new Map<string, Promise<void>>();

/**
 * Run `operation` while holding ZCode's lock for `filePath`.
 *
 * @throws with code {@link FILE_LOCK_TIMEOUT_ERROR_CODE} when the lock could
 *         not be acquired within `lockMaxWaitMs`.
 */
export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const previousTail = processFileLockTails.get(filePath) ?? Promise.resolve();
  let releaseProcessQueue!: () => void;
  const currentTail = new Promise<void>((resolve) => {
    releaseProcessQueue = resolve;
  });
  processFileLockTails.set(filePath, currentTail);
  await previousTail;

  let releaseLock: (() => Promise<void>) | undefined;
  try {
    // The lock directory sits NEXT TO the file, so the parent must exist first
    // — `mkdir` of `<missing-dir>/x.lock` fails with ENOENT, which the acquire
    // loop would misread as a lost race.
    await mkdir(dirname(filePath), { recursive: true });
    releaseLock = await acquireFileLock(filePath, options);
    return await operation();
  } finally {
    try {
      await releaseLock?.();
    } finally {
      releaseProcessQueue();
      if (processFileLockTails.get(filePath) === currentTail) {
        processFileLockTails.delete(filePath);
      }
    }
  }
}

async function acquireFileLock(
  filePath: string,
  options: FileLockOptions,
): Promise<() => Promise<void>> {
  const lockFile = `${filePath}.lock`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ownerFile = join(lockFile, `owner-${token}.json`);
  const payload = `${JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    token,
  })}\n`;
  const startedAt = Date.now();
  const maxWaitMs = options.lockMaxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const ownerlessGraceMs = Math.min(
    Math.max(options.lockOwnerlessGraceMs ?? DEFAULT_OWNERLESS_GRACE_MS, 0),
    Math.max(Math.floor(maxWaitMs / 2), 0),
  );
  const retryDelaysMs = options.lockRetryDelaysMs ?? LOCK_RETRY_DELAYS_MS;
  let lastRemovalError: unknown;

  for (let attempt = 0; ; attempt += 1) {
    let createdLock = false;
    try {
      await mkdir(lockFile);
      createdLock = true;
      const createdLockStat = await stat(lockFile);
      await writeFile(ownerFile, payload, { encoding: "utf-8", flag: "wx" });
      const currentLockStat = await stat(lockFile);
      const currentOwners = (await readdir(lockFile)).filter(
        (e) => e.startsWith("owner-") && e.endsWith(".json"),
      );
      // Ownership re-validation after the writes: the directory must still be
      // the one we created and our owner file must be its only entry.
      if (
        currentLockStat.dev !== createdLockStat.dev ||
        currentLockStat.ino !== createdLockStat.ino ||
        currentOwners.length !== 1 ||
        currentOwners[0] !== `owner-${token}.json`
      ) {
        throw Object.assign(new Error("lock ownership changed during acquire"), {
          code: "EEXIST",
        });
      }
      return async () => {
        // Only ever remove our own owner file: a lock that has since been
        // taken over belongs to a different token and must survive.
        await rm(ownerFile, { force: true }).catch(() => {});
        await rmdir(lockFile).catch(() => {
          // best-effort cleanup — a new owner makes this fail harmlessly
        });
      };
    } catch (error) {
      if (createdLock) {
        await rm(ownerFile, { force: true }).catch(() => {});
        await rmdir(lockFile).catch(() => {});
      }
      const lostCreatedLock = createdLock && errorCode(error) === "ENOENT";
      if (!isFileExistsError(error) && !lostCreatedLock) {
        throw error;
      }

      // How long WE have waited proves nothing about whether the CURRENT lock
      // is stale, so the wait cap is a hard stop: reaching it times out rather
      // than sweeping a lock a newer writer may have just installed.
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= maxWaitMs) {
        const removalErrorCode = errorCode(lastRemovalError);
        if (removalErrorCode === "EACCES" || removalErrorCode === "EPERM") {
          throw lastRemovalError;
        }
        throw createLockTimeoutError(filePath, elapsedMs, error);
      }

      const removalAttempt = await removeAbandonedLock(lockFile, ownerlessGraceMs);
      if (removalAttempt.removed) continue;
      if (removalAttempt.error !== undefined) lastRemovalError = removalAttempt.error;

      const remainingMs = Math.max(maxWaitMs - elapsedMs, 0);
      if (retryDelaysMs.length === 0 || remainingMs === 0) {
        const removalErrorCode = errorCode(lastRemovalError);
        if (removalErrorCode === "EACCES" || removalErrorCode === "EPERM") {
          throw lastRemovalError;
        }
        throw createLockTimeoutError(filePath, elapsedMs, lastRemovalError ?? error);
      }
      const retryDelayMs =
        retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? remainingMs;
      await sleep(Math.min(retryDelayMs, remainingMs));
    }
  }
}
