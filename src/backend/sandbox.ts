/**
 * Seatbelt sandbox for the zcode backend subprocess (ADR-0011).
 *
 * The backend runs every Bash/Edit/Write tool with the user's full
 * privileges; one careless command destroys real data. The bridge wraps the
 * single backend spawn point with a generated `sandbox-exec` profile using a
 * writes-only restriction model: reads and process execution stay open, file
 * writes are denied everywhere except an explicit whitelist. Children inherit
 * the sandbox, so one wrap covers the backend, its tool subprocesses, and
 * model workers — deletion (rm/mv/truncate) is a write-class syscall, so it
 * is stopped by the write denial regardless of which binary performs it
 * (name-banning executables would be trivially bypassed and is deliberately
 * not done).
 *
 * Arming is dual-switch (see sandboxActive): ZCODE_ACP_SANDBOX=1 forces it
 * globally, or a workspace opts in via `enabled: true` in its own
 * .zcode/acp/sandbox.json — the template is auto-created with enabled:false,
 * so opting in is always an explicit user edit.
 *
 * Whitelist (frozen at spawn, rebuilt on backend restart):
 * - workspace roots of all live sessions (union of server.sessionCwds)
 * - `~/.zcode*` (the backend's own sessions/db/logs — not agent privilege;
 *   denying it breaks session/create itself)
 * - system temp + regenerable cache dirs (zero-value targets, constant
 *   toolchain traffic)
 * - each project's `.zcode/acp/sandbox.json` `allow` list
 * - bridge-lifetime once-allows granted via the dynamic allow flow
 *
 * `<workspace>/.zcode/acp/` is a DENY island inside every allowed workspace:
 * the sandbox forbids writes there while the bridge — outside the sandbox —
 * persists "always allow" entries on the user's behalf. The agent cannot
 * edit its own allowlist.
 *
 * macOS-only: Seatbelt is a macOS facility. Setting the env elsewhere warns
 * once and runs unsandboxed (see sandboxActive()).
 */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { log, warn } from "../utils.js";

/** The one and only env switch. Every other knob is project config. */
export const SANDBOX_ENV = "ZCODE_ACP_SANDBOX";

/** Regenerable cache dirs trusted as default-writable (ADR-0011). */
const DEFAULT_CACHE_DIRS = [
  "~/Library/Caches",
  "~/.cache",
  "~/.npm",
  "~/Library/pnpm",
  "~/.node-gyp",
];

/**
 * Well-known system temp trees, default-writable. Tools hardcode `/tmp`
 * (a symlink to /private/tmp) or use /var/tmp, and $TMPDIR only names the
 * process's own /var/folders leaf — without these, `mktemp` in a script or a
 * compiler scratch file hits an EPERM popup for plain scratch space
 * (observed: /private/tmp/adv_backup). /private/var/folders is the per-user
 * temp+cache tree ($TMPDIR's parent, includes DARWIN_USER_CACHE_DIR); the
 * specific $TMPDIR leaf stays allowed for tightness. Listed in RESOLVED
 * form — SBPL subpath filters match REAL paths, and /tmp and /var/tmp
 * resolve into the /private entries.
 */
const DEFAULT_TEMP_DIRS = ["/private/tmp", "/private/var/tmp", "/private/var/folders"];

/** Backend state roots that must stay writable for the bridge to function. */
const ZCODE_STATE_DIRS = ["~/.zcode", "~/.zcode-beta", "~/.zcode-plugin"];

export interface SandboxConfig {
  /**
   * Project-level switch: true arms the sandbox for this workspace without
   * the global env. The auto-created template ships false — opting in is an
   * explicit user edit.
   */
  enabled: boolean;
  /** Absolute realpaths OUTSIDE the workspace granted permanent write. */
  allow: string[];
  /**
   * Absolute realpaths the user chose NEVER to grant ("永不放行") — the
   * popup is suppressed for these. Visible config, not hidden memory: the
   * user can review or undo a denial by editing this file.
   */
  deny: string[];
  /** true = .git sits behind the allow popup instead of default-writable. */
  strictGit: boolean;
}

/** Path of the per-project sandbox config inside a workspace root. */
export function sandboxConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".zcode", "acp", "sandbox.json");
}

/** Roots whose template auto-creation already failed — warn once, not per call. */
const templateFailedRoots = new Set<string>();
/** Config issues already warned — once per root(+issue), not per read. */
const warnedConfigIssues = new Set<string>();
/**
 * Last enabled value successfully parsed per config file. A config that
 * becomes unreadable (EACCES/ENOTDIR) or VANISHES after parsing enabled:true
 * must fail closed: the sandboxed agent can produce all of those from inside
 * the sandbox (chmod 0000 `.zcode`, replace `.zcode` with a file, rename it
 * away) — falling back to the disabled template would silently disarm.
 */
const lastEnabledSeen = new Map<string, boolean>();

function defaultConfig(enabled: boolean): SandboxConfig {
  return { enabled, allow: [], deny: [], strictGit: false };
}

/**
 * The config file must be a REGULAR file whose real location is exactly
 * <root>/.zcode/acp/sandbox.json. A symlinked or hardlinked-away config
 * pierces the deny island: the agent writes the link target inside the
 * allowed workspace and thereby edits its own allowlist. Missing files are
 * fine — that is the auto-create path.
 */
function configIntegrityOk(workspaceRoot: string, file: string): boolean {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.nlink > 1) return false;
    return realpathSync(file) === sandboxConfigPath(resolveReal(workspaceRoot));
  } catch {
    return true; // missing (or unreadable parents) → template path
  }
}

/**
 * Read the project sandbox config, auto-creating the template (enabled:
 * false) on first touch so the user finds the file and can flip the switch —
 * the PRESENCE of the file is never the switch, only `enabled` is, so the
 * auto-create cannot arm anything by itself. A malformed or non-object file
 * falls back to enabled:true WITHOUT rewriting it: corruption must fail
 * CLOSED (the user opted in; losing that to a half-saved file would silently
 * disarm), and clobbering the user's mid-edit bytes with a template would be
 * worse than the transient read. A symlinked/hardlinked config is treated
 * the same way (armed, persistence disabled) — see configIntegrityOk. So is
 * a config that was armed and then became unreadable or disappeared — only
 * the agent could do that from inside the sandbox.
 */
export function readSandboxConfig(workspaceRoot: string): SandboxConfig {
  const file = sandboxConfigPath(workspaceRoot);
  if (!configIntegrityOk(workspaceRoot, file)) {
    if (!warnedConfigIssues.has(file)) {
      warnedConfigIssues.add(file);
      warn(
        `sandbox: ${file} is symlinked/hardlinked outside the deny island — reading as armed; fix the link (persistence stays disabled until then)`,
      );
    }
    return defaultConfig(true);
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ENOENT on a never-armed project is the normal pre-template state.
    // Everything else — EACCES/ENOTDIR (agent tampered with `.zcode`), or a
    // miss on a config this bridge already read as armed — fails closed.
    if (code === "ENOENT" && lastEnabledSeen.get(file) !== true) {
      // Write the discovery template (best-effort; a read-only workspace
      // just never gets one — the sandbox can still be env-armed).
      if (!templateFailedRoots.has(workspaceRoot)) {
        try {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, JSON.stringify(defaultConfig(false), null, 2) + "\n");
        } catch (err) {
          templateFailedRoots.add(workspaceRoot);
          warn(
            `sandbox: could not create ${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return defaultConfig(false);
    }
    const issue = code ?? "vanished";
    if (!warnedConfigIssues.has(`${file}:${issue}`)) {
      warnedConfigIssues.add(`${file}:${issue}`);
      warn(`sandbox: ${file} unreadable (${issue}) — reading as armed`);
    }
    return defaultConfig(true);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    lastEnabledSeen.set(file, true);
    return defaultConfig(true);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    lastEnabledSeen.set(file, true);
    return defaultConfig(true);
  }
  const cfg = parsed as Partial<SandboxConfig>;
  const allow = Array.isArray(cfg.allow) ? cfg.allow.filter((p) => typeof p === "string") : [];
  const deny = Array.isArray(cfg.deny) ? cfg.deny.filter((p) => typeof p === "string") : [];
  // Relative (or `~user`) entries would silently anchor to the BRIDGE's cwd —
  // a committed config must speak in absolute paths or `~/` only.
  const absoluteAllow = allow.filter((p) => p.startsWith("/") || p.startsWith("~/"));
  const absoluteDeny = deny.filter((p) => p.startsWith("/") || p.startsWith("~/"));
  if (absoluteAllow.length !== allow.length && !warnedConfigIssues.has(`${file}:relative`)) {
    warnedConfigIssues.add(`${file}:relative`);
    warn(
      `sandbox: dropped ${allow.length - absoluteAllow.length} non-absolute allow entries in ${file}`,
    );
  }
  if (absoluteDeny.length !== deny.length && !warnedConfigIssues.has(`${file}:relative-deny`)) {
    warnedConfigIssues.add(`${file}:relative-deny`);
    warn(
      `sandbox: dropped ${deny.length - absoluteDeny.length} non-absolute deny entries in ${file}`,
    );
  }
  lastEnabledSeen.set(file, cfg.enabled === true);
  return {
    enabled: cfg.enabled === true,
    allow: absoluteAllow,
    deny: absoluteDeny,
    strictGit: cfg.strictGit === true,
  };
}

/**
 * Bridge-side persistence for "always allow" (the deny island keeps the
 * agent from writing this file itself). Round-trips the whole config so the
 * enabled flag survives the write. Dedupes by exact string. Returns false
 * when persistence is impossible (symlinked config, unwritable path) — the
 * caller then downgrades to a bridge-lifetime once-allow.
 */
export function appendSandboxAllow(workspaceRoot: string, allowedPath: string): boolean {
  const file = sandboxConfigPath(workspaceRoot);
  if (!configIntegrityOk(workspaceRoot, file)) {
    warn(`sandbox: refusing to persist through a symlinked/hardlinked ${file}`);
    return false;
  }
  const cfg = readSandboxConfig(workspaceRoot);
  if (cfg.allow.includes(allowedPath)) return true;
  cfg.allow.push(allowedPath);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        { enabled: cfg.enabled, allow: cfg.allow, deny: cfg.deny, strictGit: cfg.strictGit },
        null,
        2,
      ) + "\n",
    );
    log(`sandbox: allowlisted ${allowedPath} in ${file}`);
    return true;
  } catch (e) {
    warn(`sandbox: could not persist allowlist: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Bridge-side persistence for the popup's "永不放行" choice — the visible
 * counterpart of appendSandboxAllow: a denied path is RECORDED in the
 * config (never hidden in bridge memory), so the ask never resurfaces for
 * it and the user can review or undo the decision by editing the file.
 */
export function appendSandboxDeny(workspaceRoot: string, deniedPath: string): boolean {
  const file = sandboxConfigPath(workspaceRoot);
  if (!configIntegrityOk(workspaceRoot, file)) {
    warn(`sandbox: refusing to persist through a symlinked/hardlinked ${file}`);
    return false;
  }
  const cfg = readSandboxConfig(workspaceRoot);
  if (cfg.deny.includes(deniedPath)) return true;
  cfg.deny.push(deniedPath);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        { enabled: cfg.enabled, allow: cfg.allow, deny: cfg.deny, strictGit: cfg.strictGit },
        null,
        2,
      ) + "\n",
    );
    log(`sandbox: denylisted ${deniedPath} in ${file}`);
    return true;
  } catch (e) {
    warn(`sandbox: could not persist denylist: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Expand a leading `~` to the real home dir. */
function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Resolve a path to its filesystem truth. Seatbelt matches real paths, so a
 * symlinked prefix (/tmp → /private/tmp) would silently fail to match —
 * resolve what exists and append the (possibly not-yet-created) remainder.
 */
export function resolveReal(p: string): string {
  const expanded = expandHome(p);
  try {
    return realpathSync(expanded);
  } catch {
    // Deepest existing ancestor + remainder, so not-yet-created cache dirs
    // still land on their real location once created under a real parent.
    let dir = expanded;
    const tail: string[] = [];
    for (;;) {
      const parent = path.dirname(dir);
      if (parent === dir) return expanded;
      tail.unshift(path.basename(dir));
      dir = parent;
      try {
        const real = realpathSync(dir);
        return path.join(real, ...tail);
      } catch {
        // keep walking up
      }
    }
  }
}

/** Escape a path into an SBPL string literal. */
function sb(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface SandboxArmInput {
  /** Workspace roots (already real) with their per-project configs. */
  workspaces: Array<{ root: string; config: SandboxConfig }>;
  /** Extra writable roots: allowlists from other workspaces + once-allows. */
  extraAllow: string[];
  /**
   * Directory the profile file itself lives in — self-denied LAST so the
   * sandboxed agent cannot race/symlink/occupy the next respawn's profile
   * (see armSandboxArgv). $TMPDIR is agent-writable, so without this the
   * profile path would be attacker-reachable.
   */
  profileDir?: string;
}

/**
 * Build the SBPL profile text. SBPL resolves overlapping rules by LAST
 * match (verified empirically: an allow emitted after a deny re-permits the
 * write), so the layout is: base deny-all, then every allow, then the deny
 * carve-outs (island, strictGit) LAST so nothing can override them.
 */
export function buildSandboxProfile(input: SandboxArmInput): string {
  const allows: string[] = [];
  const denies: string[] = [];
  for (const ws of input.workspaces) {
    // Resolve here too (idempotent): direct callers may pass symlinked
    // roots (/tmp → /private/tmp) that would silently fail subpath match.
    const root = resolveReal(ws.root);
    allows.push(`(allow file-write* (subpath ${sb(root)}))`);
    // Deny island: the sandbox config lives INSIDE the writable workspace —
    // without this carve-out the agent could grant itself permissions.
    denies.push(`(deny file-write* (subpath ${sb(path.join(root, ".zcode", "acp"))}))`);
    if (ws.config.strictGit) {
      denies.push(`(deny file-write* (subpath ${sb(path.join(root, ".git"))}))`);
    }
    for (const allowed of ws.config.allow) {
      allows.push(`(allow file-write* (subpath ${sb(resolveReal(allowed))}))`);
    }
  }
  for (const p of [...ZCODE_STATE_DIRS, ...DEFAULT_CACHE_DIRS, ...DEFAULT_TEMP_DIRS]) {
    allows.push(`(allow file-write* (subpath ${sb(resolveReal(p))}))`);
  }
  for (const allowed of input.extraAllow) {
    allows.push(`(allow file-write* (subpath ${sb(resolveReal(allowed))}))`);
  }
  allows.push(
    `(allow file-write* (subpath ${sb(resolveReal(process.env.TMPDIR ?? os.tmpdir()))}))`,
  );
  // /dev/null: git and idiom-level shell redirects write here constantly —
  // without this allow, `git commit` and every `2>/dev/null` fail with
  // "could not open '/dev/null'" (observed in review probes).
  allows.push(`(allow file-write-data (literal "/dev/null"))`);
  // Pseudo-terminals: openpty opens /dev/ptmx and the granted /dev/ttysNNN
  // pair O_RDWR, and the write half collides with the blanket write deny —
  // `script`/`expect`/TUI binaries die with a bare `openpty: Operation not
  // permitted` (#127). The pseudo-tty/read/ioctl operations are already
  // covered by (allow default); Apple's own profiles (application.sb,
  // com.apple.neagent.sb) allow exactly these two write targets. A pty never
  // leaves the sandboxed process tree, so this opens no new write surface.
  allows.push(`(allow file-write* (literal "/dev/ptmx"))`);
  allows.push(`(allow file-write* (regex #"^/dev/ttys[0-9]+$"))`);
  if (input.profileDir) {
    denies.push(`(deny file-write* (subpath ${sb(input.profileDir)}))`);
  }
  return (
    ["(version 1)", "(allow default)", "(deny file-write*)", ...allows, ...denies].join("\n") + "\n"
  );
}

/** Resolved arm input for the CURRENT spawn: union of all live workspaces. */
export function collectSandboxWorkspaces(cwdRoots: Iterable<string>): {
  workspaces: Array<{ root: string; config: SandboxConfig }>;
  extraAllow: string[];
} {
  const seen = new Set<string>();
  const workspaces: Array<{ root: string; config: SandboxConfig }> = [];
  const extraAllow: string[] = [];
  for (const root of cwdRoots) {
    const real = resolveReal(root);
    if (seen.has(real)) continue;
    seen.add(real);
    const config = readSandboxConfig(real);
    workspaces.push({ root: real, config });
    // Allowlists from OTHER workspaces still apply when they share this
    // backend: the agent may hop projects in one bridge lifetime.
    for (const allowed of config.allow) extraAllow.push(allowed);
  }
  // A workspace's own allow entries are emitted with its block above; drop
  // them from extraAllow so they don't appear twice (harmless, but noisy).
  const own = new Set(workspaces.flatMap((ws) => ws.config.allow.map(resolveReal)));
  return {
    workspaces,
    extraAllow: [...new Set(extraAllow.map(resolveReal))].filter((p) => !own.has(p)),
  };
}

let envDecision: boolean | null = null;
let platformWarned = false;

/** Raw env request, uncached — the non-macOS warn must fire even when the cached darwin decision is false. */
function envWanted(): boolean {
  const raw = process.env[SANDBOX_ENV];
  return raw === "1" || raw === "true";
}

/** Env arm decision (env wanted AND darwin), cached — env can't change mid-run. */
function sandboxEnvOn(): boolean {
  if (envDecision === null) envDecision = envWanted() && process.platform === "darwin";
  return envDecision;
}

/**
 * The project-level switch: `enabled: true` inside the workspace's sandbox
 * config (auto-created on first touch, template ships false). Reading also
 * materializes the template for discovery. Once the sandbox is armed the
 * deny island keeps the agent from flipping the switch back off.
 */
export function projectSandboxEnabled(workspaceRoot: string): boolean {
  return readSandboxConfig(workspaceRoot).enabled;
}

/**
 * Whether the sandbox should arm for this bridge: ZCODE_ACP_SANDBOX=1
 * (global, cached) OR any given workspace root opted in via
 * sandbox.json `enabled` (project switch, re-checked per call so a flip
 * mid-run is seen). macOS-only: elsewhere a requested sandbox warns once and
 * runs unsandboxed.
 */
export function sandboxActive(roots: Iterable<string> = [process.cwd()]): boolean {
  if (sandboxEnvOn()) return true;
  const wanted = envWanted() || [...roots].some(projectSandboxEnabled);
  if (!wanted) return false;
  if (process.platform !== "darwin") {
    if (!platformWarned) {
      platformWarned = true;
      warn(
        `sandbox: requested (${SANDBOX_ENV}=1 or project config) but Seatbelt is macOS-only — running WITHOUT sandbox`,
      );
    }
    return false;
  }
  return true;
}

/** Test hook: reset cached decisions and warn-once sets. */
export function resetSandboxDecisionForTest(): void {
  envDecision = null;
  platformWarned = false;
  templateFailedRoots.clear();
  warnedConfigIssues.clear();
  lastEnabledSeen.clear();
}

/** Previous respawn's profile dir — removed once superseded (its backend is dead). */
let lastProfileDir: string | null = null;

/**
 * Arm a backend argv: build the profile into a FRESH unpredictable dir and
 * wrap with sandbox-exec. The dir sits DIRECTLY under $HOME with a
 * `.zcode-acp-sbx-` prefix — OUTSIDE every whitelisted path (it is a SIBLING
 * of `~/.zcode`, not inside it). That location is the load-bearing defense:
 * $TMPDIR and the cache dirs are agent-writable, and a PRIOR sandboxed
 * generation (a setsid survivor of the old process group) keeps its own
 * profile's allows — so a profile placed there could be raced, symlinked,
 * FIFO'd, or occupied no matter how fresh its name (reproduced across
 * generations even with mkdtemp + O_EXCL + a self-deny, which each generation
 * only applies to its own dir). The agent can also kill the backend at will
 * (signals are not file-writes) to control respawn timing; with the profile
 * unreachable from ANY generation, that primitive buys nothing. O_EXCL ("wx")
 * additionally refuses pre-placed symlinks from a pre-arming process, and
 * the profile still self-denies its own dir last (defense in depth for the
 * workspace-root-is-$HOME edge, where home itself is writable).
 */
export function armSandboxArgv(argv: string[], input: SandboxArmInput): string[] {
  const dir = mkdtempSync(path.join(os.homedir(), ".zcode-acp-sbx-"));
  const file = path.join(dir, "profile.sb");
  writeFileSync(file, buildSandboxProfile({ ...input, profileDir: dir }), { flag: "wx" });
  if (lastProfileDir && lastProfileDir !== dir) {
    try {
      rmSync(lastProfileDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of a superseded profile
    }
  }
  lastProfileDir = dir;
  log(`sandbox: backend wrapped with sandbox-exec (profile: ${file})`);
  return ["sandbox-exec", "-f", file, ...argv];
}
