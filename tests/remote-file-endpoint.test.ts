/**
 * Session file endpoint (ADR-0004): a real bridge loopback endpoint joined
 * with a real hub, exercised end-to-end through the hub's proxy route. The
 * happy paths prove bytes and metadata; the scope tests prove the Session
 * Root boundary (traversal, symlink escapes, unknown sessions).
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { RemoteConfig } from "../src/remote/config.js";
import { startRemoteEndpoint } from "../src/remote/endpoint.js";
import { startHub } from "../src/remote/hub-server.js";
import { ZcodeAcpServer } from "../src/server.js";
import { AGENT_INFO } from "../src/utils.js";

const TOKEN = "test-fs-token";

const cleanups: Array<() => Promise<void> | void> = [];

function trackStop(stop: () => Promise<void> | void): void {
  cleanups.push(stop);
}

afterEach(async () => {
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
});

interface Fixture {
  /** Hub-proxied fs base URL for THIS bridge instance. */
  base: string;
  /** Hub port (for direct /api requests in tests). */
  hubPort: number;
  /** Session root dir (already registered as session "s-fs"). */
  dir: string;
  /** Sibling dir outside the session root (for escape fixtures). */
  outside: string;
  endpoint: { port: number; stop(): Promise<void> };
  /** The bridge's server state (for polluting cwd records in tests). */
  server: ZcodeAcpServer;
}

async function spawnFixture(): Promise<Fixture> {
  const hub = await startHub({ port: 0, host: "127.0.0.1", token: TOKEN });
  trackStop(() => hub.close());

  const server = new ZcodeAcpServer();
  const app = acp
    .agent({ name: AGENT_INFO.name })
    .onRequest("initialize", (ctx) => server.initialize(ctx.params));
  const config: RemoteConfig = {
    token: TOKEN,
    hubPort: hub.port,
    hubHost: "127.0.0.1",
    bridgePort: 18700,
  };
  const endpoint = await startRemoteEndpoint(server, app, config);
  expect(endpoint).not.toBeNull();
  trackStop(() => endpoint!.stop());

  const dir = await mkdtemp(path.join(tmpdir(), "zcode-fs-root-"));
  trackStop(() => rm(dir, { recursive: true, force: true }));
  const outside = await mkdtemp(path.join(tmpdir(), "zcode-fs-out-"));
  trackStop(() => rm(outside, { recursive: true, force: true }));

  await writeFile(path.join(dir, "README.md"), "# hello\nsecond line\nthird line\n");
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "a.ts"), "export {};\n");
  await writeFile(path.join(outside, "secret.txt"), "outside\n");
  await symlink(path.join(outside, "secret.txt"), path.join(dir, "escape"));
  await symlink("README.md", path.join(dir, "inner-link"));

  server.sessionCwds.set("s-fs", dir);
  return {
    base: `http://127.0.0.1:${hub.port}/api/instances/${process.pid}/fs`,
    hubPort: hub.port,
    dir,
    outside,
    endpoint: endpoint!,
    server,
  };
}

function fsFetch(base: string, route: string, token = TOKEN): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${base}${route}`, { headers });
}

describe("session files over the hub proxy", () => {
  it("lists the session root with dir-first ordering and symlink kinds", async () => {
    const { base, dir } = await spawnFixture();
    const res = await fsFetch(base, "/list?sessionId=s-fs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      root: string;
      truncated: boolean;
      entries: Array<{ name: string; kind: string; size: number }>;
    };
    expect(body.root).toBe(await realpath(dir));
    expect(body.truncated).toBe(false);
    const names = body.entries.map((e) => `${e.kind}:${e.name}`);
    // Byte-order sort (uppercase before lowercase), dirs first.
    expect(names).toEqual(["dir:src", "file:README.md", "symlink:escape", "symlink:inner-link"]);
    const readme = body.entries.find((e) => e.name === "README.md")!;
    expect(readme.size).toBe("# hello\nsecond line\nthird line\n".length);
  });

  it("lists a subdirectory and answers 404 for a file path", async () => {
    const { base } = await spawnFixture();
    const ok = await fsFetch(base, "/list?sessionId=s-fs&path=src");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { entries: Array<{ name: string }> };
    expect(body.entries.map((e) => e.name)).toEqual(["a.ts"]);

    const bad = await fsFetch(base, "/list?sessionId=s-fs&path=README.md");
    expect(bad.status).toBe(404);
  });

  it("refuses to serve a session whose recorded root is /", async () => {
    const { base, server } = await spawnFixture();
    // A polluted cwd record must never widen file access to the filesystem
    // root — defense in depth behind the load-side guards.
    server.sessionCwds.set("s-polluted", "/");
    const res = await fsFetch(base, "/list?sessionId=s-polluted");
    expect(res.status).toBe(403);
    const file = await fsFetch(base, "/file?sessionId=s-polluted&path=etc/passwd");
    expect(file.status).toBe(403);
  });

  it("streams whole files with a Content-Type from the extension", async () => {
    const { base } = await spawnFixture();
    const res = await fsFetch(base, "/file?sessionId=s-fs&path=README.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown");
    expect(await res.text()).toBe("# hello\nsecond line\nthird line\n");
  });

  it("serves byte ranges as 206 with Content-Range", async () => {
    const { base } = await spawnFixture();
    const content = "# hello\nsecond line\nthird line\n";
    const res = await fsFetch(base, "/file?sessionId=s-fs&path=README.md&offset=2&length=4");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 2-5/${content.length}`);
    expect(await res.text()).toBe(content.slice(2, 6));
  });

  it("serves text line windows with X-Zcode-First-Line", async () => {
    const { base } = await spawnFixture();
    const res = await fsFetch(base, "/file?sessionId=s-fs&path=README.md&line=2&limit=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-zcode-first-line")).toBe("2");
    expect(await res.text()).toBe("second line\n");
  });

  it("rejects mixing byte and line range parameters", async () => {
    const { base } = await spawnFixture();
    const res = await fsFetch(base, "/file?sessionId=s-fs&path=README.md&offset=0&line=1");
    expect(res.status).toBe(400);
  });

  it("follows symlinks that stay inside the root", async () => {
    const { base } = await spawnFixture();
    const res = await fsFetch(base, "/file?sessionId=s-fs&path=inner-link");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# hello\nsecond line\nthird line\n");
  });

  it("enforces the session root against traversal and symlink escapes", async () => {
    const { base, outside } = await spawnFixture();
    const dotdot = await fsFetch(
      base,
      `/file?sessionId=s-fs&path=../${path.basename(outside)}/secret.txt`,
    );
    expect(dotdot.status).toBe(403);

    const link = await fsFetch(base, "/file?sessionId=s-fs&path=escape");
    expect(link.status).toBe(403);

    const unknown = await fsFetch(base, "/list?sessionId=s-nope");
    expect(unknown.status).toBe(403);

    const missing = await fsFetch(base, "/file?sessionId=s-fs&path=nope.txt");
    expect(missing.status).toBe(404);
  });

  it("guards the proxy route like the rest of /api", async () => {
    const { base, hubPort } = await spawnFixture();
    const noToken = await fsFetch(base, "/list?sessionId=s-fs", "");
    expect(noToken.status).toBe(401);

    const badInstance = await fetch(`http://127.0.0.1:${hubPort}/api/instances/999999/fs/list`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(badInstance.status).toBe(404);
  });

  it("answers 502 when the bridge port is unreachable", async () => {
    const hub = await startHub({ port: 0, host: "127.0.0.1", token: TOKEN });
    trackStop(() => hub.close());
    // Register an instance whose loopback port is closed — the hub dials it
    // on demand and must surface the connection refusal as 502.
    const reg = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: TOKEN,
        id: "dead-1",
        port: 9,
        pid: 1,
        workspace: "",
        sessions: [],
        version: AGENT_INFO.version,
      }),
    });
    expect(reg.status).toBe(200);
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/instances/dead-1/fs/list`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(502);
  });
});

describe("fs capability advertisement", () => {
  it("initialize advertises _meta.zcode.fs", async () => {
    const server = new ZcodeAcpServer();
    const resp = await server.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    } as acp.InitializeRequest);
    const meta = (resp.agentCapabilities as { _meta?: { zcode?: { fs?: boolean } } })._meta;
    expect(meta?.zcode?.fs).toBe(true);
  });
});
