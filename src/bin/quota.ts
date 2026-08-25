#!/usr/bin/env node

/**
 * Standalone CLI for querying GLM Coding Plan usage — a thin wrapper over the
 * same `queryQuota()` + `formatQuotaPlain()` the `/quota` slash command uses.
 *
 * No ACP server, no zcode subprocess: only reads `~/.zcode/v2/config.json` for
 * credentials and hits the quota HTTP API directly.
 *
 * Usage:
 *   zcode-acp quota                  one-shot: print the card and exit
 *   zcode-acp quota -w               watch mode (default 30s refresh)
 *   zcode-acp quota -w -i 60         watch with a 60s interval
 *   zcode-acp quota -d               show per-model MCP detail sub-lines
 *   zcode-acp quota --watch --interval 15
 *   zcode-acp quota -h | --help      show help
 *
 * The refresh interval has a 10s floor: the in-memory quota cache TTL is 10s,
 * and a shorter interval would just keep returning the cached value.
 */

import process from "node:process";

import { clearCache as clearGlmCache } from "../quota/cache.js";
import {
  defaultGoWindows,
  formatCombinedCardPlain,
  queryCombined,
  type Provider,
} from "../quota/combined.js";
import { clearGoCache } from "../quota/opencode-go/index.js";

/** Clear both provider caches — used by watch mode per tick for live values. */
function clearAllCaches(): void {
  clearGlmCache();
  clearGoCache();
}

/** Minimum watch interval (ms). Equals the quota cache TTL. */
const MIN_INTERVAL_MS = 10_000;
/** Default watch interval (ms). */
const DEFAULT_INTERVAL_MS = 30_000;

// ANSI escape sequences used by watch mode (no external dep — Local First).
const ANSI = {
  clearScreen: "\x1B[2J\x1B[H", // clear + cursor home
  clearLine: "\x1B[2K", // clear the entire current line
  hideCursor: "\x1B[?25l",
  showCursor: "\x1B[?25h",
} as const;

/** Parsed CLI options. Exported for unit testing. */
export interface CliOptions {
  watch: boolean;
  intervalMs: number;
  /** True when the user-supplied interval was below the 10s floor and raised. */
  intervalClamped: boolean;
  /** True when the user wants per-model MCP detail sub-lines shown. */
  detail: boolean;
  help: boolean;
  /** Which provider(s) to query — first positional arg (`glm`/`go`), else `all`. */
  provider: Provider;
  /** True when the user explicitly asked for the plain monochrome layout. */
  plain: boolean;
}

/** Human-readable usage text. */
const HELP_TEXT = `Usage: zcode-acp quota [provider] [options]

Query usage from the terminal. By default shows both GLM Coding Plan and
Opencode Go in one card; pass a provider to focus on one.

Providers:
  (none)                    Both GLM + Opencode Go (rolling + weekly + monthly).
  glm                       GLM Coding Plan only.
  go                        Opencode Go only (rolling + weekly + monthly).

GLM credentials: read from ~/.zcode/v2/config.json (created by the ZCode app).
Opencode Go credentials (env vars override the config file, field by field):
  Config file  ~/.pi/agent/opencode-go.json   {"workspaceId":"wrk_…","authCookie":"Fe26.2**…"}
  OPENCODE_GO_WORKSPACE_ID    e.g. wrk_abc123 (from the opencode.ai workspace URL)
  OPENCODE_GO_AUTH_COOKIE     the "auth" cookie value (starts with Fe26.2**)
  Get the cookie via browser DevTools → Application → Cookies → opencode.ai.

Options:
  -w, --watch              Watch mode: clear the screen and refresh periodically.
  -i, --interval <seconds> Refresh interval for watch mode (default 30, min 10).
  -d, --detail             Show per-model MCP usage detail sub-lines (GLM only).
  -p, --plain              Plain monochrome bars (no color, no in-bar overlay).
                           Color is the default on a terminal; disabled
                           automatically when stdout is piped or redirected.
  -h, --help               Show this help and exit.

Examples:
  zcode-acp quota                 # both providers, print once and exit (color bars)
  zcode-acp quota go              # Opencode Go only (3 windows)
  zcode-acp quota glm -w          # GLM only, live monitor every 30s
  zcode-acp quota -w -i 60        # both, refresh every 60s
  zcode-acp quota -d              # both, include per-model MCP breakdown
  zcode-acp quota --plain         # both, classic monochrome bars`;

/**
 * Clamp a raw interval (seconds, optional) to a valid ms value. Returns the
 * clamped value plus whether a user-supplied value was raised to the floor.
 *
 * Exported for unit testing.
 */
export function resolveIntervalMs(seconds: number | undefined): { ms: number; clamped: boolean } {
  const requested = (seconds ?? DEFAULT_INTERVAL_MS / 1000) * 1000;
  if (requested < MIN_INTERVAL_MS) {
    return { ms: MIN_INTERVAL_MS, clamped: seconds !== undefined };
  }
  return { ms: requested, clamped: false };
}

/**
 * Parse argv into {@link CliOptions}. Supports `-w`/`--watch`, `-h`/`--help`,
 * `-i <n>`/`--interval <n>` (space), `--interval=<n>`, and `-i<n>` (attached).
 * The first non-flag positional arg is the provider (`glm`/`go`); any other
 * value is ignored (treated as `all`). Unknown flags are ignored.
 *
 * Exported for unit testing.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  let watch = false;
  let help = false;
  let detail = false;
  let plain = false;
  let interval: number | undefined;
  let provider: Provider = "all";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-w":
      case "--watch":
        watch = true;
        break;
      case "-d":
      case "--detail":
        detail = true;
        break;
      case "-p":
      case "--plain":
        plain = true;
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      case "-i":
      case "--interval": {
        const next = argv[i + 1];
        if (next !== undefined) {
          const n = Number(next);
          if (Number.isFinite(n)) interval = n;
          i++; // consume the value
        }
        break;
      }
      default:
        // Support `-i<value>` / `--interval=<value>` attached forms.
        if (arg?.startsWith("--interval=")) {
          const n = Number(arg.slice("--interval=".length));
          if (Number.isFinite(n)) interval = n;
        } else if (arg?.startsWith("-i") && arg.length > 2) {
          const n = Number(arg.slice(2));
          if (Number.isFinite(n)) interval = n;
        } else if (arg === "glm" || arg === "go") {
          // First positional provider token. Only honor the first; a second
          // (e.g. `zcode-acp quota glm go`) is ignored to keep parsing simple.
          if (provider === "all") provider = arg;
        }
        // Other non-flag tokens are ignored (forward-compat / typos).
        break;
    }
  }

  const resolved = resolveIntervalMs(interval);
  return {
    watch,
    detail,
    help,
    plain,
    provider,
    intervalMs: resolved.ms,
    intervalClamped: resolved.clamped,
  };
}

/**
 * Sleep helper. Accepts an AbortSignal so SIGINT can break the wait early.
 *
 * NOTE: the timer is deliberately NOT `unref()`-ed. In watch mode this sleep
 * is the only thing keeping the event loop alive between ticks; an unref'd
 * timer lets Node exit immediately after the first frame renders, which
 * silently kills the monitor. Only a real abort (Ctrl-C) should end the wait.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** Format the watch-mode countdown suffix appended to the first header. */
function refreshSuffix(remainingSec: number): string {
  return `refresh in ${remainingSec}s`;
}

/** A rendered card plus the 0-based index of the refresh (countdown) line. */
interface RenderedCard {
  text: string;
  /** 0-based row of the refresh countdown line, or null when there is none. */
  refreshRow: number | null;
}

/**
 * Render the card for a given provider selection. Centralises the
 * combined-card formatting so watch and one-shot share one code path. In watch
 * mode the refresh countdown is rendered on the separator row after the first
 * section (its position is fixed whether or not a second section appears).
 *
 * `color` switches the bars to a heat-colored (green→red) 24-bit ANSI layout
 * with the usage numbers overlaid inside. The CLI caller gates this on
 * `stdout.isTTY && !plain`.
 */
function renderCard(
  combined: Parameters<typeof formatCombinedCardPlain>[0],
  provider: Provider,
  detail: boolean,
  color: boolean,
  refresh?: string,
): RenderedCard {
  const text = formatCombinedCardPlain(combined, {
    provider,
    glm: { detail },
    goWindows: defaultGoWindows(provider),
    color,
    refreshSuffix: refresh,
  });
  // The refresh line is the one carrying the countdown text. Without a refresh
  // suffix there is no such line. When present it sits right after the first
  // section, so we can find it by matching the suffix.
  let refreshRow: number | null = null;
  if (refresh) {
    const lines = text.split("\n");
    const idx = lines.findIndex((l) => l.includes(refresh));
    refreshRow = idx >= 0 ? idx : null;
  }
  return { text, refreshRow };
}

/**
 * Full redraw of one watch frame: clear screen, then the card (with the
 * refresh countdown on the separator row after the first section).
 */
function renderFrame(text: string): string {
  return `${ANSI.clearScreen}${text}`;
}

/**
 * Run the watch loop until the process is interrupted. Each tick clears both
 * caches (so the displayed values are fresh, not stale cache hits), queries,
 * and redraws. Between ticks a per-second countdown rewrites only the footer
 * line so the card body doesn't flicker. The combined query never throws —
 * each provider degrades internally — so this loop is robust.
 */
async function runWatch(
  intervalMs: number,
  provider: Provider,
  detail: boolean,
  color: boolean,
): Promise<void> {
  const intervalSec = Math.round(intervalMs / 1000);
  const controller = new AbortController();
  const restore = (): void => {
    process.stdout.write(ANSI.showCursor);
    process.stdout.write("\n");
  };
  // Ctrl-C: stop the loop, restore the cursor, exit cleanly.
  const onInt = (): void => {
    controller.abort();
    restore();
    process.exit(0);
  };
  process.on("SIGINT", onInt);

  process.stdout.write(ANSI.hideCursor);
  try {
    while (!controller.signal.aborted) {
      clearAllCaches(); // bypass caches — always show live values
      const combined = await queryCombined(provider);
      // Full redraw with the countdown starting at the interval max.
      const first = renderCard(combined, provider, detail, color, refreshSuffix(intervalSec));
      process.stdout.write(renderFrame(first.text));
      // Per-second countdown: rewrite only the refresh row (the separator line
      // after the first section), leaving the card body untouched. Its row is
      // fixed for the lifetime of this `combined` result, so we re-render the
      // card with the new countdown purely to extract the refreshed line text,
      // then blast it to that row via cursor-position + clear-line.
      for (let remaining = intervalSec - 1; remaining > 0; remaining--) {
        await sleep(1000, controller.signal).catch(() => undefined);
        if (controller.signal.aborted) break;
        const next = renderCard(combined, provider, detail, color, refreshSuffix(remaining));
        if (first.refreshRow !== null && next.refreshRow !== null) {
          const row = first.refreshRow + 1; // ANSI rows are 1-based
          const line = next.text.split("\n")[next.refreshRow] ?? "";
          // Move to (row, col 1), clear the line, write the refreshed countdown.
          process.stdout.write(`\x1B[${row};1H${ANSI.clearLine}${line}`);
        }
      }
    }
  } finally {
    restore();
    process.off("SIGINT", onInt);
  }
}

/**
 * Print the card once and exit. A fully-unavailable result (no provider could
 * produce data) → stderr + exit 1, so scripts can detect failure. A partial
 * result (at least one provider succeeded or is merely not_configured) goes
 * to stdout with exit 0.
 */
async function runOnce(provider: Provider, detail: boolean, color: boolean): Promise<void> {
  const combined = await queryCombined(provider);
  const out = renderCard(combined, provider, detail, color).text;

  // Failure = every selected provider ended up unavailable (not merely
  // not_configured, which is a deliberate "skip me" state).
  const glmFailed = combined.glm.kind === "unavailable";
  const goFailed = combined.go.kind === "unavailable";
  const glmSelected = provider === "all" || provider === "glm";
  const goSelected = provider === "all" || provider === "go";
  const selectedFailed =
    (glmSelected && glmFailed && (!goSelected || goFailed)) ||
    (goSelected && goFailed && (!glmSelected || glmFailed));

  if (selectedFailed) {
    process.stderr.write(out + "\n");
    process.exit(1);
  }
  process.stdout.write(out + "\n");
}

/**
 * CLI entry. Takes the argument list (defaulting to the process argv) so the
 * Unified CLI dispatcher can pass its own slice (`zcode-acp quota -w` →
 * `["-w"]`) without the subcommand name leaking in as a provider token.
 *
 * Exported for the Unified CLI dispatcher; guarded auto-run below.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(argv);

  if (opts.help) {
    process.stdout.write(HELP_TEXT + "\n");
    return;
  }

  if (opts.intervalClamped) {
    process.stderr.write(`zcode-acp quota: interval below 10s raised to 10s (cache TTL is 10s)\n`);
  }

  // Color is on by default on a real terminal; turn it off when piped/
  // redirected (isTTY is only `true` on a real TTY — Node leaves it
  // `undefined` for pipes/files) or when the user asks for --plain. This
  // matches the common CLI convention (ls, git, grep) and keeps raw escape
  // codes out of captured output.
  const color = process.stdout.isTTY === true && !opts.plain;

  if (opts.watch) {
    await runWatch(opts.intervalMs, opts.provider, opts.detail, color);
  } else {
    await runOnce(opts.provider, opts.detail, color);
  }
}

// Only auto-run when invoked directly (not when imported by tests). In an ESM
// build there is no `require.main`, so fall back to a heuristic: if argv[1]
// (the executed script) ends with this file's path, we are the entry point.
// Backslashes are normalized because argv[1] on Windows is a backslash path.
const invokedDirectly = (() => {
  const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
  return entry.endsWith("bin/quota.js") || entry.endsWith("bin/quota.ts");
})();

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`zcode-acp quota: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
