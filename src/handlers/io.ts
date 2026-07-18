/**
 * ACP client I/O helpers — thin wrappers over the AgentContext (cx) that the
 * ACP SDK passes to each handler.
 *
 * The SDK exposes `cx.notify(method, params)` and `cx.request(method, params)`;
 * these helpers name the common notifications/requests we send and centralise
 * the JSON shape so handlers stay readable.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";

import type { ZcodeAcpServer } from "../server.js";
import { warn } from "../utils.js";

/** Send a `session/update` notification to the client. */
export function sendSessionUpdate(
  cx: acp.AgentContext,
  sessionId: string,
  update: acp.SessionUpdate,
): Promise<void> {
  return cx.notify("session/update", { sessionId, update });
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
 */
export function sendAvailableCommandsDeferred(
  cx: acp.AgentContext,
  sessionId: string,
  commands: ReadonlyArray<SlashCommandEntry>,
): void {
  for (const delay of [50, 300, 1000]) {
    const t = setTimeout(() => {
      sendAvailableCommands(cx, sessionId, commands).catch((e) => {
        warn(
          `available_commands_update failed (sid=${sessionId}, delay=${delay}): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }, delay);
    // unref so shutdown is not held up by this deferred notification.
    t.unref?.();
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
