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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { log, warn } from "./utils.js";

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
  seedMarttyQuotaPlugin();
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

// ---------- quota dock plugin seeding (ADR-0021) ----------

/** Martty home resolution: env MARTTY_HOME → $DSH_HOME/.martty → ~/.martty. */
export function resolveMarttyHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MARTTY_HOME) return env.MARTTY_HOME;
  if (env.DSH_HOME) return path.join(env.DSH_HOME, ".martty");
  return path.join(homedir(), ".martty");
}

/** What the seeder decided for an existing plugin.json. */
export interface SeedPlan {
  /** "write" = create/update the file; "none" = nothing to do; "skip" = never overwrite. */
  action: "write" | "none" | "skip";
  /** "current" = ours, same version · "update" = ours, older · others = skip reasons. */
  reason: "fresh" | "current" | "update" | "foreign" | "modified" | "unparseable";
}

/**
 * Decide whether to seed the quota dock plugin, comparing the on-disk
 * plugin.json against our shipped asset. We write only when the file is
 * missing or provably our own OLDER version (source.pluginId marker + the
 * version suffix of source.packageId, mirroring the martty plugin store's
 * artifact format). Same-version files that differ from our asset, foreign
 * plugins, and unparseable files are never touched (user modifications).
 * Pure — exported for unit tests.
 */
export function planQuotaSeed(existingContent: string | null, assetContent: string): SeedPlan {
  if (existingContent === null) return { action: "write", reason: "fresh" };
  let existing: {
    source?: { pluginId?: unknown; packageId?: unknown };
  };
  try {
    existing = JSON.parse(existingContent);
  } catch {
    return { action: "skip", reason: "unparseable" };
  }
  const asset = JSON.parse(assetContent) as {
    source: { pluginId: string; packageId: string };
  };
  const src = existing.source ?? {};
  if (src.pluginId !== asset.source.pluginId) return { action: "skip", reason: "foreign" };
  const versionOf = (pkgId: unknown): number => {
    const m = typeof pkgId === "string" ? /-(\d+)$/.exec(pkgId) : null;
    return m ? Number(m[1]) : Number.NaN;
  };
  const current = versionOf(src.packageId);
  const wanted = versionOf(asset.source.packageId);
  if (!Number.isFinite(current) || current > wanted) return { action: "skip", reason: "foreign" };
  if (current < wanted) return { action: "write", reason: "update" };
  // Same version: identical content = done; anything else = user edit, keep it.
  if (existingContent.trim() === assetContent.trim()) return { action: "none", reason: "current" };
  return { action: "skip", reason: "modified" };
}

/**
 * Seed the quota dock plugin into $MARTTY_HOME/plugins/<artifactId>/ before
 * martty starts (ADR-0021). Best-effort: any failure warns and never blocks
 * the TUI. The asset ships with the npm package (assets/martty-plugins), one
 * directory level above the compiled dist/tui.js.
 */
export function seedMarttyQuotaPlugin(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const assetPath = fileURLToPath(
      new URL("../assets/martty-plugins/quota-dock/plugin.json", import.meta.url),
    );
    const assetContent = readFileSync(assetPath, "utf8");
    const target = path.join(resolveMarttyHome(env), "plugins", "zcode-acp-quota", "plugin.json");
    const existing = existsSync(target) ? readFileSync(target, "utf8") : null;
    const plan = planQuotaSeed(existing, assetContent);
    if (plan.action === "write") {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, assetContent);
      log(`tui: seeded quota dock plugin (${plan.reason}) → ${target}`);
      return true;
    }
    if (plan.action === "skip") {
      warn(`tui: quota dock plugin at ${target} is ${plan.reason} — leaving it untouched`);
    }
    return false;
  } catch (e) {
    warn(
      `tui: quota dock plugin seeding failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
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
