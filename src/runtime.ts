/**
 * Dual-runtime launcher support: prefer Bun (>=1.4, `--smol`) for this
 * package's own long-lived processes (bridge, hub, serve, TUI agent), fall
 * back to the current Node interpreter. The zcode backend subprocess is NOT
 * covered — `zcode.cjs` unconditionally loads `node:sea`, which Bun does not
 * implement, so backend resolution stays on real Node (src/backend/resolve.ts).
 *
 * Why Bun 1.4 minimum: measured on this package, 1.3.x had no memory benefit
 * over Node (~84 MB vs 81 MB idle), while 1.4.x runs the bridge in ~58 MB
 * (47 MB with --smol) vs Node's 81 MB — decisive for users running many
 * concurrent sessions.
 *
 * ZCODE_ACP_RUNTIME selects the policy: "node" forces Node (troubleshooting
 * escape hatch), "bun" prefers Bun and warns when unavailable, unset/auto
 * prefers Bun silently when a >=1.4 install is found. Failures of the probe
 * itself never block startup — Node is the safe default.
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { log, warn } from "./utils.js";

/** Interpreter decision for spawning one of this package's JS entries. */
export interface RuntimeLaunch {
  command: string;
  /** Interpreter flags placed before the JS entry (e.g. ["--smol"] for Bun). */
  preArgs: string[];
}

/** Minimum Bun version with the Rust-rewrite memory wins (see module doc). */
const MIN_BUN = { major: 1, minor: 4 };

/** `which bin` — resolve a binary on PATH without external deps. */
function whichSync(bin: string): string | null {
  try {
    const out = execFileSync("which", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Well-known Bun install locations, tried around the PATH lookup. */
function bunCandidates(): string[] {
  const cands = [
    path.join(homedir(), ".bun", "bin", "bun"), // official installer default
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ];
  const onPath = whichSync("bun");
  if (onPath) cands.unshift(onPath);
  return cands.filter((c, i, a) => c && a.indexOf(c) === i);
}

/** Parse "1.4.2" → [1, 4, 2]; null when unparseable. */
export function parseBunVersion(out: string): [number, number, number] | null {
  const m = out.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when the parsed version meets MIN_BUN. Pure — exported for tests. */
export function bunVersionOk(v: [number, number, number] | null): boolean {
  if (!v) return false;
  return v[0] > MIN_BUN.major || (v[0] === MIN_BUN.major && v[1] >= MIN_BUN.minor);
}

/** Find a >=MIN_BUN bun binary, or null. Result cached for the process. */
let bunCache: string | null | undefined;

export function detectBun(): string | null {
  if (bunCache !== undefined) return bunCache;
  bunCache = null;
  for (const cand of bunCandidates()) {
    if (!existsSync(cand)) continue;
    try {
      const out = execFileSync(cand, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      if (bunVersionOk(parseBunVersion(out))) {
        bunCache = cand;
        break;
      }
      log(
        `runtime: bun at ${cand} is ${out.trim()} (< ${MIN_BUN.major}.${MIN_BUN.minor}) — staying on node`,
      );
    } catch (e) {
      log(`runtime: bun probe failed at ${cand} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return bunCache;
}

/** Reset the probe cache (tests). */
export function resetRuntimeCache(): void {
  bunCache = undefined;
}

/**
 * The interpreter decision for this process's lifetime. When already running
 * under Bun, reuses it (execPath) — no nested re-resolution.
 */
export function resolveRuntime(): RuntimeLaunch {
  if (process.versions.bun) return { command: process.execPath, preArgs: ["--smol"] };
  const policy = (process.env.ZCODE_ACP_RUNTIME ?? "").trim().toLowerCase();
  if (policy === "node") return { command: process.execPath, preArgs: [] };
  const bun = detectBun();
  if (bun) return { command: bun, preArgs: ["--smol"] };
  if (policy === "bun") {
    warn(
      "runtime: ZCODE_ACP_RUNTIME=bun but no bun >= " +
        `${MIN_BUN.major}.${MIN_BUN.minor} found — falling back to node`,
    );
  }
  return { command: process.execPath, preArgs: [] };
}

/** Full child argv to run `jsFile` (plus trailing args) under the chosen runtime. */
export function runtimeArgv(jsFile: string, ...rest: string[]): string[] {
  const rt = resolveRuntime();
  return [rt.command, ...rt.preArgs, jsFile, ...rest];
}

/** Spawn-spread form of runtimeArgv: spawn(...runtimeSpawnParts(js), opts). */
export function runtimeSpawnParts(jsFile: string, ...rest: string[]): [string, string[]] {
  const rt = resolveRuntime();
  return [rt.command, [...rt.preArgs, jsFile, ...rest]];
}

/**
 * Hand this process over to Bun when eligible: spawn the same entry under
 * `bun --smol` with inherited stdio and mirror its exit code. Loop-safe by
 * construction — under Bun `process.versions.bun` is set and detectBun is
 * skipped, so the child never re-execs. Resolves true when the handover is in
 * progress (the caller must return immediately; this process exits with the
 * child), false when the caller should keep running in-process — Bun is
 * unavailable, Node was forced via ZCODE_ACP_RUNTIME=node, or the spawn
 * itself failed (nothing has been written to stdio yet, so the fallback is
 * safe).
 */
export async function reexecToBunIfEligible(
  entryJs: string,
  argv: readonly string[],
): Promise<boolean> {
  if (process.versions.bun) return false;
  if ((process.env.ZCODE_ACP_RUNTIME ?? "").trim().toLowerCase() === "node") return false;
  const bun = detectBun();
  if (!bun) return false;
  let settled!: (handed: boolean) => void;
  const outcome = new Promise<boolean>((resolve) => {
    settled = resolve;
  });
  log(`runtime: handing over to ${bun} --smol for ${entryJs}`);
  const child = spawn(bun, ["--smol", entryJs, ...argv], { stdio: "inherit" });
  child.once("error", (e) => {
    warn(`runtime: bun re-exec failed (${e.message}) — continuing on node`);
    settled(false);
  });
  child.once("close", (code, signal) => {
    settled(true);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  return outcome;
}
