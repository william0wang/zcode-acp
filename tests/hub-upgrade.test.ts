/**
 * Hub self-upgrade integration tests — version voting from registering
 * bridges, fingerprint votes (never restart-worthy by design), and the
 * /api/upgrade self-decided restart onto newer on-disk code.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startHub, type HubHandle } from "../src/remote/hub-server.js";
import { AGENT_INFO } from "../src/utils.js";

// These tests drive real HTTP hubs whose restart/exit paths wait on timers and
// socket teardown. Under full-suite parallel load that can outrun vitest's 5s
// default, and an inner withTimeout that equals the outer budget can never win
// against it — the failure then blames the inner step instead of the load.
vi.setConfig({ testTimeout: 15_000 });

/** Inner wait budget: same 15s as the file timeout, so it can fire first. */
const STEP_MS = 15_000;

const TOKEN = "test-hub-token";
const BASE_PORT = 18400; // bridge ports start here; ephemeral hub uses port 0

const cleanups: Array<() => Promise<void> | void> = [];

async function startTestHub(
  opts: Partial<Parameters<typeof startHub>[0]> = {},
): Promise<HubHandle> {
  const hub = await startHub({ port: 0, host: "127.0.0.1", token: TOKEN, ...opts });
  cleanups.push(() => hub.close());
  return hub;
}

afterEach(async () => {
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
});

function registerBody(overrides: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    id: "inst-1",
    port: BASE_PORT,
    pid: 123,
    workspace: "/tmp/proj",
    sessions: [{ sessionId: "s1", title: "hello", updatedAt: 1 }],
    ...overrides,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

describe("hub version self-upgrade", () => {
  it("restarts when a newer bridge registers", async () => {
    let exited = false;
    const hub = await startTestHub({
      staleVoteCooldownMs: 0,
      onIdleExit: () => {
        exited = true;
      },
    });
    const res = await withTimeout(
      fetch(`http://127.0.0.1:${hub.port}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registerBody({ version: "9999.0.0" })),
      }),
      STEP_MS,
      "register with newer version",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, restarting: true });

    // The hub exits ~500ms after replying so the response flushes first.
    await withTimeout(
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (exited) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      }),
      STEP_MS,
      "hub self-exit after newer-bridge register",
    );
    expect(exited).toBe(true);
  });

  it("does not restart for the same version or when no version is sent", async () => {
    let exited = false;
    const hub = await startTestHub({
      onIdleExit: () => {
        exited = true;
      },
    });
    const { AGENT_INFO } = await import("../src/utils.js");
    for (const version of [AGENT_INFO.version, undefined, "0.0.1"]) {
      const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registerBody(version === undefined ? {} : { version })),
      });
      expect(await res.json()).toEqual({ ok: true });
    }
    await new Promise((r) => setTimeout(r, 800));
    expect(exited).toBe(false);
    const health = await fetch(`http://127.0.0.1:${hub.port}/api/health`);
    expect(health.status).toBe(200);
  });
});

describe("hub fingerprint self-upgrade", () => {
  async function register(hub: HubHandle, body: Record<string, unknown>): Promise<Response> {
    return fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody(body)),
    });
  }

  it("NEVER restarts on a differing fingerprint (votes are version-only)", async () => {
    // Regression (live incident 2026-09-08): a coexisting dist's fingerprint
    // voted every respawned hub stale — a non-converging ~5s restart churn
    // that wiped all instances ("sessions flash then disappear"). A hash has
    // no ordering; it can never prove "newer". Fingerprint comparison lives
    // in /api/upgrade only (hub vs DISK, self-negating by construction).
    let restarted = false;
    const hub = await startTestHub({
      hubFingerprint: "7d05",
      staleVoteCooldownMs: 0,
      onRestart: () => {
        restarted = true;
      },
    });
    for (const fp of ["bbbb", "aaaa", "fcf69ae4e10f"]) {
      const res = await register(hub, { codeFingerprint: fp });
      expect(await res.json()).toEqual({ ok: true });
    }
    await new Promise((r) => setTimeout(r, 800));
    expect(restarted).toBe(false);
    expect((await fetch(`http://127.0.0.1:${hub.port}/api/health`)).status).toBe(200);
  });

  it("restarts for a strictly newer VERSION even when both sides have fingerprints", async () => {
    let restarted = false;
    const hub = await startTestHub({
      hubFingerprint: "aaaa",
      staleVoteCooldownMs: 0,
      onRestart: () => {
        restarted = true;
      },
    });
    const res = await register(hub, { version: "9999.0.0", codeFingerprint: "bbbb" });
    expect(await res.json()).toEqual({ ok: true, restarting: true });
    await withTimeout(
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (restarted) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      }),
      5000,
      "hub restart onto newer version",
    );
  });

  it("suppresses newer-bridge votes during the restart cooldown", async () => {
    // Loop breaker: a hub that just (re)started ignores stale votes for the
    // cooldown window — a same-age respawn can never be voted into a churn.
    let restarted = false;
    const hub = await startTestHub({
      staleVoteCooldownMs: 60_000,
      onRestart: () => {
        restarted = true;
      },
    });
    const res = await register(hub, { version: "9999.0.0" });
    expect(await res.json()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 800));
    expect(restarted).toBe(false);
    expect((await fetch(`http://127.0.0.1:${hub.port}/api/health`)).status).toBe(200);
  });
});

describe("hub /api/upgrade (self-decided restart)", () => {
  const upgradeUrl = (hub: HubHandle) => `http://127.0.0.1:${hub.port}/api/upgrade`;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  /**
   * Fixture on-disk code: package.json + dist/remote/hub-server.js. Written
   * BEFORE the hub starts, so its mtimes sit below the hub's startedAt —
   * exactly like a build that predates the running process.
   */
  async function writeCodeFixture(
    version: string,
  ): Promise<{ packageJson: string; distDir: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "hub-upgrade-"));
    const packageJson = path.join(root, "package.json");
    const distDir = path.join(root, "dist");
    await mkdir(path.join(distDir, "remote"), { recursive: true });
    await writeFile(packageJson, JSON.stringify({ version }));
    await writeFile(path.join(distDir, "remote", "hub-server.js"), "// code\n");
    return { packageJson, distDir };
  }

  /** Poll a flag until true or fail (the restart fires ~500ms after replying). */
  async function until(flag: () => boolean, label: string): Promise<void> {
    await withTimeout(
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (flag()) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      }),
      5000,
      label,
    );
  }

  it("rejects /api/upgrade without or with a wrong token", async () => {
    const hub = await startTestHub();
    expect((await fetch(upgradeUrl(hub), { method: "POST" })).status).toBe(401);
    expect(
      (await fetch(upgradeUrl(hub), { method: "POST", headers: { Authorization: "Bearer nope" } }))
        .status,
    ).toBe(401);
  });

  it("stays put when the on-disk code matches the running version", async () => {
    const paths = await writeCodeFixture(AGENT_INFO.version);
    let restarted = false;
    const hub = await startTestHub({
      codePaths: paths,
      onRestart: () => {
        restarted = true;
      },
    });
    const res = await fetch(upgradeUrl(hub), { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      restarting: false,
      reason: "up-to-date",
      runningVersion: AGENT_INFO.version,
      diskVersion: AGENT_INFO.version,
    });
    await new Promise((r) => setTimeout(r, 800));
    expect(restarted).toBe(false);
    expect((await fetch(`http://127.0.0.1:${hub.port}/api/health`)).status).toBe(200);
  });

  it("does not restart onto an OLDER on-disk version", async () => {
    const paths = await writeCodeFixture("0.0.1");
    let restarted = false;
    const hub = await startTestHub({
      codePaths: paths,
      onRestart: () => {
        restarted = true;
      },
    });
    const res = await fetch(upgradeUrl(hub), { method: "POST", headers: auth });
    expect(await res.json()).toMatchObject({ restarting: false, reason: "up-to-date" });
    await new Promise((r) => setTimeout(r, 800));
    expect(restarted).toBe(false);
  });

  it("restarts onto a newer on-disk version", async () => {
    const paths = await writeCodeFixture("9999.0.0");
    let restarted = false;
    const hub = await startTestHub({
      codePaths: paths,
      onRestart: () => {
        restarted = true;
      },
    });
    const res = await fetch(upgradeUrl(hub), { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      restarting: true,
      reason: "version",
      runningVersion: AGENT_INFO.version,
      diskVersion: "9999.0.0",
    });
    await until(() => restarted, "hub restart onto newer version");
  });

  it("restarts onto a different on-disk fingerprint (same version, no mtime change)", async () => {
    const paths = await writeCodeFixture(AGENT_INFO.version);
    await writeFile(
      path.join(paths.distDir, "code-fingerprint.json"),
      JSON.stringify({ fingerprint: "cccc", fileCount: 1 }),
    );
    let restarted = false;
    const hub = await startTestHub({
      hubFingerprint: "aaaa",
      codePaths: paths,
      onRestart: () => {
        restarted = true;
      },
    });
    const res = await fetch(upgradeUrl(hub), { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restarting: true, reason: "fingerprint" });
    await until(() => restarted, "hub restart onto different fingerprint");
  });

  it("stays put when the on-disk fingerprint matches (mtime skew irrelevant)", async () => {
    const paths = await writeCodeFixture(AGENT_INFO.version);
    await writeFile(
      path.join(paths.distDir, "code-fingerprint.json"),
      JSON.stringify({ fingerprint: "aaaa", fileCount: 1 }),
    );
    let restarted = false;
    const hub = await startTestHub({
      hubFingerprint: "aaaa",
      codePaths: paths,
      onRestart: () => {
        restarted = true;
      },
    });
    const res = await fetch(upgradeUrl(hub), { method: "POST", headers: auth });
    expect(await res.json()).toMatchObject({ restarting: false, reason: "up-to-date" });
    await new Promise((r) => setTimeout(r, 800));
    expect(restarted).toBe(false);
  });

  it("restarts when dist was rebuilt without a version bump", async () => {
    const paths = await writeCodeFixture(AGENT_INFO.version);
    let restarted = false;
    const hub = await startTestHub({
      codePaths: paths,
      onRestart: () => {
        restarted = true;
      },
    });
    // Let startedAt settle strictly below the rewrite's mtime, then "rebuild".
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(path.join(paths.distDir, "remote", "hub-server.js"), "// rebuilt\n");
    const res = await fetch(upgradeUrl(hub), { method: "POST", headers: auth });
    expect(await res.json()).toMatchObject({ restarting: true, reason: "mtime" });
    await until(() => restarted, "hub restart onto rebuilt dist");
  });

  it("checks the real repo layout safely when nothing is injected", async () => {
    let restarted = false;
    const hub = await startTestHub({
      onRestart: () => {
        restarted = true;
      },
    });
    // Under vitest the defaults resolve to the repo root: package.json reads
    // the same version frozen into AGENT_INFO, and src/ holds no .js files —
    // so the answer must be a calm no-op, never a crash.
    const res = await fetch(upgradeUrl(hub), { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restarting: false, reason: "up-to-date" });
    await new Promise((r) => setTimeout(r, 800));
    expect(restarted).toBe(false);
  });
});
