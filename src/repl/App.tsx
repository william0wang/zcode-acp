/**
 * Ink UI for the interactive REPL (bare `zcode-acp`).
 *
 * Rendering model: completed transcript entries go to <Static> (appended once,
 * becomes native terminal scrollback); the live turn (streaming text, thinking
 * buffer, tool rows) plus the input line re-render below it. A pending
 * permission request takes over the input area with an arrow-key picker.
 */

import { Box, Static, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { Chalk } from "chalk";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import {
  applyCompletion,
  completionCandidates,
  isConfigCommand,
  selectLabel,
  type ReplEntry,
  type ReplStatus,
  type TurnState,
  type WelcomeInfo,
} from "./model.js";

/** A permission request awaiting the user's choice. */
export interface PermissionPrompt {
  title: string;
  options: Array<{ id: string; name: string }>;
}

export interface AppProps {
  /** Completed transcript entries (history). */
  entries: ReplEntry[];
  /** Live turn in progress, null when idle. */
  turn: TurnState | null;
  /** Pending permission request, null when none. */
  permission: PermissionPrompt | null;
  /** Session status: command menu + model/mode/thought selects. */
  status: ReplStatus;
  /** True while the bridge/session is starting up. */
  busy: boolean;
  onSubmit: (text: string) => void;
  onCancelTurn: () => void;
  onAnswerPermission: (optionId: string | null) => void;
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
  ctrl: boolean;
  meta: boolean;
} {
  return {
    return: ch === "\r" || ch === "\n",
    tab: ch === "\t",
    escape: false,
    backspace: ch === "\x7f" || ch === "\b",
    ctrl: ch >= "\x01" && ch <= "\x1a" && ch !== "\r" && ch !== "\n" && ch !== "\t",
    meta: false,
  };
}

/**
 * Self-managed input line. ink-text-input's submit/clear timing proved
 * unreliable under full external rerenders, so the line owns its value and
 * handles plain typing, backspace, and submit directly — first version has
 * no cursor movement or history, which is fine for a REPL.
 *
 * While the line is a slash command (or a config command's argument), an
 * interactive completion menu sits above the box: ↑/↓ move, tab/→ complete
 * the highlighted candidate, enter picks it when the line is a partial match
 * (exact input sends instead), esc dismisses.
 */
function InputLine({
  busy,
  status,
  onSubmitText,
}: {
  busy: boolean;
  status: ReplStatus;
  onSubmitText: (text: string) => void;
}): ReactElement {
  const [value, setValue] = useState("");
  const [selIdx, setSelIdx] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Mirror of `value` for event handlers: a decomposed chunk fires several
  // state updates in one tick, so closures over `value` would see the stale
  // pre-chunk line (and submit the wrong text on an embedded \r).
  const valueRef = useRef("");
  const applyValue = (fn: (v: string) => string): void => {
    valueRef.current = fn(valueRef.current);
    setValue(valueRef.current);
  };
  const submitWith = (text: string): void => {
    valueRef.current = "";
    setValue("");
    setDismissed(false);
    if (text.trim()) onSubmitText(text.trim());
  };
  const candidates = completionCandidates(value, status);
  const menu = !dismissed && candidates !== null && candidates.length > 0 ? candidates : null;
  // New keystroke → new filter: restart the selection and re-open a
  // previously dismissed menu.
  useEffect(() => {
    setSelIdx(0);
    setDismissed(false);
  }, [value]);

  const handleChar = (
    ch: string,
    k: {
      return: boolean;
      tab: boolean;
      escape: boolean;
      backspace: boolean;
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
      // tab (or →) completes the highlighted candidate; without a menu tab is
      // dropped so no literal tab ever lands in the line.
      if (k.tab || nav?.right) {
        if (menu) {
          const item = menu[selIdx] ?? menu[0]!;
          if (item) applyValue((v) => applyCompletion(v, item));
        }
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
        const line = valueRef.current;
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
      submitWith(valueRef.current);
      return;
    }
    if (k.backspace) {
      applyValue((v) => v.slice(0, -1));
      return;
    }
    if (ch && !k.ctrl && !k.meta) {
      applyValue((v) => v + ch);
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
        backspace: key.backspace || key.delete,
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
    <Box flexDirection="column">
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
          <Text>{value}</Text>
          <Text dimColor>▏</Text>
        </Box>
        <Box justifyContent="space-between" width="100%">
          <Text dimColor>{statusLine || "type / for commands · tab completes"}</Text>
          <Text dimColor>{busy ? "" : "enter send · ctrl-c cancels/quits"}</Text>
        </Box>
      </Box>
    </Box>
  );
}

export function App(props: AppProps): ReactElement {
  const { entries, turn, permission, status, busy } = props;
  // Second consecutive idle Ctrl-C exits; a turn-running Ctrl-C only cancels.
  const idleIntCount = useRef(0);

  const submit = useCallback(
    (text: string) => {
      props.onSubmit(text);
    },
    [props],
  );

  useInput((inputChar, key) => {
    if (permission) {
      // The picker owns the keyboard; selection state lives there.
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

  return (
    <Box flexDirection="column">
      <Static items={entries}>{(entry, i) => <EntryView key={i} entry={entry} />}</Static>

      {turn ? (
        <Box flexDirection="column">
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

      {permission ? (
        <PermissionPicker
          prompt={permission}
          onAnswer={props.onAnswerPermission}
          onCancel={() => props.onAnswerPermission(null)}
        />
      ) : (
        <InputLine busy={busy} status={status} onSubmitText={submit} />
      )}
    </Box>
  );
}

function PermissionPicker({
  prompt,
  onAnswer,
  onCancel,
}: {
  prompt: PermissionPrompt;
  onAnswer: (optionId: string) => void;
  onCancel: () => void;
}): ReactElement {
  const [index, setIndex] = useState(0);
  useInput((inputChar, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIndex((i) => Math.min(prompt.options.length - 1, i + 1));
    else if (key.return) onAnswer(prompt.options[index]!.id);
    else if (key.escape || (key.ctrl && inputChar === "c") || inputChar?.includes("\x03"))
      onCancel();
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text bold>permission requested</Text>
      <Text>{prompt.title}</Text>
      {prompt.options.map((opt, i) => (
        <Box key={opt.id} paddingLeft={1}>
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
