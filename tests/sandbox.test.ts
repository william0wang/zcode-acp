/**
 * Unit tests for the Seatbelt sandbox layer (ADR-0011): the machine-global
 * config (template creation, legacy per-project migration, arm carry-over,
 * append persistence), profile generation (workspace allow + global allow +
 * strictGit + /dev/null + config-dir deny + profile self-deny), global-switch
 * arming, mid-run flip via applySandboxFlip, and hardened argv arming. Real
 * sandbox behaviour (deny-rule precedence) is exercised by
 * scripts/verify-sandbox.sh — CI runners are linux where sandbox-exec does
 * not exist, so every "arms" assertion runs under a stubbed darwin platform.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeBackend } from "../src/backend/index.js";
import {
  SANDBOX_ENV,
  appendGlobalSandboxAllow,
  appendGlobalSandboxDeny,
  appendProjectSandboxAllow,
  appendProjectSandboxDeny,
  armSandboxArgv,
  buildSandboxProfile,
  ensureGlobalSandboxConfig,
  globalSandboxConfigDir,
  globalSandboxConfigPath,
  projectSandboxConfigPath,
  projectSandboxIslandPaths,
  readGlobalSandboxConfig,
  readProjectSandboxConfig,
  resetSandboxDecisionForTest,
  sandboxActive,
  sandboxConfigPath,
  sandboxProfilesRoot,
} from "../src/backend/sandbox.js";
import { userConfigPath } from "../src/config/user-config.js";

// The arm tests redirect os.homedir() to a repo-local fixture (sandboxed
// agent sessions deny writes to the real $HOME); the passthrough mock keeps
// every other consumer on the real value until explicitly overridden. The
// `default` re-export matters: sandbox.ts does a default import.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  const homedir = vi.fn(actual.homedir);
  return { ...actual, homedir, default: { ...actual, homedir } };
});

// os.tmpdir() is symlinked on macOS (/var → /private/var) and Seatbelt
// matches real paths — every fixture must be realpath'd like production.
let tmpRoot: string;
// Scratch XDG root so the global sandbox.json / config.json land in the
// test's own tree (userConfigPath is XDG aware; hermetic-home deleted the
// ambient variable).
let xdgRoot: string;

beforeEach(() => {
  // A sandboxed agent session exports ZCODE_ACP_SANDBOX itself; clear it up
  // front so the first test starts from the "no env" state it asserts (the
  // afterEach delete only helps tests that run after the first one).
  delete process.env[SANDBOX_ENV];
  tmpRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-test-")));
  xdgRoot = mkdtempSync(path.join(os.tmpdir(), "sb-xdg-"));
  process.env.XDG_CONFIG_HOME = xdgRoot;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(xdgRoot, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  delete process.env[SANDBOX_ENV];
  resetSandboxDecisionForTest();
});

/** Run a sync body under a stubbed process.platform (restored after). */
function withPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", { value: real, configurable: true });
  }
}

async function withPlatformAsync<R>(platform: NodeJS.Platform, body: () => Promise<R>): Promise<R> {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await body();
  } finally {
    Object.defineProperty(process, "platform", { value: real, configurable: true });
  }
}

/** Write a legacy per-project config with the given fields (mkdir included). */
function writeLegacyConfig(root: string, cfg: Record<string, unknown>): void {
  mkdirSync(path.join(root, ".zcode", "acp"), { recursive: true });
  writeFileSync(sandboxConfigPath(root), JSON.stringify(cfg));
}

describe("sandboxActive", () => {
  it("stays off with no env and no config switch", () => {
    const armed = withPlatform("darwin", () => {
      resetSandboxDecisionForTest();
      return sandboxActive();
    });
    expect(armed).toBe(false);
  });

  it("env arms globally", () => {
    const armed = withPlatform("darwin", () => {
      process.env[SANDBOX_ENV] = "1";
      resetSandboxDecisionForTest();
      return sandboxActive();
    });
    expect(armed).toBe(true);
  });

  it("config-file sandbox.enabled arms (file wins over unset env)", () => {
    mkdirSync(path.dirname(userConfigPath()), { recursive: true });
    writeFileSync(userConfigPath(), JSON.stringify({ sandbox: { enabled: true } }));
    expect(withPlatform("darwin", () => sandboxActive())).toBe(true);
  });

  it("stays unsandboxed (with a warn) on non-macOS even when armed", () => {
    const armed = withPlatform("linux", () => {
      process.env[SANDBOX_ENV] = "1";
      resetSandboxDecisionForTest();
      return sandboxActive();
    });
    expect(armed).toBe(false);
  });
});

describe("readGlobalSandboxConfig", () => {
  it("absent file reads as empty grants", () => {
    expect(readGlobalSandboxConfig()).toEqual({ allow: [], deny: [], strictGit: false });
  });

  it("malformed bytes read as empty grants and are never rewritten", () => {
    const file = globalSandboxConfigPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{not json");
    expect(readGlobalSandboxConfig()).toEqual({ allow: [], deny: [], strictGit: false });
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("drops relative entries — they would anchor to the bridge cwd", () => {
    const file = globalSandboxConfigPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        allow: ["/abs/path", "~/cache", "../escape", "foo"],
        deny: [],
        strictGit: true,
      }),
    );
    expect(readGlobalSandboxConfig()).toEqual({
      allow: ["/abs/path", "~/cache"],
      deny: [],
      strictGit: true,
    });
  });
});

describe("appendGlobalSandboxAllow / appendGlobalSandboxDeny", () => {
  it("persists always-allow entries without duplicates, preserving other fields", () => {
    expect(appendGlobalSandboxAllow("/opt/data")).toBe(true);
    expect(appendGlobalSandboxAllow("/opt/data")).toBe(true);
    expect(appendGlobalSandboxAllow("/opt/other")).toBe(true);
    const onDisk = JSON.parse(readFileSync(globalSandboxConfigPath(), "utf8"));
    expect(onDisk).toEqual({ allow: ["/opt/data", "/opt/other"], deny: [], strictGit: false });
  });

  it("appendGlobalSandboxDeny persists visibly and preserves every other field", () => {
    appendGlobalSandboxAllow("/opt/ok");
    appendGlobalSandboxDeny("/opt/blocked");
    expect(appendGlobalSandboxDeny("/opt/blocked")).toBe(true); // dedupe
    const onDisk = JSON.parse(readFileSync(globalSandboxConfigPath(), "utf8"));
    expect(onDisk).toEqual({ allow: ["/opt/ok"], deny: ["/opt/blocked"], strictGit: false });
  });

  it("refuses to overwrite an unparseable file (bytes survive)", () => {
    const file = globalSandboxConfigPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{not json");
    expect(appendGlobalSandboxAllow("/opt/data")).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });
});

describe("ensureGlobalSandboxConfig", () => {
  it("creates the toolchain template when no legacy config exists", async () => {
    await ensureGlobalSandboxConfig([tmpRoot]);
    const onDisk = JSON.parse(readFileSync(globalSandboxConfigPath(), "utf8"));
    expect(onDisk.strictGit).toBe(false);
    expect(onDisk.deny).toEqual([]);
    expect(onDisk.allow[0]).toBe("~/go");
    expect(onDisk.allow).toContain("~/.gradle");
    expect(onDisk.allow).toContain("~/.m2");
    // #332: nothing is ever written into the workspace.
    expect(existsSync(path.join(tmpRoot, ".zcode"))).toBe(false);
    // enabled:false legacy (or none) must NOT touch the user config's switch.
    expect(existsSync(userConfigPath())).toBe(false);
  });

  it("migrates legacy allow/deny/strictGit from the live roots", async () => {
    writeLegacyConfig(tmpRoot, {
      enabled: false,
      allow: ["/opt/legacy", "/opt/legacy"],
      deny: ["/opt/blocked"],
      strictGit: true,
    });
    await ensureGlobalSandboxConfig([tmpRoot]);
    const onDisk = JSON.parse(readFileSync(globalSandboxConfigPath(), "utf8"));
    expect(onDisk.allow).toContain("/opt/legacy");
    expect(onDisk.allow[0]).toBe("~/go"); // template + legacy union
    expect(onDisk.deny).toEqual(["/opt/blocked"]);
    expect(onDisk.strictGit).toBe(true);
    // enabled:false — no arm carry-over.
    expect(existsSync(userConfigPath())).toBe(false);
  });

  it("legacy enabled:true carries onto the global switch (never silently disarm)", async () => {
    writeLegacyConfig(tmpRoot, { enabled: true, allow: [] });
    await ensureGlobalSandboxConfig([tmpRoot]);
    const userCfg = JSON.parse(readFileSync(userConfigPath(), "utf8"));
    expect(userCfg.sandbox.enabled).toBe(true);
  });

  it("an explicit sandbox.enabled:false in the user config wins over the migration", async () => {
    writeLegacyConfig(tmpRoot, { enabled: true, allow: [] });
    mkdirSync(path.dirname(userConfigPath()), { recursive: true });
    writeFileSync(userConfigPath(), JSON.stringify({ sandbox: { enabled: false } }));
    await ensureGlobalSandboxConfig([tmpRoot]);
    const userCfg = JSON.parse(readFileSync(userConfigPath(), "utf8"));
    expect(userCfg.sandbox.enabled).toBe(false);
  });

  it("an existing global file wins — legacy files are ignored entirely", async () => {
    mkdirSync(path.dirname(globalSandboxConfigPath()), { recursive: true });
    writeFileSync(globalSandboxConfigPath(), JSON.stringify({ allow: ["/x"] }));
    writeLegacyConfig(tmpRoot, { enabled: true, allow: ["/opt/legacy"] });
    await ensureGlobalSandboxConfig([tmpRoot]);
    const onDisk = JSON.parse(readFileSync(globalSandboxConfigPath(), "utf8"));
    expect(onDisk).toEqual({ allow: ["/x"] });
    expect(existsSync(userConfigPath())).toBe(false);
  });

  it("settles once per process — a later deletion is not resurrected", async () => {
    await ensureGlobalSandboxConfig([tmpRoot]);
    rmSync(globalSandboxConfigPath());
    await ensureGlobalSandboxConfig([tmpRoot]);
    expect(existsSync(globalSandboxConfigPath())).toBe(false);
    expect(readGlobalSandboxConfig().allow).toEqual([]); // deletion = empty grants
  });
});

describe("buildSandboxProfile", () => {
  it("denies writes by default, allows the workspace, denies the global config dir", () => {
    const profile = buildSandboxProfile({
      workspaceRoots: [tmpRoot],
      config: { allow: [], deny: [], strictGit: false },
      onceAllows: [],
    });
    const lines = profile.split("\n");
    expect(lines[0]).toBe("(version 1)");
    expect(lines).toContain("(deny file-write*)");
    expect(lines).toContain(`(allow file-write* (subpath "${tmpRoot}"))`);
    // The workspace's own config dir is a deny island again (restored with
    // the per-project config 2026-11-27) — after every allow.
    const islandDeny = `(deny file-write* (subpath "${path.join(tmpRoot, ".zcode", "acp")}"))`;
    expect(lines).toContain(islandDeny);
    expect(lines.indexOf(islandDeny)).toBeGreaterThan(
      lines.lastIndexOf(`(allow file-write* (subpath "${tmpRoot}"))`),
    );
    // The global config dir is denied — after every allow (SBPL last-match).
    const configDirDeny = `(deny file-write* (subpath "${globalSandboxConfigDir()}"))`;
    expect(lines).toContain(configDirDeny);
    const firstDenyIdx = lines.findIndex((l) => l.startsWith("(deny file-write*"));
    expect(lines.indexOf(configDirDeny)).toBeGreaterThan(
      lines.lastIndexOf(`(allow file-write* (subpath "${tmpRoot}"))`),
    );
    expect(firstDenyIdx).toBeGreaterThan(0);
    // Default cache dirs + zcode state are present (resolved under $HOME).
    expect(profile).toContain('/.zcode"');
    expect(profile).toContain('/.npm"');
    // /dev/null must be writable — git and `2>/dev/null` idioms break without
    // it ("could not open '/dev/null'", observed in review probes).
    expect(profile).toContain('(allow file-write-data (literal "/dev/null"))');
    // pty allocation (#127): openpty opens /dev/ptmx + the granted /dev/ttysNNN
    // pair O_RDWR; the write half needs explicit allows or `script`/TUI
    // binaries die with a bare `openpty: Operation not permitted`. The slave
    // allow is extension-gated (Apple application.sb form): only slaves
    // cloned through this sandbox's own ptmx are writable.
    expect(profile).toContain('(allow file-write* (literal "/dev/ptmx"))');
    expect(profile).toContain(
      '(allow file-write* (require-all (regex #"^/dev/ttys[0-9]+$") ' +
        '(extension "com.apple.sandbox.pty")))',
    );
    // SBPL is LAST-MATCH: these allows only hold while no later deny matches
    // /dev too (all emitted denies are config-dir/workspace/self subpaths).
    // A future deny touching /dev would silently re-break openpty with the
    // allows still present in the text — pin that it can never happen.
    const denyLines = lines.filter((l) => l.startsWith("(deny"));
    expect(denyLines.length).toBeGreaterThan(0);
    for (const l of denyLines) expect(l).not.toContain("/dev");
    // Well-known system temp trees are default-allowed in RESOLVED form:
    // tools hardcode /tmp (symlink → /private/tmp) or /var/tmp, and $TMPDIR
    // names only the per-user /var/folders leaf. An /tmp allow entry resolves
    // to the same line — no duplicate alias emission.
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))');
    expect(profile).toContain('(allow file-write* (subpath "/private/var/tmp"))');
    expect(profile).toContain('(allow file-write* (subpath "/private/var/folders"))');
    expect(profile.match(/subpath "\/private\/tmp"/g)).toHaveLength(1);
    // The profile's own dir self-denies LAST — the agent runs with $TMPDIR
    // writable and must not touch the next respawn's profile.
    const profile2 = buildSandboxProfile({
      workspaceRoots: [tmpRoot],
      config: { allow: [], deny: [], strictGit: false },
      onceAllows: [],
      profileDir: "/fake/sbx-dir",
    });
    const lines2 = profile2.split("\n");
    expect(lines2[lines2.length - 2]).toBe('(deny file-write* (subpath "/fake/sbx-dir"))');
  });

  it("adds a .git deny only under strictGit", () => {
    const strict = buildSandboxProfile({
      workspaceRoots: [tmpRoot],
      config: { allow: [], deny: [], strictGit: true },
      onceAllows: [],
    });
    expect(strict).toContain(`(deny file-write* (subpath "${path.join(tmpRoot, ".git")}"))`);
    const lax = buildSandboxProfile({
      workspaceRoots: [tmpRoot],
      config: { allow: [], deny: [], strictGit: false },
      onceAllows: [],
    });
    expect(lax).not.toContain('".git"');
  });

  it("includes global config allow entries and once-allows", () => {
    // realpath BEFORE removing: resolveReal must land on the resolved prefix.
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-out-")));
    rmSync(outside, { recursive: true, force: true }); // not created: resolveReal must survive
    const profile = buildSandboxProfile({
      workspaceRoots: [tmpRoot],
      config: { allow: [outside], deny: [], strictGit: false },
      onceAllows: [path.join(tmpRoot, "elsewhere")],
    });
    expect(profile).toContain(`(allow file-write* (subpath "${outside}"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${path.join(tmpRoot, "elsewhere")}"))`);
  });

  // 2026-11-27 restore: per-project grants join the profile. allow → allow
  // section; deny → the deny TAIL (SBPL last-match — a project "永不放行"
  // must beat the implicit workspace-root allow and every other allow);
  // strictGit is OR-ed with the global flag.
  it("unions per-project configs: allow section, deny tail after every allow, strictGit OR", () => {
    const projectAllow = path.join(tmpRoot, "vendor");
    const projectDeny = path.join(tmpRoot, "secrets");
    const profile = buildSandboxProfile({
      workspaceRoots: [tmpRoot],
      config: { allow: [], deny: [], strictGit: false },
      projectConfigs: [{ allow: [projectAllow], deny: [projectDeny], strictGit: true }],
      onceAllows: [],
    });
    const lines = profile.split("\n");
    expect(lines).toContain(`(allow file-write* (subpath "${projectAllow}"))`);
    const denyLine = `(deny file-write* (subpath "${projectDeny}"))`;
    expect(lines).toContain(denyLine);
    // strictGit carried by the PROJECT config alone
    expect(lines).toContain(`(deny file-write* (subpath "${path.join(tmpRoot, ".git")}"))`);
    const wsAllowIdx = lines.indexOf(`(allow file-write* (subpath "${tmpRoot}"))`);
    const projAllowIdx = lines.indexOf(`(allow file-write* (subpath "${projectAllow}"))`);
    const projDenyIdx = lines.indexOf(denyLine);
    expect(projDenyIdx).toBeGreaterThan(wsAllowIdx);
    expect(projDenyIdx).toBeGreaterThan(projAllowIdx);
    // It is the profile's LAST deny — nothing after it can re-permit.
    const lastDenyIdx = lines
      .map((l, i) => (l.startsWith("(deny") ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    expect(lastDenyIdx).toBe(projDenyIdx);
  });

  // The project config lives INSIDE its write-allowed root: without the
  // carve-out the agent could edit the allowlist it runs under.
  it("keeps each workspace's config dir a deny island after every allow", () => {
    const island = path.join(tmpRoot, ".zcode", "acp");
    const profile = buildSandboxProfile({
      workspaceRoots: [tmpRoot],
      // Allows naming the island (or an ancestor of it) from every layer…
      config: { allow: [island], deny: [], strictGit: false },
      projectConfigs: [{ allow: [tmpRoot], deny: [], strictGit: false }],
      onceAllows: [island],
    });
    const lines = profile.split("\n");
    const deny = `(deny file-write* (subpath "${island}"))`;
    expect(lines).toContain(deny);
    // …re-permit nothing: the island deny sits after the LAST allow
    // (SBPL last-match).
    const lastAllowIdx = lines
      .map((l, i) => (l.startsWith("(allow") ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    expect(lines.indexOf(deny)).toBeGreaterThan(lastAllowIdx);
  });

  it("resolves a symlinked .zcode/acp island onto its real target", () => {
    const target = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-island-")));
    try {
      mkdirSync(path.join(tmpRoot, ".zcode"));
      symlinkSync(target, path.join(tmpRoot, ".zcode", "acp"));
      // Both spellings: writes THROUGH the link land on the target, while
      // replacing the link itself lands on the lexical path.
      expect(projectSandboxIslandPaths(tmpRoot)).toEqual([
        path.join(tmpRoot, ".zcode", "acp"),
        target,
      ]);
      const profile = buildSandboxProfile({
        workspaceRoots: [tmpRoot],
        config: { allow: [], deny: [], strictGit: false },
        onceAllows: [],
      });
      expect(profile).toContain(`(deny file-write* (subpath "${target}"))`);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

// 2026-11-27 restore: `<workspace>/.zcode/acp/sandbox.json` is live config
// again. Presence = in effect (enabled ignored); popup persistence writes it
// for in-workspace paths.
describe("per-project sandbox config", () => {
  it("absent file reads as no grants", () => {
    expect(readProjectSandboxConfig(tmpRoot)).toBeNull();
  });

  it("reads allow/deny/strictGit and IGNORES the legacy enabled key", () => {
    mkdirSync(path.join(tmpRoot, ".zcode", "acp"), { recursive: true });
    writeFileSync(
      projectSandboxConfigPath(tmpRoot),
      JSON.stringify({
        enabled: true,
        allow: ["~/go", `${tmpRoot}/vendor`],
        deny: [`${tmpRoot}/secrets`],
        strictGit: true,
      }),
    );
    const cfg = readProjectSandboxConfig(tmpRoot);
    expect(cfg?.allow).toEqual(["~/go", `${tmpRoot}/vendor`]);
    expect(cfg?.deny).toEqual([`${tmpRoot}/secrets`]);
    expect(cfg?.strictGit).toBe(true);
  });

  it("malformed file reads as null and the appenders refuse to overwrite it", () => {
    mkdirSync(path.join(tmpRoot, ".zcode", "acp"), { recursive: true });
    const file = projectSandboxConfigPath(tmpRoot);
    writeFileSync(file, "{not json");
    expect(readProjectSandboxConfig(tmpRoot)).toBeNull();
    expect(appendProjectSandboxAllow(tmpRoot, `${tmpRoot}/x`)).toBe(false);
    expect(appendProjectSandboxDeny(tmpRoot, `${tmpRoot}/x`)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("appendProjectSandboxAllow/Deny create the file and extend it, preserving other fields", () => {
    expect(appendProjectSandboxAllow(tmpRoot, `${tmpRoot}/a`)).toBe(true);
    expect(appendProjectSandboxAllow(tmpRoot, `${tmpRoot}/a`)).toBe(true); // no dup
    expect(appendProjectSandboxDeny(tmpRoot, `${tmpRoot}/b`)).toBe(true);
    const cfg = readProjectSandboxConfig(tmpRoot);
    expect(cfg?.allow).toEqual([`${tmpRoot}/a`]);
    expect(cfg?.deny).toEqual([`${tmpRoot}/b`]);
    expect(cfg?.strictGit).toBe(false);
  });

  // A linked config pierces the deny island: the agent would edit the link
  // target inside the allowed workspace, or the bridge — following the link
  // — would read-modify-write some other JSON file as a deputy.
  it("a symlinked config reads as null and the appenders refuse to touch it", () => {
    const elsewhere = path.join(tmpRoot, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ allow: ["/"], deny: [], strictGit: false }));
    mkdirSync(path.join(tmpRoot, ".zcode", "acp"), { recursive: true });
    const file = projectSandboxConfigPath(tmpRoot);
    symlinkSync(elsewhere, file);

    expect(readProjectSandboxConfig(tmpRoot)).toBeNull();
    expect(appendProjectSandboxAllow(tmpRoot, `${tmpRoot}/x`)).toBe(false);
    expect(appendProjectSandboxDeny(tmpRoot, `${tmpRoot}/x`)).toBe(false);
    // The link target — what a deputy write would have widened — is untouched,
    // and the link itself is not silently replaced by a regular file.
    expect(JSON.parse(readFileSync(elsewhere, "utf8"))).toEqual({
      allow: ["/"],
      deny: [],
      strictGit: false,
    });
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it("a hardlinked config reads as null", () => {
    const elsewhere = path.join(tmpRoot, "elsewhere.json");
    mkdirSync(path.join(tmpRoot, ".zcode", "acp"), { recursive: true });
    writeFileSync(
      elsewhere,
      JSON.stringify({ allow: [`${tmpRoot}/x`], deny: [], strictGit: false }),
    );
    linkSync(elsewhere, projectSandboxConfigPath(tmpRoot));

    expect(readProjectSandboxConfig(tmpRoot)).toBeNull();
  });
});

describe("applySandboxFlip", () => {
  it("kills an unsandboxed live backend once the global switch arms mid-run", async () => {
    const server = new ZcodeAcpServer();
    const closed = vi.fn().mockResolvedValue(undefined);
    server.backend = { isDead: false, close: closed } as unknown as ZcodeBackend;
    server.sessionCwds.set("acp_a", tmpRoot);
    await withPlatformAsync("darwin", () => server.applySandboxFlip());
    expect(closed).not.toHaveBeenCalled();
    process.env[SANDBOX_ENV] = "1";
    await withPlatformAsync("darwin", () => server.applySandboxFlip());
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe("armSandboxArgv", () => {
  // Sandboxed agent sessions deny writes to the real $HOME, which would
  // EPERM the profile mkdtemp. Redirect the base into the repo — still NOT
  // $TMPDIR, so the "outside the temp trees" race-proofing assertion below
  // keeps testing what it always did.
  let homeBase: string;

  beforeEach(() => {
    homeBase = mkdtempSync(path.join(realpathSync(process.cwd()), ".sb-home-"));
    vi.mocked(os.homedir).mockReturnValue(homeBase);
  });

  afterEach(() => {
    // Cleanup first: an afterEach that throws halfway (e.g. on a broken
    // mock) must not leak the fixture dir into the repo.
    rmSync(homeBase, { recursive: true, force: true });
    vi.mocked(os.homedir).mockRestore();
  });

  const arm = () =>
    armSandboxArgv(["/usr/local/bin/node", "/glm/zcode.cjs", "app-server", "--stdio"], {
      workspaceRoots: [tmpRoot],
      config: { allow: [], deny: [], strictGit: false },
      onceAllows: [],
    });

  it("prefixes sandbox-exec, writes a self-denying profile OUTSIDE whitelisted paths", () => {
    const argv = arm();
    expect(argv.slice(0, 3)).toEqual(["sandbox-exec", "-f", argv[2]]);
    expect(argv.slice(3)).toEqual([
      "/usr/local/bin/node",
      "/glm/zcode.cjs",
      "app-server",
      "--stdio",
    ]);
    const file = argv[2]!;
    const dir = path.dirname(file);
    // Managed root under HOME, NOT $TMPDIR/caches: a prior sandboxed
    // generation keeps the old allows, so only a path no generation can
    // write is race-proof. The dir name carries the owning pid for sweeping.
    const root = path.join(os.homedir(), ".zcode-acp", "sandbox");
    expect(dir.startsWith(path.join(root, `p-${process.pid}-`))).toBe(true);
    expect(dir.startsWith(realpathSync(os.tmpdir()))).toBe(false);
    const profile = readFileSync(file, "utf8");
    expect(profile).toContain(`(deny file-write* (subpath "${dir}"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${realpathSync(root)}"))`);
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses a NEW unpredictable dir per respawn and removes the superseded one", () => {
    const first = arm()[2]!;
    const dir1 = path.dirname(first);
    expect(existsSync(dir1)).toBe(true);
    const second = arm()[2]!;
    const dir2 = path.dirname(second);
    expect(dir2).not.toBe(dir1);
    expect(existsSync(dir1)).toBe(false); // cleaned up once superseded
    rmSync(dir2, { recursive: true, force: true });
  });

  it("sweeps a DEAD bridge's pid-encoded dir on the next arm", () => {
    const root = sandboxProfilesRoot();
    const dead = spawnSync("sleep", ["0.01"]); // completes → its pid is gone
    const leftover = path.join(root, `p-${dead.pid}-leak`);
    mkdirSync(leftover, { recursive: true });
    writeFileSync(path.join(leftover, "profile.sb"), "(version 1)");

    const file = arm()[2]!;
    expect(existsSync(leftover)).toBe(false); // dead pid → swept
    rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("keeps another LIVE bridge's profile dir", () => {
    const root = sandboxProfilesRoot();
    const peer = spawn("sleep", ["10"]);
    try {
      const liveDir = path.join(root, `p-${peer.pid}-live`);
      mkdirSync(liveDir, { recursive: true });
      writeFileSync(path.join(liveDir, "profile.sb"), "(version 1)");

      const file = arm()[2]!;
      expect(existsSync(liveDir)).toBe(true); // live pid → untouched
      rmSync(liveDir, { recursive: true, force: true });
      rmSync(path.dirname(file), { recursive: true, force: true });
    } finally {
      peer.kill();
    }
  });
});
