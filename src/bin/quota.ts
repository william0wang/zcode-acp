#!/usr/bin/env node

/**
 * Standalone CLI for querying GLM Coding Plan usage — a thin wrapper over the
 * same `queryQuota()` + `formatQuotaPlain()` the `/quota` slash command uses.
 *
 * No ACP server, no zcode subprocess: only reads `~/.zcode/v2/config.json` for
 * credentials and hits the quota HTTP API directly.
 *
 * Usage:
 *   zcode-quota                  one-shot: print the card and exit
 *   zcode-quota -w               watch mode (default 30s refresh)
 *   zcode-quota -w -i 60         watch with a 60s interval
 *   zcode-quota -d               show per-model MCP detail sub-lines
 *   zcode-quota --watch --interval 15
 *   zcode-quota -h | --help      show help
 *
 * The refresh interval has a 10s floor: the in-memory quota cache TTL is 10s,
 * and a shorter interval would just keep returning the cached value.
 */

import process from "node:process";

import { clearCache } from "../quota/cache.js";
import { formatQuotaPlain, queryQuota } from "../quota/index.js";

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
}

/** Human-readable usage text. */
const HELP_TEXT = `Usage: zcode-quota [options]

Query GLM Coding Plan usage from the terminal. Reads credentials from
~/.zcode/v2/config.json (created by the ZCode app) — no server needed.

Options:
  -w, --watch              Watch mode: clear the screen and refresh periodically.
  -i, --interval <seconds> Refresh interval for watch mode (default 30, min 10).
  -d, --detail             Show per-model MCP usage detail sub-lines.
  -h, --help               Show this help and exit.

Examples:
  zcode-quota                 # print once and exit
  zcode-quota -w              # live monitor, refresh every 30s
  zcode-quota -w -i 60        # refresh every 60s
  zcode-quota -d              # include per-model MCP breakdown`;

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
 * Unknown flags are ignored. Exported for unit testing.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  let watch = false;
  let help = false;
  let detail = false;
  let interval: number | undefined;

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
        }
        break;
    }
  }

  const resolved = resolveIntervalMs(interval);
  return { watch, detail, help, intervalMs: resolved.ms, intervalClamped: resolved.clamped };
}

/** Format the current wall-clock as `HH:MM:SS` for the watch freshness stamp. */
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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

/** Render the footer line (the last line of a watch frame). */
function renderFooter(updatedAt: string, remainingSec: number): string {
  return `  updated ${updatedAt} · refresh in ${remainingSec}s …  Ctrl-C to exit`;
}

/**
 * Full redraw of one watch frame: clear screen, card body, blank line, and the
 * initial footer (counting down from `intervalSec`). `updatedAt` is captured
 * at query time so it stays fixed while only the countdown ticks.
 */
function renderFrame(plain: string, updatedAt: string, intervalSec: number): string {
  return `${ANSI.clearScreen}${plain}\n\n${renderFooter(updatedAt, intervalSec)}`;
}

/**
 * Run the watch loop until the process is interrupted. Each tick clears the
 * cache (so the displayed value is fresh, not a stale cache hit), queries, and
 * redraws. Between ticks a per-second countdown rewrites only the footer line
 * so the card body doesn't flicker. Errors from queryQuota are shown in-frame
 * and retried on the next tick rather than crashing the monitor (queryQuota
 * itself never throws — it degrades to `unavailable` — so this is defence in
 * depth).
 */
async function runWatch(intervalMs: number, detail: boolean): Promise<void> {
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
      clearCache(); // bypass cache — always show the live value
      const result = await queryQuota();
      const updatedAt = timestamp();
      // Full redraw of the whole frame (card + footer counting down from max).
      process.stdout.write(
        renderFrame(formatQuotaPlain(result, { detail }), updatedAt, intervalSec),
      );
      // Countdown: each second rewrite only the footer line, leaving the card
      // untouched. \r returns to column 0; \x1B[2K clears the line.
      for (let remaining = intervalSec - 1; remaining > 0; remaining--) {
        await sleep(1000, controller.signal).catch(() => undefined);
        if (controller.signal.aborted) break;
        process.stdout.write(`\r${ANSI.clearLine}${renderFooter(updatedAt, remaining)}`);
      }
    }
  } finally {
    restore();
    process.off("SIGINT", onInt);
  }
}

/** Print the card once and exit. Non-success → stderr + exit 1. */
async function runOnce(detail: boolean): Promise<void> {
  const result = await queryQuota();
  if (result.kind !== "success") {
    process.stderr.write(formatQuotaPlain(result, { detail }) + "\n");
    process.exit(1);
  }
  process.stdout.write(formatQuotaPlain(result, { detail }) + "\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(HELP_TEXT + "\n");
    return;
  }

  if (opts.intervalClamped) {
    process.stderr.write(`zcode-quota: interval below 10s raised to 10s (cache TTL is 10s)\n`);
  }

  if (opts.watch) {
    await runWatch(opts.intervalMs, opts.detail);
  } else {
    await runOnce(opts.detail);
  }
}

// Only auto-run when invoked directly (not when imported by tests). In an ESM
// build there is no `require.main`, so fall back to a heuristic: if argv[1]
// (the executed script) ends with this file's path, we are the entry point.
const invokedDirectly = (() => {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("bin/quota.js") || entry.endsWith("bin/quota.ts");
})();

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`zcode-quota: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
