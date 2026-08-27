import { describe, expect, it } from "vitest";

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
} from "../src/repl/input-buffer.js";

const typed = (...chars: string[]) => chars.reduce(insertAtCaret, createLineEditor());

describe("LineEditor", () => {
  it("starts empty and inserts at the end by default", () => {
    expect(createLineEditor()).toEqual({ text: "", caret: 0 });
    expect(typed("h", "i")).toEqual({ text: "hi", caret: 2 });
  });

  it("moves the caret left/right with clamping at both ends", () => {
    const ed = typed("a", "b", "c");
    expect(caretLeft(ed)).toMatchObject({ caret: 2 });
    expect(caretLeft(caretLeft(ed))).toMatchObject({ caret: 1 });
    let l = ed;
    for (let i = 0; i < 10; i++) l = caretLeft(l);
    expect(l).toMatchObject({ caret: 0 });
    for (let i = 0; i < 10; i++) l = caretRight(l);
    expect(l).toMatchObject({ caret: 3 });
    // At-rest moves return the SAME editor (no state churn).
    const atStart = caretToStart(ed);
    expect(caretLeft(atStart)).toBe(atStart);
    expect(caretRight(ed)).toBe(ed);
  });

  it("inserts before the caret when moved back", () => {
    const ed = typed("a", "b", "c");
    expect(insertAtCaret(caretLeft(ed), "X")).toEqual({ text: "abXc", caret: 3 });
  });

  it("backspace removes BEFORE the caret, delete removes AT it", () => {
    const ed = typed("a", "b", "c");
    const mid = caretLeft(caretLeft(ed)); // a|bc
    expect(backspaceAtCaret(mid)).toEqual({ text: "bc", caret: 0 });
    expect(deleteAtCaret(mid)).toEqual({ text: "ac", caret: 1 });
    // Boundary no-ops: backspace at start, delete at end.
    const atStart = caretToStart(ed);
    expect(backspaceAtCaret(atStart)).toBe(atStart);
    expect(deleteAtCaret(ed)).toBe(ed);
  });

  it("home/end jump to the line boundaries", () => {
    const ed = typed("a", "b");
    expect(caretToStart(caretLeft(ed))).toMatchObject({ caret: 0 });
    expect(caretToEnd(caretLeft(ed))).toMatchObject({ caret: 2 });
  });

  it("replacing the line (completions) parks the caret at the new end", () => {
    expect(replaceText("/model plan")).toEqual({ text: "/model plan", caret: 11 });
  });

  it("counts emoji as one caret step (code points, not UTF-16 units)", () => {
    // 🙂 is a surrogate PAIR in JS strings but ONE code point.
    const afterEmoji = typed("\u{1F642}"); // 🙂|
    expect(afterEmoji.caret).toBe(1);
    expect(backspaceAtCaret(afterEmoji)).toEqual({ text: "", caret: 0 });
    // Inserting mid-line next to the pair keeps code-point indexing sane.
    const mid = { ...afterEmoji, caret: 1 };
    expect(insertAtCaret(mid, "x")).toEqual({ text: "\u{1F642}x", caret: 2 });
  });

  it("handles CJK text like single-unit characters", () => {
    const ed = typed("你", "好");
    expect(caretLeft(ed)).toMatchObject({ caret: 1 });
    expect(backspaceAtCaret(ed)).toEqual({ text: "你", caret: 1 });
  });

  it("empty insertions are a no-op returning the same editor", () => {
    const ed = typed("a");
    expect(insertAtCaret(ed, "")).toBe(ed);
  });
});

describe("ctrlChord", () => {
  it("accepts the letter form (single keypress via ink parse-keypress)", () => {
    expect(ctrlChord("b")).toBe("b");
    expect(ctrlChord("e")).toBe("e");
  });

  it("accepts the raw control-byte form (coalesced chunk decomposition)", () => {
    expect(ctrlChord("\x02")).toBe("b"); // ctrl-b
    expect(ctrlChord("\x06")).toBe("f"); // ctrl-f
    expect(ctrlChord("\x01")).toBe("a"); // ctrl-a
    expect(ctrlChord("\x05")).toBe("e"); // ctrl-e
    expect(ctrlChord("\x15")).toBe("u"); // ctrl-u
  });

  it("rejects non-chord control bytes, other letters, and empty input", () => {
    expect(ctrlChord("\x03")).toBeNull(); // ctrl-c must stay a cancel
    expect(ctrlChord("\x04")).toBeNull();
    expect(ctrlChord("d")).toBeNull();
    expect(ctrlChord("\x02\x02")).toBeNull(); // never multi-char here
    expect(ctrlChord("")).toBeNull();
  });
});
