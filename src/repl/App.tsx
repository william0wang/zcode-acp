/**
 * Ink UI for the interactive REPL (bare `zcode-acp`).
 *
 * Rendering model: completed transcript entries go to <Static> (appended once,
 * becomes native terminal scrollback); the live turn (streaming text, thinking
 * buffer, tool rows) plus the input line re-render below it. A pending
 * permission request takes over the input area with an arrow-key picker.
 */

import { Box, Text, useInput, type Key } from "ink";
import Spinner from "ink-spinner";
import { Chalk } from "chalk";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import {
  applyCompletion,
  completionCandidates,
  estimateLines,
  isConfigCommand,
  relativeTime,
  selectLabel,
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
  replaceText,
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
  /** Completed transcript entries (history). */
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
  /** Bumped on every terminal resize — remounts <Static> for a full repaint. */
  resizeTick: number;
  /**
   * Pinned-older-lines viewport offset. Lives in run.ts's external store,
   * NOT in component state: the state MUST survive forceRedraw()'s
   * unmount+fresh-render cycles or every forced repaint silently resets
   * scrollback (and wipes a wheel/paging position with it).
   */
  scrollOffset: number;
  /** Move the scroll offset by a signed amount (clamped at >= 0). */
  onScrollDelta: (deltaLines: number) => void;
  /** Snap back to the live tail (submit / explicit return-to-tail). */
  onScrollReset: () => void;
  /** Session status: command menu + model/mode/thought selects. */
  status: ReplStatus;
  /** True while the bridge/session is starting up. */
  busy: boolean;
  /**
   * The prompt line's editor state (text + caret), owned by run.ts like the
   * other cross-repaint state — a Ctrl-L remount must never eat a draft.
   */
  editor: LineEditor;
  /** Apply one pure editor op to the prompt line and repaint. */
  applyEdit: (op: (e: LineEditor) => LineEditor) => void;
  onSubmit: (text: string) => void;
  onCancelTurn: () => void;
  onAnswerPermission: (optionId: string | null) => void;
  onAnswerQuestion: (answer: QuestionAnswer | null) => void;
  /** null = dismiss the picker without resuming. */
  onPickSession: (sessionId: string | null) => void;
  /** Force a full-frame repaint (Ctrl-L) after terminal buffer corruption. */
  onRedraw: () => void;
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
        <Text dimColor>{"  ctrl-l   repaint the screen (after terminal scroll glitches)"}</Text>
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
  onSubmitText,
}: {
  busy: boolean;
  status: ReplStatus;
  editor: LineEditor;
  applyEdit: (op: (e: LineEditor) => LineEditor) => void;
  onSubmitText: (text: string) => void;
}): ReactElement {
  // `ed` mirrors props.editor for the render below; edits go through
  // applyEdit so the state survives Ctrl-L's unmount+fresh-render cycles.
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
        setSelIdx((i) => Math.min(menu!.length - 1, i + 1));
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
      applyEdit((cur) => insertAtCaret(cur, ch));
    }
  };

  useInput((inputChar, key) => {
    // Coalesced printable chunk (paste, rapid keys) — decompose per char so
    // embedded \r/\n/\t keep submit/tab semantics. Escape-sequence chunks
    // (arrow keys flushed together) keep ink's parsed flags instead.
    if (inputChar && inputChar.length > 1 && !inputChar.includes("\x1b") && !key.ctrl) {
      for (const ch of inputChar) {
        handleChar(ch, derivedKey(ch), null);
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
  // mirroring the editor dropdown state.
  const statusLine = [
    selectLabel(status.model),
    selectLabel(status.mode),
    selectLabel(status.thought),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    // width="100%": the chrome parent is a row Box, so without an explicit
    // width the whole subtree shrink-wraps to its longest line and the
    // bordered input box stops spanning the terminal.
    <Box flexDirection="column" width="100%">
      {menu ? (
        <Box flexDirection="column" paddingLeft={2}>
          {menu.map((m, i) => (
            <Text key={`${m.label}:${m.value}`} color={i === selIdx ? "cyan" : undefined}>
              {i === selIdx ? "❯ " : "  "}
              {m.current ? "● " : "  "}
              {m.label}
              {m.description ? ` — ${m.description}` : ""}
            </Text>
          ))}
          <Text dimColor> ↑/↓ select · tab or enter picks · esc dismiss</Text>
        </Box>
      ) : null}
      <Box
        borderStyle="round"
        borderColor={busy ? "gray" : "cyan"}
        paddingX={1}
        width="100%"
        flexDirection="column"
      >
        <Box>
          <Text dimColor>{busy ? "starting… " : "❯ "}</Text>
          {(() => {
            // Block cursor on the character at the caret (a space past the
            // end) — makes ←/→ editing visible, unlike the old tail-pinned ▏.
            const parts = Array.from(ed.text);
            const before = parts.slice(0, ed.caret).join("");
            const atCaret = parts.slice(ed.caret, ed.caret + 1).join("");
            const after = parts.slice(ed.caret + 1).join("");
            return (
              <>
                <Text>{before}</Text>
                <Text backgroundColor="white" color="black">
                  {atCaret || " "}
                </Text>
                {after ? <Text>{after}</Text> : null}
              </>
            );
          })()}
        </Box>
        <Box justifyContent="space-between" width="100%">
          <Text dimColor>{statusLine || "type / for commands · tab completes"}</Text>
          <Text dimColor> </Text>
          <Text dimColor>{busy ? "" : "enter send · ctrl-c cancels/quits"}</Text>
        </Box>
      </Box>
    </Box>
  );
}

/** Rendered height of one transcript entry, including its top margin. */
function entryHeight(entry: ReplEntry, width: number): number {
  switch (entry.kind) {
    case "user":
      return 1 + estimateLines(entry.text, width);
    case "welcome":
      return 1 + 11; // marginTop + branding/session/config/tips block
    case "tool":
      // Tool rows wrap when the title is long — count them like text.
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
  // Throttle for page-key-triggered forced repaints (key repeat guard).
  const lastRedrawAt = useRef(0);

  // Full-screen app layout (alternate screen): the transcript is an in-app
  // viewport above the input chrome — nothing ever prints to the terminal's
  // own scrollback, so resizes just re-wrap the whole app cleanly.
  // Full terminal width — no centered reading column; every region spans cols.
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 24;

  // --- scroll state ---
  // Value comes from run.ts's external store (see AppProps); this component
  // only reads it and requests deltas/resets.
  const scrollOffset = props.scrollOffset;

  const submit = useCallback(
    (text: string) => {
      // Own messages must be visible immediately — leave pinned scrollback.
      props.onScrollReset();
      props.onSubmit(text);
    },
    [props],
  );

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
    // Ctrl-L — vim-convention full repaint. Terminals that scroll into their
    // own buffer while an alternate-screen app runs (Warp notably) can garble
    // the screen without the app ever hearing about it; ink only writes
    // diffs, so a manual forced repaint is the recovery path.
    if ((key.ctrl && inputChar === "l") || (inputChar ?? "").includes("\x0c")) {
      props.onRedraw();
      return;
    }
    // Scrollback paging — inert while a picker owns the keyboard. Each page
    // key also forces a throttled full repaint: the typical moment for it is
    // right after scrolling the terminal's own buffer (Warp garbles the
    // alternate screen there and ink's diffs can't heal it).
    if (key.pageUp || key.pageDown || key.home || key.end) {
      if (sessionPick || question || permission) return;
      const viewport = Math.max(3, rows - CHROME_ROWS);
      if (key.home) props.onScrollDelta(Number.MAX_SAFE_INTEGER);
      else if (key.end) props.onScrollReset();
      else if (key.pageUp) props.onScrollDelta(Math.floor(viewport * 0.8));
      else props.onScrollDelta(-Math.floor(viewport * 0.8));
      const now = Date.now();
      if (now - lastRedrawAt.current > 400) {
        lastRedrawAt.current = now;
        props.onRedraw();
      }
      return;
    }
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
    // Esc with prompts waiting: interrupt the running turn — the stop
    // handler drains the queue, so the next queued message starts at once.
    if (key.escape && turn && queued.length > 0) {
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
    const isSkip =
      key.escape || (key.ctrl && inputChar === "c") || (inputChar ?? "").includes("\x03");
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
    if (key.escape || (key.ctrl && inputChar === "c") || (inputChar ?? "").includes("\x03")) {
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
    if (key.escape || (key.ctrl && inputChar === "c") || (inputChar ?? "").includes("\x03")) {
      props.onAnswerPermission(null);
    }
  }

  // Fixed rows reserved for the input chrome (input box + status line +
  // scroll indicator + safety margin). Everything above is transcript.
  const CHROME_ROWS = 6;
  // The queued-prompts panel sits between the turn block and the input box.
  const queuedShown = Math.min(queued.length, 3);
  const queueRows = queued.length > 0 ? queuedShown + (queued.length > 3 ? 1 : 0) + 1 : 0;
  const viewportRows = Math.max(3, rows - CHROME_ROWS - queueRows - turnHeight(turn, cols));
  // Render only the visible tail of the transcript: cost per frame stays
  // constant no matter how long the session grows. `scrollOffset` pins older
  // lines while the user reads back; overflow:hidden crops the top edge.
  const heights = entries.map((e) => entryHeight(e, cols));
  const total = heights.reduce((a, b) => a + b, 0);
  const maxOffset = Math.max(0, total - viewportRows);
  const offset = Math.min(scrollOffset, maxOffset);
  let start = entries.length;
  for (let avail = viewportRows - offset; start > 0; start--) {
    const h = heights[start - 1]!;
    if (avail - h < 0) break;
    avail -= h;
  }
  if (start > 0 && viewportRows - offset > 0) start--; // partial top entry
  const visible = entries.slice(start);

  return (
    <Box flexDirection="column" height={rows} width={cols}>
      <Box
        flexDirection="column"
        width={cols}
        height={viewportRows}
        overflow="hidden"
        justifyContent="flex-end"
      >
        {visible.map((entry, i) => (
          <EntryView key={start + i} entry={entry} />
        ))}
      </Box>
      {offset > 0 ? (
        <Box width={cols}>
          <Text dimColor> ↑ {offset} lines hidden — pageDown or end returns to the live tail</Text>
        </Box>
      ) : null}

      {turn ? (
        <Box flexDirection="column" width={cols}>
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
        <Box flexDirection="column" width={cols}>
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
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold>sessions · {cwd}</Text>
      {pick.items.map((s, i) => {
        const title = s.title?.trim() || "untitled";
        const age = relativeTime(s.updatedAt);
        const elsewhere = s.cwd && s.cwd !== cwd ? ` · ${s.cwd}` : "";
        return (
          <Box key={s.sessionId} paddingLeft={1}>
            <Text color={i === index ? "cyan" : undefined}>
              {i === index ? "❯ " : "  "}
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
