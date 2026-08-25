/**
 * Pure REPL turn state machine: folds ACP SessionUpdate notifications for one
 * prompt turn into renderable entries. No React, no I/O — exported for unit
 * tests.
 *
 * Chunk ordering follows what the bridge emits per turn: thought chunks and
 * message chunks arrive interleaved as streams (buffered until the stream
 * switches), tool calls arrive as discrete events keyed by toolCallId, and a
 * tool_call_update may later change only the status of an existing row.
 */

import type { SessionUpdate } from "@agentclientprotocol/sdk";

/** Alias so tests can build fixtures without importing SDK types directly. */
export type SessionUpdateLike = SessionUpdate;

/** One rendered line (or block) in the transcript. */
export type ReplEntry =
  | { kind: "user"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id?: string; title: string; status: string }
  | { kind: "note"; text: string };

/** Live snapshot of a turn in progress (null textBuf/thinkBuf = not streaming). */
export interface TurnState {
  entries: ReplEntry[];
  textBuf: string;
  thinkBuf: string;
}

export function createTurnState(): TurnState {
  return { entries: [], textBuf: "", thinkBuf: "" };
}

/** Extract displayable text from any content block shape (text/thought). */
function blockText(content: unknown): string {
  if (content && typeof content === "object" && "text" in content) {
    const t = (content as { text?: unknown }).text;
    return typeof t === "string" ? t : "";
  }
  return "";
}

/**
 * Apply one update to the live turn state. Returns a NEW state object (safe
 * for React-style always-replace updates). Unknown update kinds are ignored.
 */
export function applyUpdate(state: TurnState, update: SessionUpdate): TurnState {
  const next: TurnState = {
    entries: state.entries,
    textBuf: state.textBuf,
    thinkBuf: state.thinkBuf,
  };
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const chunk = blockText(update.content);
      // A message chunk after thinking means the thought stream ended — flush
      // it as its own dim entry before the prose starts.
      if (chunk && next.thinkBuf) {
        next.entries = [...next.entries, { kind: "thinking", text: next.thinkBuf.trim() }];
        next.thinkBuf = "";
      }
      next.textBuf = next.textBuf + chunk;
      return next;
    }
    case "agent_thought_chunk": {
      next.thinkBuf = next.thinkBuf + blockText(update.content);
      return next;
    }
    case "tool_call":
    case "tool_call_update": {
      const id = update.toolCallId ?? "";
      const title = update.title ?? id;
      const status = update.status ?? "pending";
      const idx = next.entries.findIndex((e) => e.kind === "tool" && e.id === id && id !== "");
      // tool_call_update may arrive for a call we never saw (pre-turn replay
      // leftovers); render it as a fresh row instead of dropping it.
      if (idx >= 0) {
        const old = next.entries[idx]!;
        if (old.kind === "tool") {
          const entries = [...next.entries];
          entries[idx] = { kind: "tool", id, title: update.title ?? old.title, status };
          next.entries = entries;
        }
      } else {
        next.entries = [...next.entries, { kind: "tool", id, title, status }];
      }
      return next;
    }
    case "plan": {
      // First version renders plans as a one-line note; full plan UI is a
      // follow-up. Counts entries when the shape provides them.
      const items = Array.isArray(update.entries) ? update.entries.length : 0;
      next.entries = [
        ...next.entries,
        { kind: "note", text: items > 0 ? `plan · ${items} steps` : "plan updated" },
      ];
      return next;
    }
    default:
      return next;
  }
}

/**
 * Close out a turn: flush any pending thought/text buffers as final entries
 * and append the stop-reason note. Returns only the finished entries — the
 * turn state is discarded afterwards.
 */
export function finishTurn(state: TurnState, stopReason?: string): ReplEntry[] {
  const entries = [...state.entries];
  if (state.thinkBuf.trim()) entries.push({ kind: "thinking", text: state.thinkBuf.trim() });
  if (state.textBuf.trim()) entries.push({ kind: "assistant", text: state.textBuf.trim() });
  if (stopReason && stopReason !== "end_turn") {
    entries.push({ kind: "note", text: `stopped: ${stopReason}` });
  }
  return entries;
}

/** REPL meta-commands. Everything else is a prompt. */
export type ReplCommand = "exit" | null;

export function parseCommand(text: string): ReplCommand {
  const t = text.trim();
  if (t === "/exit" || t === "/quit" || t === "/q") return "exit";
  return null;
}

/**
 * Segment a bulk stdin event (paste, scripted pty) that embeds CR/LF. Ink maps
 * only a LONE \r to key.return, so a multi-line write arrives as one printable
 * event. The first segment completes the in-progress line (`value` prefix);
 * every middle segment submits standalone; the final segment stays buffered as
 * the new in-progress line. Empty submits are dropped by the caller's trim.
 */
export function splitBulkInput(
  value: string,
  input: string,
): { submits: string[]; buffer: string } {
  const parts = input.split(/[\r\n]+/);
  const submits = [value + (parts[0] ?? "")];
  for (let i = 1; i < parts.length - 1; i++) {
    submits.push(parts[i] ?? "");
  }
  return { submits, buffer: (parts[parts.length - 1] ?? "").replace(/[\r\n]/g, "") };
}
