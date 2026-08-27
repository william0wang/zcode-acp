/**
 * Single-line editor state for the REPL input box — caret movement plus
 * insertion/deletion at the caret. Pure functions so the component stays a
 * thin shell and the behavior is unit-testable.
 *
 * The caret counts CODE POINTS (`Array.from`), not UTF-16 units, so emoji
 * (surrogate pairs) step over as one position even though typical CJK input
 * needs no special handling either way.
 */

export interface LineEditor {
  /** The editable line text. */
  text: string;
  /** Caret as a code-point offset; always within [0, cpCount(text)]. */
  caret: number;
}

export function createLineEditor(): LineEditor {
  return { text: "", caret: 0 };
}

const toArray = (text: string): string[] => Array.from(text);

/** Whole-line replacement (completion results), caret parked at the end. */
export function replaceText(text: string): LineEditor {
  return { text, caret: toArray(text).length };
}

export function insertAtCaret(editor: LineEditor, str: string): LineEditor {
  if (!str) return editor;
  const parts = toArray(editor.text);
  parts.splice(editor.caret, 0, ...toArray(str));
  return { text: parts.join(""), caret: editor.caret + toArray(str).length };
}

/** Remove the character BEFORE the caret (Backspace). */
export function backspaceAtCaret(editor: LineEditor): LineEditor {
  if (editor.caret === 0) return editor;
  const parts = toArray(editor.text);
  parts.splice(editor.caret - 1, 1);
  return { text: parts.join(""), caret: editor.caret - 1 };
}

/** Remove the character AT/after the caret (Forward Delete). */
export function deleteAtCaret(editor: LineEditor): LineEditor {
  const parts = toArray(editor.text);
  if (editor.caret >= parts.length) return editor;
  parts.splice(editor.caret, 1);
  return { ...editor, text: parts.join("") };
}

function move(editor: LineEditor, delta: number): LineEditor {
  const max = toArray(editor.text).length;
  const caret = Math.min(max, Math.max(0, editor.caret + delta));
  return caret === editor.caret ? editor : { ...editor, caret };
}

export function caretLeft(editor: LineEditor): LineEditor {
  return move(editor, -1);
}

export function caretRight(editor: LineEditor): LineEditor {
  return move(editor, 1);
}

export function caretToStart(editor: LineEditor): LineEditor {
  return { ...editor, caret: 0 };
}

export function caretToEnd(editor: LineEditor): LineEditor {
  return replaceText(editor.text);
}

/**
 * Resolve a Ctrl-B/F/A/E/U chord to its letter, or null when the key isn't
 * one of our chords. Two delivery shapes exist and both must match:
 * - single keypress: ink's parse-keypress normalizes `\x02` to name "b" plus
 *   the ctrl flag, so useInput hands us the LETTER;
 * - control bytes coalesced into one multi-char data chunk get decomposed by
 *   InputLine's derivedKey() and arrive as the RAW byte (`"\x02"`).
 */
const CHORD_LETTERS = ["b", "f", "a", "e", "u"];

export function ctrlChord(ch: string): "b" | "f" | "a" | "e" | "u" | null {
  if (ch.length !== 1) return null;
  let letter: string;
  if (ch >= "a" && ch <= "z") {
    letter = ch;
  } else {
    const code = ch.charCodeAt(0); // \x01..\x1a — Ctrl-letter byte form
    if (code < 1 || code > 26) return null;
    letter = String.fromCharCode(code + 96);
  }
  return (CHORD_LETTERS as string[]).includes(letter)
    ? (letter as "b" | "f" | "a" | "e" | "u")
    : null;
}
