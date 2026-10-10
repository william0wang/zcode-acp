/**
 * Ollama Cloud usage formatting.
 *
 * Renders the plan's usage windows as progress bars in the same style as the
 * GLM and Opencode Go sections, so all sections read as one card in the
 * combined view. Which windows exist depends on the account's plan: legacy
 * plans expose session (5h) + weekly; current credit plans expose monthly.
 * The API exposes no reset timestamps, so the reset moments are derived at
 * query time (window anchoring, or /api/me's billing period for monthly) and
 * rendered as the same `MM-DD HH:MM` trailing stamp the other providers use —
 * absent when the monthly lookup fails.
 */

import { pickOverlay, renderColorBar } from "../color.js";
import { formatResetTime, renderBar } from "../format.js";
import { roundTenth } from "../rounding.js";
import type { OcQueryResult } from "./types.js";

/** Label + window metadata, in display order. Which rows appear depends on
 *  the account's plan: legacy plans carry session (5h) + weekly; current
 *  credit plans carry monthly only. */
const WINDOW_META: Array<{
  key: "session" | "weekly" | "monthly";
  label: string;
  resetKey: "sessionResetAt" | "weeklyResetAt" | "monthlyResetAt";
}> = [
  { key: "session", label: "5h", resetKey: "sessionResetAt" },
  { key: "weekly", label: "Week", resetKey: "weeklyResetAt" },
  { key: "monthly", label: "Month", resetKey: "monthlyResetAt" },
];

/** A rendered section: a header line and zero or more body lines. */
export interface RenderedSection {
  header: string;
  body: string[];
}

/**
 * Render the Ollama Cloud section.
 *
 * Used by the combined formatter. The header is always `Ollama Cloud`; body
 * has one bar line per window, plus (2026-10 API) a spend detail line under
 * the bars when the result carries `usageUsd`. Non-success kinds return a
 * header + a single explanatory line.
 *
 * When `color` is true the bar is a heat-colored 24-bit ANSI bar with the
 * percent overlaid inside, mirroring the other providers' color layout.
 */
export function formatOcSection(result: OcQueryResult, color = false): RenderedSection {
  const header = "Ollama Cloud";

  if (result.kind !== "success") {
    const msg =
      result.kind === "not_configured"
        ? "not configured (set OLLAMA_API_KEY)"
        : result.kind === "auth_error"
          ? "auth failed — check your Ollama API key"
          : "unavailable";
    return { header, body: [msg] };
  }

  const body = WINDOW_META.filter((m) => result[m.key] !== undefined).map((m) => {
    const fraction = result[m.key]!;
    const pct = roundTenth(fraction * 100);
    const reset = formatResetTime(result[m.resetKey]);
    const trailing = reset ? ` · ${reset}` : "";
    if (color) {
      const bar = renderColorBar(pct, { overlay: pickOverlay({ usedPercent: pct }) });
      return `${m.label.padEnd(5)} ${bar}${trailing}`;
    }
    return `${m.label.padEnd(5)} ${renderBar(pct)}  ${String(pct).padStart(2)}%${trailing}`;
  });

  const detail = formatOcSpendLine(result);
  if (detail) body.push(detail);

  return { header, body };
}

/**
 * Spend detail line for the analytics API (2026-10+): `usage` spend over the
 * rolling 30d window, with the plan credit as context when known. Indented to
 * sit under the window bars. `null` when the result carries no spend (legacy
 * response shape) — the card then stays exactly as before.
 */
function formatOcSpendLine(result: Extract<OcQueryResult, { kind: "success" }>): string | null {
  if (result.usageUsd === undefined) return null;
  const spend = `$${result.usageUsd.toFixed(2)}`;
  const of = result.creditUsd !== undefined ? ` of $${result.creditUsd}` : " spent";
  const req =
    result.requestCount !== undefined
      ? ` · ${result.requestCount.toLocaleString("en-US")} req`
      : "";
  return `      ${spend}${of}${req} (30d)`;
}
