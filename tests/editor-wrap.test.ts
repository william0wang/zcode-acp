/**
 * Tests for the input line's visual wrap + caret placement
 * (src/repl/model.ts): hard-cut wrapping at display-column width (CJK-aware)
 * and caret row/offset resolution, including row-boundary carets.
 */

import { describe, expect, it } from "vitest";

import { editorTextRows, inputBoxRows, locateCaret, wrapEditorLine } from "../src/repl/model.js";

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
