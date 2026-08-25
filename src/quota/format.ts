/**
 * Quota result formatting — renders a {@link QuotaResult} as a multi-line
 * plain-text card inside a ```text fenced block.
 *
 * The whole card is wrapped in a fenced code block so the editor renders it in
 * a monospace, bordered, copy-able frame. Monospace also normalises the block
 * element widths (▓/░ are NOT marked East-Asian-Wide, but some proportional
 * chat fonts stretch them; a code frame guarantees 1-cell-per-bar).
 *
 * The progress bar uses two block characters at {@link BAR_WIDTH}-cell width
 * for a clean, precise fill (each cell = 5%):
 *   █ (U+2588, full block) — used portion
 *   ░ (U+2591, light shade) — remaining portion
 * Inside a monospace code block the full-block reads as a solid, high-impact
 * fill for used quota, with the light shade marking the remainder.
 */

import { pickOverlay, renderColorBar } from "./color.js";
import type { QuotaItem, QuotaResult } from "./types.js";

/**
 * Progress-bar cell count. 20 cells = 5% granularity, fine enough to read
 * real usage at a glance while still fitting a code-block frame on one line.
 */
const BAR_WIDTH = 20;

/** Filled / empty cell characters. */
const CHAR_FULL = "█";
const CHAR_EMPTY = "░";

/** Pad a percent number to 2 chars (right-aligned). */
function padPercent(n: number): string {
  return String(n).padStart(2);
}

/**
 * Render a {@link BAR_WIDTH}-cell progress bar for a used-percent in [0, 100].
 *
 * 0% → all empty; 100% → all full; otherwise the used portion is `█` and the
 * rest is `░`, rounded to the nearest cell (each cell = 10%).
 */
export function renderBar(usedPercent: number): string {
  const clamped = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return CHAR_FULL.repeat(filled) + CHAR_EMPTY.repeat(empty);
}

/**
 * Format a reset timestamp (ms) as a local `MM-DD HH:MM` string, or `null`.
 *
 * Exported so the Opencode Go formatter can reuse the same layout (Go windows
 * carry only a relative `resetInSec`; the caller converts that to an absolute
 * ms timestamp against the fetch snapshot first).
 */
export function formatResetTime(nextResetTime?: number): string | null {
  if (nextResetTime === undefined || !Number.isFinite(nextResetTime)) return null;
  const d = new Date(nextResetTime);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

/** Capitalise the first letter of a plan level (e.g. "pro" → "Pro"). */
function capitalise(s: string): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Build the trailing annotation for an item: reset time first (so all items
 * align), then the absolute used counter last (only some limits carry it).
 */
function formatTrailing(item: QuotaItem): string {
  const parts: string[] = [];

  const reset = formatResetTime(item.nextResetTime);
  if (reset) parts.push(reset);

  // Absolute used counter — only some limit kinds carry it (MCP/TIME_LIMIT).
  // The total is intentionally omitted: it is a fixed allowance already
  // expressed by the percentage bar, so showing `/1000` adds no information.
  if (typeof item.usedCount === "number" && Number.isFinite(item.usedCount)) {
    parts.push(`${item.usedCount}`);
  }

  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/**
 * Color-mode trailing annotation: reset time only. The percent and the
 * used/total counter are already overlaid inside the colored bar (see
 * {@link pickOverlay}), so the right margin just carries the reset stamp.
 */
function formatTrailingColor(item: QuotaItem): string {
  const reset = formatResetTime(item.nextResetTime);
  return reset ? ` · ${reset}` : "";
}

/** Right-pad a model code for aligned detail sub-lines. */
const DETAIL_LABEL_WIDTH = 14;

/**
 * Options controlling which sections of the card are rendered.
 *
 * - `detail` (default `true`): show per-model usage breakdown sub-lines
 *   (`├ search-prime …`). Set to `false` for compact terminal output where the
 *   aggregate bar is enough.
 * - `compact` (default `false`): collapse the MCP item into a trailing
 *   annotation on the 5h line (`· MCP (used/total)`) and drop its standalone
 *   bar line + detail sub-lines. Used only by the combined dual-provider CLI
 *   view to keep the merged card short; the standalone `glm` subcommand and
 *   the `/quota` slash command keep the full layout.
 * - `color` (default `false`): render the bar as a heat-colored (green→red)
 *   24-bit ANSI bar with the usage numbers overlaid inside (see
 *   {@link pickOverlay}), leaving only the reset time on the right margin.
 *   Only the `zcode-acp quota` CLI sets this (gated on `stdout.isTTY`); the
 *   `/quota` slash command never does, so its fenced ```text card stays plain
 *   and copy-paste-safe.
 */
export interface FormatOptions {
  detail?: boolean;
  compact?: boolean;
  color?: boolean;
}

/** Resolve partial options into complete flags. */
function resolveOptions(opts?: FormatOptions): {
  detail: boolean;
  compact: boolean;
  color: boolean;
} {
  return {
    detail: opts?.detail ?? true,
    compact: opts?.compact ?? false,
    color: opts?.color ?? false,
  };
}

/** Render one quota item line (+ indented detail sub-lines if present). */
function formatItem(item: QuotaItem, showDetail: boolean, color = false): string[] {
  const lines: string[] = [];
  if (color) {
    // Color mode: the percent (or used/total) is overlaid inside the heat bar,
    // so the right margin carries only the reset stamp.
    const bar = renderColorBar(item.usedPercent, { overlay: pickOverlay(item) });
    lines.push(`${item.label.padEnd(5)} ${bar}${formatTrailingColor(item)}`);
  } else {
    const bar = renderBar(item.usedPercent);
    lines.push(
      `${item.label.padEnd(5)} ${bar}  ${padPercent(item.usedPercent)}%${formatTrailing(item)}`,
    );
  }

  if (showDetail && item.detail && item.detail.length > 0) {
    const last = item.detail.length - 1;
    item.detail.forEach((d, i) => {
      const branch = i === last ? "└" : "├";
      const name = d.modelCode.padEnd(DETAIL_LABEL_WIDTH);
      lines.push(`  ${branch} ${name}${d.usage}`);
    });
  }
  return lines;
}

/** Error/fallback messages keyed by `kind`. */
const STATUS_MESSAGES: Record<Exclude<QuotaResult["kind"], "success">, string> = {
  auth_error: "🔒 Quota auth expired — re-login in the ZCode app",
  rate_limited: "⏳ Quota service busy, try again shortly",
  unavailable: "⚠ Quota info unavailable",
};

/**
 * A rendered GLM section — a header (plan name) and the bar lines.
 *
 * Exported so the combined CLI view can compose the GLM section alongside the
 * Opencode Go section inside one card, without duplicating the per-item
 * formatting logic.
 */
export interface RenderedGlmSection {
  header: string;
  body: string[];
}

/**
 * Render the GLM section (header + one bar line per item) without the fence
 * or divider.
 *
 * Non-success kinds return a header of `"GLM Coding Plan"` and a single
 * explanatory body line, mirroring {@link formatQuota}'s non-success prose
 * (just split into header/body for composability).
 *
 * In `compact` mode the MCP item is collapsed into a trailing annotation on
 * the 5h line (`· MCP (used/total)`) and its own bar line + detail sub-lines
 * are dropped — used by the combined dual-provider CLI view to keep the merged
 * card short. The standalone `glm` subcommand and `/quota` slash command use
 * the full layout.
 */
export function renderGlmSection(result: QuotaResult, opts?: FormatOptions): RenderedGlmSection {
  const header = "GLM Coding Plan";
  if (result.kind !== "success") {
    return { header, body: [STATUS_MESSAGES[result.kind]] };
  }
  const { detail, compact, color } = resolveOptions(opts);
  const title = `${header}${result.level ? ` · ${capitalise(result.level)}` : ""}`;

  if (compact) {
    // Find the MCP item to fold into the 5h line as a trailing note.
    const mcp = result.items.find((it) => it.key === "mcp");
    const mcpNote = formatMcpNote(mcp);
    const body = result.items
      .filter((it) => it.key !== "mcp")
      .map((it) =>
        formatItem(it, false, color)[0]!.replace(
          /$/,
          mcpNote && it.key === "token_5h" ? mcpNote : "",
        ),
      );
    // If 5h is somehow absent but MCP exists, surface MCP as its own line so
    // the data isn't lost.
    const has5h = result.items.some((it) => it.key === "token_5h");
    if (mcp && !has5h && mcpNote) {
      body.push(formatItem(mcp, false, color)[0]!);
    }
    return { header: title, body };
  }

  const body = result.items.flatMap((item) => formatItem(item, detail, color));
  return { header: title, body };
}

/**
 * Build the MCP trailing note for compact mode: ` · MCP N` when the item
 * carries an absolute counter, ` · MCP NN%` when it only has a percentage, or
 * `""` when there is no MCP item.
 */
function formatMcpNote(mcp: QuotaItem | undefined): string {
  if (!mcp) return "";
  if (typeof mcp.usedCount === "number" && Number.isFinite(mcp.usedCount)) {
    return ` · MCP ${mcp.usedCount}`;
  }
  return ` · MCP ${padPercent(mcp.usedPercent)}%`;
}

/**
 * Render a {@link QuotaResult} as a multi-line plain-text card wrapped in a
 * ```text fenced block.
 *
 * The fence makes the editor render the card in a monospace, bordered, copy-
 * able frame — without it the proportional chat font mangles block-element
 * widths (▓/░ render at different glyph advances and can look stretched), and
 * the divider/bars lose their alignment.
 *
 * Success → header line + divider + one progress-bar line per item (plus
 * indented per-model detail where present). Non-success kinds → a single
 * explanatory line, unfenced (they are short prose, not a card).
 */
export function formatQuota(result: QuotaResult, opts?: FormatOptions): string {
  if (result.kind !== "success") {
    return STATUS_MESSAGES[result.kind];
  }

  const section = renderGlmSection(result, opts);
  // Divider spans the longest line so the frame looks balanced; 34 ≈ label(5)
  // + space(1) + bar(20) + spaces(2) + "NN%"(3) + trailing-room(3).
  const divider = "─".repeat(34);
  return ["```text", section.header, divider, ...section.body, "```"].join("\n");
}

/**
 * {@link formatQuota} without the ```text fence — for raw terminal output.
 *
 * The fence is only useful inside an editor chat frame (where it triggers a
 * bordered, copy-able code block). A real terminal renders the fence as
 * literal ```` ``` ```` characters, so the standalone CLI strips it.
 * Non-success kinds are already unfenced short prose, returned unchanged.
 */
export function formatQuotaPlain(result: QuotaResult, opts?: FormatOptions): string {
  const card = formatQuota(result, opts);
  return result.kind === "success" ? card.replace(/^```text\n/, "").replace(/\n```$/, "") : card;
}
