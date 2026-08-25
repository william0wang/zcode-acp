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
import { useCallback, useRef, useState, type ReactElement } from "react";

import { splitBulkInput, type ReplEntry, type TurnState } from "./model.js";

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
  }
}

/**
 * Self-managed input line. ink-text-input's submit/clear timing proved
 * unreliable under full external rerenders, so the line owns its value and
 * handles plain typing, backspace, and submit directly — first version has
 * no cursor movement or history, which is fine for a REPL.
 */
function InputLine({
  busy,
  onSubmitText,
}: {
  busy: boolean;
  onSubmitText: (text: string) => void;
}): ReactElement {
  const [value, setValue] = useState("");
  const submitWith = (text: string): void => {
    setValue("");
    if (text.trim()) onSubmitText(text.trim());
  };
  useInput((inputChar, key) => {
    if (key.return) {
      submitWith(value);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (inputChar && !key.ctrl && !key.meta) {
      // Bulk stdin writes (pasted text, scripted ptys) arrive as ONE event
      // that may embed \r/\n — ink only maps a lone \r to key.return. Treat
      // every embedded CR/LF as a submit boundary; the last segment stays
      // buffered as the new in-progress line.
      if (/[\r\n]/.test(inputChar)) {
        const { submits, buffer } = splitBulkInput(value, inputChar);
        for (const line of submits) {
          submitWith(line);
        }
        setValue(buffer);
        return;
      }
      setValue((v) => v + inputChar);
    }
  });
  return (
    <Box borderStyle="round" borderColor={busy ? "gray" : "cyan"} paddingX={1}>
      <Text dimColor>{busy ? "starting… " : "❯ "}</Text>
      <Text>{value}</Text>
      <Text dimColor>▏</Text>
    </Box>
  );
}

export function App(props: AppProps): ReactElement {
  const { entries, turn, permission, busy } = props;
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
    if (key.ctrl && inputChar === "c") {
      if (turn) {
        props.onCancelTurn();
        idleIntCount.current = 0;
      } else {
        idleIntCount.current += 1;
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
        <InputLine busy={busy} onSubmitText={submit} />
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
    else if (key.escape || (key.ctrl && inputChar === "c")) onCancel();
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
