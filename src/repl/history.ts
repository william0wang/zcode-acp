/**
 * Per-project prompt history (ADR-0008): JSONL at
 * ~/.zcode/acp/repl-history/<sha1(cwd)>.jsonl, one submitted line per JSON
 * string. Pure fs-in/file-fs-out helpers — the entry list itself lives in
 * run.ts's external store, so Ctrl-L repaints and session swaps never lose
 * it. The reader is tolerant: malformed lines are skipped, never fatal.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Entries kept per project; enforced on load (truncate-rewrite) and save. */
export const HISTORY_MAX = 500;

/** Absolute path of this project's history file. */
export function historyPath(cwd: string): string {
  const digest = createHash("sha1").update(cwd).digest("hex");
  return join(homedir(), ".zcode", "acp", "repl-history", `${digest}.jsonl`);
}

/**
 * Read and parse a history file, oldest first. Bad lines are dropped;
 * when the file grew past HISTORY_MAX it is rewritten with the newest tail
 * so the cap holds without a separate maintenance pass.
 */
export function loadHistory(filePath: string, max = HISTORY_MAX): string[] {
  if (!existsSync(filePath)) return [];
  let entries: string[] = [];
  try {
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "string" && parsed.trim()) entries.push(parsed);
      } catch {
        // torn write / manual edit — skip the line
      }
    }
  } catch {
    return []; // unreadable file: start fresh rather than crash the REPL
  }
  if (entries.length > max) {
    entries = entries.slice(-max);
    saveHistory(filePath, entries, max);
  }
  return entries;
}

/** Persist the whole list (≤ max entries), creating the directory once. */
export function saveHistory(filePath: string, entries: readonly string[], max = HISTORY_MAX): void {
  const tail = entries.slice(-max);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      tail.map((line) => JSON.stringify(line)).join("\n") + (tail.length ? "\n" : ""),
    );
  } catch {
    // best-effort persistence: an unwritable home dir must not break submits
  }
}

/**
 * Pure consecutive-duplicate suppression: resubmitting the recalled newest
 * entry (or mashing enter on the same line) must not spam the file.
 */
export function pushHistory(entries: readonly string[], text: string): string[] {
  if (!text.trim()) return [...entries];
  if (entries[entries.length - 1] === text) return [...entries];
  return [...entries, text];
}
