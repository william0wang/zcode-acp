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

import stringWidth from "string-width";

import type { SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";

import type { QuotaResult } from "../quota/types.js";

/** Alias so tests can build fixtures without importing SDK types directly. */
export type SessionUpdateLike = SessionUpdate;

/**
 * Compact plan-quota summary for the prompt line's status row, e.g.
 * `"5h 34% · wk 8%"`. Token windows only (5h / weekly — all GLM exposes);
 * MCP detail lives in the full `/quota` card, not a one-line indicator, and
 * unknown future windows are skipped rather than mislabeled. Returns null
 * when there is nothing worth showing (fetch failed / auth expired /
 * transient busy) so the row degrades to its previous form instead of
 * nagging.
 */
export function formatQuotaLine(result: QuotaResult | null): string | null {
  if (result === null || result.kind !== "success") return null;
  const parts: string[] = [];
  for (const item of result.items) {
    const label = item.key === "token_5h" ? "5h" : item.key === "token_week" ? "wk" : null;
    if (label === null) continue;
    // Compact status-line readout: integer percents on purpose — the 0.1-step
    // precision rule (quota/rounding.ts) belongs to the /quota card only.
    parts.push(`${label} ${Math.round(item.usedPercent)}%`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Estimated rendered line count of `text` when wrapped at `width` display
 * columns (CJK-aware via string-width). Word-wrap vs hard-cut can differ by a
 * line on pathological words — close enough for viewport slicing.
 */
export function estimateLines(text: string, width: number): number {
  if (width <= 0) return 1;
  let lines = 0;
  for (const raw of text.split("\n")) {
    lines += Math.max(1, Math.ceil(stringWidth(raw) / width));
  }
  return lines;
}

/**
 * One visual row of the wrapped input line: the code-point slice [start, next)
 * of the editor text, hard-cut at `width` display columns (terminal-style soft
 * wrap — same convention estimateLines assumes) with "\n" forcing a break.
 */
export interface EditorRow {
  text: string;
  /** Code-point offset of this row's first character within the editor text. */
  start: number;
}

export interface CaretPosition {
  row: number;
  /** Display column of the caret within its row. */
  col: number;
  /** Code-point offset of the caret relative to its row's start. */
  rowOffset: number;
  totalRows: number;
}

/**
 * Hard-wrap the (logically single-line, "\n"-tolerant) editor text into visual
 * rows of at most `width` display columns. CJK-aware via string-width; a
 * character wider than a whole row still occupies its own row.
 */
export function wrapEditorLine(text: string, width: number): EditorRow[] {
  if (width <= 0) return [{ text, start: 0 }];
  const rows: EditorRow[] = [];
  let current = "";
  let start = 0;
  let used = 0;
  const cps = Array.from(text);
  cps.forEach((ch, i) => {
    if (ch === "\n") {
      rows.push({ text: current, start });
      current = "";
      start = i + 1;
      used = 0;
      return;
    }
    const w = stringWidth(ch);
    if (used > 0 && used + w > width) {
      rows.push({ text: current, start });
      current = "";
      start = i;
      used = 0;
    }
    current += ch;
    used += w;
  });
  if (current || text.endsWith("\n") || text === "") rows.push({ text: current, start });
  // A "\n" at the exact end already closed an empty trailing row above.
  return rows.length > 0 ? rows : [{ text: "", start: 0 }];
}

/** Locate the caret within wrapEditorLine's layout. O(caret), fine for prompts. */
export function locateCaret(text: string, caret: number, width: number): CaretPosition {
  const clamped = Math.max(0, Math.min(Array.from(text).length, caret));
  const rows = wrapEditorLine(text, width);
  // Width-based placement alone would misplace the caret when wide chars
  // straddle a cut boundary, so anchor on each row's start offset instead.
  const rowIndexAtStart = new Map<number, number>();
  rows.forEach((r, idx) => rowIndexAtStart.set(r.start, idx));
  let row = 0;
  let col = 0;
  let rowOffset = 0;
  Array.from(text)
    .slice(0, clamped)
    .forEach((ch, i) => {
      const mapped = rowIndexAtStart.get(i);
      if (mapped !== undefined) {
        row = mapped;
        col = 0;
        rowOffset = 0;
      }
      col += stringWidth(ch);
      rowOffset += 1;
    });
  // Caret sitting exactly on a row's start offset belongs to THAT row's head
  // (start-of-next-line), not past the previous row's last column.
  const atBoundary = rowIndexAtStart.get(clamped);
  if (clamped > 0 && atBoundary !== undefined) {
    return { row: atBoundary, col: 0, rowOffset: 0, totalRows: rows.length };
  }
  return {
    row: Math.min(row, rows.length - 1),
    col,
    rowOffset,
    totalRows: rows.length,
  };
}

/**
 * Widest prompt prefix the input box ever shows ("starting… " while the
 * bridge session initializes). Text-row reservation for the app layout uses
 * this narrowest inner width so reserved rows NEVER undercount what
 * InputLine actually renders — an undercount makes ink's frame overflow the
 * terminal (see the completion-menu note in App.tsx).
 */
const INPUT_PREFIX_COLS = stringWidth("starting… ");

/** Visual text rows of the input editor at terminal width `cols`. */
export function editorTextRows(text: string, cols: number): number {
  const inner = Math.max(4, cols - 2 - INPUT_PREFIX_COLS);
  return wrapEditorLine(text, inner).length;
}

/**
 * Rows the whole bordered input box occupies: 2 border + status row + text.
 * Used by both the layout fold (App) and as InputLine's own height — keep in
 * one place so they can never drift apart.
 */
export function inputBoxRows(editorText: string, cols: number): number {
  return editorTextRows(editorText, cols) + 3;
}
/**
 * Sliding viewport over a picker's full item list: pinned to the head while
 * the selection fits in the first window, then the selection rides the
 * window's bottom edge one row per step until the list tail clamps it.
 * Pickers stay short no matter how many sessions/options exist — rendering
 * the full list would blow up the dynamic footer and jolt the scrollback.
 */
export function pickerWindow<T>(items: T[], index: number, max = 8): { slice: T[]; start: number } {
  if (items.length === 0) return { slice: [], start: 0 };
  const size = Math.min(Math.max(1, max), items.length);
  const clampedIndex = Math.max(0, Math.min(index, items.length - 1));
  const start = Math.min(Math.max(0, clampedIndex - size + 1), items.length - size);
  return { slice: items.slice(start, start + size), start };
}

export interface WelcomeInfo {
  version: string;
  cwd: string;
  /** Display labels of the seeded config selects ("" when not advertised). */
  model: string;
  mode: string;
  thought: string;
}

/** One rendered line (or block) in the transcript. */
export type ReplEntry =
  | { kind: "user"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id?: string; title: string; status: string }
  | { kind: "note"; text: string }
  | { kind: "welcome"; info: WelcomeInfo };

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
export type ReplCommand = "exit" | "sessions" | null;

export function parseCommand(text: string): ReplCommand {
  const t = text.trim();
  if (t === "/exit" || t === "/quit" || t === "/q") return "exit";
  if (t === "/sessions") return "sessions";
  return null;
}

/**
 * One resumable session as shown by the interactive `/sessions` picker.
 * Mirrors the ACP `session/list` entry shape without importing SDK types.
 */
export interface SessionSummary {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}

/**
 * Compact relative age for a session's `updatedAt` ("just now", "5m ago",
 * "2h ago", "3d ago", else the ISO date). Empty for absent/unparsable input.
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * A slash command advertised by the bridge (`available_commands_update`).
 */
export interface CommandInfo {
  name: string;
  description: string;
}

/** One select config (model / mode / thought) with its current value. */
export interface ConfigSelect {
  current: string;
  options: Array<{ value: string; name: string }>;
}

/**
 * Session-level status surface: the command menu plus the three config
 * selects, all pushed by the bridge outside the turn stream.
 */
export interface ReplStatus {
  commands: CommandInfo[];
  model: ConfigSelect | null;
  mode: ConfigSelect | null;
  thought: ConfigSelect | null;
}

export function createReplStatus(): ReplStatus {
  return { commands: [], model: null, mode: null, thought: null };
}

/** Shared by both lists below so /help and /exit keep one description each. */
const HELP_COMMAND: CommandInfo = { name: "help", description: "list commands (REPL-local)" };
const EXIT_COMMAND: CommandInfo = { name: "exit", description: "quit the REPL" };

/** Commands shown before the bridge's first `available_commands_update`. */
export const FALLBACK_COMMANDS: CommandInfo[] = [
  HELP_COMMAND,
  { name: "model", description: "show or switch model" },
  { name: "mode", description: "show or switch mode" },
  { name: "thought", description: "show or switch thought level" },
  { name: "compact", description: "compact conversation context" },
  { name: "mcp", description: "list configured MCP servers" },
  { name: "quota", description: "show plan usage card" },
  EXIT_COMMAND,
];

/** REPL-local commands, always offered regardless of what the bridge advertises. */
const LOCAL_COMMANDS: CommandInfo[] = [
  HELP_COMMAND,
  { name: "sessions", description: "list and resume project sessions" },
  EXIT_COMMAND,
];

/**
 * The command menu: bridge-advertised commands (or the fallback list before
 * the first push) with the REPL-local entries merged in front — without the
 * merge, /help and /exit vanish from completion and /help output as soon as
 * the bridge's own list lands (the bridge only advertises ITS commands).
 */
export function commandMenu(status: ReplStatus): CommandInfo[] {
  const advertised = status.commands.length > 0 ? status.commands : FALLBACK_COMMANDS;
  const locals = LOCAL_COMMANDS.filter((l) => !advertised.some((a) => a.name === l.name));
  return [...locals, ...advertised];
}

/**
 * Fold a status-relevant session update into the status. Called for EVERY
 * update (idle and in-turn): the config/command pushes that follow a switch
 * slash-command arrive while that turn is still active. Unknown kinds return
 * the SAME object reference so callers can skip the rerender.
 */
export function applyStatusUpdate(status: ReplStatus, update: SessionUpdate): ReplStatus {
  switch (update.sessionUpdate) {
    case "available_commands_update": {
      const list = (update.availableCommands ?? []).map((c) => ({
        name: c.name,
        description: c.description ?? "",
      }));
      return { ...status, commands: list };
    }
    case "config_option_update": {
      const next = { ...status };
      for (const opt of update.configOptions ?? []) {
        if (opt.id !== "model" && opt.id !== "mode" && opt.id !== "thought") continue;
        // The union also has boolean/toggle variants; only selects carry options.
        if (opt.type !== "select") continue;
        // Select entries are options or one-level groups — flatten groups.
        const options = (opt.options ?? []).flatMap((o): Array<{ value: string; name: string }> =>
          "value" in o
            ? [{ value: o.value, name: o.name ?? o.value }]
            : (o.options ?? []).map((g) => ({ value: g.value, name: g.name ?? g.value })),
        );
        next[opt.id] = { current: opt.currentValue, options };
      }
      return next;
    }
    case "current_mode_update": {
      return {
        ...status,
        mode: { current: update.currentModeId, options: status.mode?.options ?? [] },
      };
    }
    default:
      return status;
  }
}

/** Display label for a select's current value (name over raw value). */
export function selectLabel(select: ConfigSelect | null): string {
  if (!select) return "";
  return select.options.find((o) => o.value === select.current)?.name ?? select.current;
}

/**
 * Seed the status from the session/new RESPONSE: the bridge ships the initial
 * model/mode/thought selects in the response body, not as a follow-up
 * notification (later changes do push config_option_update notifications).
 */
export function seedStatusFromNewSession(
  status: ReplStatus,
  response: { configOptions?: SessionConfigOption[] | null },
): ReplStatus {
  return applyStatusUpdate(status, {
    sessionUpdate: "config_option_update",
    configOptions: response.configOptions ?? [],
  } as SessionUpdate);
}

/**
 * Render a config select as note lines: one per option, current marked with a
 * bullet. The raw `value` is what the user types after /model etc., so it is
 * shown whenever it differs from the display name (third-party models).
 */
export function formatConfigList(title: string, select: ConfigSelect | null): string[] {
  if (!select || select.options.length === 0) {
    return [`${title}: no options advertised yet`];
  }
  const lines = [`${title}:`];
  for (const o of select.options) {
    const mark = o.value === select.current ? "●" : " ";
    const hint = o.value !== o.name ? `  (${o.value})` : "";
    lines.push(`${mark} ${o.name}${hint}`);
  }
  return lines;
}

function helpEntries(status: ReplStatus): ReplEntry[] {
  const lines = ["commands:"];
  for (const c of commandMenu(status)) {
    lines.push(`  /${c.name} — ${c.description}`);
  }
  lines.push("/model, /mode, /thought without an argument list options; with one they switch.");
  return lines.map((text) => ({ kind: "note", text }) as ReplEntry);
}

/**
 * REPL-local commands that never reach the bridge: `/help`, and the arg-less
 * listing form of `/model` `/mode` `/thought` (the bridge rejects those with
 * -32602). Everything else — including the switch forms with an argument —
 * returns null and is sent as a prompt (the bridge's slash interception is
 * the battle-tested path editors use).
 */
export function handleLocalCommand(text: string, status: ReplStatus): ReplEntry[] | null {
  const stripped = text.trim();
  if (!stripped.startsWith("/")) return null;
  const spaceIdx = stripped.indexOf(" ");
  const cmd = (spaceIdx < 0 ? stripped : stripped.slice(0, spaceIdx)).toLowerCase();
  const hasArg = spaceIdx >= 0 && stripped.slice(spaceIdx + 1).trim().length > 0;
  if (cmd === "/help") return helpEntries(status);
  if (cmd === "/model" || cmd === "/mode" || cmd === "/thought") {
    if (hasArg) return null;
    const key = cmd.slice(1) as "model" | "mode" | "thought";
    return formatConfigList(cmd, status[key]).map((text) => ({ kind: "note", text }) as ReplEntry);
  }
  return null;
}

// ---------- interactive completion ----------

/** One entry of the completion menu below/above the input line. */
export interface CompletionItem {
  /** Text inserted into the line when chosen (command with "/", or option value). */
  value: string;
  /** Display label shown in the menu. */
  label: string;
  /** Secondary text (command description, or the raw value when it differs). */
  description?: string;
  /** True when this option is the select's current value (● marker). */
  current?: boolean;
}

/**
 * Max rows the menu renders — longer lists narrow with the typed prefix.
 * Also the FIXED slot count of the rendered menu block (blanks beyond the
 * candidate count): constant height keeps ink's frame updates equal-size,
 * which is what keeps the top highlight visible (see App.tsx menu block).
 */
export const COMPLETION_LIMIT = 8;

/** Commands whose single argument is completable from the config selects. */
const CONFIG_COMMANDS = new Set(["model", "mode", "thought"]);

/** Whether `cmd` (bare name, no slash) takes a completable config argument. */
export function isConfigCommand(cmd: string): boolean {
  return CONFIG_COMMANDS.has(cmd);
}

/**
 * True when the line sits in a config command's argument menu ("/model v…").
 * There the highlighted option IS the decision — enter executes the switch
 * directly. Every other completion context (command names, skill commands,
 * plugins) only FILLS the line; sending stays the user's explicit choice.
 * Only meaningful when a completion menu is open (line starts with "/").
 */
export function isConfigArgumentMenu(value: string): boolean {
  if (!value.startsWith("/")) return false;
  const spaceIdx = value.indexOf(" ");
  if (spaceIdx < 0) return false;
  return CONFIG_COMMANDS.has(value.slice(1, spaceIdx).toLowerCase());
}

/**
 * Bare command names whose whole action needs no input ("exit", "help", ...):
 * enter ON PICK runs them directly, like config argument menus. Anything not
 * listed here — skills, plugin commands, unknown advertised names — keeps
 * fill semantics because its bare form usually expects an argument, and
 * sending must stay the user's explicit act.
 */
const ONE_SHOT_COMMANDS = new Set(["help", "sessions", "exit", "compact", "mcp", "quota"]);

/** Whether the "/"-prefixed single-token line executes immediately when picked. */
export function isOneShotCommandValue(value: string): boolean {
  if (!value.startsWith("/") || value.indexOf(" ") >= 0) return false;
  return ONE_SHOT_COMMANDS.has(value.slice(1).toLowerCase());
}

/**
 * Completion candidates for the current line, or null outside a completion
 * context:
 *   - "/par"     → advertised commands matching the prefix ("/" alone = all)
 *   - "/model v" → model option values/names matching the argument prefix
 *   - other text, a second space, or a select not yet advertised → null/[]
 */
export function completionCandidates(value: string, status: ReplStatus): CompletionItem[] | null {
  if (!value.startsWith("/")) return null;
  const spaceIdx = value.indexOf(" ");
  if (spaceIdx < 0) {
    const query = value.slice(1).toLowerCase();
    return commandMenu(status)
      .filter((c) => c.name.toLowerCase().startsWith(query))
      .slice(0, COMPLETION_LIMIT)
      .map((c) => ({ value: `/${c.name}`, label: `/${c.name}`, description: c.description }));
  }
  const cmd = value.slice(1, spaceIdx).toLowerCase();
  if (!CONFIG_COMMANDS.has(cmd)) return null;
  const arg = value.slice(spaceIdx + 1);
  if (arg.includes(" ")) return null; // past the single argument
  const select = status[cmd as "model" | "mode" | "thought"];
  if (!select) return null;
  const query = arg.toLowerCase();
  return select.options
    .filter(
      (o) => o.value.toLowerCase().startsWith(query) || o.name.toLowerCase().startsWith(query),
    )
    .slice(0, COMPLETION_LIMIT)
    .map((o) => ({
      value: o.value,
      label: o.name,
      description: o.value !== o.name ? o.value : undefined,
      current: o.value === select.current,
    }));
}

/**
 * Insert a chosen candidate into the line. Command completions keep a
 * trailing space so the argument menu opens immediately; option completions
 * replace the argument in place (`/model <value>`).
 */
export function applyCompletion(value: string, item: CompletionItem): string {
  const spaceIdx = value.indexOf(" ");
  if (spaceIdx < 0) return `${item.value} `;
  return `${value.slice(0, spaceIdx + 1)}${item.value}`;
}

// ---------- AskUserQuestion elicitation form ----------

/** One question parsed from the bridge's AskUserQuestion elicitation form. */
export interface QuestionForm {
  /** Content key the answer must ride under (`q_<i>`). */
  key: string;
  /** The question text. */
  title: string;
  multiSelect: boolean;
  options: Array<{ value: string; label: string }>;
}

/**
 * Parse an `elicitation/create` form payload (the bridge's AskUserQuestion
 * mapping — see `buildAskUserElicitationForm`) into renderable questions:
 * `q_<i>` string fields with `oneOf` const/title options (single-select) or
 * array fields with `items.anyOf` (multi-select).
 *
 * The `q_<i>_other` free-text companions are skipped (the picker has a
 * built-in custom-answer row) and the skip sentinel option is dropped (esc
 * covers skip). Returns null when the payload has no renderable question.
 */
export function parseQuestionForm(params: unknown): QuestionForm[] | null {
  if (!params || typeof params !== "object") return null;
  const schema = (params as { requestedSchema?: unknown }).requestedSchema;
  if (!schema || typeof schema !== "object") return null;
  const props = (schema as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return null;

  const entries = Object.entries(props as Record<string, unknown>)
    .filter(([key]) => /^q_\d+$/.test(key))
    .sort((a, b) => Number(a[0].slice(2)) - Number(b[0].slice(2)));

  const forms: QuestionForm[] = [];
  for (const [key, prop] of entries) {
    if (!prop || typeof prop !== "object") continue;
    const p = prop as {
      title?: unknown;
      type?: unknown;
      oneOf?: unknown;
      items?: { anyOf?: unknown };
    };
    if (typeof p.title !== "string") continue;
    const raw = Array.isArray(p.oneOf)
      ? p.oneOf
      : Array.isArray(p.items?.anyOf)
        ? p.items.anyOf
        : null;
    if (raw === null) continue;
    const options: Array<{ value: string; label: string }> = [];
    for (const o of raw) {
      if (!o || typeof o !== "object") continue;
      const value = (o as { const?: unknown }).const;
      if (typeof value !== "string" || value === "__skip__") continue;
      const title = (o as { title?: unknown }).title;
      options.push({ value, label: typeof title === "string" ? title : value });
    }
    if (options.length === 0) continue;
    forms.push({ key, title: p.title, multiSelect: p.type === "array", options });
  }
  return forms.length > 0 ? forms : null;
}
