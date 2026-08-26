/**
 * Tests for the 24-bit color progress bar used by the `zcode-acp quota` CLI's
 * default (heat) mode. The `/quota` slash command never touches this module —
 * it stays on the plain `renderBar`.
 */

import { describe, expect, it } from "vitest";

import { heatColor, pickOverlay, renderColorBar, RESET } from "../src/quota/color.js";

// ANSI ESC character. Constructed via charCode so regex literals don't trip the
// `no-control-regex` lint rule (which flags literal \x1b in patterns).
const ESC = String.fromCharCode(27);
// Strip every ANSI escape sequence (SGR etc.) from a string, leaving only the
// visible characters. Used to assert on what the user actually sees.
const stripAnsi = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

describe("heatColor", () => {
  it("0% → green", () => {
    expect(heatColor(0)).toEqual([34, 197, 94]);
  });

  it("100% → red", () => {
    expect(heatColor(100)).toEqual([239, 68, 68]);
  });

  it("50% → yellow (the midpoint)", () => {
    expect(heatColor(50)).toEqual([234, 179, 8]);
  });

  it("interpolates linearly in the lower half (25% between green and yellow)", () => {
    // t = 0.5 → halfway between green (34,197,94) and yellow (234,179,8).
    expect(heatColor(25)).toEqual([
      Math.round((34 + 234) / 2),
      Math.round((197 + 179) / 2),
      Math.round((94 + 8) / 2),
    ]);
  });

  it("clamps inputs outside [0, 100]", () => {
    expect(heatColor(150)).toEqual([239, 68, 68]);
    expect(heatColor(-10)).toEqual([34, 197, 94]);
  });
});

describe("pickOverlay", () => {
  it("returns used/total when both counters are finite numbers", () => {
    expect(pickOverlay({ usedPercent: 14, usedCount: 237, totalCount: 1000 })).toBe("237/1000");
  });

  it("returns NN% when no counters are present", () => {
    expect(pickOverlay({ usedPercent: 73 })).toBe("73%");
  });

  it("returns NN% when only usedCount is present (no total)", () => {
    // A partial counter pair carries no more info than the percent.
    expect(pickOverlay({ usedPercent: 42, usedCount: 237 })).toBe("42%");
  });

  it("returns NN% when only totalCount is present", () => {
    expect(pickOverlay({ usedPercent: 42, totalCount: 1000 })).toBe("42%");
  });

  it("keeps one fractional digit for decimal percents (Opencode Go 0.1 steps)", () => {
    expect(pickOverlay({ usedPercent: 72.6 })).toBe("72.6%");
    expect(pickOverlay({ usedPercent: 72.4 })).toBe("72.4%");
    // More than one decimal rounds to one, not away.
    expect(pickOverlay({ usedPercent: 72.44 })).toBe("72.4%");
  });

  it("renders integer percents bare, including after 1-decimal rounding", () => {
    expect(pickOverlay({ usedPercent: 73 })).toBe("73%");
    // Near-boundary decimals collapse to the bare integer, never "100.0%".
    expect(pickOverlay({ usedPercent: 99.96 })).toBe("100%");
    expect(pickOverlay({ usedPercent: 0.04 })).toBe("0%");
  });

  it("clamps percent outside [0, 100] before formatting", () => {
    expect(pickOverlay({ usedPercent: 150 })).toBe("100%");
    expect(pickOverlay({ usedPercent: -10 })).toBe("0%");
  });

  it("treats non-finite counters as absent (falls back to NN%)", () => {
    expect(pickOverlay({ usedPercent: 50, usedCount: NaN, totalCount: 1000 })).toBe("50%");
    expect(pickOverlay({ usedPercent: 50, usedCount: 237, totalCount: Infinity })).toBe("50%");
  });
});

describe("renderColorBar", () => {
  it("emits 24-bit background and foreground escapes plus a reset", () => {
    const bar = renderColorBar(50);
    expect(bar).toContain(`${ESC}[48;2;`); // bg color
    expect(bar).toContain(`${ESC}[38;2;`); // fg color
    expect(bar.endsWith(RESET)).toBe(true);
  });

  it("uses the fill (heat) color on used cells and the empty color on the rest", () => {
    // At 50% with width 20: cells 0–9 are fill (yellow 234,179,8), 10–19 are
    // empty (40,40,48). Both background escapes must appear.
    const bar = renderColorBar(50);
    expect(bar).toContain(`${ESC}[48;2;234;179;8m`); // yellow fill bg
    expect(bar).toContain(`${ESC}[48;2;40;40;48m`); // empty bg
  });

  it("at 0% every cell is empty (no fill color present)", () => {
    const bar = renderColorBar(0);
    expect(bar).not.toContain(`${ESC}[48;2;34;197;94m`); // green fill (0% heat)
    expect(bar).toContain(`${ESC}[48;2;40;40;48m`);
  });

  it("at 100% every cell is fill (no empty color present)", () => {
    const bar = renderColorBar(100);
    expect(bar).not.toContain(`${ESC}[48;2;40;40;48m`);
    expect(bar).toContain(`${ESC}[48;2;239;68;68m`); // red fill (100% heat)
  });

  it("places the overlay text centered across the bar width", () => {
    // width 20, overlay "73%" (len 3) → start at floor((20-3)/2) = 8.
    // Cell 8 carries '7', cell 9 '3', cell 10 '%'. We strip every ANSI escape
    // and check the remaining visible characters are the centered overlay with
    // space padding around it.
    const visible = stripAnsi(renderColorBar(73, { overlay: "73%" }));
    expect(visible).toHaveLength(20);
    expect(visible.slice(8, 11)).toBe("73%");
    expect(visible.slice(0, 8)).toBe(" ".repeat(8));
    expect(visible.slice(11)).toBe(" ".repeat(9));
  });

  it("default width is 20 (matches the plain renderBar)", () => {
    expect(stripAnsi(renderColorBar(42))).toHaveLength(20);
  });

  it("honors a custom width", () => {
    expect(stripAnsi(renderColorBar(50, { width: 10 }))).toHaveLength(10);
  });

  it("omits overlay text when none is given (visible chars are all spaces)", () => {
    const visible = stripAnsi(renderColorBar(42));
    expect(visible).toBe(" ".repeat(20));
  });

  it("clamps percent outside [0, 100]", () => {
    // 150% should render identically to 100% (all fill, red).
    expect(renderColorBar(150)).toBe(renderColorBar(100));
    expect(renderColorBar(-10)).toBe(renderColorBar(0));
  });
});
