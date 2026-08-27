/**
 * Ink UI for the interactive REPL (bare `zcode-acp`).
 *
 * Rendering model: the whole app draws in a fixed-height frame managed by
 * run.ts (full-screen mode) — the transcript is an in-app viewport, and the
 * live turn (streaming text, thinking buffer, tool rows), prompt line, and
 * pickers render inside it. A pending permission request takes over the
 * input area with an arrow-key picker.
 */

import { Box, Static, Text, useInput, type Key } from "ink";
import Spinner from "ink-spinner";
import { Chalk } from "chalk";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import stringWidth from "string-width";

import {
  applyCompletion,
  COMPLETION_LIMIT,
  completionCandidates,
  estimateLines,
  isConfigArgumentMenu,
  isConfigCommand,
  isOneShotCommandValue,
  locateCaret,
  pickerWindow,
  relativeTime,
  selectLabel,
  wrapEditorLine,
  type ReplEntry,
  type ReplStatus,
  type SessionSummary,
  type TurnState,
  type WelcomeInfo,
} from "./model.js";
import {
  backspaceAtCaret,
  caretLeft,
  caretRight,
  caretToEnd,
  caretToStart,
  createLineEditor,
  ctrlChord,
  deleteAtCaret,
  insertAtCaret,
  planChunkOps,
  replaceText,
  sanitizeInputChunk,
  type LineEditor,
} from "./input-buffer.js";

/** A permission request awaiting the user's choice. */
export interface PermissionPrompt {
  /** Box heading ("permission requested" / "plan approval"). */
  heading: string;
  title: string;
  /** Long body shown under the title (e.g. the plan text for ExitPlanMode). */
  detail?: string;
  options: Array<{ id: string; name: string }>;
}

/** A question awaiting the user's answer (AskUserQuestion via elicitation). */
export interface QuestionPrompt {
  title: string;
  multiSelect: boolean;
  options: Array<{ value: string; label: string }>;
}

/** The interactive `/sessions` picker: resumable project sessions. */
export interface SessionPick {
  items: SessionSummary[];
}

/** A picked question answer: chosen option values plus an optional custom text. */
export interface QuestionAnswer {
  picked: string[];
  custom: string;
}

/** Display state of the question picker (selection, toggles, custom typing). */
export interface PickerState {
  index: number;
  /** null = option list active; string = custom-answer input in progress. */
  custom: string | null;
  toggled: string[];
}

export interface AppProps {
  /** Completed transcript entries — printed once into native scrollback. */
  entries: ReplEntry[];
  /** Live turn in progress, null when idle. */
  turn: TurnState | null;
  /** Pending permission request, null when none. */
  permission: PermissionPrompt | null;
  /** Pending AskUserQuestion, null when none (renders instead of the input). */
  question: QuestionPrompt | null;
  /** Pending /sessions picker, null when closed. */
  sessionPick: SessionPick | null;
  /** Prompts accepted but waiting for the running turn to finish. */
  queued: string[];
  /** Session status: command menu + model/mode/thought selects. */
  status: ReplStatus;
  /** True while the bridge/session is starting up. */
  busy: boolean;
  /**
   * True while a /sessions resume is replaying history. Replayed updates
   * fold silently into run.ts's buffers — rendering per message made big
   * sessions freeze the UI, so App just shows this one-line progress hint.
   */
  replaying: boolean;
  /**
   * The prompt line's editor state (text + caret), owned by run.ts's
   * external store so submit paths can reset it and rerender snapshots
   * stay pure functions of that state.
   */
  editor: LineEditor;
  /** Apply one pure editor op to the prompt line and repaint. */
  applyEdit: (op: (e: LineEditor) => LineEditor) => void;
  /** Compact plan-quota suffix for the status row (null = not fetched yet). */
  quotaLine: string | null;
  /**
   * Live completion-menu visibility. InputLine mirrors it out of its React
   * state on every render (same external-store rationale as the editor), so
   * the app-level key handler can give the menu first claim on esc.
   */
  isMenuOpen: () => boolean;
  /** InputLine → external store: publish the current menu visibility. */
  onMenuOpenChange: (open: boolean) => void;
  onSubmit: (text: string) => void;
  onCancelTurn: () => void;
  onAnswerPermission: (optionId: string | null) => void;
  onAnswerQuestion: (answer: QuestionAnswer | null) => void;
  /** null = dismiss the picker without resuming. */
  onPickSession: (sessionId: string | null) => void;
  onExit: () => void;
}

// Fixed-level chalk so colorization is deterministic regardless of TTY
// detection (tests run with level 0; the REPL terminal always takes color).
const color = new Chalk({ level: 2 });

/**
 * Colorize markdown code fences: lines between ``` fences render cyan. Line
 * level state machine — exported for unit tests.
 */
export function colorizeCodeFences(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        return color.dim(line);
      }
      return inFence ? color.cyan(line) : line;
    })
    .join("\n");
}

/**
 * Esc / Ctrl-C means "dismiss" for every picker (question form, /sessions,
 * permission). Both ctrl-c delivery shapes count: a lone \x03 arrives as
 * ("c", ctrl) but rapid presses coalesce into one raw chunk with ctrl=false.
 */
function isCancelKey(inputChar: string | undefined, key: Key): boolean {
  return key.escape || (key.ctrl && inputChar === "c") || (inputChar ?? "").includes("\x03");
}

const TOOL_STATUS_ICON: Record<string, string> = {
  pending: "○",
  in_progress: "●",
  completed: "✔",
  failed: "✘",
};

/**
 * Startup welcome panel — the agent-CLI-style hero shown until the first
 * prompt pushes it into scrollback: branding, session info, the seeded
 * config, and the key hints a first-time user needs.
 */
function WelcomeView({ info }: { info: WelcomeInfo }): ReactElement {
  const config = [info.model, info.mode, info.thought].filter(Boolean).join(" · ");
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="cyan" bold>
          zcode-acp
        </Text>
        <Text dimColor> v{info.version}</Text>
      </Box>
      <Text dimColor>session · {info.cwd}</Text>
      {config ? (
        <Box marginTop={1}>
          <Text dimColor>● </Text>
          <Text bold>{config}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{"  /        command menu — ↑/↓ move · enter picks · esc closes"}</Text>
        <Text dimColor>{"  /model   switch model — /mode and /thought likewise"}</Text>
        <Text dimColor>{"  /sessions list and resume past conversations of this project"}</Text>
        <Text dimColor>{"  ctrl-c   cancel a running turn · idle, press twice to quit"}</Text>
      </Box>
    </Box>
  );
}

function EntryView({ entry }: { entry: ReplEntry }): ReactElement {
  switch (entry.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>
            &gt;{" "}
          </Text>
          <Text>{entry.text}</Text>
        </Box>
      );
    case "thinking": {
      const oneLine = entry.text.replace(/\s+/g, " ").slice(0, 120);
      return <Text dimColor>⎿ thinking · {oneLine}</Text>;
    }
    case "assistant":
      return <Text>{colorizeCodeFences(entry.text)}</Text>;
    case "tool":
      return (
        <Text>
          <Text
            color={
              entry.status === "failed" ? "red" : entry.status === "completed" ? "green" : "yellow"
            }
          >
            {TOOL_STATUS_ICON[entry.status] ?? "•"}{" "}
          </Text>
          <Text>{entry.title}</Text>
          <Text dimColor> ({entry.status})</Text>
        </Text>
      );
    case "note":
      return <Text dimColor>-- {entry.text}</Text>;
    case "welcome":
      return <WelcomeView info={entry.info} />;
  }
}

/**
 * Derive ink-style key flags for a single char of a COALESCED multi-key chunk
 * (fast double-ctrl-c, "\t\t", …). ink delivers such chunks as ONE event with
 * the raw string and mostly-false flags, so we decompose per char to keep each
 * key's semantics. Chunks containing ESC (arrow-key sequences) are never
 * decomposed — the caller leaves those to ink's parser.
 */
function derivedKey(ch: string): {
  return: boolean;
  tab: boolean;
  escape: boolean;
  backspace: boolean;
  forwardDelete: boolean;
  left: boolean;
  right: boolean;
  ctrl: boolean;
  meta: boolean;
} {
  return {
    return: ch === "\r" || ch === "\n",
    tab: ch === "\t",
    escape: false,
    backspace: ch === "\x7f" || ch === "\b",
    // Arrow / Delete keys always arrive as escape sequences and are handled
    // by ink's parser, never inside a decomposed printable chunk.
    forwardDelete: false,
    left: false,
    right: false,
    ctrl: ch >= "\x01" && ch <= "\x1a" && ch !== "\r" && ch !== "\n" && ch !== "\t",
    meta: false,
  };
}

/**
 * Self-managed input line. ink-text-input's submit/clear timing proved
 * unreliable under full external rerenders, so the line owns its value and
 * handles plain typing, caret-aware editing (←/→ or Ctrl-B/F to move,
 * Backspace/Delete at the caret, Ctrl-A/E line jumps, Ctrl-U clear), and
 * submit directly.
 *
 * While the line is a slash command (or a config command's argument), an
 * interactive completion menu sits above the box: ↑/↓ move, tab/→ complete
 * the highlighted candidate, enter picks it when the line is a partial match
 * (exact input sends instead), esc dismisses. ←/→ only move the caret when
 * they are not acting as menu/completion keys.
 */
function InputLine({
  busy,
  status,
  editor,
  applyEdit,
  onMenuOpenChange,
  quotaLine,
  onSubmitText,
}: {
  busy: boolean;
  status: ReplStatus;
  editor: LineEditor;
  applyEdit: (op: (e: LineEditor) => LineEditor) => void;
  /** Publish current menu visibility to the external store (see AppProps). */
  onMenuOpenChange: (open: boolean) => void;
  quotaLine: string | null;
  onSubmitText: (text: string) => void;
}): ReactElement {
  // `ed` mirrors props.editor for the render below; edits go through
  // applyEdit so run.ts's store stays the single source of truth.
  const ed = editor;
  const [selIdx, setSelIdx] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Mirror of `ed` for event handlers: a decomposed chunk fires several
  // state updates in one tick, so closures over `ed` would see the stale
  // pre-chunk line (and submit the wrong text on an embedded \r).
  const edRef = useRef(editor);
  edRef.current = editor;
  // Completion paths replace the whole line — adopt with caret at the end.
  const applyValue = (fn: (v: string) => string): void => {
    applyEdit((e) => replaceText(fn(e.text)));
  };
  const submitWith = (text: string): void => {
    applyEdit(() => createLineEditor());
    setDismissed(false);
    if (text.trim()) onSubmitText(text.trim());
  };
  const candidates = completionCandidates(ed.text, status);
  const menu = !dismissed && candidates !== null && candidates.length > 0 ? candidates : null;
  // Mirror visibility out of React on every render: the app-level key handler
  // may run for the same keystroke and must see the PRE-keystroke value
  // (stale-by-one-keystroke is exactly right — it decides esc precedence
  // before this component's own listener dismisses anything). Plain store
  // assignment, no React state, so this can't loop.
  onMenuOpenChange(menu !== null);
  // New keystroke → new filter: restart the selection and re-open a
  // previously dismissed menu.
  useEffect(() => {
    setSelIdx(0);
    setDismissed(false);
  }, [ed.text]);

  const handleChar = (
    ch: string,
    k: {
      return: boolean;
      tab: boolean;
      escape: boolean;
      backspace: boolean;
      forwardDelete: boolean;
      left: boolean;
      right: boolean;
      ctrl: boolean;
      meta: boolean;
    },
    nav: { up: boolean; down: boolean; right: boolean } | null,
  ): void => {
    if (nav || k.tab) {
      if (nav?.up) {
        setSelIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (nav?.down) {
        // Without an open menu there is nothing to move through — swallow
        // the press. `menu!` here used to throw inside a setState UPDATER,
        // which fires during the next render: React unmounted the whole
        // tree and ink restored the terminal, leaving a silent zombie.
        if (!menu) return;
        setSelIdx((i) => Math.min(menu.length - 1, i + 1));
        return;
      }
      // tab (or →) completes the highlighted candidate when a menu is open.
      // Without one, → falls through to caret movement below so it stays a
      // plain editing key; bare tabs are still dropped.
      if ((k.tab || nav?.right) && menu) {
        const item = menu[selIdx] ?? menu[0]!;
        if (item) applyValue((v) => applyCompletion(v, item));
        return;
      }
    }
    if (k.escape) {
      setDismissed(true);
      return;
    }
    if (k.return) {
      // With the menu open, Enter PICKS the highlighted candidate — never
      // sends the raw partial. It only sends when the line already is the
      // exact runnable form: a full NON-config command ("/help", "/exit") or
      // a config command with its exact option ("/mode plan"). Config
      // commands without an argument open their option menu instead of the
      // static listing, so a switch never needs hand-typed input.
      if (menu) {
        const item = menu[selIdx] ?? menu[0]!;
        const line = edRef.current.text;
        const spaceIdx = line.indexOf(" ");
        // One-shot commands ("/exit", "/help", "/compact", ...) run ON PICK:
        // the highlighted row already names the whole action. Other
        // command-name menus — skills, plugins, unknown advertised commands —
        // keep fill semantics: their bare form usually expects an argument,
        // and sending must stay the user's explicit act.
        if (spaceIdx < 0 && isOneShotCommandValue(item.value)) {
          submitWith(item.value);
          return;
        }
        // Config argument menus execute ON PICK too ("/model x" switches
        // right away): the highlighted row already states the full decision,
        // so fill-then-confirm would only add a redundant enter.
        if (spaceIdx >= 0 && isConfigArgumentMenu(line)) {
          submitWith(`${line.slice(0, spaceIdx + 1)}${item.value}`);
          return;
        }
        if (spaceIdx < 0) {
          if (line === item.value && !isConfigCommand(item.value.replace(/^\//, ""))) {
            submitWith(line);
          } else {
            applyValue(() => applyCompletion(line, item));
          }
          return;
        }
        if (line === `${line.slice(0, spaceIdx + 1)}${item.value}`) {
          submitWith(line);
        } else {
          applyValue(() => applyCompletion(line, item));
        }
        return;
      }
      submitWith(edRef.current.text);
      return;
    }
    // Caret-aware edits. ←/→ arrive as escape-sequence chunks (never inside
    // coalesced printable chunks), so they ride the k flags below.
    if (k.backspace) {
      applyEdit(backspaceAtCaret);
      return;
    }
    if (k.forwardDelete) {
      applyEdit(deleteAtCaret);
      return;
    }
    if (k.left) {
      applyEdit(caretLeft);
      return;
    }
    if (k.right && !menu) {
      applyEdit(caretRight);
      return;
    }
    // Readline-standard Ctrl chords: B/F move by char, A/E jump to the
    // line's ends, U kills the whole line. Accept both delivery shapes —
    // the letter (single keypress) and the raw control byte (coalesced
    // chunks) — see ctrlChord().
    if (k.ctrl) {
      const chord = ctrlChord(ch);
      if (chord === "b") return void applyEdit(caretLeft);
      if (chord === "f") return void applyEdit(caretRight);
      if (chord === "a") return void applyEdit(caretToStart);
      if (chord === "e") return void applyEdit(caretToEnd);
      if (chord === "u") return void applyEdit(() => createLineEditor());
    }
    if (ch && !k.ctrl && !k.meta) {
      // Paste/drop chunks can carry escape bytes (bracketed-paste wrappers,
      // image-drop binary) — sanitize before they reach editor state, or
      // every later render re-wraps corrupted text.
      const clean = sanitizeInputChunk(ch);
      if (clean) applyEdit((cur) => insertAtCaret(cur, clean));
    }
  };

  useInput((inputChar, key) => {
    // Coalesced printable chunk (paste, rapid keys) — batched via
    // planChunkOps: printable runs apply as ONE editor op, semantic bytes
    // stay per-character. Escape-sequence chunks (arrow keys flushed
    // together) keep ink's parsed flags instead.
    if (inputChar && inputChar.length > 1 && !inputChar.includes("\x1b") && !key.ctrl) {
      for (const op of planChunkOps(inputChar)) {
        if (op.kind === "insert") {
          applyEdit((cur) => insertAtCaret(cur, op.text));
        } else {
          handleChar(op.ch, derivedKey(op.ch), null);
        }
      }
      return;
    }
    handleChar(
      inputChar,
      {
        return: key.return,
        tab: key.tab,
        escape: key.escape,
        backspace: key.backspace,
        forwardDelete: key.delete,
        left: key.leftArrow,
        right: key.rightArrow,
        ctrl: key.ctrl,
        meta: key.meta,
      },
      key.upArrow || key.downArrow || key.rightArrow
        ? { up: key.upArrow, down: key.downArrow, right: key.rightArrow }
        : null,
    );
  });

  // e.g. "GLM-5.3 · build · max" — lives INSIDE the input box (bottom row),
  // mirroring the editor dropdown state. The plan-quota suffix rides after it
  // ("5h 34% · wk 8%"), clamped so one wrap never changes the box height —
  // the transcript viewport slices heights from CHROME_ROWS.
  const cols = process.stdout.columns || 100;
  const statusLine = [
    selectLabel(status.model),
    selectLabel(status.mode),
    selectLabel(status.thought),
  ]
    .filter(Boolean)
    .join(" · ");
  const LEFT_BUDGET = Math.max(12, cols - 40); // right hint ≈ 34 cols + margin
  const leftLine = [statusLine, quotaLine].filter(Boolean).join(" · ").slice(0, LEFT_BUDGET);

  return (
    // width="100%": the chrome parent is a row Box, so without an explicit
    // width the whole subtree shrink-wraps to its longest line and the
    // bordered input box stops spanning the terminal.
    <Box flexDirection="column" width="100%">
      {menu ? (
        // Rows are pre-colored as ONE plain string (chalk) instead of a
        // <Text color> wrapper — whole-string rows always diff as clean
        // full-line replacements. The block ALWAYS paints COMPLETION_LIMIT
        // slots (blanks beyond the candidate count), so filtering changes
        // only line CONTENT, never height: ink's frame update erases the
        // previous frame's line count upward and rewrites, and a height
        // change misplaces that sequence — the top candidate row used to
        // land off-position and go invisible until the selection moved.
        <Box flexDirection="column" paddingLeft={2}>
          {Array.from({ length: COMPLETION_LIMIT }, (_, i) => {
            const m = menu[i];
            if (!m) {
              return <Text key={`slot:${i}`}> </Text>;
            }
            const desc = m.description ? ` — ${m.description}` : "";
            const body = `${m.current ? "● " : "  "}${m.label}${desc}`;
            return (
              <Text key={`${i}:${m.label}:${m.value}`}>
                {i === selIdx ? color.cyan(`❯ ${body}`) : `  ${body}`}
              </Text>
            );
          })}
          <Text dimColor>
            {(() => {
              // Hint follows the HIGHLIGHTED row: one-shot commands announce
              // that enter runs them, config menus that it switches, and
              // everything else keeps pick-to-fill.
              if (isConfigArgumentMenu(ed.text)) {
                return " ↑/↓ select · enter switches now · tab fills · esc dismiss";
              }
              const picked = menu[selIdx] ?? menu[0];
              if (picked && isOneShotCommandValue(picked.value)) {
                return " ↑/↓ select · enter runs it now · tab fills · esc dismiss";
              }
              return " ↑/↓ select · tab or enter picks · esc dismiss";
            })()}
          </Text>
        </Box>
      ) : null}
      <Box
        borderStyle="round"
        borderColor={busy ? "gray" : "cyan"}
        paddingX={1}
        width="100%"
        flexDirection="column"
      >
        {(() => {
          // Multi-row prompt: text hard-wraps at the inner width and the
          // block cursor sits on its OWN visual row — soft-wrap via implicit
          // ink layout used to strand the caret visually on the first row.
          const prefix = busy ? "starting… " : "❯ ";
          const prefixCols = stringWidth(prefix);
          const inner = Math.max(4, cols - 2 - prefixCols);
          const rows = wrapEditorLine(ed.text, inner);
          const pos = locateCaret(ed.text, ed.caret, inner);
          return (
            <Box flexDirection="column">
              {rows.map((r, i) => {
                const indent = i === 0 ? prefix : " ".repeat(prefixCols);
                if (i !== pos.row) {
                  return (
                    <Box key={r.start}>
                      <Text dimColor>{indent}</Text>
                      {r.text ? <Text>{r.text}</Text> : <Text> </Text>}
                    </Box>
                  );
                }
                // Block cursor on the character at the caret (a space past
                // the end) — makes ←/→ editing visible.
                const parts = Array.from(r.text);
                const split = Math.max(0, Math.min(parts.length, pos.rowOffset));
                const before = parts.slice(0, split).join("");
                const atCaret = parts.slice(split, split + 1).join("");
                const after = parts.slice(split + 1).join("");
                return (
                  <Box key={r.start}>
                    <Text dimColor>{indent}</Text>
                    <Text>{before}</Text>
                    <Text backgroundColor="white" color="black">
                      {atCaret || " "}
                    </Text>
                    {after ? <Text>{after}</Text> : null}
                  </Box>
                );
              })}
            </Box>
          );
        })()}
        <Box justifyContent="space-between" width="100%">
          <Text dimColor>{leftLine || "type / for commands · tab completes"}</Text>
          <Text dimColor> </Text>
          <Text dimColor>{busy ? "" : "enter send · ctrl-c cancels/quits"}</Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Rendered height of one live-turn entry (local twin of the old viewport
 * entryHeight): feeds turnHeight's cap math only.
 */
function entryHeight(entry: ReplEntry, width: number): number {
  switch (entry.kind) {
    case "user":
      return 1 + estimateLines(`> ${entry.text}`, width);
    case "welcome":
      return 1 + 11;
    case "tool":
      return estimateLines(`• ${entry.title} (${entry.status})`, width);
    default:
      return estimateLines(entry.text, width);
  }
}

/**
 * Height of the live-turn block (entries + streaming buffers + spinner).
 * Deliberately biased HIGH: an underestimate makes the whole layout exceed
 * the terminal and ink clips from the bottom — the input box disappears. A
 * few blank rows at the bottom of the viewport are harmless by contrast.
 */
function turnHeight(turn: TurnState | null, width: number): number {
  if (!turn) return 0;
  let h = turn.entries.reduce((n, e) => n + entryHeight(e, width), 0);
  if (turn.thinkBuf.trim()) {
    // The render collapses whitespace and keeps only the tail, but even that
    // can wrap (CJK especially) — measure it instead of assuming one line.
    h += estimateLines(`⎿ thinking · ${turn.thinkBuf.replace(/\s+/g, " ").slice(-120)}`, width);
  }
  if (turn.textBuf) h += estimateLines(turn.textBuf, width);
  return h + 1 + 2; // spinner line + safety margin
}

export function App(props: AppProps): ReactElement {
  const { entries, turn, permission, question, sessionPick, queued, status, busy } = props;
  // Second consecutive idle Ctrl-C exits; a turn-running Ctrl-C only cancels.
  const idleIntCount = useRef(0);

  // Native-scrollback layout: full terminal width — no centered reading
  // column. `rows` still matters for capping the live-turn tail so the input
  // box can't be pushed off-screen mid-stream; there is no viewport math.
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 24;

  const submit = useCallback((text: string) => props.onSubmit(text), [props]);

  // --- picker keyboard state ---
  // Pickers are PURE VIEWS; all their keys are handled HERE in the app-level
  // useInput. ink's per-component useInput proved unreliable for components
  // mounted late via external rerenders (ink.rerender from the run loop):
  // the freshly-mounted hook sometimes never receives events. The root-level
  // hook always does.
  const EMPTY_Q: PickerState = { index: 0, custom: null, toggled: [] };
  const [q, setQ] = useState<PickerState>(EMPTY_Q);
  const qRef = useRef<PickerState>(EMPTY_Q);
  const applyQ = (fn: (s: PickerState) => PickerState): void => {
    qRef.current = fn(qRef.current);
    setQ(qRef.current);
  };
  useEffect(() => {
    // New question (or cleared) → fresh selection state.
    applyQ(() => EMPTY_Q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question]);

  const [permIndex, setPermIndex] = useState(0);
  const permIndexRef = useRef(0);
  useEffect(() => {
    permIndexRef.current = 0;
    setPermIndex(0);
  }, [permission]);

  // /sessions picker selection (mirrored in a ref for the key handler).
  const [sessIndex, setSessIndex] = useState(0);
  const sessIndexRef = useRef(0);
  useEffect(() => {
    sessIndexRef.current = 0;
    setSessIndex(0);
  }, [sessionPick]);

  useInput((inputChar, key) => {
    if (sessionPick && sessionPick.items.length > 0) {
      handleSessionKey(inputChar, key);
      return;
    }
    if (question) {
      handleQuestionKey(inputChar, key);
      return;
    }
    if (permission) {
      handlePermissionKey(inputChar, key);
      return;
    }
    // Esc interrupts the running turn — with or without queued follow-ups;
    // the stop handler drains the queue, so a next queued message starts at
    // once. With the completion menu open, the menu takes this esc instead
    // (dismiss); a second esc reaches here and interrupts.
    if (key.escape && turn && !props.isMenuOpen()) {
      props.onCancelTurn();
      return;
    }
    // Count ctrl-c presses across both delivery shapes: a lone \x03 arrives
    // as ("c", ctrl) but rapid presses coalesce into one raw "\x03\x03"
    // chunk with ctrl=false (ink does not split multi-key chunks).
    const presses =
      (key.ctrl && inputChar === "c" ? 1 : 0) + ((inputChar ?? "").match(/\x03/g)?.length ?? 0);
    if (presses > 0) {
      if (turn) {
        props.onCancelTurn();
        idleIntCount.current = 0;
      } else {
        idleIntCount.current += presses;
        if (idleIntCount.current >= 2) props.onExit();
      }
      return;
    }
    idleIntCount.current = 0;
  });

  /** Keys for the active AskUserQuestion picker (state mirrors in qRef). */
  function handleQuestionKey(inputChar: string | undefined, key: Key): void {
    if (!question) return;
    const isSkip = isCancelKey(inputChar, key);
    if (qRef.current.custom !== null) {
      if (key.return) {
        props.onAnswerQuestion({ picked: [...qRef.current.toggled], custom: qRef.current.custom });
        return;
      }
      if (isSkip) {
        applyQ((s) => ({ ...s, custom: null }));
        return;
      }
      if (key.backspace || key.delete) {
        applyQ((s) => ({ ...s, custom: (s.custom ?? "").slice(0, -1) }));
        return;
      }
      if (
        inputChar &&
        !key.ctrl &&
        !key.meta &&
        inputChar.length === 1 &&
        !/[\r\n]/.test(inputChar)
      ) {
        applyQ((s) => ({ ...s, custom: (s.custom ?? "") + inputChar }));
      }
      return;
    }
    if (key.upArrow) {
      applyQ((s) => ({ ...s, index: Math.max(0, s.index - 1) }));
      return;
    }
    if (key.downArrow) {
      applyQ((s) => ({ ...s, index: Math.min(question.options.length, s.index + 1) }));
      return;
    }
    if (isSkip) {
      props.onAnswerQuestion(null); // skip this question
      return;
    }
    const onCustomRow = qRef.current.index === question.options.length;
    if (key.return || key.tab) {
      if (onCustomRow) {
        applyQ((s) => ({ ...s, custom: "" }));
        return;
      }
      if (question.multiSelect) {
        props.onAnswerQuestion({ picked: [...qRef.current.toggled], custom: "" });
        return;
      }
      props.onAnswerQuestion({
        picked: [question.options[qRef.current.index]!.value],
        custom: "",
      });
      return;
    }
    if (inputChar === " " && question.multiSelect && !onCustomRow) {
      const value = question.options[qRef.current.index]!.value;
      applyQ((s) => ({
        ...s,
        toggled: s.toggled.includes(value)
          ? s.toggled.filter((v) => v !== value)
          : [...s.toggled, value],
      }));
    }
  }

  /** Keys for the /sessions picker (selection mirrored in sessIndexRef). */
  function handleSessionKey(inputChar: string | undefined, key: Key): void {
    if (!sessionPick) return;
    const last = sessionPick.items.length - 1;
    if (key.upArrow) {
      sessIndexRef.current = Math.max(0, sessIndexRef.current - 1);
      setSessIndex(sessIndexRef.current);
      return;
    }
    if (key.downArrow) {
      sessIndexRef.current = Math.min(last, sessIndexRef.current + 1);
      setSessIndex(sessIndexRef.current);
      return;
    }
    if (key.return) {
      props.onPickSession(sessionPick.items[sessIndexRef.current]!.sessionId);
      return;
    }
    if (isCancelKey(inputChar, key)) {
      props.onPickSession(null);
    }
  }

  /** Keys for the active permission picker (selection mirrored in permIndexRef). */
  function handlePermissionKey(inputChar: string | undefined, key: Key): void {
    if (!permission) return;
    if (key.upArrow) {
      permIndexRef.current = Math.max(0, permIndexRef.current - 1);
      setPermIndex(permIndexRef.current);
      return;
    }
    if (key.downArrow) {
      permIndexRef.current = Math.min(permission.options.length - 1, permIndexRef.current + 1);
      setPermIndex(permIndexRef.current);
      return;
    }
    if (key.return) {
      props.onAnswerPermission(permission.options[permIndexRef.current]!.id);
      return;
    }
    if (isCancelKey(inputChar, key)) {
      props.onAnswerPermission(null);
    }
  }

  // The queued-prompts panel sits between the turn block and the input box.
  const queuedShown = Math.min(queued.length, 3);
  const queueRows = queued.length > 0 ? queuedShown + (queued.length > 3 ? 1 : 0) + 1 : 0;

  // The live-turn block is capped at half the screen: the input box must
  // stay visible while a long reply streams, and non-alt-screen ink can't
  // pin anything — a taller dynamic footer would push it below the fold.
  // Older turn entries crop from the top (bottom-anchored + overflow:hidden);
  // the full transcript lands in <Static> on stop.
  const MAX_TURN_ROWS = Math.max(6, Math.floor(rows / 2));
  // Bottom-anchored overflow:hidden also absorbs ink word-wrap vs hard-cut
  // estimate drift INSIDE this box: an undercounted row crops invisibly off
  // the top instead of stretching the footer past the fold.
  const turnBudget = Math.min(turnHeight(turn, cols), MAX_TURN_ROWS);

  return (
    <Box flexDirection="column" width={cols}>
      {/* Completed entries print ONCE into the terminal's own scrollback and
          are never re-rendered — native smooth scroll, selection, search all
          work, and history survives exit. */}
      <Static items={entries}>
        {(entry, index) => (
          <Box key={index} flexDirection="column" width={cols}>
            <EntryView entry={entry} />
          </Box>
        )}
      </Static>
      {props.replaying ? (
        <Text dimColor>
          <Spinner type="dots" /> restoring history…
        </Text>
      ) : null}

      {turn ? (
        <Box
          flexDirection="column"
          width={cols}
          height={turnBudget}
          overflow="hidden"
          justifyContent="flex-end"
        >
          {turn.entries.map((e, i) => (
            <EntryView key={i} entry={e} />
          ))}
          {turn.thinkBuf.trim() ? (
            <Text dimColor>⎿ thinking · {turn.thinkBuf.replace(/\s+/g, " ").slice(-120)}</Text>
          ) : null}
          {turn.textBuf ? <Text>{colorizeCodeFences(turn.textBuf)}</Text> : null}
          <Text dimColor>
            <Spinner type="dots" /> ctrl-c to cancel
          </Text>
        </Box>
      ) : null}

      {queued.length > 0 ? (
        <Box
          flexDirection="column"
          width={cols}
          height={queueRows}
          overflow="hidden"
          justifyContent="flex-end"
        >
          {queued.slice(0, 3).map((text, i) => (
            <Text key={`${i}:${text}`} dimColor>
              ⏸ queued · {text.length > cols - 16 ? `${text.slice(0, cols - 17)}…` : text}
            </Text>
          ))}
          {queued.length > 3 ? <Text dimColor>⏸ … +{queued.length - 3} more</Text> : null}
          {turn ? (
            <Text dimColor> esc stops the current turn and sends the next queued message</Text>
          ) : null}
        </Box>
      ) : null}

      <Box width={cols}>
        {sessionPick ? (
          <SessionPicker pick={sessionPick} index={sessIndex} cwd={process.cwd()} />
        ) : permission ? (
          <PermissionPicker prompt={permission} index={permIndex} />
        ) : question ? (
          <QuestionPicker prompt={question} state={q} />
        ) : (
          <InputLine
            busy={busy}
            status={status}
            editor={props.editor}
            applyEdit={props.applyEdit}
            quotaLine={props.quotaLine}
            onMenuOpenChange={props.onMenuOpenChange}
            onSubmitText={submit}
          />
        )}
      </Box>
    </Box>
  );
}

/**
 * `/sessions` picker: resumable sessions of the current project, newest last
 * (the backend orders by activity). Enter resumes; esc dismisses.
 */
function SessionPicker({
  pick,
  index,
  cwd,
}: {
  pick: SessionPick;
  index: number;
  cwd: string;
}): ReactElement {
  const win = pickerWindow(pick.items, index);
  const above = win.start;
  const below = pick.items.length - (win.start + win.slice.length);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold>
        sessions · {cwd} · {Math.min(index + 1, pick.items.length)}/{pick.items.length}
      </Text>
      {above > 0 ? <Text dimColor> … {above} newer above</Text> : null}
      {win.slice.map((s, i) => {
        const abs = win.start + i;
        const title = s.title?.trim() || "untitled";
        const age = relativeTime(s.updatedAt);
        const elsewhere = s.cwd && s.cwd !== cwd ? ` · ${s.cwd}` : "";
        return (
          <Box key={s.sessionId} paddingLeft={1}>
            <Text color={abs === index ? "cyan" : undefined}>
              {abs === index ? "❯ " : "  "}
              {title}
            </Text>
            <Text dimColor>
              {" "}
              {age ? `· ${age}` : ""}· {s.sessionId.slice(0, 8)}
              {elsewhere}
            </Text>
          </Box>
        );
      })}
      {below > 0 ? <Text dimColor> … {below} older below</Text> : null}
      <Text dimColor>↑/↓ select · enter resume · esc cancel</Text>
    </Box>
  );
}

function PermissionPicker({
  prompt,
  index,
}: {
  prompt: PermissionPrompt;
  index: number;
}): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text bold>{prompt.heading}</Text>
      <Text>{prompt.title}</Text>
      {prompt.detail ? (
        <Box marginTop={1}>
          <Text>{colorizeCodeFences(prompt.detail.trimEnd())}</Text>
        </Box>
      ) : null}
      {prompt.options.map((opt, i) => (
        <Box key={opt.id} paddingLeft={1} marginTop={i === 0 && prompt.detail ? 1 : 0}>
          <Text color={i === index ? "cyan" : undefined}>
            {i === index ? "❯ " : "  "}
            {opt.name}
          </Text>
        </Box>
      ))}
      <Text dimColor>↑/↓ select · enter confirm · esc cancel</Text>
    </Box>
  );
}

/**
 * AskUserQuestion picker: the question text as the heading (NOT a permission
 * shell), options below, and a built-in custom-answer row. Single-select:
 * enter picks. Multi-select: space toggles, enter confirms. esc/ctrl-c skips
 * the question (its key is omitted from the form response).
 */
function QuestionPicker({
  prompt,
  state,
}: {
  prompt: QuestionPrompt;
  state: PickerState;
}): ReactElement {
  const customRow = prompt.options.length; // index of the custom row
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold>❓ {prompt.title}</Text>
      {prompt.options.map((opt, i) => (
        <Box key={opt.value} paddingLeft={1}>
          <Text color={i === state.index ? "cyan" : undefined}>
            {i === state.index ? "❯ " : "  "}
            {prompt.multiSelect ? (state.toggled.includes(opt.value) ? "[●] " : "[ ] ") : ""}
            {opt.label}
          </Text>
        </Box>
      ))}
      {state.custom !== null ? (
        <Box paddingLeft={1}>
          <Text color="cyan">❯ ✎ </Text>
          <Text>{state.custom}</Text>
          <Text dimColor>▏</Text>
        </Box>
      ) : (
        <Box paddingLeft={1}>
          <Text
            color={state.index === customRow ? "cyan" : undefined}
            dimColor={state.index !== customRow}
          >
            {state.index === customRow ? "❯ " : "  "}✎ type a custom answer…
          </Text>
        </Box>
      )}
      <Text dimColor>
        {prompt.multiSelect
          ? "↑/↓ move · space toggle · enter confirm · esc skip"
          : "↑/↓ move · enter pick · esc skip"}
      </Text>
    </Box>
  );
}
