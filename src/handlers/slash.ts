/**
 * Slash-command interception inside `session/prompt`.
 *
 * When the prompt text starts with `/`, dispatch the matching ZCode method
 * directly (compact/goal/fork/model/mode/thought), emit a short
 * feedback `agent_message_chunk`, and return `end_turn` — never reaching the
 * normal turn loop.
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
 * Anything else starting with `/` is NOT a command: only the names advertised
 * in the editor's `/` completion menu (plus the passthrough built-ins above)
 * go the command route. Unknown `/x` is sent to the model as plain text via
 * {@link neutralizeSlashText} — the backend's command resolver must never see
 * it, because an unresolvable name can hard-fail the turn and wedge the
 * session (e.g. pasting a directory path like `/Users/me/project`).
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
import { loadPluginCommands } from "../config/plugin-commands.js";
import { loadSkillCommands } from "../config/skill-discovery.js";
import { messages } from "../i18n.js";
import { formatQuota, queryQuota } from "../quota/index.js";
import { CONFIG_DISPATCH, SLASH_COMMANDS, warn } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";
import { sendTextChunk } from "./io.js";
import { compact, fork, goal } from "./extensions.js";
import { listSessions, resumeIntoSession } from "./session.js";
import { askSessionPick, type SessionPickItem } from "./server-requests.js";

/** Rows offered by the /resume picker (newest first). */
const RESUME_PICK_LIMIT = 10;

/** `/resume` label: "title · YYYY-MM-DD HH:mm" (untitled sessions get a dash). */
function resumeLabel(
  title: string | null | undefined,
  updatedAt: string | null | undefined,
): string {
  const when = updatedAt ? updatedAt.slice(0, 16).replace("T", " ") : "?";
  return `${title && title.trim() ? title.trim() : "(untitled)"} · ${when}`;
}

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
  // but since they're dynamic we don't list them here — they join the known
  // set below via loadPluginCommands().
]);

/**
 * Command names the bridge treats as real commands: the static list advertised
 * in the `/` completion menu, backend-resolvable built-ins, TUI-only names
 * (which get a friendly error), and plugin commands. Built lazily on first
 * use (plugin commands don't change mid-session — same freshness as the
 * advertised list in index.ts) so importing this module does no fs work.
 */
let knownCommands: Set<string> | null = null;
function knownCommandSet(): Set<string> {
  if (!knownCommands) {
    const names = [
      ...SLASH_COMMANDS.map((c) => c.name),
      ...PASSTHROUGH_COMMANDS,
      ...UNSUPPORTED_TUI_COMMANDS,
      ...loadPluginCommands().map((c) => c.name),
      // Skills travel BOTH spellings: `$name` for grouping-capable editors
      // (Zed) and bare `name` for martty / the remote App (whose `/` menus
      // cannot match a `$`-prefixed name). Both are passthrough to the model.
      ...loadSkillCommands().flatMap((c) =>
        c.name.startsWith("$") ? [c.name, c.name.slice(1)] : [c.name],
      ),
    ];
    knownCommands = new Set<string>(names);
  }
  return knownCommands;
}

/** Whether `cmd` (already lowercased, no leading slash) is a real command. */
function isKnownCommand(cmd: string): boolean {
  // $-prefixed names are discovered Skills (e.g. /$tdd) — always passthrough.
  return cmd.startsWith("$") || knownCommandSet().has(cmd);
}

/**
 * Neutralise slash-command resolution for prompts that are NOT real commands.
 *
 * The backend parses any prompt whose trimmed text starts with `/` as a
 * command invocation (`name + args`), and an unresolvable name can fail the
 * whole turn. This helper decides the wire text for `/`-leading prompts:
 *   - known command → returned unchanged (the backend resolves it);
 *   - anything else (e.g. a pasted path `/Users/me/proj`) → prefixed with a
 *     zero-width space. U+200B survives the backend's trim(), so the
 * `^\/` command parse can never match, while the model sees the prompt
 *     verbatim (ZWSP is invisible and tokenizes as nothing).
 *
 * Non-slash prompts pass through unchanged.
 */
export function neutralizeSlashText(text: string): string {
  const stripped = text.trimStart();
  if (!stripped.startsWith("/")) return text;
  const parts = stripped.slice(1).split(/\s(.*)/s);
  const cmd = (parts[0] ?? "").toLowerCase();
  return isKnownCommand(cmd) ? text : `\u200B${text}`;
}

/**
 * Shared flow behind /auto and /goal: the bridge-driven goal loop
 * (ADR-0022). Returns the user-facing status message; the caller wraps it
 * in `ok()`.
 *
 * The first word is a subcommand ONLY when it is exactly one of the
 * keywords — anything else is free text (the objective). Trade-off: an
 * objective that genuinely starts with e.g. "stop the flaky test" cannot be
 * expressed and needs rewording; preferable to silently truncating the
 * first word of EVERY objective (the old parse).
 */
async function autoFlow(
  server: ZcodeAcpServer,
  acpSid: string,
  zcodeSid: string,
  arg: string,
  label: "auto" | "goal",
): Promise<string> {
  const { GoalLoopDriver } = await import("../goal-loop/driver.js");
  const { readGoalState } = await import("../goal-loop/state.js");
  const resumeHint = label === "goal" ? "/goal resume" : "/auto resume";
  const sub = arg.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (sub === "pause") {
    const live = GoalLoopDriver.live(server, zcodeSid);
    if (!live) return messages().goalPaused("not running");
    live.pause();
    return messages().goalPaused(`${label} pause requested — takes effect at the round boundary`);
  }
  // "clear" (backend-goal-mode parity: action=clear) is a stop alias — the
  // saved state is kept so an explicit resume is always deliberate.
  if (sub === "stop" || sub === "clear") {
    const live = GoalLoopDriver.live(server, zcodeSid);
    if (!live) return messages().goalStopped;
    live.stop();
    return messages().goalStopped;
  }
  if (sub === "resume") {
    const live = GoalLoopDriver.live(server, zcodeSid);
    if (live) {
      // A paused-but-still-registered driver (its current round has not
      // reached the boundary yet) must clear the pending pause — start()
      // would be a no-op and the pause would land anyway, swallowing the
      // resume. The flag is only consumed at the boundary, so this is
      // race-free by construction.
      live.resume();
    } else {
      const prior = readGoalState(server.projectCwd(), zcodeSid);
      if (!prior) {
        throw new RequestError(
          -32602,
          label === "goal" ? messages().slashErrGoalArg : messages().slashErrAutoArg,
        );
      }
      GoalLoopDriver.start(server, acpSid, zcodeSid, prior.objective, { resume: true });
    }
    return messages().slashAutoSet("resuming");
  }
  // No subcommand (or status) = status; free text = start a loop.
  if (!sub || sub === "status") {
    const live = GoalLoopDriver.live(server, zcodeSid);
    if (live) return live.statusText();
    const prior = readGoalState(server.projectCwd(), zcodeSid);
    if (prior) {
      return messages().goalPaused(`saved state: ${prior.objective} — ${resumeHint} to continue`);
    }
    throw new RequestError(
      -32602,
      label === "goal" ? messages().slashErrGoalArg : messages().slashErrAutoArg,
    );
  }
  GoalLoopDriver.start(server, acpSid, zcodeSid, arg);
  return label === "goal" ? messages().slashGoalSet(arg) : messages().slashAutoSet(arg);
}

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
          return ok(messages().slashCompactTimeout);
        }
        return ok(messages().slashCompacted);
      }
      case "goal": {
        // Route /goal through the bridge-driven loop (ADR-0022), same as
        // /auto. The legacy backend goal mode runs backend-internal turns
        // whose events the translator must drop (ghost-completed guard), so
        // ACP clients never saw goal progress — only "goal set" plus untyped
        // leaked events the client renders as "Other" (issue #178). The loop
        // is validated against the real backend now, so /goal shares the
        // /auto machinery. Escape hatch: ZCODE_ACP_GOAL_MODE=backend
        // restores the legacy backend goal mode.
        if (process.env.ZCODE_ACP_GOAL_MODE === "backend") {
          if (!arg) throw new RequestError(-32602, messages().slashErrGoalArg);
          await goal(server, { sessionId: acpSid, action: "set", objective: arg });
          return ok(messages().slashGoalSet(arg));
        }
        return ok(await autoFlow(server, acpSid, zcodeSid, arg, "goal"));
      }
      case "auto": {
        // Bridge-driven goal loop (ADR-0022).
        return ok(await autoFlow(server, acpSid, zcodeSid, arg, "auto"));
      }
      case "fork": {
        const result = (await fork(server, { sessionId: acpSid })) as {
          forkedSessionId?: string;
        };
        return ok(messages().slashForked(result.forkedSessionId ?? "?"));
      }
      case "resume": {
        // Candidate list: this thread's workspace, minus the live/running
        // sessions (an adopted conversation must be at rest) and the thread's
        // own session. `/resume <sessionId>` skips the popup and adopts that
        // id directly (still subject to the empty-thread guard).
        const cwd = server.sessionCwds.get(acpSid) ?? undefined;
        const { sessions } = await listSessions(server, { cwd });
        const running = new Set([...server.pendingTurns.values()].map((t) => t.zcodeSid));
        const currentSid = server.resolveSid(acpSid);
        const resumable = sessions
          .filter((s) => s.sessionId && s.sessionId !== currentSid && !running.has(s.sessionId))
          .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
        const target = arg ? (sessions.find((s) => s.sessionId === arg)?.sessionId ?? null) : null;
        if (arg && !target) throw new RequestError(-32602, messages().slashErrResumeArg(arg));
        let chosen: string | null = target ?? null;
        if (!chosen) {
          if (resumable.length === 0) return ok(messages().slashResumeNone);
          const items: SessionPickItem[] = resumable.slice(0, RESUME_PICK_LIMIT).map((s) => ({
            sessionId: s.sessionId,
            label: resumeLabel(s.title, s.updatedAt),
          }));
          const picked = await askSessionPick(server, cx, acpSid, items);
          if (!picked) return ok(messages().slashResumeCancelled);
          chosen = picked;
        }
        const result = await resumeIntoSession(server, cx, acpSid, chosen);
        if (!result.ok) return ok(result.error);
        return ok(messages().slashResumed(result.title ?? chosen));
      }
      case "model": {
        if (!arg) throw new RequestError(-32602, messages().slashErrModelArg);
        const switchOk = await applyModelSwitch(server, zcodeSid, arg);
        if (!switchOk) throw new RequestError(-32603, messages().slashErrSwitchFailed(arg));
        await emitConfigOptionUpdate(server, cx, acpSid, zcodeSid, "model");
        return ok(messages().slashModelSet(arg));
      }
      case "mode":
      case "thought": {
        if (!arg) throw new RequestError(-32602, messages().slashErrArg(cmd));
        const dispatch = CONFIG_DISPATCH[cmd];
        if (!dispatch) throw new RequestError(-32602, messages().slashErrUnknown(cmd));
        const resp = await server
          .ensureBackend()
          .request(
            server.nextId(),
            dispatch.method,
            { sessionId: zcodeSid, [dispatch.paramKey]: arg },
            15000,
          );
        if (resp.error) {
          throw new RequestError(-32603, messages().slashErrFailed(cmd, resp.error.message));
        }
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
          return ok(messages().slashTuiOnly(cmd));
        }
        // $-prefixed commands are discovered Skills (e.g. /$tdd). The $ is a
        // visual grouping marker for the editor's completion menu. Pass through
        // as-is — the model sees /$name and resolves it via the Skill tool.
        if (cmd.startsWith("$")) return null;
        // Plugin commands advertised in the completion menu (the remaining
        // known names at this point — static/TUI/passthrough were all consumed
        // above) → passthrough for the backend to resolve.
        if (knownCommandSet().has(cmd)) return null;
        // Unknown /x (not advertised, not a built-in — e.g. a pasted directory
        // path): NOT a command. Return null for the normal turn loop; the
        // caller runs the prompt through neutralizeSlashText() so the backend
        // never attempts command resolution on it.
        return null;
    }
  } catch (e) {
    warn(`  /${cmd} failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}
