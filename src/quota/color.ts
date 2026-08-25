/**
 * Color progress-bar rendering for the `zcode-acp quota` CLI.
 *
 * The default CLI view overlays the usage numbers directly onto a heat-colored
 * (green→yellow→red) bar using 24-bit ANSI background colors, so the percentage
 * or used/total counter reads from inside the bar and the right margin stays
 * short (just the reset time). `--plain` and the `/quota` slash command bypass
 * this module entirely and keep the classic monochrome `█`/`░` layout from
 * {@link renderBar}.
 *
 * Only real terminals render 24-bit color; the CLI caller gates this on
 * `process.stdout.isTTY` so piping to a file or another command never emits
 * raw escape codes.
 */

/** ANSI reset (cancel all attributes). */
export const RESET = "\x1b[0m";

/** 24-bit RGB triple. */
type Rgb = readonly [number, number, number];

/** ANSI 24-bit background-color escape. */
function bg(r: number, g: number, b: number): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}

/** ANSI 24-bit foreground (text) color escape. */
function fg(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Linear interpolation between two numbers, rounded to an 8-bit channel. */
function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Empty-cell background (constant dark gray, independent of usage). */
const EMPTY_BG: Rgb = [40, 40, 48];
/** Empty-cell foreground (muted gray text). */
const EMPTY_FG: Rgb = [120, 120, 130];
/** Fill-cell foreground (white text — high contrast on saturated fill). */
const FILL_FG: Rgb = [255, 255, 255];

/**
 * Green→yellow→red heat color for a usage percent.
 *
 * 0% → green `(34,197,94)`, 50% → yellow `(234,179,8)`, 100% → red
 * `(239,68,68)`, piecewise-linearly interpolated. Input is clamped to [0, 100].
 */
export function heatColor(pct: number): Rgb {
  const p = Math.max(0, Math.min(100, pct));
  if (p < 50) {
    const t = p / 50;
    return [lerp(34, 234, t), lerp(197, 179, t), lerp(94, 8, t)];
  }
  const t = (p - 50) / 50;
  return [lerp(234, 239, t), lerp(179, 68, t), lerp(8, 68, t)];
}

/**
 * Pick the overlay text drawn inside the bar.
 *
 * Returns `"used/total"` when the item carries both absolute counters (e.g. the
 * MCP limit), otherwise `"NN%"` (the rounded used percent). This lets
 * counter-bearing limits show their exact counts in-bar while counter-less
 * limits (5h, Opencode Go windows) show the percent.
 */
export function pickOverlay(item: {
  usedPercent: number;
  usedCount?: number;
  totalCount?: number;
}): string {
  if (
    typeof item.usedCount === "number" &&
    typeof item.totalCount === "number" &&
    Number.isFinite(item.usedCount) &&
    Number.isFinite(item.totalCount)
  ) {
    return `${item.usedCount}/${item.totalCount}`;
  }
  return `${Math.round(Math.max(0, Math.min(100, item.usedPercent)))}%`;
}

/** Options for {@link renderColorBar}. */
export interface ColorBarOptions {
  /** Text drawn centered inside the bar (e.g. `"73%"` or `"237/1000"`). */
  overlay?: string;
  /** Total cell count; defaults to 20 to match the plain {@link renderBar}. */
  width?: number;
}

/**
 * Render a heat-colored progress bar with optional centered overlay text.
 *
 * Each cell is one background color: the fill cells use {@link heatColor} (so
 * low usage reads green, high usage red), the empty cells use a constant dark
 * gray. When an overlay string is supplied its characters are written over the
 * bar with a contrasting foreground (white on fill, gray on empty), centered
 * across the `width` cells. The result always ends with {@link RESET} so the
 * color never leaks into the text that follows.
 */
export function renderColorBar(usedPercent: number, opts?: ColorBarOptions): string {
  const width = opts?.width ?? 20;
  const pct = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((pct / 100) * width);
  const [fr, fgg, fb] = heatColor(pct);

  const overlay = opts?.overlay ?? "";
  const overlayStart = Math.floor((width - overlay.length) / 2);

  let out = "";
  for (let i = 0; i < width; i++) {
    const isFill = i < filled;
    const [br, bgg, bb] = isFill ? [fr, fgg, fb] : EMPTY_BG;
    const idx = i - overlayStart;
    const ch = idx >= 0 && idx < overlay.length ? overlay[idx]! : " ";
    const [tr, tg, tb] = isFill ? FILL_FG : EMPTY_FG;
    out += `${bg(br, bgg, bb)}${fg(tr, tg, tb)}${ch}`;
  }
  return out + RESET;
}
