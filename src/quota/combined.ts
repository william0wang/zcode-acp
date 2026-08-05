/**
 * Combined multi-provider quota — the orchestration layer used by the
 * `zcode-quota` CLI when no provider subcommand is given (default mode).
 *
 * Queries GLM Coding Plan and Opencode Go in parallel and renders a single
 * merged card with one section per provider. The `/quota` slash command does
 * NOT use this — it stays on the single-provider GLM {@link formatQuota}.
 *
 * Design notes:
 *   - `Promise.all` so a slow Opencode Go scrape doesn't delay the GLM card.
 *   - A `not_configured` Opencode Go result is silently dropped (no header,
 *     no error line) in `all` mode, so GLM-only users see no noise. In `go`
 *     mode it surfaces as a help line because the user explicitly asked.
 *   - The divider width is computed from the widest body line so the frame
 *     stays balanced regardless of which windows/counts are present.
 */

import type { FormatOptions } from "./format.js";
import { renderGlmSection } from "./format.js";
import { queryQuota } from "./index.js";
import { formatGoSection, queryGoUsage } from "./opencode-go/index.js";
import type { GoQueryResult, GoWindowKey } from "./opencode-go/types.js";
import type { QuotaResult } from "./types.js";

/** Which provider(s) to query. */
export type Provider = "all" | "glm" | "go";

/** The combined result of both providers. */
export interface CombinedResult {
  glm: QuotaResult;
  go: GoQueryResult;
}

/**
 * Which Opencode Go windows to render. All three (rolling + weekly + monthly)
 * are shown in every mode that renders Go at all — the compact color layout
 * leaves room for the monthly bar.
 */
export function defaultGoWindows(provider: Provider): GoWindowKey[] {
  // All three windows everywhere now — the compact color layout leaves room
  // for the monthly bar. `provider` is accepted to keep the call sites
  // self-documenting (and to allow per-provider trimming again later) even
  // though every branch currently returns the same set.
  void provider;
  return ["rolling", "weekly", "monthly"];
}

/**
 * Query both providers in parallel.
 *
 * Each provider degrades internally (GLM → `unavailable`, Go →
 * `not_configured`/`unavailable`); neither ever throws, so `Promise.all`
 * always resolves.
 */
export async function queryCombined(provider: Provider): Promise<CombinedResult> {
  // For `glm`-only we skip the Go fetch entirely; for `go`-only we skip GLM.
  // Skipping is cheaper and avoids touching Go credentials the user may not
  // have set. We still return both fields so the formatter's shape is uniform.
  const tasks: [Promise<QuotaResult>, Promise<GoQueryResult>] =
    provider === "glm"
      ? [queryQuota(), Promise.resolve({ kind: "not_configured" })]
      : provider === "go"
        ? [Promise.resolve({ kind: "unavailable" }), queryGoUsage()]
        : [queryQuota(), queryGoUsage()];

  const [glm, go] = await Promise.all(tasks);
  return { glm, go };
}

/**
 * Decide whether the Go section should appear at all in `all` mode.
 *
 * `not_configured` is silently dropped (the user hasn't set credentials and
 * didn't explicitly ask for Go). All other kinds — including `unavailable`
 * and `auth_error` — render so the user sees that something is wrong.
 */
function shouldShowGo(provider: Provider, go: GoQueryResult): boolean {
  if (provider === "glm") return false;
  if (go.kind === "not_configured" && provider === "all") return false;
  return true;
}

/**
 * Render the combined result as a single fenced ```text card.
 *
 * Sections are separated by a blank line; each section has a ` Header` line
 * (indented one space so it reads as a sub-heading) followed by its body.
 * The divider spans the widest line in the card.
 */
export function formatCombinedCard(
  combined: CombinedResult,
  opts: {
    provider: Provider;
    glm?: FormatOptions;
    goWindows?: GoWindowKey[];
    /** Render heat-colored 24-bit ANSI bars with overlaid numbers. */
    color?: boolean;
    /** Optional trailing annotation appended to the first section header
     *  (e.g. ` · refresh in 29s`). Watch mode uses it to show the countdown. */
    refreshSuffix?: string;
  } = { provider: "all" },
): string {
  const provider = opts.provider;
  const lines = renderCombinedLines(
    combined,
    provider,
    opts.glm,
    opts.goWindows,
    opts.color,
    opts.refreshSuffix,
  );
  return ["```text", ...lines, "```"].join("\n");
}

/** {@link formatCombinedCard} without the fence — for raw terminal output. */
export function formatCombinedCardPlain(
  combined: CombinedResult,
  opts: {
    provider: Provider;
    glm?: FormatOptions;
    goWindows?: GoWindowKey[];
    color?: boolean;
    refreshSuffix?: string;
  } = { provider: "all" },
): string {
  return renderCombinedLines(
    combined,
    opts.provider,
    opts.glm,
    opts.goWindows,
    opts.color,
    opts.refreshSuffix,
  ).join("\n");
}

/**
 * Render the card body lines (no fence). Shared by fenced/plain variants.
 *
 * Single-provider modes render just that provider's section header + body
 * (no `Quota Overview` banner, no divider). `all` mode renders the banner,
 * divider, and both sections.
 */
/**
 * Width the refresh line is right-aligned to. Matches the classic GLM divider
 * width so the countdown lines up with the card's visual frame.
 */
const REFRESH_LINE_WIDTH = 34;

/**
 * Build the separator line that follows the first rendered section.
 *
 * In watch mode this carries the refresh countdown, right-aligned to
 * {@link REFRESH_LINE_WIDTH} so its position is stable regardless of how many
 * sections follow (or whether Go is configured). When no refresh suffix is
 * supplied the line is blank — it still occupies the row so the layout below
 * it never shifts.
 */
function separatorLine(refreshSuffix?: string): string {
  if (!refreshSuffix) return "";
  return refreshSuffix.padStart(REFRESH_LINE_WIDTH);
}

function renderCombinedLines(
  combined: CombinedResult,
  provider: Provider,
  glmOpts?: FormatOptions,
  goWindows?: GoWindowKey[],
  color = false,
  /** Optional refresh countdown rendered on the separator line after the
   *  first section (e.g. `refresh in 29s`). */
  refreshSuffix?: string,
): string[] {
  const { glm, go } = combined;
  const sep = separatorLine(refreshSuffix);
  // Fold the color flag into the GLM FormatOptions so it reaches renderGlmSection
  // alongside detail/compact without each caller having to set it.
  const glmOptsColor: FormatOptions = { ...glmOpts, color };

  // Single-provider GLM: behave like the original card (header + divider +
  // body) minus the fence, so `zcode-quota glm` looks identical to today's
  // `zcode-quota`.
  if (provider === "glm") {
    const lines = renderSingleGlm(glm, glmOptsColor);
    // The separator rides after the (only) section, then nothing follows.
    return sep ? [...lines, sep] : lines;
  }
  // Single-provider Go: header + body, no banner/divider.
  if (provider === "go") {
    const section = formatGoSection(go, goWindows ?? defaultGoWindows("go"), Date.now(), color);
    const lines = [section.header, ...section.body];
    return sep ? [...lines, sep] : lines;
  }

  // Combined `all` mode. GLM renders full (MCP on its own line) — the layout
  // is short enough now that compact mode isn't worth the lost detail.
  const glmSection = renderGlmSection(glm, glmOptsColor);
  const showGo = shouldShowGo("all", go);
  const goSection = showGo
    ? formatGoSection(go, goWindows ?? defaultGoWindows("all"), Date.now(), color)
    : null;

  const hasGlm = glmSection.body.length > 0;
  const hasGo = !!goSection && goSection.body.length > 0;

  // The separator line always follows the FIRST rendered section, so its row
  // is fixed whether or not a second section appears.
  const sections: string[][] = [];
  if (hasGlm) sections.push([` ${glmSection.header}`, ...glmSection.body]);
  if (hasGo) sections.push([` ${goSection!.header}`, ...goSection!.body]);

  if (sections.length === 0) {
    return ["  ⚠ no usage data available"];
  }

  // No banner or top divider — the section headers themselves identify each
  // provider, and an extra banner line adds noise without information. The
  // refresh countdown sits on the separator row between sections (or after
  // the only section), right-aligned.
  const body: string[] = [];
  sections.forEach((sec, i) => {
    if (i > 0) body.push(sep);
    body.push(...sec);
  });
  // If there's only one section, the separator still trails it so the refresh
  // line keeps its fixed position.
  if (sections.length === 1 && sep) body.push(sep);
  return body;
}

/**
 * Render a single GLM provider as header + divider + body (the classic card,
 * minus the fence). Used for `zcode-quota glm`.
 */
function renderSingleGlm(result: QuotaResult, opts?: FormatOptions): string[] {
  const section = renderGlmSection(result, opts);
  if (result.kind !== "success") {
    // Non-success → just the prose line, no header/divider (matches formatQuota).
    return section.body;
  }
  const divider = "─".repeat(34);
  return [section.header, divider, ...section.body];
}
