#!/usr/bin/env node

/**
 * Unified CLI entry (`zcode-acp`). Every operational surface is a subcommand;
 * bare invocation opens the interactive Martty TUI (ADR-0020). See docs/adr
 * 0007 for why the old `zcode-acp-hub` / `zcode-quota` bins were folded in
 * here and why `zcode-acp-server` remains as a bin alias pointing at this
 * same file.
 *
 * The legacy alias is detected via argv[0]: npm/pnpm install bin names as
 * symlinks, so both `zcode-acp` and `zcode-acp-server` resolve to dist/cli.js
 * while Node keeps the invoked path in argv — basename tells us which name the
 * user (or editor config) actually typed.
 */

import { basename } from "node:path";
import process from "node:process";

import { main as runHub } from "./bin/hub.js";
import { main as runQuota } from "./bin/quota.js";
import { main as runServer, runHeadless } from "./index.js";
import { checkTuiRuntime, runTui } from "./tui.js";
import { AGENT_INFO } from "./utils.js";

/** What the dispatcher decided to run. `args` are the tokens after the subcommand. */
export type Invocation =
  | { kind: "help" }
  | { kind: "tui"; explicit: boolean; check: boolean }
  | { kind: "server" }
  | { kind: "serve" }
  | { kind: "hub" }
  | { kind: "quota"; args: string[] }
  | { kind: "unknown"; sub: string };

/**
 * Map (invoked name, argv) to a subcommand. Pure — exported for unit tests.
 *
 * `invokedAs` is basename(argv[1]); `zcode-acp-server` means we were spawned
 * by an editor config that expects the bridge to speak ACP on stdio with no
 * subcommand prefix. Bare `zcode-acp` opens the interactive Martty TUI;
 * `repl` stays accepted as the old spelling of `tui`.
 */
export function resolveInvocation(invokedAs: string, argv: readonly string[]): Invocation {
  if (invokedAs === "zcode-acp-server") return { kind: "server" };
  const sub = argv[0];
  if (sub === undefined) return { kind: "tui", explicit: false, check: false };
  if (sub === "repl" || sub === "tui") {
    return { kind: "tui", explicit: true, check: argv.slice(1).includes("--check") };
  }
  if (sub === "-h" || sub === "--help" || sub === "help") {
    return { kind: "help" };
  }
  switch (sub) {
    case "server":
      return { kind: "server" };
    case "serve":
      return { kind: "serve" };
    case "hub":
      return { kind: "hub" };
    case "quota":
      return { kind: "quota", args: argv.slice(1) };
    default:
      return { kind: "unknown", sub };
  }
}

const HELP_TEXT = `Usage: zcode-acp [command] [options]

The single entry point for every zcode-acp-server surface. Bare invocation
opens the interactive Martty TUI (agent chat in this terminal).

Commands:
  (none) | tui       Interactive agent chat (Martty TUI): stream output,
                      tool rows, model picker, session resume. /exit quits.
                      'tui --check' runs a headless wiring check and exits.
  quota [args...]   Plan usage cards (was the zcode-quota bin): -w watch,
                    -i <sec>, -d detail, -p plain, provider glm|go.
  hub               Run the remote-access hub daemon (was zcode-acp-hub;
                    usually auto-spawned by bridges, rarely run by hand).
  serve             Headless bridge for remote session-create (ADR-0014):
                    no stdio editor, lives for remote WS clients until idle.
                    Normally spawned by the hub, not run by hand (needs
                    ZCODE_ACP_REMOTE=1 + ZCODE_ACP_REMOTE_TOKEN).
  server            The editor-facing ACP bridge over stdio (was
                    zcode-acp-server; editors normally launch it via the bin
                    alias without this subcommand).
  -h, --help        Show this help.
  --version         Show the package version.

Examples:
  zcode-acp                                # chat interactively in this repo
  zcode-acp quota -w                       # live usage monitor
  zcode-acp server                         # stdio bridge (for testing)`;

async function main(): Promise<void> {
  if (process.argv[2] === "--version") {
    process.stdout.write(`${AGENT_INFO.version}\n`);
    return;
  }
  const invocation = resolveInvocation(basename(process.argv[1] ?? ""), process.argv.slice(2));
  switch (invocation.kind) {
    case "help":
      process.stdout.write(HELP_TEXT + "\n");
      return;
    case "tui":
      if (invocation.check) {
        process.exitCode = (await checkTuiRuntime()) ? 0 : 1;
        return;
      }
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await runTui();
        return;
      }
      if (invocation.explicit) {
        process.stderr.write("zcode-acp: interactive TUI needs a TTY — run it from a terminal.\n");
        process.exit(2);
      }
      // Bare invocation without a TTY falls back to the stdio server: on
      // Windows npm shims spawn `node ...\dist\cli.js`, so argv[0] loses the
      // bin name and editors configured with either bin land here. Unix
      // pipes get the same fallback (JSON-RPC on stdin, exit on EOF).
      await runServer();
      return;
    case "server":
      await runServer();
      return;
    case "serve":
      await runHeadless();
      return;
    case "hub":
      await runHub();
      return;
    case "quota":
      await runQuota(invocation.args);
      return;
    case "unknown":
      process.stderr.write(`zcode-acp: unknown command '${invocation.sub}'\n\n`);
      process.stdout.write(HELP_TEXT + "\n");
      process.exit(1);
  }
}

// Only auto-run when this file is the executed entry — directly
// (`node dist/cli.js`) or through either bin symlink (`zcode-acp`,
// `zcode-acp-server`), where argv[1] keeps the symlink path. Imports (the
// test suite) fall through to a no-op.
const invokedDirectly = (() => {
  const entry = process.argv[1] ?? "";
  const name = basename(entry);
  return (
    entry.endsWith("cli.js") ||
    entry.endsWith("cli.ts") ||
    name === "zcode-acp" ||
    name === "zcode-acp-server"
  );
})();

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(
      `zcode-acp: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
