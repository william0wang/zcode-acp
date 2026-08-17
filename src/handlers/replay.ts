/**
 * Tail replay kernel — slicing, cursor pagination, and the `session/load`
 * replay/`session/load_earlier` handlers (Proposal 0001 / ADR-0003).
 *
 * session/load replays history as session/update notifications; for long
 * sessions that cost is O(full history) on every attach and reconnect. The
 * helpers here slice the fetched messages into turn-aligned batches and page
 * backwards with an opaque cursor. Batches are sent under the per-session
 * replay lock (`withReplayBatch` in io.ts) so a batch never interleaves with
 * live-turn updates for the same session; `replayMessages` is the one sender
 * that bypasses the per-message lock — it only runs inside a batch.
 */

import { randomUUID } from "node:crypto";

import type * as acp from "@agentclientprotocol/sdk";

import type { ZcodeMessage, ZcodeMessagesResult } from "../backend/types.js";
import type { ZcodeAcpServer } from "../server.js";
import { log, warn } from "../utils.js";
import { throwError, withReplayBatch } from "./io.js";

/** Upper bound for a requested tail/page size (values above clamp to this). */
export const MAX_REPLAY_LIMIT = 500;
/** Page size for `session/load_earlier` when the request omits `limit`. */
export const DEFAULT_EARLIER_LIMIT = 50;

/** Wire metadata describing one delivered batch (additive-only over time). */
export interface ReplayMeta {
  cursor: string;
  hasMore: boolean;
  replayedMessages: number;
  replayedTurns: number;
  totalMessages: number;
  totalTurns: number;
}

export interface ReplaySlice {
  batch: ZcodeMessage[];
  meta: ReplayMeta;
}

/** `session/load_earlier` params (top-level — our parser, not an ACP spec method). */
export interface LoadEarlierParams {
  sessionId: string;
  before?: string;
  limit?: number;
}

interface CursorPayload {
  v: 1;
  id?: string;
  index: number;
  totalTurns: number;
}

/**
 * Indices where a turn starts: every user message, plus 0 so leading
 * non-user messages (system preambles) belong to the first turn.
 */
function turnStarts(messages: ZcodeMessage[]): number[] {
  const starts: number[] = messages.length > 0 ? [0] : [];
  messages.forEach((m, i) => {
    if (m.info?.role === "user" && i > 0) starts.push(i);
  });
  return starts;
}

/** Count of turn starts inside [start, end). */
function turnsInRange(starts: number[], start: number, end: number): number {
  return starts.filter((s) => s >= start && s < end).length;
}

function encodeCursor(messages: ZcodeMessage[], index: number, totalTurns: number): string {
  const anchor = messages[index]?.info?.id;
  const payload: CursorPayload = { v: 1, index, totalTurns };
  if (anchor) payload.id = anchor;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(before: string): CursorPayload {
  try {
    const raw = JSON.parse(Buffer.from(before, "base64url").toString("utf8")) as CursorPayload;
    if (
      raw?.v !== 1 ||
      !Number.isInteger(raw.index) ||
      raw.index < 0 ||
      !Number.isInteger(raw.totalTurns)
    ) {
      throw new Error("bad shape");
    }
    return raw;
  } catch {
    // Garbage or foreign cursors are indistinguishable from expired ones.
    return throwError(-32602, "cursor expired");
  }
}

function buildSlice(
  messages: ZcodeMessage[],
  starts: number[],
  start: number,
  end: number,
): ReplaySlice {
  const totalTurns = starts.length;
  return {
    batch: messages.slice(start, end),
    meta: {
      cursor: encodeCursor(messages, start, totalTurns),
      hasMore: start > 0,
      replayedMessages: end - start,
      replayedTurns: turnsInRange(starts, start, end),
      totalMessages: messages.length,
      totalTurns,
    },
  };
}

/** The greatest turn start at or before `pos` (0 when none — starts include 0). */
function alignToTurnStart(starts: number[], pos: number): number {
  let aligned = 0;
  for (const s of starts) {
    if (s <= pos) aligned = s;
    else break;
  }
  return aligned;
}

function clampLimit(limit: number): number {
  return Math.max(0, Math.min(Math.floor(limit), MAX_REPLAY_LIMIT));
}

/**
 * Slice the last `limit` messages, aligned back to the start of the turn
 * containing the oldest one — never a mid-turn cut. `limit: 0` attaches with
 * metadata only (cursor anchors at the end of history).
 */
export function sliceTail(messages: ZcodeMessage[], limit: number): ReplaySlice {
  const starts = turnStarts(messages);
  const clamped = clampLimit(limit);
  if (clamped === 0) {
    // Metadata-only attach: an empty batch whose cursor anchors at the end of
    // history, so load_earlier pages the whole tail.
    return buildSlice(messages, starts, messages.length, messages.length);
  }
  if (clamped >= messages.length) return buildSlice(messages, starts, 0, messages.length);
  const start = alignToTurnStart(starts, messages.length - clamped);
  return buildSlice(messages, starts, start, messages.length);
}

/** Full-history slice (no `_meta.zcode.limit` on session/load). */
export function fullSlice(messages: ZcodeMessage[]): ReplaySlice {
  return buildSlice(messages, turnStarts(messages), 0, messages.length);
}

/**
 * Slice up to `limit` messages strictly older than the `before` cursor.
 * The cursor points into a prefix of history, so turns appended after it was
 * minted keep it valid; only a history that shrank (compaction/truncation)
 * throws `cursor expired` — clients map that to a full re-`session/load`.
 */
export function sliceBefore(messages: ZcodeMessage[], before: string, limit: number): ReplaySlice {
  const starts = turnStarts(messages);
  const cur = decodeCursor(before);
  if (cur.index > messages.length || cur.totalTurns > starts.length) {
    return throwError(-32602, "cursor expired");
  }
  if (cur.id != null && cur.index < messages.length && messages[cur.index].info?.id !== cur.id) {
    return throwError(-32602, "cursor expired");
  }
  const end = cur.index;
  if (end === 0) return buildSlice(messages, starts, 0, 0);
  const clamped = clampLimit(limit);
  const start = clamped === 0 ? end : alignToTurnStart(starts, Math.max(0, end - clamped));
  return buildSlice(messages, starts, start, end);
}

/**
 * Read the tail limit from `session/load`'s `_meta.zcode.limit`. The SDK's
 * zod params schema strips unknown top-level keys, so bridge extensions ride
 * in `_meta` (ADR-0003). Returns null when absent/non-finite = full replay.
 */
export function readTailLimit(params: acp.LoadSessionRequest): number | null {
  const zcode = (params._meta as { zcode?: { limit?: unknown } } | undefined)?.zcode;
  const raw = zcode?.limit;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return clampLimit(raw);
}

/**
 * Drop duplicate entries the backend can return for the same message id
 * (observed in live session/messages payloads: the same id appears at
 * multiple, non-adjacent positions with identical content). Replaying every
 * copy makes clients render the same paragraph once per copy. Each id is
 * kept at its first (original) position with its latest (most recent)
 * content; id-less entries pass through untouched.
 */
function dedupeMessages(messages: ZcodeMessage[]): ZcodeMessage[] {
  const firstIndex = new Map<string, number>();
  const latest = new Map<string, ZcodeMessage>();
  messages.forEach((m, i) => {
    const id = m.info?.id;
    if (!id) return;
    if (!firstIndex.has(id)) firstIndex.set(id, i);
    latest.set(id, m);
  });
  if (firstIndex.size === messages.length) return messages;
  return messages
    .map((m, i) => {
      const id = m.info?.id;
      if (!id) return m;
      return firstIndex.get(id) === i ? (latest.get(id) ?? m) : null;
    })
    .filter((m): m is ZcodeMessage => m !== null);
}

/** Fetch session/messages from zcode (the bridge's only history source). */
export async function fetchMessages(
  server: ZcodeAcpServer,
  zcodeSid: string,
): Promise<ZcodeMessage[]> {
  const backend = server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    "session/messages",
    { sessionId: zcodeSid },
    8000,
  );
  if (resp.error) {
    // Swallowed on purpose (replay must not crash the load) — but loudly: a
    // silent empty here renders the whole conversation blank for the client.
    warn(`session/messages failed for ${zcodeSid}: ${resp.error.message ?? ""}`);
    return [];
  }
  const result = (resp.result ?? {}) as ZcodeMessagesResult;
  return dedupeMessages(result.messages ?? []);
}

/**
 * Strip harness-injected reminder plumbing from user text. The agent runtime
 * appends TodoWrite/Read usage nudges (with an optional todo-list dump) and
 * `<system-reminder>` blocks to user turns — they are not user speech, and
 * replaying them verbatim makes clients render them as user input.
 *
 * The nudges arrive in stored history WITHOUT tags (verified against live
 * session/messages payloads), so they are matched by their stable shape: a
 * fixed opening signature, a fixed closing sentence, and — when present — a
 * bracket-wrapped todo dump. Real user text before or after the block
 * survives; user messages that consist only of plumbing are dropped by the
 * caller's empty-check.
 */
function stripSystemReminders(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(
      /The (?:TodoWrite|Read) tool hasn't been used recently\.[\s\S]*?This is just a gentle reminder - ignore if not applicable\./g,
      "",
    )
    .replace(/Here (?:are|is)[^\n]*todo list:\s*\n\s*\n\[[\s\S]*?\](?=\n|$)/g, "")
    .trim();
}

/**
 * Harness context-handoff summaries ("This session is being continued from a
 * previous conversation…") are informative plumbing: replayed IN FULL but
 * flagged via `_meta.zcode.collapsed` so capable clients render them folded
 * behind an expand control instead of as a wall of pseudo-user text. Clients
 * that ignore `_meta` (e.g. Zed) display the text unchanged.
 */
const CONTEXT_HANDOFF = /^\s*This session is being continued from a previous conversation/;

function handoffMeta(): { zcode: { collapsed: true; kind: "context-handoff" } } {
  return { zcode: { collapsed: true, kind: "context-handoff" } };
}

/**
 * Replay messages as session/update notifications, oldest → newest.
 *
 * MUST run inside `withReplayBatch` for the session: this is the one sender
 * that bypasses the per-message lock in sendSessionUpdate (the batch already
 * holds it), which is what makes the batch atomic against live dispatch.
 */
export async function replayMessages(
  cx: acp.AgentContext,
  acpSid: string,
  messages: ZcodeMessage[],
): Promise<number> {
  let replayed = 0;
  for (const m of messages) {
    const info = m.info ?? {};
    const role = info.role;
    const mid = info.id ?? `hist_${randomUUID().slice(0, 12)}`;
    for (const p of m.parts ?? []) {
      if (!p || typeof p !== "object") continue;
      const ptype = (p as { type?: string }).type;
      if (ptype === "text") {
        let text = (p as { text?: string }).text ?? "";
        if (!text) continue;
        if (role === "user") {
          text = stripSystemReminders(text);
          if (!text) continue;
        }
        const collapsed = role === "user" && CONTEXT_HANDOFF.test(text);
        await cx.notify("session/update", {
          sessionId: acpSid,
          update: {
            sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
            content: { type: "text", text },
            messageId: mid,
          },
          ...(collapsed ? { _meta: handoffMeta() } : {}),
        });
      } else if (ptype === "reasoning") {
        const rp = p as { text?: string; content?: string };
        const text = rp.text ?? rp.content ?? "";
        if (text) {
          await cx.notify("session/update", {
            sessionId: acpSid,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text },
              messageId: `thought_${mid}`,
            },
          });
        }
      } else if (ptype === "tool") {
        const tp = p as {
          id?: string;
          tool?: string;
          title?: string;
          status?: string;
        };
        const title = tp.title ?? tp.tool ?? "tool call";
        const histToolName = tp.tool ?? "";
        await cx.notify("session/update", {
          sessionId: acpSid,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: tp.id ?? `histtool_${randomUUID().slice(0, 8)}`,
            title,
            kind: "other",
            status: (tp.status as acp.ToolCallStatus) ?? "completed",
            ...(histToolName ? { _meta: { claudeCode: { toolName: histToolName } } } : {}),
          },
        });
      }
      // patch / step-start / other: skipped (history replay focuses on text + tool summary)
    }
    replayed += 1;
  }
  return replayed;
}

/**
 * `session/load_earlier` — deliver one page of history strictly older than
 * the `before` cursor, oldest → newest (clients prepend). Requires the
 * session to already be attached in this bridge; pagination never triggers
 * an implicit backend resume.
 */
export async function loadEarlier(
  server: ZcodeAcpServer,
  params: LoadEarlierParams,
  cx: acp.AgentContext,
): Promise<{ replayMeta: ReplayMeta }> {
  const acpSid = params.sessionId;
  const zcodeSid = server.resolveSid(acpSid);
  if (!zcodeSid) {
    return throwError(-32602, "session not registered — attach via session/load first");
  }
  if (!params.before) return throwError(-32602, "before (cursor) required");

  const messages = await fetchMessages(server, zcodeSid);
  const slice = sliceBefore(messages, params.before, params.limit ?? DEFAULT_EARLIER_LIMIT);
  await withReplayBatch(acpSid, () => replayMessages(cx, acpSid, slice.batch));
  log(`session/load_earlier: ${slice.meta.replayedMessages} messages before cursor`);
  return { replayMeta: slice.meta };
}
