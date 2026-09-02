/**
 * Unit tests for the Seatbelt sandbox layer (ADR-0011): profile generation
 * (workspace allow + deny island + strictGit + /dev/null + profile self-deny),
 * project config (auto-created template, enabled switch, integrity checks,
 * allowlist append), dual-switch arming (env OR project opt-in), mid-run flip
 * via applySandboxFlip, and hardened argv arming. Real sandbox behaviour
 * (deny-rule precedence) is exercised by scripts/verify-sandbox.sh — CI
 * runners are linux where sandbox-exec does not exist, so every "arms"
 * assertion runs under a stubbed darwin platform.
 */

import {
  chmodSync,
  existsSync,
  linkSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeBackend } from "../src/backend/index.js";
import {
  SANDBOX_ENV,
  appendSandboxAllow,
  appendSandboxDeny,
  armSandboxArgv,
  buildSandboxProfile,
  collectSandboxWorkspaces,
  readSandboxConfig,
  resetSandboxDecisionForTest,
  sandboxActive,
  sandboxConfigPath,
} from "../src/backend/sandbox.js";

// os.tmpdir() is symlinked on macOS (/var → /private/var) and Seatbelt
// matches real paths — every fixture must be realpath'd like production.
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-test-")));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
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

/** Write a project config with the given fields (mkdir included). */
function writeConfig(root: string, cfg: Record<string, unknown>): void {
  mkdirSync(path.join(root, ".zcode", "acp"), { recursive: true });
  writeFileSync(sandboxConfigPath(root), JSON.stringify(cfg));
}

describe("sandboxActive", () => {
  it("stays off with no env and no opted-in root; the read materializes the template", () => {
    const armed = withPlatform("darwin", () => {
      resetSandboxDecisionForTest();
      return sandboxActive([tmpRoot]);
    });
    expect(armed).toBe(false);
    expect(readSandboxConfig(tmpRoot)).toEqual({
      enabled: false,
      allow: [],
      deny: [],
      strictGit: false,
    });
  });

  it("env arms globally regardless of configs", () => {
    const armed = withPlatform("darwin", () => {
      process.env[SANDBOX_ENV] = "1";
      resetSandboxDecisionForTest();
      return sandboxActive([tmpRoot]);
    });
    expect(armed).toBe(true);
  });

  it("flipping enabled:true arms the project (any-of roots)", () => {
    const other = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-other-")));
    try {
      appendSandboxAllow(tmpRoot, "/opt/data"); // materializes the template
      expect(withPlatform("darwin", () => sandboxActive([tmpRoot, other]))).toBe(false);
      writeConfig(tmpRoot, { enabled: true });
      expect(withPlatform("darwin", () => sandboxActive([tmpRoot, other]))).toBe(true);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("fails CLOSED on a malformed config — a corrupted opt-in must not disarm", () => {
    writeConfig(tmpRoot, {}); // then corrupt it
    writeFileSync(sandboxConfigPath(tmpRoot), "{not json");
    expect(withPlatform("darwin", () => sandboxActive([tmpRoot]))).toBe(true);
  });

  it("stays unsandboxed (with a warn) on non-macOS even when armed", () => {
    const armed = withPlatform("linux", () => {
      process.env[SANDBOX_ENV] = "1";
      resetSandboxDecisionForTest();
      return sandboxActive([tmpRoot]);
    });
    expect(armed).toBe(false);
  });
});

describe("readSandboxConfig / appendSandboxAllow", () => {
  it("auto-creates the discovery template (enabled:false) on first read", () => {
    const cfg = readSandboxConfig(tmpRoot);
    expect(cfg).toEqual({ enabled: false, allow: [], deny: [], strictGit: false });
    const onDisk = JSON.parse(readFileSync(sandboxConfigPath(tmpRoot), "utf8"));
    expect(onDisk).toEqual({ enabled: false, allow: [], deny: [], strictGit: false });
  });

  it("fails CLOSED on a malformed file and never rewrites the user's bytes", () => {
    writeConfig(tmpRoot, { enabled: true });
    writeFileSync(sandboxConfigPath(tmpRoot), "{not json");
    const cfg = readSandboxConfig(tmpRoot);
    expect(cfg).toEqual({ enabled: true, allow: [], deny: [], strictGit: false });
    // A half-saved editor buffer must survive — no template clobbering.
    expect(readFileSync(sandboxConfigPath(tmpRoot), "utf8")).toBe("{not json");
  });

  it("fails CLOSED on non-object JSON (numbers, booleans, null, arrays)", () => {
    for (const garbage of ["123", "true", "null", "[]"]) {
      writeConfig(tmpRoot, {});
      writeFileSync(sandboxConfigPath(tmpRoot), garbage);
      expect(readSandboxConfig(tmpRoot).enabled).toBe(true);
    }
  });

  it("drops relative allow entries — they would anchor to the bridge cwd", () => {
    writeConfig(tmpRoot, { enabled: true, allow: ["/abs/path", "~/cache", "../escape", "foo"] });
    expect(readSandboxConfig(tmpRoot).allow).toEqual(["/abs/path", "~/cache"]);
  });

  it("reads a symlinked config as armed (island piercing fails closed)", () => {
    // The attack: sandbox.json -> ../../cfg.json; the agent writes cfg.json
    // (inside the allowed workspace, outside the island) to edit its own
    // allowlist. The bridge must not follow the link.
    const target = path.join(tmpRoot, "cfg.json");
    writeFileSync(target, JSON.stringify({ enabled: true, allow: ["~/.ssh"] }));
    mkdirSync(path.join(tmpRoot, ".zcode", "acp"), { recursive: true });
    symlinkSync(target, sandboxConfigPath(tmpRoot));
    expect(readSandboxConfig(tmpRoot)).toEqual({
      enabled: true,
      allow: [],
      deny: [],
      strictGit: false,
    });
    expect(appendSandboxAllow(tmpRoot, "/opt/data")).toBe(false);
    expect(JSON.parse(readFileSync(target, "utf8")).allow).toEqual(["~/.ssh"]);
  });

  it("reads a hardlinked config as armed and refuses to persist through it", () => {
    const real = path.join(tmpRoot, "cfg.json");
    writeConfig(tmpRoot, { enabled: true, allow: [] });
    linkSync(sandboxConfigPath(tmpRoot), real); // nlink now 2 → island pierced
    expect(readSandboxConfig(tmpRoot).enabled).toBe(true);
    expect(appendSandboxAllow(tmpRoot, "/opt/data")).toBe(false);
  });

  it("reads a config that VANISHED after being armed as still armed (fail closed)", () => {
    writeConfig(tmpRoot, { enabled: true, allow: [] });
    expect(readSandboxConfig(tmpRoot).enabled).toBe(true);
    rmSync(sandboxConfigPath(tmpRoot));
    expect(readSandboxConfig(tmpRoot).enabled).toBe(true); // agent rename/rm must not disarm
  });

  it("re-templates a config that vanished while never armed", () => {
    appendSandboxAllow(tmpRoot, "/x"); // materializes the enabled:false template
    rmSync(sandboxConfigPath(tmpRoot));
    expect(readSandboxConfig(tmpRoot)).toEqual({
      enabled: false,
      allow: [],
      deny: [],
      strictGit: false,
    });
  });

  it("reads an EACCES config dir as armed (chmod-0000 must not disarm)", () => {
    writeConfig(tmpRoot, { enabled: true, allow: [] });
    expect(readSandboxConfig(tmpRoot).enabled).toBe(true);
    chmodSync(path.join(tmpRoot, ".zcode"), 0o000);
    try {
      expect(readSandboxConfig(tmpRoot).enabled).toBe(true);
    } finally {
      chmodSync(path.join(tmpRoot, ".zcode"), 0o755);
    }
  });

  it("reads a config behind a `.zcode` FILE (ENOTDIR) as armed once seen", () => {
    writeConfig(tmpRoot, { enabled: true, allow: [] });
    expect(readSandboxConfig(tmpRoot).enabled).toBe(true);
    rmSync(path.join(tmpRoot, ".zcode"), { recursive: true, force: true });
    writeFileSync(path.join(tmpRoot, ".zcode"), "agent-planted file");
    expect(readSandboxConfig(tmpRoot).enabled).toBe(true);
  });

  it("persists always-allow entries without duplicates, preserving enabled", () => {
    writeConfig(tmpRoot, { enabled: true, allow: [], deny: [], strictGit: false });
    expect(appendSandboxAllow(tmpRoot, "/opt/data")).toBe(true);
    expect(appendSandboxAllow(tmpRoot, "/opt/data")).toBe(true);
    expect(appendSandboxAllow(tmpRoot, "/opt/other")).toBe(true);
    const onDisk = JSON.parse(readFileSync(sandboxConfigPath(tmpRoot), "utf8"));
    expect(onDisk).toEqual({
      enabled: true,
      allow: ["/opt/data", "/opt/other"],
      deny: [],
      strictGit: false,
    });
  });

  it("parses the deny list and drops relative entries from it too", () => {
    writeConfig(tmpRoot, {
      enabled: true,
      allow: [],
      deny: ["/opt/blocked", "relative/nope"],
      strictGit: false,
    });
    expect(readSandboxConfig(tmpRoot)).toEqual({
      enabled: true,
      allow: [],
      deny: ["/opt/blocked"],
      strictGit: false,
    });
  });

  it("appendSandboxDeny persists visibly and preserves every other field", () => {
    writeConfig(tmpRoot, { enabled: true, allow: ["/opt/ok"], strictGit: true });
    expect(appendSandboxDeny(tmpRoot, "/opt/blocked")).toBe(true);
    expect(appendSandboxDeny(tmpRoot, "/opt/blocked")).toBe(true); // dedupe
    const onDisk = JSON.parse(readFileSync(sandboxConfigPath(tmpRoot), "utf8"));
    expect(onDisk).toEqual({
      enabled: true,
      allow: ["/opt/ok"],
      deny: ["/opt/blocked"],
      strictGit: true,
    });
  });
});

describe("buildSandboxProfile", () => {
  it("denies writes by default, allows the workspace, carves the .zcode/acp deny island", () => {
    const profile = buildSandboxProfile({
      workspaces: [
        { root: tmpRoot, config: { enabled: true, allow: [], deny: [], strictGit: false } },
      ],
      extraAllow: [],
    });
    const lines = profile.split("\n");
    expect(lines[0]).toBe("(version 1)");
    expect(lines).toContain("(deny file-write*)");
    expect(lines).toContain(`(allow file-write* (subpath "${tmpRoot}"))`);
    expect(lines).toContain(
      `(deny file-write* (subpath "${path.join(tmpRoot, ".zcode", "acp")}"))`,
    );
    // Default cache dirs + zcode state are present (resolved under $HOME).
    expect(profile).toContain('/.zcode"');
    expect(profile).toContain('/.npm"');
    // /dev/null must be writable — git and `2>/dev/null` idioms break without
    // it ("could not open '/dev/null'", observed in review probes).
    expect(profile).toContain('(allow file-write-data (literal "/dev/null"))');
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
      workspaces: [
        { root: tmpRoot, config: { enabled: true, allow: [], deny: [], strictGit: false } },
      ],
      extraAllow: [],
      profileDir: "/fake/sbx-dir",
    });
    const lines2 = profile2.split("\n");
    expect(lines2[lines2.length - 2]).toBe('(deny file-write* (subpath "/fake/sbx-dir"))');
  });

  it("adds a .git deny only under strictGit", () => {
    const strict = buildSandboxProfile({
      workspaces: [{ root: tmpRoot, config: { enabled: true, allow: [], strictGit: true } }],
      extraAllow: [],
    });
    expect(strict).toContain(`(deny file-write* (subpath "${path.join(tmpRoot, ".git")}"))`);
    const lax = buildSandboxProfile({
      workspaces: [
        { root: tmpRoot, config: { enabled: true, allow: [], deny: [], strictGit: false } },
      ],
      extraAllow: [],
    });
    expect(lax).not.toContain('".git"');
  });

  it("includes config allow entries and extraAllow roots", () => {
    // realpath BEFORE removing: resolveReal must land on the resolved prefix.
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-out-")));
    rmSync(outside, { recursive: true, force: true }); // not created: resolveReal must survive
    const profile = buildSandboxProfile({
      workspaces: [
        { root: tmpRoot, config: { enabled: true, allow: [outside], deny: [], strictGit: false } },
      ],
      extraAllow: [path.join(tmpRoot, "elsewhere")],
    });
    expect(profile).toContain(`(allow file-write* (subpath "${outside}"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${path.join(tmpRoot, "elsewhere")}"))`);
  });
});

describe("collectSandboxWorkspaces", () => {
  it("dedupes symlinked duplicates and unions allowlists across workspaces", () => {
    const realA = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-a-")));
    const linkA = path.join(tmpRoot, "link-a");
    symlinkSync(realA, linkA);
    appendSandboxAllow(realA, path.join(tmpRoot, "granted"));
    const { workspaces, extraAllow } = collectSandboxWorkspaces([realA, linkA]);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.root).toBe(realA);
    // realA's own allow entry rides its workspace block, not extraAllow.
    expect(extraAllow).toEqual([]);
  });

  it("emits each workspace's allow under its own block (cross-root union)", () => {
    const a = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-wa-")));
    const b = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-wb-")));
    appendSandboxAllow(a, b);
    // ensureBackend passes ALL live session cwds: a's allowlist for b rides
    // a's own workspace block — b need not carry it in its own config.
    const { workspaces, extraAllow } = collectSandboxWorkspaces([a, b]);
    expect(workspaces.map((ws) => ws.root)).toEqual([a, b]);
    expect(extraAllow).toEqual([]);
    const profile = buildSandboxProfile({ workspaces, extraAllow });
    expect(profile).toContain(`(allow file-write* (subpath "${b}"))`);
  });
});

describe("applySandboxFlip", () => {
  it("kills an unsandboxed live backend once a workspace opted in mid-run", async () => {
    const server = new ZcodeAcpServer();
    const closed = vi.fn().mockResolvedValue(undefined);
    server.backend = { isDead: false, close: closed } as unknown as ZcodeBackend;
    server.sessionCwds.set("acp_a", tmpRoot);
    appendSandboxAllow(tmpRoot, "/opt/data"); // template only (enabled:false)
    await withPlatformAsync("darwin", () => server.applySandboxFlip());
    expect(closed).not.toHaveBeenCalled();
    writeConfig(tmpRoot, { enabled: true });
    await withPlatformAsync("darwin", () => server.applySandboxFlip());
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a sandboxed or dead backend", async () => {
    const server = new ZcodeAcpServer();
    const closed = vi.fn().mockResolvedValue(undefined);
    server.sessionCwds.set("acp_a", tmpRoot);
    writeConfig(tmpRoot, { enabled: true });
    server.backendSandboxed = true;
    server.backend = { isDead: false, close: closed } as unknown as ZcodeBackend;
    await withPlatformAsync("darwin", () => server.applySandboxFlip());
    expect(closed).not.toHaveBeenCalled();
    server.backendSandboxed = false;
    server.backend = { isDead: true, close: closed } as unknown as ZcodeBackend;
    await withPlatformAsync("darwin", () => server.applySandboxFlip());
    expect(closed).not.toHaveBeenCalled();
  });
});

describe("armSandboxArgv", () => {
  const arm = () =>
    armSandboxArgv(["/usr/local/bin/node", "/glm/zcode.cjs", "app-server", "--stdio"], {
      workspaces: [
        { root: tmpRoot, config: { enabled: true, allow: [], deny: [], strictGit: false } },
      ],
      extraAllow: [],
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
    // Home base, NOT $TMPDIR/caches: a prior sandboxed generation keeps the
    // old allows, so only a path no generation can write is race-proof.
    expect(dir.startsWith(path.join(os.homedir(), ".zcode-acp-sbx-"))).toBe(true);
    expect(dir.startsWith(realpathSync(os.tmpdir()))).toBe(false);
    const profile = readFileSync(file, "utf8");
    expect(profile).toContain(`(deny file-write* (subpath "${dir}"))`);
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
});
