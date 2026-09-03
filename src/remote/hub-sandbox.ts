/**
 * Hub sandbox self-relaunch (macOS / launchd).
 *
 * A hub born inside our Seatbelt wrap cannot do its job: `open -a Terminal`
 * for the visible REPL (ADR-0016) gets TCC-attributed to the requester
 * identity "Sandbox" and Terminal silently refuses the document — while
 * `open` itself exits 0, so the incubation just burns its budget and every
 * remote session-create fails. Seatbelt cannot be escaped from within (it
 * is inherited unconditionally across fork/exec), so the only way out is a
 * process that already lives OUTSIDE the sandbox: launchd. The wrapped hub
 * writes a throwaway LaunchAgent plist (launchd reads the path itself, the
 * sandbox does not constrain it) and bootstraps itself into the user's gui
 * domain; the relaunched hub is a clean user process.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { log, warn } from "../utils.js";

/**
 * Set on every sandboxed backend spawn (see server.ts ensureBackend) and
 * inherited down any spawn chain. Its presence in the hub's env means THIS
 * process was born inside the wrap — unlike ZCODE_ACP_SANDBOX, which a user
 * may legitimately set globally and which must NOT trigger a relaunch.
 */
export const SANDBOX_ACTIVE_ENV = "ZCODE_ACP_SANDBOX_ACTIVE";

/** launchd label for the self-relaunched hub (machine singleton, like the port). */
export const HUB_LAUNCH_LABEL = "com.zcode.acp.hub";

/** Whether this process was born inside our Seatbelt wrap. */
export function sandboxBorn(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === "darwin" && (env[SANDBOX_ACTIVE_ENV] ?? "").trim() !== "";
}

/** Minimal XML escaping for plist string values (env values are arbitrary). */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The LaunchAgent plist body: run the hub entry under this node, with THIS
 * process's env minus the birth marker (so the relaunched hub does not
 * re-trigger). RunAtLoad/KeepAlive stay false — the hub is started exactly
 * once, now, via kickstart; if it dies the bridges re-spawn it (the existing
 * machine-singleton behaviour).
 */
export function buildHubRelaunchPlist(opts: {
  nodePath: string;
  hubJs: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}): string {
  const envEntries = Object.entries(opts.env).filter(([k]) => k !== SANDBOX_ACTIVE_ENV);
  const pair = ([k, v]: [string, string | undefined]) =>
    `        <key>${xmlEscape(k)}</key>\n        <string>${xmlEscape(String(v))}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${HUB_LAUNCH_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(opts.nodePath)}</string>
        <string>${xmlEscape(opts.hubJs)}</string>
        <string>hub</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries.map(pair).join("\n")}
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(opts.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(opts.logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Relaunch this hub outside the sandbox: write the plist into a fresh
 * mkdtemp (a default-allowed temp tree under the Seatbelt profile, and
 * launchd — outside the sandbox — reads the path itself), load it into the
 * user's gui domain and start the job. Returns true when the relaunch was
 * handed to launchd; false means the caller should keep running (degraded)
 * and warn. Best-effort diagnostics of the relaunched hub land in the log
 * file next to the plist.
 *
 * A label that was already bootstrapped freezes the FIRST plist's definition
 * — `kickstart` restarts whatever is loaded and would silently revive stale
 * env (a rotated token, an old port). The definition must therefore be
 * swapped: bootout the old label, then bootstrap the fresh plist (bootout is
 * asynchronous, so bootstrap retries a few times). A blind kickstart of an
 * unreplaced definition is never attempted.
 */
export function selfRelaunchOutsideSandbox(opts: {
  nodePath: string;
  hubJs: string;
  logPath?: string;
}): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), "zcode-hub-relaunch-"));
  const logPath = opts.logPath ?? path.join(dir, "hub.log");
  const plistPath = path.join(dir, "hub.plist");
  writeFileSync(plistPath, buildHubRelaunchPlist({ ...opts, env: process.env, logPath }));
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const target = `${domain}/${HUB_LAUNCH_LABEL}`;
  // Best-effort cleanup of the PREVIOUS attempt's dir (plist + log); the
  // current dir stays — the relaunched job writes its log there.
  const sentinel = path.join(tmpdir(), "zcode-hub-relaunch-last");
  try {
    const previous = readFileSync(sentinel, "utf8").trim();
    if (previous) rmSync(previous, { recursive: true, force: true });
  } catch {
    // no previous attempt (or unreadable) — nothing to clean
  }
  try {
    writeFileSync(sentinel, dir);
  } catch {
    // best-effort — worst case a few temp dirs accumulate
  }
  let loaded = false;
  let lastError = "";
  for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
    try {
      execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "ignore" });
      loaded = true;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // Likely already bootstrapped: drop the old definition and retry with
      // the fresh plist (bootout completes asynchronously — hence the wait).
      try {
        execFileSync("launchctl", ["bootout", target], { stdio: "ignore" });
      } catch {
        // nothing was loaded under the label — nothing to boot out
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
  if (!loaded) {
    warn(
      `hub: launchd bootstrap failed (${lastError}) — running sandboxed; ` +
        "restart the hub from a normal terminal instead",
    );
    return false;
  }
  try {
    execFileSync("launchctl", ["kickstart", target], { stdio: "ignore" });
  } catch (e) {
    warn(
      `hub: launchd kickstart failed (${e instanceof Error ? e.message : String(e)}) — ` +
        "running sandboxed; restart the hub from a normal terminal instead",
    );
    return false;
  }
  log(`hub: relaunched outside the sandbox via launchd (${target}, plist: ${plistPath})`);
  return true;
}
