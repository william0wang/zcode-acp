/**
 * Quota result formatting — renders a {@link QuotaResult} as a multi-line
 * plain-text card for the `agent_message_chunk` feedback.
 *
 * The progress bar uses two block characters at {@link BAR_WIDTH}-cell width
 * for a clean, precise fill (each cell = 10%):
 *   █ (U+2588, full)   — used portion
 *   ░ (U+2591, light)  — remaining portion
 */

import type { QuotaItem, QuotaResult } from "./types.js";

/** Progress-bar cell count. Compact to fit chat-frame width without wrapping. */
const BAR_WIDTH = 10;

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

/** Format a reset timestamp (ms) as a local `MM-DD HH:MM` string, or `null`. */
function formatResetTime(nextResetTime?: number): string | null {
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
 * align), then `(used/total)` last (only some limits carry absolute counters).
 */
function formatTrailing(item: QuotaItem): string {
  const parts: string[] = [];

  const reset = formatResetTime(item.nextResetTime);
  if (reset) parts.push(reset);

  // Absolute counters — only some limit kinds carry them (MCP/TIME does,
  // legacy TOKENS_LIMIT often does not). Placed last so the reset times of
  // counter-less items (e.g. 5h) stay left-aligned with counter-bearing ones.
  if (
    typeof item.usedCount === "number" &&
    typeof item.totalCount === "number" &&
    Number.isFinite(item.usedCount) &&
    Number.isFinite(item.totalCount)
  ) {
    parts.push(`(${item.usedCount}/${item.totalCount})`);
  }

  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/** Right-pad a model code for aligned detail sub-lines. */
const DETAIL_LABEL_WIDTH = 14;

/** Render one quota item line (+ indented detail sub-lines if present). */
function formatItem(item: QuotaItem): string[] {
  const lines: string[] = [];
  const bar = renderBar(item.usedPercent);
  lines.push(
    `${item.label.padEnd(5)} ${bar}  ${padPercent(item.usedPercent)}%${formatTrailing(item)}`,
  );

  if (item.detail && item.detail.length > 0) {
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
 * Render a {@link QuotaResult} as a multi-line plain-text card.
 *
 * Success → header line + divider + one progress-bar line per item (plus
 * indented per-model detail where present). Non-success kinds → a single
 * explanatory line.
 */
export function formatQuota(result: QuotaResult): string {
  if (result.kind !== "success") {
    return STATUS_MESSAGES[result.kind];
  }

  const header = `GLM Coding Plan${result.level ? ` · ${capitalise(result.level)}` : ""}`;
  const divider = "─".repeat(50);
  const body = result.items.flatMap(formatItem);
  return [header, divider, ...body].join("\n");
}
