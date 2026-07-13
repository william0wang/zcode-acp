/**
 * Slash-command interception inside `session/prompt`.
 *
 * When the prompt text starts with `/`, dispatch the matching ZCode method
 * directly (compact/goal/fork/rewind/steer/model/mode/thought), emit a short
 * feedback `agent_message_chunk`, and return `end_turn` — never reaching the
 * normal turn loop. Unknown `/x` falls through to the model (extensibility).
 *
 * Commands handled by the ZCode backend (skill/init/code-review and other
 * plugin commands) are NOT intercepted here — they pass through to
 * `session/send` and the backend resolves them before the model sees them.
 *
 * Commands that require the ZCode TUI (plugins/login/logout/new/resume/
 * locale/expert/workflow/workflows/effort/help) return a friendly error
 * instead of passing raw text to the model (which would confuse it).
 *
 * `/mcp` lists all configured MCP servers (from config.json + plugins),
 * showing the user exactly what's available without needing the TUI.
 *
 * `/quota` is the exception: it does not call ZCode at all — it queries the
 * GLM Coding Plan usage API directly and renders the result.
 *
 * Returns the PromptResponse when intercepted, or null to let the caller run a
 * normal turn.
 */

import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";

import { RequestError } from "@agentclientprotocol/sdk";
import { applyModelSwitch } from "../config/runtime-model.js";
import { emitConfigOptionUpdate } from "../config/options.js";
import { formatMcpServers, loadMcpServers } from "../config/mcp-discovery.js";
import { formatQuota, queryQuota } from "../quota/index.js";
import { CONFIG_DISPATCH, warn } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";
import { sendTextChunk } from "./io.js";
import { compact, fork, rewind, steer } from "./extensions.js";

/**
 * ZCode built-in commands that require the TUI command center or interactive
 * UI (selection panels, login flows, etc.). They cannot work in app-server
 * mode, so we return a friendly error instead of passing raw `/cmd` text to
 * the model (which would produce confusing output).
 */
const UNSUPPORTED_TUI_COMMANDS = new Set([
  "plugins",
  "login",
  "logout",
  "new",
  "resume",
  "locale",
  "expert",
  "workflow",
  "workflows",
  "effort",
  "help",
]);

/**
 * Commands resolved by the ZCode backend's `customCommandPromptResolver` or
 * `executeTurn` before the model sees them. They pass through to
 * `session/send` as-is. Used to decide whether to intercept or pass through.
 */
const PASSTHROUGH_COMMANDS = new Set([
  "skill",
  "init",
  // Plugin commands (code-review, android-dev, etc.) are also passthrough,
  // but since they're dynamic we don't list them here — unknown commands
  // fall through to return null (passthrough) by default.
]);

/** Try to intercept a slash command. Returns a PromptResponse when handled, null otherwise. */
export async function handleSlashCommand(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
  text: string,
): Promise<acp.PromptResponse | null> {
  const stripped = text.trim();
  if (!stripped.startsWith("/")) return null;

  const parts = stripped.slice(1).split(/\s(.*)/s);
  const cmd = (parts[0] ?? "").toLowerCase();
  const arg = (parts[1] ?? "").trim();
  const chunkMsgId = randomUUID();

  const feedback = async (msg: string): Promise<void> => {
    await sendTextChunk(cx, acpSid, msg, chunkMsgId);
  };

  const ok = async (msg: string): Promise<acp.PromptResponse> => {
    await feedback(msg);
    return { stopReason: "end_turn" };
  };

  try {
    switch (cmd) {
      case "quota": {
        // Does not touch ZCode — queries the GLM usage API directly. Always
        // returns a status line (success card or an error fallback), so this
        // never throws into the catch below under normal conditions.
        const result = await queryQuota();
        return ok(formatQuota(result));
      }
      case "mcp": {
        // Lists all configured MCP servers (from config.json + enabled plugins).
        // Does not touch ZCode — reads the same config the backend auto-loads.
        return ok(formatMcpServers(loadMcpServers()));
      }
      case "compact": {
        const result = (await compact(server, { sessionId: acpSid }, cx)) as {
          __lockTimeout?: boolean;
        };
        if (result.__lockTimeout) {
          // 300s elapsed but the lock never released — the backend may still be
          // compacting; the next prompt will hit "a prompt is already running".
          return ok(
            "⚠ compact timed out (300s), backend may still be processing — wait a bit before sending",
          );
        }
        return ok("✓ compacted conversation context");
      }
      case "goal": {
        if (!arg) throw new RequestError(-32602, "/goal requires a goal description");
        await server
          .ensureBackend()
          .request(
            server.nextId(),
            "session/goal",
            { sessionId: zcodeSid, action: "set", objective: arg },
            30000,
          );
        return ok(`✓ goal set: ${arg}`);
      }
      case "fork": {
        const result = (await fork(server, { sessionId: acpSid })) as {
          forkedSessionId?: string;
        };
        return ok(`✓ forked new session: ${result.forkedSessionId ?? "?"}`);
      }
      case "rewind": {
        await rewind(server, { sessionId: acpSid });
        return ok("✓ rewound workspace to checkpoint");
      }
      case "steer": {
        if (!arg) throw new RequestError(-32602, "/steer requires content");
        await steer(server, { sessionId: acpSid, content: arg });
        return ok("✓ appended instruction to the running turn");
      }
      case "model": {
        if (!arg) throw new RequestError(-32602, "/model requires a model id");
        const switchOk = await applyModelSwitch(server, zcodeSid, arg);
        if (!switchOk) throw new RequestError(-32603, `model switch failed for ${arg}`);
        return ok(`✓ model = ${arg}`);
      }
      case "mode":
      case "thought": {
        if (!arg) throw new RequestError(-32602, `/${cmd} requires an argument`);
        const dispatch = CONFIG_DISPATCH[cmd];
        if (!dispatch) throw new RequestError(-32602, `unknown /${cmd}`);
        const resp = await server
          .ensureBackend()
          .request(
            server.nextId(),
            dispatch.method,
            { sessionId: zcodeSid, [dispatch.paramKey]: arg },
            15000,
          );
        if (resp.error) throw new RequestError(-32603, `${cmd} failed: ${resp.error.message}`);
        // Notify the editor UI: emit config_option_update (+ current_mode_update
        // for mode). Without this the dropdown / mode indicator never reflects
        // the change — slash commands return end_turn and bypass the turn-
        // completion reconciliation in prompt().
        await emitConfigOptionUpdate(server, cx, acpSid, zcodeSid, cmd);
        if (cmd === "mode") server.lastMode.set(acpSid, arg);
        return ok(`✓ ${cmd} = ${arg}`);
      }
      default:
        // Known passthrough commands (skill/init/plugin commands) → let the
        // ZCode backend resolve them via customCommandPromptResolver or
        // executeTurn. Don't intercept.
        if (PASSTHROUGH_COMMANDS.has(cmd)) return null;
        // TUI-only commands → return a friendly error instead of passing
        // raw text to the model (which would confuse it).
        if (UNSUPPORTED_TUI_COMMANDS.has(cmd)) {
          return ok(`⚠ /${cmd} is not available in ACP mode (requires ZCode TUI)`);
        }
        // $-prefixed commands are discovered Skills (e.g. /$tdd). The $ is a
        // visual grouping marker for the editor's completion menu. Pass through
        // as-is — the model sees /$name and resolves it via the Skill tool.
        if (cmd.startsWith("$")) return null;
        // Truly unknown /x → don't intercept, send to the model as normal
        // text (extensibility — plugin commands or future commands).
        return null;
    }
  } catch (e) {
    warn(`  /${cmd} failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}
