/**
 * Opencode Go dashboard HTML parser.
 *
 * The dashboard is a SolidJS SSR page. Usage data is embedded as hydration
 * assignments inside a `<script>`, in the shape:
 *
 *   rollingUsage:$R[N]={usagePercent:<n>,resetInSec:<n>}
 *
 * (field order may vary; `$R[N]` is a Solid hydration reference). This is JS
 * source, not JSON, so we extract with regexes rather than `JSON.parse`. Two
 * independent reference implementations (pi-go-bars, @beyona/pi-zai-usage)
 * use the same approach as of 2026-08, but the format has no stability
 * contract — a frontend change will silently break extraction, which is why
 * {@link looksLikeDashboard} guards against parser rot.
 */

import type { GoWindow } from "./types.js";

/** Numeric capture group: integer or decimal, optionally negative. */
const NUM = String.raw`(-?\d+(?:\.\d+)?)`;

/**
 * Build the two regexes for one window. Solid emits the fields in either
 * order, so we need one pattern per ordering.
 */
function windowRegexes(name: string): [RegExp, RegExp] {
  return [
    new RegExp(
      String.raw`${name}:\$R\[\d+\]=\{[^}]*usagePercent:${NUM}[^}]*resetInSec:${NUM}[^}]*\}`,
    ),
    new RegExp(
      String.raw`${name}:\$R\[\d+\]=\{[^}]*resetInSec:${NUM}[^}]*usagePercent:${NUM}[^}]*\}`,
    ),
  ];
}

const [RE_ROLLING_PCT, RE_ROLLING_RST] = windowRegexes("rollingUsage");
const [RE_WEEKLY_PCT, RE_WEEKLY_RST] = windowRegexes("weeklyUsage");
const [RE_MONTHLY_PCT, RE_MONTHLY_RST] = windowRegexes("monthlyUsage");

/**
 * Extract one window. Tries both field orderings; returns `null` if neither
 * matches or the captured numbers are not finite.
 */
function parseWindow(html: string, rePct: RegExp, reRst: RegExp): GoWindow | null {
  let m = rePct.exec(html);
  if (m) {
    const usagePercent = Number(m[1]);
    const resetInSec = Number(m[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }
  m = reRst.exec(html);
  if (m) {
    const resetInSec = Number(m[1]);
    const usagePercent = Number(m[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }
  return null;
}

/**
 * Detect whether the HTML is a dashboard page (vs. a login redirect or error
 * page). Used to distinguish "parser is outdated" from "no windows present".
 */
export function looksLikeDashboard(html: string): boolean {
  return (
    html.includes("rollingUsage") || html.includes("weeklyUsage") || html.includes("monthlyUsage")
  );
}

/** Result of parsing the dashboard — each window is independently optional. */
export interface ParsedGoDashboard {
  rolling: GoWindow | null;
  weekly: GoWindow | null;
  monthly: GoWindow | null;
  /**
   * Set when the HTML looks like a dashboard but no windows parsed — the SSR
   * format likely changed. The caller surfaces this as `unavailable`.
   */
  parserOutdated: boolean;
}

/**
 * Parse the dashboard HTML into the three windows.
 *
 * `parserOutdated` is true when the page looks like a dashboard (contains the
 * window variable names) but none of the three windows matched — signalling
 * that the SolidJS hydration format has drifted.
 */
export function parseGoDashboard(html: string): ParsedGoDashboard {
  const rolling = parseWindow(html, RE_ROLLING_PCT, RE_ROLLING_RST);
  const weekly = parseWindow(html, RE_WEEKLY_PCT, RE_WEEKLY_RST);
  const monthly = parseWindow(html, RE_MONTHLY_PCT, RE_MONTHLY_RST);

  const parserOutdated =
    rolling === null && weekly === null && monthly === null && looksLikeDashboard(html);

  return { rolling, weekly, monthly, parserOutdated };
}
