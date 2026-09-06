/**
 * Martty TUI launcher — the interactive CLI surface (ADR-0020).
 *
 * Bare `zcode-acp` spawns the bundled Martty terminal client (npm `martty`:
 * a Node wrapper selecting a per-platform Rust binary from its vendor/ dir)
 * with this package wired in as its ACP agent:
 *
 *   martty --agent <node> --agent-arg <dist/index.js>
 *
 * Martty owns the UI; this package stays the protocol bridge. The launcher
 * shares stdio with the child and inherits the environment, and Martty passes
 * its environment through to the spawned agent (verified) — the hub's
 * ZCODE_ACP_RESUME_SESSION boot-resume target (ADR-0017) reaches the bridge,
 * where session/new serves it as a session/load.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { warn } from "./utils.js";

/** Path to Martty's Node wrapper (bin/martty.js), or null when not installed. */
export function resolveMarttyJs(): string | null {
  try {
    // "./bin/martty.js" is outside Martty's exports map, so resolve the
    // package.json (always exported) and walk into the package dir.
    const pkgJson = createRequire(import.meta.url).resolve("martty/package.json");
    return path.join(path.dirname(pkgJson), "bin", "martty.js");
  } catch {
    return null;
  }
}

/** Absolute path of this package's ACP agent entry (dist/index.js). */
export function agentEntryJs(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

/**
 * Martty argv (after the wrapper script) wiring the bridge in as its agent.
 * `process.execPath` avoids PATH/shebang differences across platforms.
 * Pure — exported for unit tests.
 */
export function buildTuiArgs(agentJs: string): string[] {
  return ["--agent", process.execPath, "--agent-arg", agentJs];
}

/**
 * Run the interactive Martty TUI in this terminal. Resolves when Martty exits
 * and mirrors its exit code. Signals aimed at this process are forwarded so a
 * SIGTERM from a supervisor reaches the TUI too (terminal ctrl+c already hits
 * the whole foreground process group).
 */
export async function runTui(): Promise<void> {
  const marttyJs = resolveMarttyJs();
  if (!marttyJs) {
    throw new Error("martty is not installed — reinstall the zcode-acp-server package");
  }
  const child = spawn(process.execPath, [marttyJs, ...buildTuiArgs(agentEntryJs())], {
    stdio: "inherit",
  });
  const code = await settle(child);
  if (code !== 0) process.exitCode = code ?? 1;
}

/**
 * Headless wiring check (CI / smoke): Martty spawns the bridge, runs the ACP
 * initialize handshake, prints agent info, and exits. True on exit 0.
 */
export async function checkTuiRuntime(): Promise<boolean> {
  const marttyJs = resolveMarttyJs();
  if (!marttyJs) {
    warn("tui: martty is not installed — reinstall the zcode-acp-server package");
    return false;
  }
  const child = spawn(
    process.execPath,
    [marttyJs, "--check-runtime", ...buildTuiArgs(agentEntryJs())],
    { stdio: "inherit" },
  );
  return (await settle(child)) === 0;
}

/** Resolve on child exit; forward terminal signals while it runs. */
function settle(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    const forward = (sig: NodeJS.Signals) => child.kill(sig);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.once("exit", (code) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(code);
    });
    child.once("error", (err) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      warn(`tui: failed to start martty: ${err.message}`);
      resolve(1);
    });
  });
}
