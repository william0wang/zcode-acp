/**
 * Tests for the input line's visual wrap + caret placement
 * (src/repl/model.ts): hard-cut wrapping at display-column width (CJK-aware)
 * and caret row/offset resolution, including row-boundary carets.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_PROMPT_CHARS,
  createLineEditor,
  insertAtCaret,
  planChunkOps,
  sanitizeInputChunk,
} from "../src/repl/input-buffer.js";
import { editorTextRows, inputBoxRows, locateCaret, wrapEditorLine } from "../src/repl/model.js";

describe("sanitizeInputChunk", () => {
  it("strips C0 controls and DEL (incl. escape bytes) but keeps text", () => {
    expect(sanitizeInputChunk("\x1b[200~pasted error /tmp/a.png\x1b[201~")).toBe(
      "[200~pasted error /tmp/a.png[201~",
    );
    expect(sanitizeInputChunk("ok\x00\x07text\x7f中")).toBe("oktext中");
    expect(sanitizeInputChunk("emoji 🎉 keep")).toBe("emoji 🎉 keep");
  });
});

describe("planChunkOps", () => {
  it("batches a long paste into a SINGLE insert op", () => {
    // Regression lock for the REPL paste crash: per-character ops meant one
    // ink rerender per char, blowing React's nested-update limit.
    const chunk = "E: TypeError: cannot read properties of undefined ".repeat(200);
    const ops = planChunkOps(chunk);
    expect(ops).toEqual([{ kind: "insert", text: chunk }]);
  });

  it("splits around semantic bytes so their key semantics survive", () => {
    const ops = planChunkOps("first\nsecond\tthird");
    expect(ops).toEqual([
      { kind: "insert", text: "first" },
      { kind: "char", ch: "\n" },
      { kind: "insert", text: "second" },
      { kind: "char", ch: "\t" },
      { kind: "insert", text: "third" },
    ]);
  });

  it("drops control junk from runs (bracketed-paste wrappers, binary)", () => {
    const ops = planChunkOps("\x1b[200~/tmp/a.png\x1b[201~");
    expect(ops).toEqual([{ kind: "insert", text: "[200~/tmp/a.png[201~" }]);
  });

  it("returns no ops for a chunk of non-semantic junk", () => {
    // \x00 and \x1b are plain garbage (stripped); ctrl-range bytes like
    // \x07/\x03 are SEMANTIC and must stay as char ops (next assertion).
    expect(planChunkOps("\x00\x1b")).toEqual([]);
  });

  it("keeps ctrl-range bytes as individual char ops (legacy semantics)", () => {
    expect(planChunkOps("ab\x03")).toEqual([
      { kind: "insert", text: "ab" },
      { kind: "char", ch: "\x03" },
    ]);
  });
});

describe("prompt size cap", () => {
  it("refuses inserts past MAX_PROMPT_CHARS instead of growing forever", () => {
    let ed = createLineEditor();
    ed = insertAtCaret(ed, "a".repeat(MAX_PROMPT_CHARS));
    expect(ed.text.length).toBe(MAX_PROMPT_CHARS);
    ed = insertAtCaret(ed, "b".repeat(100));
    expect(ed.text.length).toBe(MAX_PROMPT_CHARS);
  });

  it("inserts partially up to the cap", () => {
    let ed = insertAtCaret(createLineEditor(), "x".repeat(10));
    ed = insertAtCaret(ed, "y".repeat(5));
    expect(ed.text.endsWith("yyyyy")).toBe(true);
  });
});

describe("wrapEditorLine", () => {
  it("keeps short text on one row", () => {
    expect(wrapEditorLine("hello", 10)).toEqual([{ text: "hello", start: 0 }]);
  });

  it("returns one empty row for empty text", () => {
    expect(wrapEditorLine("", 10)).toEqual([{ text: "", start: 0 }]);
  });

  it("hard-cuts long ASCII lines at width", () => {
    const rows = wrapEditorLine("abcdefghij", 4);
    expect(rows.map((r) => r.text)).toEqual(["abcd", "efgh", "ij"]);
    expect(rows.map((r) => r.start)).toEqual([0, 4, 8]);
  });

  it("counts CJK characters as 2 columns", () => {
    // Each han char is 2 cols wide → 3 fit into width 6.
    const rows = wrapEditorLine("你好世界测试", 6);
    expect(rows.map((r) => r.text)).toEqual(["你好世", "界测试"]);
  });

  it("never splits a wide character across rows", () => {
    // Width 5: two han chars (4 cols) fit, the third would overflow → own row.
    const rows = wrapEditorLine("你好好", 5);
    expect(rows.map((r) => r.text)).toEqual(["你好", "好"]);
  });

  it("breaks a row wider than any single character cleanly", () => {
    expect(wrapEditorLine("ab", 1).map((r) => r.text)).toEqual(["a", "b"]);
    expect(wrapEditorLine("width0", 0)[0]).toEqual({ text: "width0", start: 0 });
  });
});

describe("locateCaret", () => {
  it("places start and end carets of a single-row line", () => {
    expect(locateCaret("hello", 0, 10)).toMatchObject({ row: 0, col: 0, rowOffset: 0 });
    expect(locateCaret("hello", 5, 10)).toMatchObject({ row: 0, col: 5, rowOffset: 5 });
  });

  it("moves to later rows as the caret advances past the cut", () => {
    const pos = locateCaret("abcdefghij", 6, 4);
    expect(pos.row).toBe(1);
    expect(pos.rowOffset).toBe(2);
    expect(pos.col).toBe(2);
    expect(pos.totalRows).toBe(3);
  });

  it("snaps a caret sitting exactly at the next row's head onto that row", () => {
    const pos = locateCaret("abcdef", 4, 4);
    expect(pos.row).toBe(1);
    expect(pos.rowOffset).toBe(0);
    expect(pos.col).toBe(0);
  });

  it("counts wide-character columns inside a mixed line", () => {
    // "a你好" in width 4 wraps after 你 (cols: 1+2 fit); a caret between
    // "a" and 你 stays on row 0 but the column must count 你 as 2 once
    // passed. A caret between 你 and 好 is an exact row boundary → next
    // row's head.
    const mid = locateCaret("a你好", 1, 4);
    expect(mid.row).toBe(0);
    expect(mid.rowOffset).toBe(1);
    // Caret between 你 (end of row 0) and 好 (overflowed to row 1) snaps to
    // the next row's head — same wrap-point convention as every other cut.
    const end = locateCaret("a你好", 2, 4);
    expect(end.row).toBe(1);
    expect(end.col).toBe(0);
    expect(end.rowOffset).toBe(0);
  });

  it("clamps out-of-range carets", () => {
    expect(locateCaret("abc", 99, 4)).toMatchObject({ row: 0, rowOffset: 3 });
    expect(locateCaret("abc", -5, 4)).toMatchObject({ row: 0, rowOffset: 0 });
  });
});

describe("editor layout reservation", () => {
  it("reserves border + status rows around wrapped text", () => {
    expect(inputBoxRows("", 100)).toBe(4); // 1 text + 3 chrome
    // Plenty of wrap room no matter what prefix is live.
    expect(inputBoxRows("x".repeat(500), 80)).toBeGreaterThanOrEqual(inputBoxRows("", 80) + 1);
  });

  it("grows monotonically with longer prompts", () => {
    const rows20 = editorTextRows("a".repeat(40), 20);
    const rows60 = editorTextRows("a".repeat(120), 20);
    expect(rows60).toBeGreaterThan(rows20);
  });
});
