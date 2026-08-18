/**
 * ACP client I/O helpers — thin wrappers over the AgentContext (cx) that the
 * ACP SDK passes to each handler.
 *
 * The SDK exposes `cx.notify(method, params)` and `cx.request(method, params)`;
 * these helpers name the common notifications/requests we send and centralise
 * the JSON shape so handlers stay readable.
 */

import { randomUUID } from "node:crypto";

import type * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";

import type { ZcodeAcpServer } from "../server.js";
import { warn } from "../utils.js";

/**
 * Send a `session/update` notification to the client, serialized through the
 * per-session replay guard (see `enqueueSessionSend`).
 */
export function sendSessionUpdate(
  cx: acp.AgentContext,
  sessionId: string,
  update: acp.SessionUpdate,
): Promise<void> {
  return enqueueSessionSend(sessionId, () => cx.notify("session/update", { sessionId, update }));
}

/** Per-session replay guard: a FIFO chain of notification sends. */
interface ReplayGuard {
  tail: Promise<void>;
}
const replayGuards = new Map<string, ReplayGuard>();

/** Append a job to a guard's chain; a rejected job never breaks later sends. */
function enqueue(guard: ReplayGuard, job: () => Promise<void>): Promise<void> {
  const run = guard.tail.then(job);
  guard.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Run one client-notification send through the per-session replay guard:
 * while a replay batch (`withReplayBatch`) is in flight for this session, the
 * send queues behind it so a batch is never interleaved with live updates —
 * this applies to background-task emissions too, not just handler dispatch.
 * Sessions that never replay take the lock-free fast path.
 */
export function enqueueSessionSend(sessionId: string, send: () => Promise<void>): Promise<void> {
  const guard = replayGuards.get(sessionId);
  if (!guard) return send();
  return enqueue(guard, send);
}

/**
 * Run one replay batch for a session under exclusive use of its guard.
 * While the batch runs, `sendSessionUpdate` calls for the SAME session (live
 * turn dispatch) queue behind it; the batch's own sends go through
 * `replayMessages`, which notifies directly — that bypass is what makes the
 * batch atomic without a re-entrant lock. Concurrent batches serialize.
 */
export async function withReplayBatch<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  let guard = replayGuards.get(sessionId);
  if (!guard) {
    guard = { tail: Promise.resolve() };
    replayGuards.set(sessionId, guard);
  }
  // Take ownership: later senders (including other batches) chain behind us.
  const prev = guard.tail;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  guard.tail = held;
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Drop the entry when nobody chained behind us. enqueue and
    // withReplayBatch are synchronous up to their first await, so a concurrent
    // taker always swaps guard.tail before this check runs — no race window.
    if (replayGuards.get(sessionId) === guard && guard.tail === held) {
      replayGuards.delete(sessionId);
    }
  }
}

/** Send an `agent_message_chunk` text notification. */
export function sendTextChunk(
  cx: acp.AgentContext,
  sessionId: string,
  text: string,
  messageId: string,
): Promise<void> {
  return sendSessionUpdate(cx, sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    messageId,
  });
}

/**
 * Echo an incoming `session/prompt` to every OTHER client as a
 * `user_message_chunk`. ACP clients render their own outgoing prompt locally
 * and never re-broadcast it, so without this echo a turn driven from one
 * client (editor tab or remote attach) shows up on the others without the
 * user message that started it. The prompting client is excluded — it would
 * render the echo as a duplicate of what it already appended. Fire-and-forget;
 * best-effort (failures warn and never break the prompt).
 */
export function echoUserPromptToOthers(
  server: ZcodeAcpServer,
  prompter: acp.AgentContext,
  params: { sessionId: string; prompt: acp.PromptRequest["prompt"] },
): void {
  const blocks = Array.isArray(params.prompt)
    ? params.prompt
    : [{ type: "text", text: params.prompt }];
  const text = blocks
    .map((b) => (typeof b === "object" && b.type === "text" ? (b.text ?? "") : ""))
    .filter((t) => t.length > 0)
    .join("\n")
    .trim();
  if (!text) return;
  const messageId = `uprompt_${randomUUID()}`;
  void enqueueSessionSend(params.sessionId, () =>
    server.clients
      .notifyOthers(prompter, "session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text },
          messageId,
        },
      })
      .catch((e: unknown) => {
        warn(
          `user-prompt echo failed (sid=${params.sessionId}): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }),
  );
}

/** Shape of a slash command entry (matches ACP's AvailableCommand). */
interface SlashCommandEntry {
  name: string;
  description: string;
  input?: { hint: string };
}

/** Send an `available_commands_update` notification listing our slash commands. */
export function sendAvailableCommands(
  cx: acp.AgentContext,
  sessionId: string,
  commands: ReadonlyArray<SlashCommandEntry>,
): Promise<void> {
  return sendSessionUpdate(cx, sessionId, {
    sessionUpdate: "available_commands_update",
    availableCommands: commands.map((c) => {
      const out: { name: string; description: string; input?: { hint: string } } = {
        name: c.name,
        description: c.description,
      };
      if (c.input) out.input = c.input;
      return out;
    }),
  });
}

/**
 * Per-session pending deferred-notification timeouts. Tracks the timers from
 * repeated `sendAvailableCommandsDeferred` calls so a newer call can cancel
 * the older call's still-pending timers. Without this, a slow timer (e.g.
 * the 1000ms fire from an earlier session/load) could fire AFTER a newer
 * call's 50ms fire, overwriting the newer command list with the stale one.
 */
const activeDeferredTimeouts = new Map<string, Set<ReturnType<typeof setTimeout>>>();

/**
 * Send `available_commands_update` after a short delay so it lands after the
 * session response. ACP clients initialize their session state machine on the
 * response; a notification arriving earlier can be dropped, leaving the `/`
 * completion menu empty.
 *
 * The notification is fired three times (50ms / 300ms / 1000ms) to cover slow
 * client warm-up: on a fresh Zed tab the session view may still be initialising
 * at the 50ms mark, dropping the first notification. `available_commands_update`
 * is overwrite-semantics (not additive), so repeats are harmless — the client
 * keeps the latest snapshot. Fire-and-forget (returns void).
 *
 * Each call cancels any still-pending timers from a prior call for the same
 * session, so a rapid sequence (e.g. load then resume) can't have an old
 * timer overwrite the newest command list.
 */
export function sendAvailableCommandsDeferred(
  cx: acp.AgentContext,
  sessionId: string,
  commands: ReadonlyArray<SlashCommandEntry>,
): void {
  // Cancel any pending timers from a previous call so the stale command list
  // can't overwrite the one we're about to schedule.
  const prev = activeDeferredTimeouts.get(sessionId);
  if (prev) {
    for (const t of prev) clearTimeout(t);
    prev.clear();
  }
  const active = new Set<ReturnType<typeof setTimeout>>();
  activeDeferredTimeouts.set(sessionId, active);

  for (const delay of [50, 300, 1000]) {
    const t = setTimeout(() => {
      sendAvailableCommands(cx, sessionId, commands)
        .catch((e) => {
          warn(
            `available_commands_update failed (sid=${sessionId}, delay=${delay}): ` +
              `${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          active.delete(t);
          // Drop the session entry once all three fires have settled, so the
          // map doesn't retain empty Sets. Only delete if still ours — a newer
          // call may have replaced the entry.
          if (active.size === 0 && activeDeferredTimeouts.get(sessionId) === active) {
            activeDeferredTimeouts.delete(sessionId);
          }
        });
    }, delay);
    // unref so shutdown is not held up by this deferred notification.
    t.unref?.();
    active.add(t);
  }
}

/** Throw a JSON-RPC error from a handler (the SDK converts it to an error response). */
export function throwError(code: number, message: string): never {
  throw new RequestError(code, message);
}

/** Server instance attached to the running agent (set by index.ts on connect). */
export interface ServerHolder {
  server: ZcodeAcpServer;
}
