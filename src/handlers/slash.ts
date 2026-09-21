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
 * showing the user exactly what's available without needing the TUI. When the
 * backend answers `mcp/list` (mode:"status"), the card is upgraded to live
 * per-server health (status / tool count / failureKind).
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
import { emitConfigOptionUpdate, rememberModelChoice } from "../config/options.js";
import {
  formatMcpServerHealth,
  formatMcpServers,
  loadMcpServers,
  type McpServerHealth,
} from "../config/mcp-discovery.js";
import { loadPluginCommands } from "../config/plugin-commands.js";
import { loadSkillCommands } from "../config/skill-discovery.js";
import { goalModeIsBackend } from "../config/settings.js";
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

/**
 * Wire text for `/`-leading prompts. Identity on 0.16.9 — see below.
 *
 * This used to prefix unknown `/x` prompts with a zero-width space, on the
 * reverse-engineered belief that the backend hard-fails a turn whose prompt
 * fails command resolution. The open-sourced runtime disproves that: command
 * parsing recognizes ONLY /compact, /fork, /rewind
 * (core/src/runtime/methods/turn.ts:105-106,240-267), and every other name
 * returns undefined from resolveZCodeCustomCommandPrompt — the input facade
 * then passes the ORIGINAL text to the model as a normal prompt, with no
 * half-expansion and no turn failure (bootstrap/src/custom-command-prompt.ts:31-44,
 * comment at :39-41). The ZWSP injection therefore only corrupted session
 * history and model input.
 *
 * Kept as the single seam where a legacy-build guard would live if a build
 * that DOES hard-fail unknown commands ever needs supporting again.
 */
export function neutralizeSlashText(text: string): string {
  return text;
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
  opts: { onStart?: (driver: unknown) => Promise<string> } = {},
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
  const driver = GoalLoopDriver.start(server, acpSid, zcodeSid, arg);
  if (opts.onStart && driver) return opts.onStart(driver);
  return label === "goal" ? messages().slashGoalSet(arg) : messages().slashAutoSet(arg);
}

/**
 * Fetch per-server MCP health from the backend `mcp/list` RPC with
 * `mode:"status"` (params `{workspace:{workspacePath, workspaceKey}}` —
 * workspace-level, no sessionId; result `statuses` keyed by server name).
 *
 * Best-effort: returns null on ANY failure (older backend answering -32601,
 * timeout, malformed result, empty status map) after at most one warn, and
 * the caller falls back to the local-discovery card unchanged.
 */
async function fetchMcpStatuses(
  server: ZcodeAcpServer,
  acpSid: string,
): Promise<Record<string, McpServerHealth> | null> {
  const cwd = server.sessionCwds.get(acpSid) ?? server.projectCwd();
  try {
    const resp = await server
      .ensureBackend()
      .request(
        server.nextId(),
        "mcp/list",
        { workspace: { workspacePath: cwd, workspaceKey: cwd }, mode: "status" },
        15000,
      );
    if (resp.error) {
      warn(`/mcp: mcp/list failed (${resp.error.message}) — using local discovery`);
      return null;
    }
    const raw = (resp.result as { statuses?: unknown } | null)?.statuses;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warn("/mcp: mcp/list returned no statuses — using local discovery");
      return null;
    }
    const out: Record<string, McpServerHealth> = {};
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const o = entry as Record<string, unknown>;
      const health: McpServerHealth = {
        status: typeof o["status"] === "string" ? o["status"] : "unknown",
        toolCount: typeof o["toolCount"] === "number" ? o["toolCount"] : 0,
      };
      if (typeof o["failureKind"] === "string") health.failureKind = o["failureKind"];
      const authUrl = (o["authorization"] as { authorizationUrl?: unknown } | undefined)
        ?.authorizationUrl;
      if (typeof authUrl === "string" && authUrl) health.authorizationUrl = authUrl;
      out[name] = health;
    }
    // An empty map carries no health information — keep the local card.
    return Object.keys(out).length > 0 ? out : null;
  } catch (e) {
    warn(
      `/mcp: mcp/list threw (${e instanceof Error ? e.message : String(e)}) — using local discovery`,
    );
    return null;
  }
}

/**
 * Try to intercept a slash command. Returns a PromptResponse when handled, null otherwise.
 *
 * `client` is the REQUESTING connection (runPrompt's 6th arg, undefined for
 * client-less invocations). Only replay-shaped dispatch — /resume's history
 * replay — uses it; command feedback keeps going through the broadcast cx.
 */
export async function handleSlashCommand(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
  text: string,
  client?: acp.AgentContext,
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
        // Lists all configured MCP servers (from config.json + enabled plugins),
        // enriched with live per-server health from the backend `mcp/list` RPC
        // (mode:"status" — reports health WITHOUT connecting). Any RPC failure
        // (older backend, -32601, timeout) keeps the local-discovery card.
        const servers = loadMcpServers();
        const statuses = await fetchMcpStatuses(server, acpSid);
        return ok(statuses ? formatMcpServerHealth(statuses) : formatMcpServers(servers));
      }
      case "compact": {
        // `/compact <focus…>` forwards the argument as compact instructions.
        const result = (await compact(
          server,
          { sessionId: acpSid, instructions: arg || undefined },
          cx,
        )) as {
          __lockTimeout?: boolean;
          __compactFailed?: boolean;
          __alreadyRunning?: boolean;
        };
        if (result.__lockTimeout) {
          // 300s elapsed but the lock never released — the backend may still be
          // compacting; the next prompt will hit "a prompt is already running".
          return ok(messages().slashCompactTimeout);
        }
        if (result.__compactFailed) {
          return ok(messages().slashCompactFailed);
        }
        if (result.__alreadyRunning) {
          return ok(messages().slashCompactAlreadyRunning);
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
        // /auto machinery. Escape hatch: goal.mode "backend" (config file)
        // or ZCODE_ACP_GOAL_MODE=backend restores the legacy backend goal mode.
        if (goalModeIsBackend()) {
          if (!arg) throw new RequestError(-32602, messages().slashErrGoalArg);
          await goal(server, { sessionId: acpSid, action: "set", objective: arg });
          return ok(messages().slashGoalSet(arg));
        }
        return ok(
          await autoFlow(server, acpSid, zcodeSid, arg, "goal", {
            // Hold the prompt request open until the loop settles: clients
            // like Paseo only render live session/update events inside an
            // active turn, so a fire-and-forget start made every round
            // invisible to them.
            onStart: async (driver) => {
              const live = driver as { holdRequest(): Promise<string> };
              return live && typeof live.holdRequest === "function"
                ? live.holdRequest()
                : messages().slashGoalSet(arg);
            },
          }),
        );
      }
      case "auto": {
        // Bridge-driven goal loop (ADR-0022).
        return ok(
          await autoFlow(server, acpSid, zcodeSid, arg, "auto", {
            onStart: async (driver) => {
              const live = driver as { holdRequest(): Promise<string> };
              return live && typeof live.holdRequest === "function"
                ? live.holdRequest()
                : messages().slashAutoSet(arg);
            },
          }),
        );
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
        // Targeted replay: the adopting connection renders the adopted
        // history, and the broadcast cx would append it to every OTHER
        // attached client's transcript — the "replay disorder" fixed for
        // session/load + session/resume (2026-09-21), same rule here.
        const result = await resumeIntoSession(server, client ?? cx, acpSid, chosen);
        if (!result.ok) return ok(result.error);
        return ok(messages().slashResumed(result.title ?? chosen));
      }
      case "model": {
        if (!arg) throw new RequestError(-32602, messages().slashErrModelArg);
        const switchOk = await applyModelSwitch(server, zcodeSid, arg);
        if (!switchOk) throw new RequestError(-32603, messages().slashErrSwitchFailed(arg));
        // Remember the choice exactly like the dropdown path (setConfigOption):
        // without it a switch made here is invisible to the post-resume
        // re-assert, which would roll the session back to an older remembered
        // model — and the TUI's ONLY switch path would have no stickiness.
        rememberModelChoice(server, acpSid, zcodeSid, { model: arg });
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
        // Remember a thought-level switch like the dropdown path — /thought
        // is the TUI's only level switch and must survive resumes.
        if (cmd === "thought") rememberModelChoice(server, acpSid, zcodeSid, { thought: arg });
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
        // backend itself passes unresolvable /x through as a normal prompt
        // (custom-command-prompt.ts:31-44), so no text rewriting is needed.
        return null;
    }
  } catch (e) {
    warn(`  /${cmd} failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}
