/**
 * Opencode Go usage formatting.
 *
 * Renders the three windows (rolling 5h / weekly 7d / monthly 30d) as progress
 * bars identical in style to the GLM card, so the two sections read as one
 * cohesive card in the combined view. Reuses {@link renderBar} from the GLM
 * formatter for visual consistency.
 */

import { pickOverlay, renderColorBar } from "../color.js";
import { formatResetTime, renderBar } from "../format.js";
import type { GoQueryResult, GoWindowKey } from "./types.js";

/** Label + window-key metadata, in display order. */
const WINDOW_META: Array<{ key: GoWindowKey; label: string }> = [
  { key: "rolling", label: "5h" },
  { key: "weekly", label: "Week" },
  { key: "monthly", label: "Month" },
];

/**
 * Format a duration in seconds as a compact countdown.
 *
 * - `>= 1d`  → `Xd Yh` (e.g. `6d 8h`)
 * - `>= 1h`  → `Yh Zm` (e.g. `2h 30m`)
 * - `>= 1m`  → `Zm`    (e.g. `45m`)
 * - `< 1m`   → `<1m`
 */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 60) return "<1m";
  const s = Math.floor(sec);
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const mins = Math.floor((s % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Pad a percent to 2 chars (right-aligned), matching the GLM card. */
function padPercent(n: number): string {
  return String(n).padStart(2);
}

/** A rendered section: a header line and zero or more body lines. */
export interface RenderedSection {
  header: string;
  body: string[];
}

/**
 * Render the Opencode Go section for the requested windows.
 *
 * Used by the combined formatter. The header is always `Opencode Go`; body
 * has one bar line per window. Non-success kinds return a header + a single
 * explanatory line.
 *
 * When `color` is true the bar is a heat-colored 24-bit ANSI bar with the
 * percent overlaid inside (Go windows carry no absolute counters, so the
 * overlay is always `NN%`), mirroring the GLM color layout.
 */
export function formatGoSection(
  result: GoQueryResult,
  windows: readonly GoWindowKey[],
  now: number = Date.now(),
  color = false,
): RenderedSection {
  const header = "Opencode Go";

  if (result.kind !== "success") {
    const msg =
      result.kind === "not_configured"
        ? "not configured (set OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE)"
        : result.kind === "auth_error"
          ? "auth expired — refresh your opencode.ai cookie"
          : "unavailable";
    return { header, body: [msg] };
  }

  const elapsedSec = Math.max(0, (now - result.fetchedAt) / 1000);
  const body = WINDOW_META.filter((m) => windows.includes(m.key)).map((m) => {
    const w = result[m.key];
    if (!w) {
      return `${m.label.padEnd(5)} (no data)`;
    }
    // Live countdown: subtract elapsed time since the fetch snapshot, then
    // convert to an absolute reset timestamp (matches the GLM card's layout).
    const remainingSec = Math.max(0, w.resetInSec - elapsedSec);
    const resetAt = result.fetchedAt + remainingSec * 1000;
    const reset = formatResetTime(resetAt) ?? "<1m";
    if (color) {
      const bar = renderColorBar(w.usagePercent, {
        overlay: pickOverlay({ usedPercent: w.usagePercent }),
      });
      return `${m.label.padEnd(5)} ${bar} · ${reset}`;
    }
    const bar = renderBar(w.usagePercent);
    // No leading indent — the bar lines align with GLM's so the two sections
    // read as one card. The section header carries the ` Opencode Go` indent.
    return `${m.label.padEnd(5)} ${bar}  ${padPercent(w.usagePercent)}% · ${reset}`;
  });

  return { header, body };
}
