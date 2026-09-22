/**
 * Settings API end-to-end tests — a real hub on an ephemeral port plus a real
 * loopback HTTP server standing in for the bridge.
 *
 * What is under test here is the TRANSPORT contract, not the config writers
 * (those have their own unit tests): the token gate on the hub mount, the
 * unauthenticated loopback mount, the `/api` prefix stripping that lets one
 * factory serve both, the per-instance proxy, and the effect classes a client
 * depends on to decide whether to prompt for a restart.
 *
 * All filesystem state is redirected into a temp ZCODE_HOME/HOME so the
 * developer's real configuration is never read or written.
 */

import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSettingsHandler,
  resetAppUpdateStateForTest,
  resetPendingRestartForTest,
} from "../src/remote/settings-endpoint.js";
import {
  setAppUpdatePlatformForTest,
  setManifestNetworkForTest,
} from "../src/settings/app-update.js";
import { listAgents, setBuiltInAgentModel } from "../src/settings/agents-config.js";
import { listSkills } from "../src/settings/skills.js";
import { startHub, type HubHandle } from "../src/remote/hub-server.js";
import { zcodeCliConfigPath, zcodeHomeDir, zcodePersonalProviderPath } from "../src/utils.js";

const TOKEN = "test-settings-token";

const cleanups: Array<() => Promise<void> | void> = [];

let home: string;
let hub: HubHandle;
/** The loopback server that plays the bridge's role. */
let loopback: Server;
let loopbackPort: number;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "settings-api-test-"));
  resetPendingRestartForTest();
  // These routes are macOS-shaped (a bundle, a plist, a rename swap). Pinning the
  // platform keeps the assertions meaningful on a Linux runner instead of
  // letting them silently fall through to the non-macOS branch.
  setAppUpdatePlatformForTest("darwin");
  vi.stubEnv("ZCODE_HOME", home);
  vi.stubEnv("HOME", home);
  hub = await startHub({ port: 0, host: "127.0.0.1", token: TOKEN });
  cleanups.push(() => hub.close());
  loopback = createServer((req, res) => settingsHandler(req, res));
  await new Promise<void>((resolve) => loopback.listen(0, "127.0.0.1", resolve));
  const address = loopback.address();
  loopbackPort = typeof address === "object" && address ? address.port : 0;
  cleanups.push(() => new Promise<void>((resolve) => loopback.close(() => resolve())));
  // The hub prunes instances it has never heard of, so register one.
  const registered = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: TOKEN,
      id: "inst-1",
      port: loopbackPort,
      pid: process.pid,
      workspace: "/tmp/proj",
      sessions: [],
    }),
  });
  expect(registered.ok).toBe(true);
});

afterEach(async () => {
  setAppUpdatePlatformForTest(process.platform);
  vi.unstubAllEnvs();
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
  await rm(home, { recursive: true, force: true });
});

const settingsHandler = createSettingsHandler();

/** Write a file, creating its parent directory. */
async function put(file: string, body: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

/** Write an agent markdown file under the (temp) ZCode home. */
async function writeAgent(name: string, description: string): Promise<void> {
  await put(
    path.join(zcodeHomeDir(), "agents", `${name}.md`),
    `---\nname: "${name}"\ndescription: "${description}"\n---\nYou are ${name}.\n`,
  );
}

/** GET on the hub's machine-level settings route. */
function hubGet(sub: string, token = TOKEN): Promise<Response> {
  return fetch(`http://127.0.0.1:${hub.port}/api/settings/${sub}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** GET on the bridge's loopback settings route (no token). */
function loopbackGet(sub: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${loopbackPort}/settings/${sub}`);
}

function loopbackSend(method: string, sub: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${loopbackPort}/settings/${sub}`, {
    method,
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

describe("settings API — auth and mounts", () => {
  it("rejects the hub mount without a token", async () => {
    const res = await hubGet("all", "");
    expect(res.status).toBe(401);
  });

  it("rejects the hub mount with a wrong token", async () => {
    const res = await hubGet("all", "wrong-token");
    expect(res.status).toBe(401);
  });

  it("accepts the token as a query parameter too (browser-friendly)", async () => {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/settings/all?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("serves the loopback mount with no token", async () => {
    const res = await loopbackGet("all");
    expect(res.status).toBe(200);
  });

  it("answers 404 for an unknown settings route on both mounts", async () => {
    expect((await hubGet("nope")).status).toBe(404);
    expect((await loopbackGet("nope")).status).toBe(404);
  });

  it("proxies the per-instance form to the bridge's loopback mount", async () => {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances/inst-1/settings/all`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("404s the per-instance form for an unknown instance", async () => {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances/ghost/settings/all`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("settings API — reads", () => {
  it("returns every section in one snapshot", async () => {
    const res = await hubGet("all");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    for (const key of ["models", "skills", "mcp", "hooks", "agents", "usage", "resetCards"]) {
      expect(body[key]).toBeDefined();
    }
  });

  it("degrades the usage and reset-card sections instead of failing the snapshot", async () => {
    // No database and no credential store are normal states; the first screen
    // must still render. `usage` reports unavailability and `resetCards` reports
    // eligibility with credentials: false.
    const res = await hubGet("all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      usage: { available: boolean };
      resetCards: { providers: string[]; credentials: boolean; reason?: string };
    };
    expect(body.usage.available).toBe(false);
    expect(body.resetCards.providers).toContain("account:bigmodel-individual-coding-plan");
    expect(body.resetCards.credentials).toBe(false);
    expect(body.resetCards.reason).toBeTruthy();
  });

  it("reports hooks as disabled until the gate is set", async () => {
    const res = await hubGet("hooks");
    const body = (await res.json()) as { ok: boolean; enabled: boolean };
    expect(body.ok).toBe(true);
    // The tree can be populated while the runtime gate is off — the client
    // must not read a non-empty tree as "hooks are running".
    expect(body.enabled).toBe(false);
  });

  it("lists the built-in agents as read-only", async () => {
    const res = await hubGet("agents");
    const body = (await res.json()) as {
      agents: Array<{ name: string; readOnly: boolean }>;
      builtIn: string[];
    };
    expect(body.builtIn).toContain("general-purpose");
    for (const name of ["general-purpose", "Explore"]) {
      expect(body.agents.find((a) => a.name === name)!.readOnly).toBe(true);
    }
  });
});

describe("settings API — writes report their effect class", () => {
  it("marks a model add as immediate", async () => {
    const res = await loopbackSend("POST", "models", {
      providerId: "p1",
      modelId: "m1",
      contextWindow: 128000,
    });
    const body = (await res.json()) as { ok: boolean; effect: string };
    expect(body.ok).toBe(true);
    expect(body.effect).toBe("immediate");
  });

  it("marks an MCP change as needs-restart", async () => {
    const res = await loopbackSend("PUT", "mcp/ctx7", {
      type: "stdio",
      command: "npx",
      args: ["-y", "ctx7"],
    });
    const body = (await res.json()) as { ok: boolean; effect: string };
    expect(body.ok).toBe(true);
    expect(body.effect).toBe("needs-restart");
    const written = JSON.parse(await readFile(zcodeCliConfigPath(), "utf8")) as {
      mcp: { servers: Record<string, { command: string }> };
    };
    expect(written.mcp.servers.ctx7!.command).toBe("npx");
  });

  it("marks a hook edit as needs-restart", async () => {
    await loopbackSend("POST", "hooks/enabled", { enabled: true });
    await put(zcodeCliConfigPath(), {
      hooks: {
        enabled: true,
        events: { Stop: [{ hooks: [{ type: "command", command: "a" }] }] },
      },
    });
    const res = await loopbackSend("PUT", "hooks/Stop/0", {
      command: "b",
      hookIndex: 0,
    });
    const body = (await res.json()) as { ok: boolean; effect: string };
    expect(body.ok).toBe(true);
    expect(body.effect).toBe("needs-restart");
  });

  it("marks an agent create as needs-restart", async () => {
    const res = await loopbackSend("PUT", "agents/worker", {
      description: "does work",
    });
    const body = (await res.json()) as { ok: boolean; effect: string };
    expect(body.ok).toBe(true);
    expect(body.effect).toBe("needs-restart");
  });

  it("rejects a malformed body with a 400 rather than a 500", async () => {
    const res = await fetch(`http://127.0.0.1:${loopbackPort}/settings/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("passes the module's actionable message through", async () => {
    const res = await loopbackSend("PUT", "providers/ghost", { enabled: false });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/no rule/);
  });
});

describe("settings API — agents and skills routes", () => {
  it("accepts POST (the documented method) on the agent enable route", async () => {
    await writeAgent("worker", "A worker");
    const res = await loopbackSend("POST", "agents/worker/enable", { enable: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; effect: string };
    expect(body.ok).toBe(true);
    expect(body.effect).toBe("needs-restart");
  });

  it("clears a built-in agent override when both ids are null", async () => {
    await setBuiltInAgentModel("general-purpose", {
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.3",
    });
    const res = await loopbackSend("PUT", "agents/general-purpose", {
      providerId: null,
      modelId: null,
    });
    expect(res.status).toBe(200);
    const agents = await listAgents();
    const builtIn = agents.find((a) => a.name === "general-purpose")!;
    expect(builtIn.modelSelection).toBeUndefined();
  });

  it("refuses a partial built-in override (only one of the two ids)", async () => {
    const res = await loopbackSend("PUT", "agents/general-purpose", {
      providerId: "account:bigmodel-individual-coding-plan",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/send nulls to clear/);
  });

  it("deletes a skill from the agents scope, not only the user scope", async () => {
    // The agents root (~/.agents/skills, resolved from os.homedir()) is listed
    // and copyable, so refusing to delete it made half the listed skills
    // undeletable. Written under the temp HOME so the real tree is untouched.
    const agentsRoot = path.join(os.homedir(), ".agents", "skills", "beta");
    await mkdir(agentsRoot, { recursive: true });
    cleanups.push(() => rm(agentsRoot, { recursive: true, force: true }));
    await writeFile(
      path.join(agentsRoot, "SKILL.md"),
      "---\nname: beta\ndescription: does beta\n---\n",
    );
    const listed = await listSkills();
    expect(listed.some((s) => s.path.includes(".agents/skills/beta/SKILL.md"))).toBe(true);
    const res = await loopbackSend(
      "DELETE",
      `skills/${encodeURIComponent(path.join(agentsRoot, "SKILL.md"))}`,
    );
    expect(res.status).toBe(200);
    const after = await listSkills();
    expect(after.some((s) => s.path.includes(".agents/skills/beta/SKILL.md"))).toBe(false);
  });
});

describe("settings API — writes land in the real files", () => {
  it("persists a provider enable/disable", async () => {
    await put(zcodePersonalProviderPath(), {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [{ providerId: "p1", enabled: true }] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    });
    const res = await loopbackSend("PUT", "providers/p1", { enabled: false });
    expect(res.status).toBe(200);
    const written = JSON.parse(await readFile(zcodePersonalProviderPath(), "utf8")) as {
      config: { providerConfigRules: { providerRules: Array<{ enabled: boolean }> } };
    };
    expect(written.config.providerConfigRules.providerRules[0]!.enabled).toBe(false);
  });

  it("persists a skill disable and keeps the skill listed", async () => {
    const dir = path.join(zcodeHomeDir(), "skills", "alpha");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "---\nname: alpha\ndescription: does alpha\n---\n");
    const skillPath = path.join(dir, "SKILL.md");
    const disable = await loopbackSend("POST", "skills/enable", {
      path: skillPath,
      enable: false,
    });
    expect(disable.status).toBe(200);
    const list = (await (await loopbackGet("skills")).json()) as {
      skills: Array<{ name: string; enabled: boolean }>;
    };
    expect(list.skills.find((s) => s.name === "alpha")!.enabled).toBe(false);
  });
});

describe("settings API — backups", () => {
  it("lists a backup taken by an earlier write and restores it", async () => {
    await put(zcodePersonalProviderPath(), {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [{ providerId: "p1", enabled: true }] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    });
    await loopbackSend("PUT", "providers/p1", { enabled: false });
    const backups = (await (await loopbackGet("backups")).json()) as {
      backups: { providerConfig: Array<{ path: string }> };
    };
    expect(backups.backups.providerConfig).toHaveLength(1);
    const restore = await loopbackSend("POST", "backups/restore", {
      file: "providerConfig",
      path: backups.backups.providerConfig[0]!.path,
    });
    expect(restore.status).toBe(200);
    const restored = JSON.parse(await readFile(zcodePersonalProviderPath(), "utf8")) as {
      config: { providerConfigRules: { providerRules: Array<{ enabled: boolean }> } };
    };
    expect(restored.config.providerConfigRules.providerRules[0]!.enabled).toBe(true);
  });

  it("refuses to restore from a path that is not one of this file's backups", async () => {
    const res = await loopbackSend("POST", "backups/restore", {
      file: "providerConfig",
      path: "/etc/passwd",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not a backup/);
  });
});

describe("settings API — usage and reset cards", () => {
  it("reports an unavailable usage snapshot when no database exists", async () => {
    const res = await loopbackGet("usage?range=7d");
    const body = (await res.json()) as { ok: boolean; usage: { available: boolean } };
    expect(body.ok).toBe(true);
    // No agent database is a normal state, not an error.
    expect(body.usage.available).toBe(false);
  });

  it("rejects an unknown range", async () => {
    const res = await loopbackGet("usage?range=1y");
    expect(res.status).toBe(400);
  });

  it("refuses reset cards for a non-coding-plan provider", async () => {
    const res = await loopbackGet("reset-cards?providerId=builtin:bigmodel-coding-plan");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/account coding-plan provider/);
  });

  it("reports credentials_unavailable when the credential store is missing", async () => {
    const res = await loopbackGet("reset-cards?providerId=account:bigmodel-individual-coding-plan");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("credentials_unavailable");
  });

  it("refuses a spend without a nonce", async () => {
    const res = await loopbackSend("POST", "reset-cards/use", {
      providerId: "account:bigmodel-individual-coding-plan",
      resetType: "FIVE_HOUR",
      idempotencyKey: "k",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/nonce/);
  });

  it("refuses an unknown reset type", async () => {
    const res = await loopbackSend("POST", "reset-cards/use", {
      providerId: "account:bigmodel-individual-coding-plan",
      resetType: "MONTH",
      nonce: "n",
      idempotencyKey: "k",
    });
    expect(res.status).toBe(400);
  });
});

describe("settings API — pending restart and backend restart", () => {
  it("starts with nothing pending and arms on a needs-restart write", async () => {
    const before = (await (await loopbackGet("pending-restart")).json()) as {
      pendingRestart: boolean;
    };
    expect(before.pendingRestart).toBe(false);
    await loopbackSend("PUT", "mcp/ctx7", { command: "npx" });
    const after = (await (await loopbackGet("pending-restart")).json()) as {
      pendingRestart: boolean;
      writes: number;
    };
    expect(after.pendingRestart).toBe(true);
    expect(after.writes).toBeGreaterThan(0);
  });

  it("does not arm on an immediate-effect write", async () => {
    await loopbackSend("POST", "skills/enable", {
      path: path.join(zcodeHomeDir(), "skills", "x", "SKILL.md"),
      enable: false,
    });
    const res = (await (await loopbackGet("pending-restart")).json()) as {
      pendingRestart: boolean;
    };
    expect(res.pendingRestart).toBe(false);
  });

  it("refuses a backend restart on the machine-level (hub) mount", async () => {
    // The hub serves settings with no bridge, so there is no backend to restart
    // — it must say so rather than pretending.
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/settings/backend/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(501);
  });
});

describe("settings API — app update", () => {
  /** A temp bundle with a known version, pointed at by ZCODE_APP_PATH. */
  async function fakeApp(version: string): Promise<string> {
    const app = await mkdtemp(path.join(tmpdir(), "settings-app-update-"));
    await mkdir(path.join(app, "Contents"), { recursive: true });
    await writeFile(
      path.join(app, "Contents", "Info.plist"),
      `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
      "utf8",
    );
    cleanups.push(() => rm(app, { recursive: true, force: true }));
    return app;
  }

  /**
   * Stub the manifest network so the route is exercised without touching the
   * real CDN. The manifest parsing and version comparison have their own unit
   * tests; here only the route's shape and status codes matter.
   */
  function stubManifest(version: string, url?: string): void {
    const artifact =
      url ??
      "https://cdn-zcode.z.ai/zcode/electron/releases/9.9.9/macos-arm64/ZCode-9.9.9-mac-arm64.zip";
    const body = [
      "version: " + version,
      "files:",
      `    - url: ${artifact}`,
      "      sha512: abc",
    ].join("\n");
    setManifestNetworkForTest(
      (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
    );
  }

  afterEach(() => {
    setManifestNetworkForTest(fetch);
    resetAppUpdateStateForTest();
  });

  it("reports an available update with the release notes and artifacts", async () => {
    const app = await fakeApp("3.14.1");
    vi.stubEnv("ZCODE_APP_PATH", app);
    stubManifest("3.14.3");
    const res = await loopbackGet("app-update?channel=stable");
    const body = (await res.json()) as {
      ok: boolean;
      appUpdate: {
        updateAvailable: boolean;
        currentVersion: string | null;
        latestVersion: string | null;
        platform: string;
        appPath: string | null;
        releaseName: string | null;
        releaseNotes: string | null;
        files: Array<{ url: string }>;
        install: { stage: string };
      };
    };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.appUpdate.updateAvailable).toBe(true);
    expect(body.appUpdate.currentVersion).toBe("3.14.1");
    expect(body.appUpdate.latestVersion).toBe("3.14.3");
    expect(body.appUpdate.files).toHaveLength(1);
    expect(body.appUpdate.appPath).toBe(path.resolve(app));
    expect(body.appUpdate.install.stage).toBe("idle");
  });

  it("reports no update with an empty artifact list", async () => {
    const app = await fakeApp("3.14.3");
    vi.stubEnv("ZCODE_APP_PATH", app);
    stubManifest("3.14.3");
    const res = await loopbackGet("app-update");
    const body = (await res.json()) as {
      ok: boolean;
      appUpdate: { updateAvailable: boolean; files: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.appUpdate.updateAvailable).toBe(false);
    expect(body.appUpdate.files).toEqual([]);
  });

  it("rejects an unknown channel", async () => {
    const res = await loopbackGet("app-update?channel=beta");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/channel/);
  });

  it("reports a machine with no app installed instead of failing", async () => {
    vi.stubEnv("ZCODE_APP_PATH", path.join(tmpdir(), "settings-no-app-xyz"));
    stubManifest("3.14.3");
    const res = await loopbackGet("app-update");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; appUpdate: { appPath: string | null } };
    expect(body.ok).toBe(true);
    expect(body.appUpdate.appPath).toBeNull();
  });

  it("surfaces a manifest failure as an error rather than an empty answer", async () => {
    const app = await fakeApp("3.14.1");
    vi.stubEnv("ZCODE_APP_PATH", app);
    setManifestNetworkForTest(
      (async () => new Response("boom", { status: 502 })) as unknown as typeof fetch,
    );
    const res = await loopbackGet("app-update");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/manifest_http_502/);
  });

  it("refuses to install from a non-CDN url", async () => {
    const res = await loopbackSend("POST", "app-update/install", {
      version: "3.14.3",
      url: "https://evil.example.com/ZCode.zip",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/official ZCode CDN/);
  });

  it("refuses an install without a version", async () => {
    const res = await loopbackSend("POST", "app-update/install", {
      url: "https://cdn-zcode.z.ai/zcode/electron/releases/3.14.3/macos-arm64/ZCode-3.14.3-mac-arm64.zip",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/version is required/);
  });

  it("refuses an install without a url", async () => {
    const res = await loopbackSend("POST", "app-update/install", { version: "3.14.3" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/url is required/);
  });

  it("accepts an official CDN install and starts it in the background", async () => {
    const app = await fakeApp("3.14.1");
    vi.stubEnv("ZCODE_APP_PATH", app);
    const url =
      "https://cdn-zcode.z.ai/zcode/electron/releases/3.14.3/macos-arm64/ZCode-3.14.3-mac-arm64.zip";
    // The manifest is the authority: the route re-reads it and only proceeds when
    // the requested version AND url are the ones this channel serves.
    stubManifest("3.14.3", url);
    // A body that closes immediately keeps the download hermetic; the install
    // stage then fails on the missing archive, which is fine — this test is
    // about the route accepting and dispatching, not about installing.
    let calls = 0;
    setManifestNetworkForTest((async () => {
      calls += 1;
      // First call is the manifest read; the second is the artifact.
      if (calls === 1) {
        return new Response(
          ["version: 3.14.3", "files:", `    - url: ${url}`, "      sha512: abc"].join("\n"),
          { status: 200 },
        );
      }
      return new Response("not-a-zip", { status: 200 });
    }) as unknown as typeof fetch);
    const res = await loopbackSend("POST", "app-update/install", { version: "3.14.3", url });
    // 202 Accepted: the download runs detached so the request is not held open
    // for a 250 MB transfer.
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; install: { stage: string; version: string } };
    expect(body.ok).toBe(true);
    expect(body.install.version).toBe("3.14.3");
    expect(["downloading", "installing", "done", "failed"]).toContain(body.install.stage);
  });

  it("refuses a downgrade: the requested version must be what the channel serves", async () => {
    const app = await fakeApp("3.14.3");
    vi.stubEnv("ZCODE_APP_PATH", app);
    const url =
      "https://cdn-zcode.z.ai/zcode/electron/releases/3.14.1/macos-arm64/ZCode-3.14.1-mac-arm64.zip";
    let calls = 0;
    setManifestNetworkForTest((async () => {
      calls += 1;
      if (calls === 1) {
        // The channel serves 3.14.3, and the manifest DOES list the older
        // artifact — the version check is what must catch this, not the URL
        // membership check.
        return new Response(
          [
            "version: 3.14.3",
            "files:",
            `    - url: ${url}`,
            "      sha512: abc",
            "    - url: https://cdn-zcode.z.ai/zcode/electron/releases/3.14.3/macos-arm64/ZCode-3.14.3-mac-arm64.zip",
            "      sha512: def",
          ].join("\n"),
          { status: 200 },
        );
      }
      return new Response("not-a-zip", { status: 200 });
    }) as unknown as typeof fetch);
    const res = await loopbackSend("POST", "app-update/install", { version: "3.14.1", url });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/latest stable version/);
  });

  it("refuses an install that is not newer than the installed version", async () => {
    const app = await fakeApp("3.14.3");
    vi.stubEnv("ZCODE_APP_PATH", app);
    const url =
      "https://cdn-zcode.z.ai/zcode/electron/releases/3.14.3/macos-arm64/ZCode-3.14.3-mac-arm64.zip";
    let calls = 0;
    setManifestNetworkForTest((async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          ["version: 3.14.3", "files:", `    - url: ${url}`, "      sha512: abc"].join("\n"),
          { status: 200 },
        );
      }
      return new Response("not-a-zip", { status: 200 });
    }) as unknown as typeof fetch);
    const res = await loopbackSend("POST", "app-update/install", { version: "3.14.3", url });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/not newer than/);
  });

  it("refuses a CDN url that is not an entry in the current manifest", async () => {
    const app = await fakeApp("3.14.1");
    vi.stubEnv("ZCODE_APP_PATH", app);
    let calls = 0;
    setManifestNetworkForTest((async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          [
            "version: 3.14.3",
            "files:",
            "    - url: https://cdn-zcode.z.ai/zcode/electron/releases/3.14.3/macos-arm64/ZCode-3.14.3-mac-arm64.zip",
            "      sha512: abc",
          ].join("\n"),
          { status: 200 },
        );
      }
      return new Response("not-a-zip", { status: 200 });
    }) as unknown as typeof fetch);
    const res = await loopbackSend("POST", "app-update/install", {
      version: "3.14.3",
      url: "https://cdn-zcode.z.ai/zcode/electron/releases/3.14.2/macos-arm64/ZCode-3.14.2-mac-arm64.zip",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/not in the current release/);
  });

  it("refuses a second concurrent install with 409", async () => {
    const app = await fakeApp("3.14.1");
    vi.stubEnv("ZCODE_APP_PATH", app);
    const url =
      "https://cdn-zcode.z.ai/zcode/electron/releases/3.14.3/macos-arm64/ZCode-3.14.3-mac-arm64.zip";
    // A body that never ends keeps the first install in the downloading stage,
    // which is the state the guard reads — otherwise the first call would
    // finish (and clear its in-flight marker) before the second arrives. The
    // first fetch is the manifest read, which must answer so the install starts.
    let releaseHold: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let calls = 0;
    setManifestNetworkForTest((async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          ["version: 3.14.3", "files:", `    - url: ${url}`, "      sha512: abc"].join("\n"),
          { status: 200 },
        );
      }
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await held;
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch);
    const first = loopbackSend("POST", "app-update/install", { version: "3.14.3", url });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await loopbackSend("POST", "app-update/install", { version: "3.14.3", url });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toMatch(/already in progress/);
    expect((await first).status).toBe(202);
    releaseHold?.();
  });

  it("is gated by the hub token like every other settings route", async () => {
    const res = await hubGet("app-update", "wrong-token");
    expect(res.status).toBe(401);
    const ok = await hubGet("app-update");
    expect(ok.status).toBe(200);
  });
});
