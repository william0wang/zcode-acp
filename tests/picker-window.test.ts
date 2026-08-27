/**
 * Tests for the pickers' sliding viewport (src/repl/model.ts): the window is
 * pinned to the head while the selection fits, then trails one row per step.
 */

import { describe, expect, it } from "vitest";

import { pickerWindow } from "../src/repl/model.js";

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe("pickerWindow", () => {
  it("shows the whole list when it fits", () => {
    const w = pickerWindow([1, 2, 3], 2, 8);
    expect(w).toEqual({ slice: [1, 2, 3], start: 0 });
  });

  it("pins to the head while the selection fits in the first window", () => {
    const items = range(20);
    expect(pickerWindow(items, 0, 8)).toEqual({ slice: range(8), start: 0 });
    expect(pickerWindow(items, 7, 8)).toEqual({ slice: range(8), start: 0 });
  });

  it("follows one row per step once the selection walks past an edge", () => {
    const items = range(20);
    expect(pickerWindow(items, 8, 8)).toEqual({
      slice: [1, 2, 3, 4, 5, 6, 7, 8],
      start: 1,
    });
  });

  it("clamps at the tail so the window stays full to the last item", () => {
    expect(pickerWindow(range(20), 19, 8)).toEqual({
      slice: [12, 13, 14, 15, 16, 17, 18, 19],
      start: 12,
    });
  });

  it("handles empty lists and out-of-range indices", () => {
    expect(pickerWindow([], 0)).toEqual({ slice: [], start: 0 });
    const w = pickerWindow(range(5), -50, 3);
    expect(w.start).toBe(0);
    const w2 = pickerWindow(range(5), 99, 3);
    expect(w2.slice).toEqual([2, 3, 4]);
  });
});
