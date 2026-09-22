/**
 * Locked, validated, backed-up JSON writes for the app-owned config files.
 *
 * Four invariants, in order (ADR-0026):
 *
 *  1. **Cross-process mutual exclusion.** Every write holds ZCode's own file
 *     lock, so a settings write never discards a change the desktop app is
 *     making at the same moment.
 *  2. **Read-modify-write, never rewrite.** The mutator receives the parsed
 *     current document and returns the next one, so keys this module knows
 *     nothing about survive byte-for-byte. The same file carries skills, MCP,
 *     hooks, plugins and agent-runtime settings owned by different writers.
 *  3. **Self-validation before the bytes land.** `validate(encode(next))`
 *     must succeed; a candidate that cannot round-trip is refused, because the
 *     failure mode otherwise is the backend silently degrading to an empty
 *     overlay while the user watches their models disappear.
 *  4. **Backup then atomic rename.** The previous content is copied to
 *     `<file>.bak-<timestamp>` (newest 5 kept) before a temp file is renamed
 *     over the target. A crash mid-write leaves either the old file or the new
 *     one, never a torn document.
 *
 * A corrupt existing file REFUSES the write instead of being treated as `{}`:
 * silently rewriting a damaged document from an empty base would destroy
 * whatever is still recoverable in it.
 *
 * Scope of invariant 1, precisely: ZCode takes this lock for
 * `provider_config.json`, `credentials.json` and the builtin-provider config,
 * so those three are genuinely mutually excluded against a running desktop app.
 * `cli/config.json` is NOT locked by the app's own writer (it does a bare
 * temp+rename), so for that file the lock only excludes other BRIDGE
 * processes — concurrent edits still lose one side's change, exactly as they
 * do between the app's own multiple processes. Invariants 2-4 hold everywhere.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock, type FileLockOptions } from "./file-lock.js";
import { warn } from "../utils.js";

/** How many timestamped backups to keep per file. */
export const BACKUP_KEEP = 5;

/** Serialization for the config files this module owns: 2-space, trailing newline. */
export function encodeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Read + parse a config file.
 *
 * @returns the parsed document, or `null` when the file is absent.
 * @throws when the file exists but is not a JSON object — the caller must
 *         refuse the write rather than base it on an empty document.
 */
export async function readJsonDocument(file: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON — refusing to write (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object — refusing to write`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Scan a directory for `<basename>.bak-*` entries, newest first.
 *
 * `readdir` yields bare file names, so the prefix must be the BASENAME — an
 * absolute-path prefix never matches and the rotation silently keeps
 * everything. The stamp is a flattened ISO timestamp, whose lexicographic
 * order equals chronological order, so a string sort is the date sort.
 */
async function scanBackups(file: string): Promise<Array<{ name: string; path: string }>> {
  const dir = dirname(file);
  const prefix = `${basename(file)}.bak-`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // directory vanished — nothing to scan
  }
  return entries
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, path: join(dir, name) }))
    .sort((a, b) => (a.name < b.name ? 1 : -1)); // newest first
}

/** Rotate `<file>.bak-<ts>` copies down to {@link BACKUP_KEEP} newest. */
async function pruneBackups(file: string): Promise<void> {
  const backups = await scanBackups(file);
  for (const stale of backups.slice(BACKUP_KEEP)) {
    await rm(stale.path, { force: true }).catch(() => {});
  }
}

/**
 * Copy the current content aside before it is replaced.
 *
 * @returns the backup path, or undefined when there was nothing to back up or
 *          the copy failed (a failed backup never blocks the write itself).
 */
async function backupCurrent(file: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return undefined; // absent (or unreadable) — nothing worth backing up
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${file}.bak-${stamp}`;
  try {
    await writeFile(backupPath, raw, { encoding: "utf8", mode: 0o600 });
    await pruneBackups(file);
    return backupPath;
  } catch (error) {
    warn(
      `settings: backup of ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

export interface WriteJsonOptions extends FileLockOptions {
  /**
   * Serializer for the bytes that land on disk. Defaults to
   * {@link encodeJson} (2-space + trailing newline); pass a custom one for
   * files whose canonical form differs.
   */
  encode?: (doc: Record<string, unknown>) => string;
  /**
   * Round-trip check on the candidate document. Return `false` (or throw) to
   * refuse the write; nothing is backed up or renamed in that case.
   */
  validate?: (doc: Record<string, unknown>) => boolean | string;
  /** Skip the pre-write backup (used by the restore path, which re-backs-up). */
  skipBackup?: boolean;
}

export interface WriteJsonResult {
  /** The document actually written. */
  doc: Record<string, unknown>;
  /** Backup path taken before the write, when one existed. */
  backup?: string;
}

/**
 * Read-modify-write one config file under the file lock.
 *
 * @param mutator receives the parsed current document (an empty object when
 *        the file is absent) and returns the next document. Returning the same
 *        reference is a no-op that still validates and writes.
 * @throws on a corrupt existing file, a failed validation, or a lock timeout.
 */
export async function writeJsonAtomic(
  file: string,
  mutator: (
    current: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
  options: WriteJsonOptions = {},
): Promise<WriteJsonResult> {
  return withFileLock(
    file,
    async () => {
      const current = await readJsonDocument(file);
      const next = await mutator(current ?? {});
      const encoded = (options.encode ?? encodeJson)(next);
      if (options.validate) {
        const verdict = options.validate(next);
        if (verdict !== true) {
          throw new Error(
            typeof verdict === "string"
              ? `refusing to write ${file}: ${verdict}`
              : `refusing to write ${file}: validation failed`,
          );
        }
      }
      // Re-parse the encoded bytes: what lands on disk must decode back to the
      // same document, otherwise the writer and the reader disagree about the
      // file's meaning.
      const reparsed = JSON.parse(encoded) as unknown;
      if (typeof reparsed !== "object" || reparsed === null || Array.isArray(reparsed)) {
        throw new Error(`refusing to write ${file}: encoded document is not an object`);
      }

      const backup = options.skipBackup ? undefined : await backupCurrent(file);
      const dir = dirname(file);
      await mkdir(dir, { recursive: true });
      const temp = join(
        dir,
        `.${basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
      );
      try {
        await writeFile(temp, encoded, { encoding: "utf8", mode: 0o600 });
        await rename(temp, file);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      return { doc: next, ...(backup !== undefined ? { backup } : {}) };
    },
    options,
  );
}

/**
 * Write a non-JSON text file (agent markdown) atomically.
 *
 * The config files are JSON and go through `writeJsonAtomic`; agent markdown is
 * a different format but has the same crash-safety requirement — a plain
 * `writeFile` truncates in place, so a crash mid-write leaves a torn file with
 * no backup to recover from. Same shape as the JSON path minus the JSON encode
 * and validation: backup, temp file in the same directory, rename.
 *
 * No file lock: ZCode's own writer for `~/.zcode/agents/*.md` does not take the
 * config lock, so taking it here would buy mutual exclusion only against other
 * bridge processes while adding contention the app never has.
 */
export async function writeTextAtomic(
  file: string,
  content: string,
  options: { skipBackup?: boolean } = {},
): Promise<void> {
  if (!options.skipBackup) await backupCurrent(file);
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const temp = join(
    dir,
    `.${basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function basename(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

/** List the backups currently held for a config file, newest first. */
export async function listBackups(
  file: string,
): Promise<Array<{ path: string; createdAt: string }>> {
  const prefix = `${basename(file)}.bak-`;
  return (await scanBackups(file)).map(({ name, path: backupPath }) => ({
    path: backupPath,
    // The stamp is the ISO time with ':' and '.' flattened. Only the TIME part
    // used those separators — the date uses '-' natively — so rebuilding by
    // replacing every '-' would corrupt the date (`2026:09:22T…`). Restore the
    // time segments only.
    createdAt: backupStampToIso(name.slice(prefix.length)),
  }));
}

/**
 * Rebuild an ISO timestamp from the flattened backup stamp.
 *
 * `new Date().toISOString()` yields `2026-09-22T14:10:00.000Z`; the backup name
 * flattens `:` and `.` to `-`, giving `2026-09-22T14-10-00-000Z`. The date half
 * keeps its dashes, so only the trailing four segments are restored.
 */
export function backupStampToIso(stamp: string): string {
  const match = /^(.*T)(\d+)-(\d+)-(\d+)-(\d+)Z$/u.exec(stamp);
  if (!match) return stamp;
  return `${match[1]}${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}
