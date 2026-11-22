/**
 * Settings parity routes (settings-alignment-requirements.md, bridge
 * additions): MCP status, hooks add/remove, skill detail.
 *
 * Same harness idea as workflow-settings.test.ts: the REAL handler factory
 * on a loopback server, a real ZcodeAcpServer with an in-memory fake backend
 * (request recorder + canned results) for the mcp/list RPC, and a hermetic
 * HOME so cli-config and skills touch only scratch files.
 */

import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { createSettingsHandler } from "../src/remote/settings-endpoint.js";
import { ZcodeAcpServer } from "../src/server.js";

const cleanups: Array<() => Promise<void> | void> = [];

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "settings-parity-"));
  vi.stubEnv("HOME", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
  await rm(home, { recursive: true, force: true });
});

/** A backend whose mcp/list answers from a canned script; records calls. */
function makeBridge(mcpListResult?: { error?: unknown; result?: unknown }): {
  server: ZcodeAcpServer;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const backend = {
    isDead: false,
    request: async (id: number, method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "mcp/list") {
        if (mcpListResult?.error) return { id, error: mcpListResult.error };
        return { id, result: mcpListResult?.result ?? {} };
      }
      return { id, result: {} };
    },
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  const server = new ZcodeAcpServer();
  server.backend = backend;
  return { server, calls };
}

/** Mount the handler on a loopback server; returns its base URL. */
async function serveSettings(server?: ZcodeAcpServer): Promise<string> {
  const handler = createSettingsHandler(server);
  const http = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  return `http://127.0.0.1:${port}`;
}

async function call(
  base: string,
  method: string,
  pathName: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const resp = await fetch(base + pathName, {
    method,
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return { status: resp.status, json: await resp.json().catch(() => null) };
}

async function readCliConfigFile(): Promise<Record<string, any>> {
  const raw = await readFile(path.join(home, ".zcode", "cli", "config.json"), "utf8");
  return JSON.parse(raw) as Record<string, any>;
}

// ---- GET /settings/mcp-status ----

describe("settings mcp-status", () => {
  it("relays the backend mcp/list status map", async () => {
    const { server, calls } = makeBridge({
      result: {
        statuses: {
          fetch: { status: "ok", toolCount: 3 },
          broken: { status: "failed", toolCount: 0, failureKind: "start_error" },
          oauth: {
            status: "needs_authorization",
            toolCount: 0,
            authorization: { authorizationUrl: "https://mcp.example/auth" },
          },
        },
      },
    });
    const base = await serveSettings(server);
    const { status, json } = await call(base, "GET", "/settings/mcp-status");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.available).toBe(true);
    expect(json.statuses).toEqual({
      fetch: { status: "ok", toolCount: 3 },
      broken: { status: "failed", toolCount: 0, failureKind: "start_error" },
      oauth: {
        status: "needs_authorization",
        toolCount: 0,
        authorizationUrl: "https://mcp.example/auth",
      },
    });
    expect(calls).toEqual([
      { method: "mcp/list", params: { workspace: { workspacePath: expect.any(String), workspaceKey: expect.any(String) }, mode: "status" } },
    ]);
  });

  it("answers available:false on a backend that cannot report status", async () => {
    const { server } = makeBridge({ error: { code: -32601, message: "method not found" } });
    const base = await serveSettings(server);
    const { status, json } = await call(base, "GET", "/settings/mcp-status");
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, available: false, statuses: {} });
  });

  it("points the machine-level mount at the per-instance spelling (409)", async () => {
    const base = await serveSettings(); // no server — the hub's mount
    const { status, json } = await call(base, "GET", "/settings/mcp-status");
    expect(status).toBe(409);
    expect(json.error).toContain("per-bridge");
  });
});

// ---- POST /settings/hooks/{event} (+ /remove) ----

describe("settings hooks add/remove", () => {
  it("appends into the matcher-named group and creates groups on demand", async () => {
    const base = await serveSettings(makeBridge().server);
    const add = (event: string, body: unknown) =>
      call(base, "POST", `/settings/hooks/${event}`, body);

    expect((await add("PreToolUse", { matcher: "Bash", hook: { type: "command", command: "a.sh" } })).json).toMatchObject({ ok: true, effect: "needs-restart" });
    // Same matcher → same group, appended after the first.
    await add("PreToolUse", { matcher: "Bash", hook: { type: "command", command: "b.sh" } });
    // Absent matcher → its own group (distinct from the "Bash" one).
    await add("PreToolUse", { hook: { type: "process", command: "c.sh" } });
    // enabled:true normalizes away (enabled is the default).
    await add("Stop", { hook: { type: "command", command: "d.sh", enabled: true } });

    const cfg = await readCliConfigFile();
    expect(cfg.hooks.events.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "a.sh" }, { type: "command", command: "b.sh" }] },
      { hooks: [{ type: "process", command: "c.sh" }] },
    ]);
    expect(cfg.hooks.events.Stop).toEqual([{ hooks: [{ type: "command", command: "d.sh" }] }]);
  });

  it("rejects a malformed add (unknown event / bad entry)", async () => {
    const base = await serveSettings(makeBridge().server);
    expect((await call(base, "POST", "/settings/hooks/Nope", { hook: { type: "command", command: "x" } })).status).toBe(400);
    expect((await call(base, "POST", "/settings/hooks/Stop", { hook: { type: "command" } })).status).toBe(400);
    expect((await call(base, "POST", "/settings/hooks/Stop", {})).status).toBe(400);
  });

  it("removes by fingerprint and refuses a stale index", async () => {
    const base = await serveSettings(makeBridge().server);
    await call(base, "POST", "/settings/hooks/Stop", {
      matcher: "",
      hook: { type: "command", command: "only.sh" },
    });
    const remove = (body: unknown) => call(base, "POST", "/settings/hooks/Stop/remove", body);

    // Wrong fingerprint → 400, nothing deleted.
    const stale = await remove({ matcherIndex: 0, hookIndex: 0, command: "other.sh" });
    expect(stale.status).toBe(400);
    expect(stale.json.error).toContain("changed");
    expect((await readCliConfigFile()).hooks.events.Stop).toHaveLength(1);

    // Right fingerprint → gone, and the emptied group drops with it.
    const ok = await remove({ matcherIndex: 0, hookIndex: 0, command: "only.sh" });
    expect(ok.json).toMatchObject({ ok: true, effect: "needs-restart" });
    const cfg = await readCliConfigFile();
    expect(cfg.hooks.events).toBeUndefined();
  });
});

// ---- GET /settings/skills/{path} ----

describe("settings skill detail", () => {
  it("serves frontmatter, body and state for a user-scope skill", async () => {
    const dir = path.join(home, ".zcode", "skills", "demo");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      '---\nname: demo\ndescription: Demo skill\nargument-hint: "[file]"\n---\nBody line 1\nBody line 2\n',
      "utf8",
    );
    const base = await serveSettings(makeBridge().server);
    const enc = encodeURIComponent(path.join(dir, "SKILL.md"));
    const { status, json } = await call(base, "GET", `/settings/skills/${enc}`);
    expect(status).toBe(200);
    expect(json.skill).toMatchObject({
      name: "demo",
      description: "Demo skill",
      scope: "user",
      enabled: true,
      deletable: true,
      metadata: { name: "demo", description: "Demo skill", "argument-hint": "[file]" },
      body: "Body line 1\nBody line 2\n",
    });
  });

  it("refuses paths outside the skill roots", async () => {
    const base = await serveSettings(makeBridge().server);
    const outside = encodeURIComponent(path.join(home, "elsewhere", "SKILL.md"));
    const { status, json } = await call(base, "GET", `/settings/skills/${outside}`);
    expect(status).toBe(400);
    expect(json.error).toContain("outside");
  });
});
