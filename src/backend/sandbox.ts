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
 * Arming is the GLOBAL switch only (`sandbox.enabled` in the user config
 * file, or ZCODE_ACP_SANDBOX=1). Path grants are TWO layers, live-read on
 * every arm and unioned into the profile (2026-11-27 restores the
 * per-project face the 2026-11-17 revision had removed):
 * - the machine-global file next to the user config
 *   (`~/.config/zcode-acp/sandbox.json`, XDG aware), auto-created on first
 *   backend spawn with a pre-granted toolchain template (~/go, ~/.gradle,
 *   ~/.m2, ...);
 * - each live workspace's `.zcode/acp/sandbox.json` — present = in effect
 *   (its `enabled` key is ignored; the global switch is the only arm).
 *   allow lists join the profile's allow section, deny lists join the deny
 *   tail (SBPL last-match: a project deny beats every allow), strictGit is
 *   OR-ed. The dynamic allow popup persists "始终允许"/"始终拒绝" into the
 *   project file when the path sits under a workspace root, else into the
 *   global one — grants live where they apply.
 * A legacy per-project file on a machine whose global file predates the
 * 2026-11-17 revision NEVER migrated (ensureGlobalSandboxConfig early-
 * returns on an existing file) — with the per-project face restored that
 * file is live config again, so the one-shot migration stays first-create
 * only (the then-live roots' union is already in the file).
 *
 * Whitelist (frozen at spawn, rebuilt on backend restart):
 * - workspace roots of all live sessions (union of server.sessionCwds)
 * - `~/.zcode*` (the backend's own sessions/db/logs — not agent privilege;
 *   denying it breaks session/create itself)
 * - system temp + regenerable cache dirs (zero-value targets, constant
 *   toolchain traffic)
 * - the global config's `allow` list + each live workspace's per-project
 *   `.zcode/acp/sandbox.json` allow list + bridge-lifetime once-allows
 *   granted via the dynamic allow flow
 *
 * The global config directory (`~/.config/zcode-acp/`) is DENIED in every
 * profile: the bridge — outside the sandbox — persists popup grants there on
 * the user's behalf, and the agent must not be able to edit its own
 * allowlist or the hub credentials that live beside it. The base write-deny
 * already covers it; the explicit deny also holds in the
 * workspace-root-is-its-ancestor edge (a workspace rooted at $HOME would
 * otherwise re-permit it). Each live workspace's own `.zcode/acp/` gets the
 * same treatment (the deny island, `projectSandboxIslandPaths`): it sits
 * INSIDE its write-allowed root, so without the carve-out the project
 * allowlist would be agent-editable again.
 *
 * macOS-only: Seatbelt is a macOS facility. Setting the env elsewhere warns
 * once and runs unsandboxed (see sandboxActive()).
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { log, warn } from "../utils.js";
import { globalSandboxEnabled } from "../config/settings.js";
import { userConfigPath } from "../config/user-config.js";
import { readJsonDocument, writeJsonAtomic } from "../settings/atomic-write.js";

/**
 * The global env/config switch (`ZCODE_ACP_SANDBOX`, or `sandbox.enabled` in
 * the user config file). Path grants live in the global sandbox.json — this
 * switch only arms.
 */
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

/**
 * Toolchain home dirs the auto-created template pre-grants. All are
 * regenerable-or-reinstallable targets with constant build traffic; the user
 * edits the file to trim or extend the list (~/Library/Caches-style cache
 * trees are already covered by DEFAULT_CACHE_DIRS). Same risk class as the
 * long-default-writable ~/.npm (which also carries .npmrc tokens).
 */
const TOOLCHAIN_TEMPLATE_ALLOW = [
  "~/go", // GOPATH default: module cache (pkg/mod) + go install bin
  "~/.gradle", // wrapper dists, dependency caches, daemon registry
  "~/.m2", // Maven local repository
  "~/.cargo", // Rust registry + installed cargo binaries
  "~/.rustup", // Rust toolchains
  "~/.cocoapods", // CocoaPods specs/repos
  "~/.pub-cache", // Dart/Flutter packages
  "~/.nuget", // .NET package cache
  "~/.pnpm-store", // pnpm content-addressable store
  "~/.bun", // Bun install cache + binaries
  "~/.android", // Android debug keystores, AVD data
  "~/Library/Android/sdk", // Android SDK (gradle writes build artifacts)
];

/** The machine-global sandbox config (grants; arming lives in config.json). */
export interface GlobalSandboxConfig {
  /** Absolute or `~/`-prefixed realpaths granted permanent write. */
  allow: string[];
  /** Realpaths the user chose NEVER to grant ("永不放行") — popup suppressed. */
  deny: string[];
  /** true = .git sits behind the allow popup instead of default-writable. */
  strictGit: boolean;
}

/** Path of the machine-global sandbox config, beside the user config file. */
export function globalSandboxConfigPath(): string {
  return path.join(path.dirname(userConfigPath()), "sandbox.json");
}

/**
 * Directory holding the global config (and config.json itself). Denied in
 * every profile — the agent must not edit its own allowlist or the hub
 * credentials next to it, and this deny must survive a workspace allow that
 * covers the directory (workspace rooted at $HOME).
 */
export function globalSandboxConfigDir(): string {
  return resolveReal(path.dirname(userConfigPath()));
}

/** Config issues already warned — once per issue, not per read. */
const warnedGlobalIssues = new Set<string>();

/**
 * Filter to absolute/`~/` entries and warn once about the dropped rest.
 * Relative entries would anchor to the BRIDGE's cwd — a shared file must
 * speak in absolute paths or `~/` only.
 */
function sanitizePathList(raw: unknown, file: string, issueKey: string): string[] {
  if (!Array.isArray(raw)) return [];
  const list = raw.filter((p): p is string => typeof p === "string");
  const absolute = list.filter((p) => p.startsWith("/") || p.startsWith("~/"));
  if (absolute.length !== list.length && !warnedGlobalIssues.has(`${file}:${issueKey}`)) {
    warnedGlobalIssues.add(`${file}:${issueKey}`);
    warn(
      `sandbox: dropped ${list.length - absolute.length} non-absolute ${issueKey} entries in ${file}`,
    );
  }
  return absolute;
}

/** Parse a global-config-shaped object (unknown fields ignored). */
function sanitizeGlobalSandboxConfig(parsed: Partial<GlobalSandboxConfig>): GlobalSandboxConfig {
  return {
    allow: Array.isArray(parsed.allow) ? parsed.allow : [],
    deny: Array.isArray(parsed.deny) ? parsed.deny : [],
    strictGit: parsed.strictGit === true,
  };
}

/**
 * Live-read the machine-global sandbox config. Absent = nothing granted (the
 * file is only auto-created once, by ensureGlobalSandboxConfig; a user
 * DELETING it chose empty grants, and it is not resurrected). Malformed
 * bytes read as empty + a one-time warn, and persistGlobalSandboxConfig
 * refuses to overwrite them — the user's half-saved buffer survives.
 */
export function readGlobalSandboxConfig(): GlobalSandboxConfig {
  const file = globalSandboxConfigPath();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { allow: [], deny: [], strictGit: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (!warnedGlobalIssues.has(`${file}:malformed`)) {
      warnedGlobalIssues.add(`${file}:malformed`);
      warn(`sandbox: ${file} is not valid JSON — reading as empty grants`);
    }
    return { allow: [], deny: [], strictGit: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (!warnedGlobalIssues.has(`${file}:shape`)) {
      warnedGlobalIssues.add(`${file}:shape`);
      warn(`sandbox: ${file} is not a JSON object — reading as empty grants`);
    }
    return { allow: [], deny: [], strictGit: false };
  }
  const cfg = sanitizeGlobalSandboxConfig(parsed as Partial<GlobalSandboxConfig>);
  return {
    allow: sanitizePathList(cfg.allow, file, "allow"),
    deny: sanitizePathList(cfg.deny, file, "deny"),
    strictGit: cfg.strictGit,
  };
}

/**
 * Sync read-modify-write persistence (temp file + rename, lazy-alias-store
 * pattern). The only writers are bridge processes outside the sandbox, so a
 * lost update between two concurrent bridges costs one re-asked popup, never
 * a torn file. REFUSES to write over unparseable bytes.
 */
function persistSandboxConfigFile(
  file: string,
  mutate: (cfg: GlobalSandboxConfig) => GlobalSandboxConfig,
): boolean {
  let cfg: GlobalSandboxConfig;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    raw = ""; // absent — mutate starts from empty
  }
  if (raw !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (
      parsed === undefined ||
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      if (!warnedGlobalIssues.has(`${file}:refuse-write`)) {
        warnedGlobalIssues.add(`${file}:refuse-write`);
        warn(`sandbox: ${file} is unparseable — refusing to overwrite it (fix the file by hand)`);
      }
      return false;
    }
    cfg = sanitizeGlobalSandboxConfig(parsed as Partial<GlobalSandboxConfig>);
  } else {
    cfg = { allow: [], deny: [], strictGit: false };
  }
  const next = mutate(cfg);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
    );
    // O_EXCL: a project file's dir used to be agent-writable, so a planted
    // temp name must fail the write instead of being followed.
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { flag: "wx" });
    renameSync(tmp, file);
    return true;
  } catch (e) {
    warn(`sandbox: could not persist ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

function persistGlobalSandboxConfig(
  mutate: (cfg: GlobalSandboxConfig) => GlobalSandboxConfig,
): boolean {
  return persistSandboxConfigFile(globalSandboxConfigPath(), mutate);
}

/**
 * Bridge-side persistence for the popup's "始终允许" choice: append to the
 * global allow list. Returns false when persistence is impossible
 * (unparseable/unwritable file) — the caller downgrades to a bridge-lifetime
 * once-allow.
 */
export function appendGlobalSandboxAllow(allowedPath: string): boolean {
  const ok = persistGlobalSandboxConfig((cfg) =>
    cfg.allow.includes(allowedPath) ? cfg : { ...cfg, allow: [...cfg.allow, allowedPath] },
  );
  if (ok) log(`sandbox: allowlisted ${allowedPath} in ${globalSandboxConfigPath()}`);
  return ok;
}

/**
 * The visible counterpart for "永不放行": a denied path is RECORDED in the
 * global config, so the ask never resurfaces for it and the user can review
 * or undo the decision by editing the file.
 */
export function appendGlobalSandboxDeny(deniedPath: string): boolean {
  const ok = persistGlobalSandboxConfig((cfg) =>
    cfg.deny.includes(deniedPath) ? cfg : { ...cfg, deny: [...cfg.deny, deniedPath] },
  );
  if (ok) log(`sandbox: denylisted ${deniedPath} in ${globalSandboxConfigPath()}`);
  return ok;
}

// ---------------------------------------------------------------------------
// Per-project config (restored 2026-11-27): each live workspace's
// `.zcode/acp/sandbox.json` is live config again. Presence = in effect —
// the `enabled` key is ignored (the global switch is the only arm) — and
// popup persistence writes HERE for paths under a workspace root, so grants
// live where they apply. The file was dead between 2026-11-17 and this
// restore; the one-shot migration never re-reads it (ensureGlobalSandbox-
// Config early-returns on an existing global file), which is exactly why
// the face had to come back instead of "fixing" the migration.
// ---------------------------------------------------------------------------

/** Path of a workspace's per-project sandbox config. */
export function projectSandboxConfigPath(workspaceRoot: string): string {
  return path.join(resolveReal(workspaceRoot), ".zcode", "acp", "sandbox.json");
}

/**
 * Real paths of a workspace's deny island — its project config dir. The
 * project config lives INSIDE its write-allowed root, so the profile must
 * carve the dir out or the agent could edit its own allowlist (the guarantee
 * the global config dir deny gives the global file). Seatbelt matches real
 * paths: when `.zcode`/`acp` is a symlink (dotfiles layouts), writes through
 * the link land on the target while replacing the link itself lands on the
 * lexical path — deny both.
 */
export function projectSandboxIslandPaths(workspaceRoot: string): string[] {
  const lexical = path.join(resolveReal(workspaceRoot), ".zcode", "acp");
  const real = resolveReal(lexical);
  return real === lexical ? [lexical] : [lexical, real];
}

/**
 * A project config must be a REGULAR file at exactly its own path. A
 * symlinked or hardlinked-away config pierces the deny island: the agent
 * writes the link target inside the allowed workspace, or the bridge —
 * following the link — read-modify-writes some other JSON file as a deputy.
 * Such a config reads as absent and is never persisted through. A missing
 * file is fine: that is the "no project grants" state.
 */
function projectConfigIntegrityOk(file: string): boolean {
  try {
    const st = lstatSync(file);
    return st.isFile() && st.nlink === 1 && realpathSync(file) === file;
  } catch {
    return true;
  }
}

/**
 * Live-read one workspace's per-project grants. Absent, malformed or
 * symlinked/hardlinked → null (no grants; a corrupt or linked file warns once
 * and is skipped, never overwritten — persistSandboxConfigFile refuses it
 * separately).
 */
export function readProjectSandboxConfig(workspaceRoot: string): GlobalSandboxConfig | null {
  const file = projectSandboxConfigPath(workspaceRoot);
  if (!projectConfigIntegrityOk(file)) {
    if (!warnedGlobalIssues.has(`${file}:link`)) {
      warnedGlobalIssues.add(`${file}:link`);
      warn(
        `sandbox: ${file} is a symlink or has multiple links — ignoring it ` +
          `(a project config must be a regular file at exactly this path)`,
      );
    }
    return null;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    if (!warnedGlobalIssues.has(`${file}:malformed`)) {
      warnedGlobalIssues.add(`${file}:malformed`);
      warn(`sandbox: ${file} is not valid JSON — ignoring it`);
    }
    return null;
  }
  const cfg = sanitizeGlobalSandboxConfig(parsed as Partial<GlobalSandboxConfig>);
  return {
    allow: sanitizePathList(cfg.allow, file, "allow"),
    deny: sanitizePathList(cfg.deny, file, "deny"),
    strictGit: cfg.strictGit,
  };
}

/** Popup "始终允许" for a path under a workspace root (see readProjectSandboxConfig). */
export function appendProjectSandboxAllow(workspaceRoot: string, allowedPath: string): boolean {
  const file = projectSandboxConfigPath(workspaceRoot);
  if (!projectConfigIntegrityOk(file)) {
    warn(`sandbox: refusing to persist through a symlinked/hardlinked ${file}`);
    return false;
  }
  const ok = persistSandboxConfigFile(file, (cfg) =>
    cfg.allow.includes(allowedPath) ? cfg : { ...cfg, allow: [...cfg.allow, allowedPath] },
  );
  if (ok) log(`sandbox: allowlisted ${allowedPath} in ${file}`);
  return ok;
}

/** Popup "始终拒绝" for a path under a workspace root. */
export function appendProjectSandboxDeny(workspaceRoot: string, deniedPath: string): boolean {
  const file = projectSandboxConfigPath(workspaceRoot);
  if (!projectConfigIntegrityOk(file)) {
    warn(`sandbox: refusing to persist through a symlinked/hardlinked ${file}`);
    return false;
  }
  const ok = persistSandboxConfigFile(file, (cfg) =>
    cfg.deny.includes(deniedPath) ? cfg : { ...cfg, deny: [...cfg.deny, deniedPath] },
  );
  if (ok) log(`sandbox: denylisted ${deniedPath} in ${file}`);
  return ok;
}

// ---------------------------------------------------------------------------
// Legacy per-project config (REMOVED as a config source 2026-11-17; read
// exactly once, during migration into the global file).
// ---------------------------------------------------------------------------

/** The removed per-project config shape — kept for the one-shot migration. */
export interface LegacySandboxConfig {
  enabled: boolean;
  allow: string[];
  deny: string[];
  strictGit: boolean;
}

/** Path of the deprecated per-project config (migration reads only). */
export function sandboxConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".zcode", "acp", "sandbox.json");
}

/**
 * Tolerant legacy read for migration: missing/unparseable → null (nothing to
 * migrate — a corrupt leftover must not block the global template), relative
 * entries dropped (same rule the file always had).
 */
function readLegacySandboxConfig(workspaceRoot: string): LegacySandboxConfig | null {
  const file = projectSandboxConfigPath(workspaceRoot);
  // Same integrity rule as the live read — never follow a link into the
  // machine-global config.
  if (!projectConfigIntegrityOk(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const cfg = parsed as Partial<LegacySandboxConfig>;
  const keep = (list: unknown): string[] =>
    Array.isArray(list)
      ? list.filter((p) => typeof p === "string" && (p.startsWith("/") || p.startsWith("~/")))
      : [];
  return {
    enabled: cfg.enabled === true,
    allow: keep(cfg.allow),
    deny: keep(cfg.deny),
    strictGit: cfg.strictGit === true,
  };
}

/** Settled flag: the global config settle (create+migrate) runs once per process. */
let globalConfigSettled = false;

/**
 * One-shot per process: materialize the machine-global sandbox config.
 * Absent file → create it (O_EXCL — a sibling bridge winning the race is
 * fine, its content stands) from the toolchain template UNIONed with any
 * legacy per-project configs of the live roots. A legacy `enabled: true`
 * arms the GLOBAL switch (never silently disarm an upgraded machine); an
 * explicit `sandbox.enabled: false` in the user config wins over the
 * migration. Never writes into workspaces (#332) — only an explicit
 * in-workspace popup decision creates a project file.
 */
export async function ensureGlobalSandboxConfig(cwdRoots: Iterable<string>): Promise<void> {
  if (globalConfigSettled) return;
  globalConfigSettled = true; // set first: a failure must not retry every spawn
  const file = globalSandboxConfigPath();
  if (existsSync(file)) return; // user-managed from here on; deletion = empty grants

  const legacyAllow: string[] = [];
  const legacyDeny: string[] = [];
  let legacyStrictGit = false;
  let legacyArmed = false;
  for (const root of cwdRoots) {
    const legacy = readLegacySandboxConfig(resolveReal(root));
    if (!legacy) continue;
    for (const p of legacy.allow) if (!legacyAllow.includes(p)) legacyAllow.push(p);
    for (const p of legacy.deny) if (!legacyDeny.includes(p)) legacyDeny.push(p);
    legacyStrictGit = legacyStrictGit || legacy.strictGit;
    legacyArmed = legacyArmed || legacy.enabled;
  }
  const config: GlobalSandboxConfig = {
    allow: [...new Set([...TOOLCHAIN_TEMPLATE_ALLOW, ...legacyAllow])],
    deny: [...new Set(legacyDeny)],
    strictGit: legacyStrictGit,
  };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
    log(
      `sandbox: created ${file}` +
        (legacyAllow.length + legacyDeny.length > 0
          ? ` (migrated ${legacyAllow.length} allow / ${legacyDeny.length} deny legacy entries)`
          : " (toolchain template)"),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      warn(`sandbox: could not create ${file}: ${e instanceof Error ? e.message : String(e)}`);
      return; // the read path treats absence as empty grants; nothing else to do
    }
    // EEXIST: a sibling bridge won the create race — its content stands.
  }
  if (legacyArmed) await migrateLegacyArming();
}

/**
 * Carry a legacy per-project `enabled: true` onto the global switch. The
 * project switch no longer exists, so doing nothing would silently disarm a
 * machine that had the sandbox on — the arming intent migrates instead
 * (fail-closed direction). An explicit `sandbox.enabled: false` in the user
 * config is the user's later decision and wins; then we only warn.
 */
async function migrateLegacyArming(): Promise<void> {
  const file = userConfigPath();
  try {
    if (globalSandboxEnabled()) return; // already armed (env or file)
    const current = await readJsonDocument(file);
    const sandbox =
      current !== null && typeof current["sandbox"] === "object" && current["sandbox"] !== null
        ? (current["sandbox"] as Record<string, unknown>)
        : null;
    if (sandbox !== null && sandbox["enabled"] === false) {
      warn(
        `sandbox: a legacy project config had enabled:true, but ${file} explicitly sets ` +
          "sandbox.enabled:false — NOT arming; flip that key to re-arm",
      );
      return;
    }
    await writeJsonAtomic(file, (cur) => {
      const section =
        typeof cur["sandbox"] === "object" && cur["sandbox"] !== null
          ? { ...(cur["sandbox"] as Record<string, unknown>) }
          : {};
      if (section["enabled"] === true) return cur;
      return { ...cur, sandbox: { ...section, enabled: true } };
    });
    warn(
      `sandbox: legacy per-project sandbox switch migrated — armed globally via ` +
        `sandbox.enabled:true in ${file} (edit that file to turn it off)`,
    );
  } catch (e) {
    warn(
      `sandbox: legacy arm migration failed (${e instanceof Error ? e.message : String(e)}) — ` +
        `set sandbox.enabled:true in ${file} to re-arm`,
    );
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
  /** Live workspace roots (resolved + deduped here). */
  workspaceRoots: Iterable<string>;
  /** Machine-global grants: allow list + strictGit flag. */
  config: GlobalSandboxConfig;
  /**
   * Per-workspace `.zcode/acp/sandbox.json` grants (2026-11-27 restore):
   * the caller live-reads one per workspace root at every arm. Allow lists
   * join the allow section, deny lists join the deny tail (they must beat
   * the implicit workspace-root allow), strictGit is OR-ed.
   */
  projectConfigs?: Iterable<GlobalSandboxConfig>;
  /** Bridge-lifetime once-allows granted via the dynamic allow flow. */
  onceAllows?: Iterable<string>;
  /**
   * Directory the profile file itself lives in — self-denied LAST so the
   * sandboxed agent cannot race/symlink/occupy the next respawn's profile
   * (see armSandboxArgv). $TMPDIR is agent-writable, so without this the
   * profile path would be attacker-reachable.
   */
  profileDir?: string;
  /**
   * Managed root under which every profile dir lives (`~/.zcode-acp/sandbox/`).
   * Denied in full: no sandboxed generation may touch ANY profile, its own or
   * another bridge's — same placement invariant the profileDir deny provides,
   * covering the whole centralized tree.
   */
  profilesRoot?: string;
}

/**
 * Build the SBPL profile text. SBPL resolves overlapping rules by LAST
 * match (verified empirically: an allow emitted after a deny re-permits the
 * write), so the layout is: base deny-all, then every allow, then the deny
 * carve-outs (global config dir, per-root config islands, strictGit, profile
 * dirs, project denies) LAST so nothing can override them.
 */
export function buildSandboxProfile(input: SandboxArmInput): string {
  const allows: string[] = [];
  const denies: string[] = [];
  const projectConfigs = [...(input.projectConfigs ?? [])];
  const strictGit = input.config.strictGit || projectConfigs.some((pc) => pc.strictGit);
  const seenRoots = new Set<string>();
  for (const root of input.workspaceRoots) {
    // Resolve here too (idempotent): direct callers may pass symlinked
    // roots (/tmp → /private/tmp) that would silently fail subpath match.
    const real = resolveReal(root);
    if (seenRoots.has(real)) continue;
    seenRoots.add(real);
    allows.push(`(allow file-write* (subpath ${sb(real)}))`);
    if (strictGit) {
      denies.push(`(deny file-write* (subpath ${sb(path.join(real, ".git"))}))`);
    }
  }
  for (const allowed of input.config.allow) {
    allows.push(`(allow file-write* (subpath ${sb(resolveReal(allowed))}))`);
  }
  for (const pc of projectConfigs) {
    for (const allowed of pc.allow) {
      allows.push(`(allow file-write* (subpath ${sb(resolveReal(allowed))}))`);
    }
  }
  for (const p of [...ZCODE_STATE_DIRS, ...DEFAULT_CACHE_DIRS, ...DEFAULT_TEMP_DIRS]) {
    allows.push(`(allow file-write* (subpath ${sb(resolveReal(p))}))`);
  }
  for (const allowed of input.onceAllows ?? []) {
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
  // covered by (allow default). The slave allow mirrors Apple's own profiles
  // (application.sb, com.apple.neagent.sb): the sandbox pty extension gates
  // it to slaves cloned through THIS sandbox's ptmx opens (the extension
  // follows fork/exec into tool children), so no other same-user tty
  // becomes writable.
  allows.push(`(allow file-write* (literal "/dev/ptmx"))`);
  allows.push(
    `(allow file-write* (require-all (regex #"^/dev/ttys[0-9]+$") ` +
      `(extension "com.apple.sandbox.pty")))`,
  );
  // The global config dir (sandbox.json + config.json + hub credentials):
  // agent-unreachable by policy — the bridge persists grants there from
  // OUTSIDE the sandbox. Emitted in the deny tail so a workspace allow that
  // covers it (a workspace rooted at $HOME) can never re-permit it.
  denies.push(`(deny file-write* (subpath ${sb(globalSandboxConfigDir())}))`);
  // Same guarantee for each workspace's project config, which lives inside
  // its own write-allowed root: without this carve-out the agent could edit
  // the project allowlist it is about to run under (ADR-0011 deny island).
  for (const real of seenRoots) {
    for (const island of projectSandboxIslandPaths(real)) {
      denies.push(`(deny file-write* (subpath ${sb(island)}))`);
    }
  }
  if (input.profileDir) {
    denies.push(`(deny file-write* (subpath ${sb(input.profileDir)}))`);
  }
  if (input.profilesRoot) {
    denies.push(`(deny file-write* (subpath ${sb(resolveReal(input.profilesRoot))}))`);
  }
  // Project denies LAST of all: SBPL resolves overlaps by last match, so a
  // project "永不放行" must beat the implicit workspace-root allow above.
  for (const pc of projectConfigs) {
    for (const p of pc.deny) {
      denies.push(`(deny file-write* (subpath ${sb(resolveReal(p))}))`);
    }
  }
  return (
    ["(version 1)", "(allow default)", "(deny file-write*)", ...allows, ...denies].join("\n") + "\n"
  );
}

let platformWarned = false;

/** Global arm request: `sandbox.enabled` in the user config file (file wins) or ZCODE_ACP_SANDBOX=1/true. */
function globalWanted(): boolean {
  return globalSandboxEnabled();
}

/**
 * Whether the sandbox should arm for this bridge: the GLOBAL switch only
 * (user config `sandbox.enabled` or ZCODE_ACP_SANDBOX=1) — the per-project
 * opt-in was removed with the per-project config (2026-11-17; a legacy
 * enabled:true was migrated onto the global switch by
 * ensureGlobalSandboxConfig). Live read — a config flip mid-run is seen at
 * the next sandboxActive call (applySandboxFlip applies it at prompt entry).
 * macOS-only: elsewhere a requested sandbox warns once and runs unsandboxed.
 */
export function sandboxActive(): boolean {
  if (!globalWanted()) return false;
  if (process.platform !== "darwin") {
    if (!platformWarned) {
      platformWarned = true;
      warn(
        `sandbox: requested (${SANDBOX_ENV}=1 or config file) but Seatbelt is macOS-only — running WITHOUT sandbox`,
      );
    }
    return false;
  }
  return true;
}

/** Test hook: reset cached decisions and warn-once sets. */
export function resetSandboxDecisionForTest(): void {
  platformWarned = false;
  warnedGlobalIssues.clear();
  globalConfigSettled = false;
}

/** Previous respawn's profile dir — removed once superseded (its backend is dead). */
let lastProfileDir: string | null = null;

/** Managed root for all sandbox profile dirs — centralized, sweepable. */
export function sandboxProfilesRoot(): string {
  return path.join(os.homedir(), ".zcode-acp", "sandbox");
}

/** Age at which a profile dir is sweepable even if its pid looks alive. */
const SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Old-name `~/.zcode-acp-sbx-*` sibling from a pre-centralization bridge. */
const LEGACY_SBX_PREFIX = ".zcode-acp-sbx-";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists but belongs to another user — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove profile dirs of DEAD bridges. Each dir is pid-encoded (`p-<pid>-*`):
 * a live pid (another running bridge) keeps its dir, a dead pid is a crash
 * leak. The 7-day age guard also reaps dirs held "alive" by a recycled or
 * zombie pid. Runs only from armSandboxArgv, best-effort throughout.
 */
function sweepProfileDirs(root: string): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return; // no root yet or unreadable — nothing to sweep
  }
  const now = Date.now();
  for (const entry of entries) {
    const full = path.join(root, entry);
    if (full === lastProfileDir) continue;
    const m = /^p-(\d+)-/.exec(entry);
    try {
      const stale = now - statSync(full).mtimeMs > SWEEP_MAX_AGE_MS;
      // Own pid + not lastProfileDir = a chain-cleanup leftover of THIS
      // process — dead by construction. Unparsable name: age-expire only.
      const dead = m ? Number(m[1]) === process.pid || !pidAlive(Number(m[1])) : stale;
      if (stale || dead) rmSync(full, { recursive: true, force: true });
    } catch {
      // best-effort — a vanished/racing dir is fine
    }
  }
}

/**
 * Migration sweep: remove the per-arm `~/.zcode-acp-sbx-*` HOME siblings
 * this bridge's ancestors leaked (each bridge cleaned only its own previous
 * dir; crashes and restarts accumulated — 121 observed on one machine). Runs
 * on every arm (idempotent): old bridges may still be alive and leaking. The
 * 1h mtime guard leaves alone anything a still-running OLD bridge may be
 * reading mid-exec; a profile is only ever read at exec time, and every arm
 * creates a fresh dir, so older siblings are dead by construction.
 */
function sweepLegacySbxDirs(): void {
  const home = os.homedir();
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return;
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.startsWith(LEGACY_SBX_PREFIX)) continue;
    const full = path.join(home, entry);
    try {
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Arm a backend argv: build the profile into a FRESH unpredictable dir under
 * `~/.zcode-acp/sandbox/` and wrap with sandbox-exec. The managed root is
 * OUTSIDE every whitelisted path (the profile allows ~/.zcode* state dirs,
 * caches, and temp trees — never ~/.zcode-acp), which is the load-bearing
 * defense: $TMPDIR and the cache dirs are agent-writable, and a PRIOR
 * sandboxed generation (a setsid survivor of the old process group) keeps its
 * own profile's allows — so a profile placed there could be raced, symlinked,
 * FIFO'd, or occupied no matter how fresh its name (reproduced across
 * generations even with mkdtemp + O_EXCL + a self-deny, which each generation
 * only applies to its own dir). The agent can also kill the backend at will
 * (signals are not file-writes) to control respawn timing; with the profile
 * unreachable from ANY generation, that primitive buys nothing. O_EXCL ("wx")
 * additionally refuses pre-placed symlinks from a pre-arming process, the
 * profile denies the whole profiles root last, and the self-deny of its own
 * dir remains as defense in depth for the workspace-root-is-$HOME edge (where
 * home itself is writable).
 */
export function armSandboxArgv(argv: string[], input: SandboxArmInput): string[] {
  const root = sandboxProfilesRoot();
  mkdirSync(root, { recursive: true });
  // pid-encoded name: the arm-time sweep can tell a live bridge's profile
  // from a crashed bridge's leak and remove only the latter.
  const dir = mkdtempSync(path.join(root, `p-${process.pid}-`));
  const file = path.join(dir, "profile.sb");
  writeFileSync(file, buildSandboxProfile({ ...input, profileDir: dir, profilesRoot: root }), {
    flag: "wx",
  });
  if (lastProfileDir && lastProfileDir !== dir) {
    try {
      rmSync(lastProfileDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of a superseded profile
    }
  }
  lastProfileDir = dir;
  sweepProfileDirs(root);
  sweepLegacySbxDirs();
  log(`sandbox: backend wrapped with sandbox-exec (profile: ${file})`);
  return ["sandbox-exec", "-f", file, ...argv];
}
