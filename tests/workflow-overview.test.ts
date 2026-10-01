/**
 * Machine-level workflow overview (`GET /api/workflow-overview`):
 * workspace dedupe (a project with an editor + serve bridge must render ONE
 * group), freshest-bridge preference with sibling fallback, machine-wide
 * active runs with owner-instance annotation, and the hub route wiring.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { buildWorkflowOverview, type OverviewInstance } from "../src/remote/workflow-overview.js";
import { startHub, type HubHandle } from "../src/remote/hub-server.js";

const TOKEN = "test-hub-token";
const cleanups: Array<() => Promise<void> | void> = [];

function track<T>(value: T, stop: (v: T) => Promise<void> | void): T {
  cleanups.push(() => stop(value));
  return value;
}

afterEach(async () => {
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
});

interface FakeBridge {
  port: number;
  /** Paths this bridge was asked for (pathname + scope only). */
  calls: string[];
}

/**
 * A fake bridge serving the two workflow routes. `answer` decides the body
 * per (kind, scope); an undefined answer rejects with a 404 — the "old
 * bridge" shape.
 */
function startFakeBridge(
  answer: (
    kind: "list" | "runs",
    scope: string,
  ) => { workflows?: unknown[]; runs?: unknown[]; invalid?: unknown[] } | undefined,
): Promise<FakeBridge> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const scope = url.searchParams.get("scope") ?? "project";
    calls.push(`${url.pathname}?${scope}`);
    const kind = url.pathname.endsWith("/runs") ? "runs" : "list";
    const body = answer(kind, scope);
    if (body === undefined) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...body }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      cleanups.push(() => new Promise<void>((ok) => server.close(() => ok())));
      resolve({ port, calls });
    });
  });
}

/** A port with nothing listening (bind ephemeral, release). */
async function deadPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function inst(
  id: string,
  port: number,
  workspace: string,
  startedAt: number,
  sessions: OverviewInstance["sessions"] = [],
): OverviewInstance {
  return { id, port, workspace, startedAt, sessions };
}

describe("buildWorkflowOverview", () => {
  it("dedupes one workspace to ONE group, answered by the freshest bridge", async () => {
    const older = await startFakeBridge((kind, scope) => {
      if (scope !== "project")
        return kind === "list" ? { workflows: [], invalid: [] } : { runs: [] };
      return kind === "list" ? { workflows: [{ name: "old-copy" }], invalid: [] } : { runs: [] };
    });
    const newer = await startFakeBridge((kind, scope) => {
      if (scope !== "project")
        return kind === "list" ? { workflows: [], invalid: [] } : { runs: [] };
      return kind === "list"
        ? { workflows: [{ name: "fresh" }], invalid: [] }
        : { runs: [{ runId: "r1", name: "fresh", status: "completed", updatedAt: 9 }] };
    });

    const overview = await buildWorkflowOverview([
      inst("old", older.port, "/proj/a", 100),
      inst("new", newer.port, "/proj/a", 200),
    ]);

    const projects = overview.groups.filter((g) => g.scope === "project");
    expect(projects).toHaveLength(1);
    expect(projects[0]!.instanceId).toBe("new");
    expect(projects[0]!.workflows).toEqual([{ name: "fresh" }]);
    expect(projects[0]!.lastRuns["fresh"]!.runId).toBe("r1");
    expect(projects[0]!.error).toBeNull();
  });

  it("falls back to an older sibling when the freshest is unreachable", async () => {
    const older = await startFakeBridge((kind, scope) => {
      if (scope !== "project")
        return kind === "list" ? { workflows: [], invalid: [] } : { runs: [] };
      return kind === "list" ? { workflows: [{ name: "only" }], invalid: [] } : { runs: [] };
    });
    const overview = await buildWorkflowOverview([
      inst("old", older.port, "/proj/a", 100),
      inst("new", await deadPort(), "/proj/a", 200),
    ]);

    const project = overview.groups.find((g) => g.scope === "project")!;
    expect(project.instanceId).toBe("old");
    expect(project.error).toBeNull();
    expect(project.workflows).toEqual([{ name: "only" }]);
  });

  it("answers an error group when every bridge of a workspace failed", async () => {
    const overview = await buildWorkflowOverview([inst("dead", await deadPort(), "/proj/a", 100)]);
    const project = overview.groups.find((g) => g.scope === "project")!;
    expect(project.error).toBeTruthy();
    expect(project.workspace).toBe("/proj/a");
    expect(project.workflows).toEqual([]);
    expect(project.instanceId).toBe("dead");
  });

  it("keeps distinct workspaces as separate groups, sorted by path", async () => {
    const bridge = await startFakeBridge((kind, scope) => {
      if (kind === "list") return { workflows: [], invalid: [] };
      return { runs: scope === "project" ? [] : [] };
    });
    const overview = await buildWorkflowOverview([
      inst("b", bridge.port, "/proj/b", 100),
      inst("a", bridge.port, "/proj/a", 100),
    ]);
    const projects = overview.groups.filter((g) => g.scope === "project");
    expect(projects.map((g) => g.workspace)).toEqual(["/proj/a", "/proj/b"]);
  });

  it("returns empty groups and active runs when no bridge is registered", async () => {
    const overview = await buildWorkflowOverview([]);
    expect(overview).toEqual({ ok: true, groups: [], activeRuns: [] });
  });

  it("feeds active runs from the machine-wide journal read and annotates owners", async () => {
    const bridge = await startFakeBridge((kind, scope) => {
      if (kind === "list") return { workflows: [], invalid: [] };
      if (scope === "global") {
        return {
          runs: [
            {
              runId: "r1",
              name: "live",
              status: "running",
              updatedAt: 30,
              acpSessionId: "sess_a",
            },
            { runId: "r2", name: "done", status: "completed", updatedAt: 20 },
            {
              runId: "r3",
              name: "queued",
              status: "pending",
              updatedAt: 10,
              acpSessionId: "sess_b",
            },
          ],
        };
      }
      return { runs: [] };
    });

    const overview = await buildWorkflowOverview([
      inst("A", bridge.port, "/proj/a", 200, [{ sessionId: "sess_a", status: "running" }]),
      inst("B", bridge.port, "/proj/b", 100, [{ sessionId: "sess_b", status: "idle" }]),
    ]);

    expect(overview.activeRuns.map((r) => r.runId)).toEqual(["r1", "r3"]);
    expect(overview.activeRuns[0]!.ownerInstanceId).toBe("A");
    expect(overview.activeRuns[1]!.ownerInstanceId).toBe("B");
    // The global group's badges join the same machine-wide read by name.
    const global = overview.groups.find((g) => g.scope === "global")!;
    expect(global.instanceId).toBe("A"); // freshest-started wins
    expect(global.lastRuns["live"]!.runId).toBe("r1");
  });

  it("leaves an ownerless active run bare (no instance lists its session)", async () => {
    const bridge = await startFakeBridge((kind, scope) => {
      if (kind === "list") return { workflows: [], invalid: [] };
      if (scope === "global") {
        return {
          runs: [{ runId: "r9", status: "running", acpSessionId: "sess_x", updatedAt: 5 }],
        };
      }
      return { runs: [] };
    });
    const overview = await buildWorkflowOverview([inst("A", bridge.port, "/proj/a", 100)]);
    expect(overview.activeRuns).toHaveLength(1);
    expect(overview.activeRuns[0]!.ownerInstanceId).toBeUndefined();
  });
});

describe("hub /api/workflow-overview", () => {
  it("serves the aggregated overview behind the token", async () => {
    const bridge = await startFakeBridge((kind, scope) => {
      if (kind === "list") return { workflows: [{ name: "deploy" }], invalid: [] };
      return {
        runs:
          scope === "global"
            ? [{ runId: "r1", name: "deploy", status: "running", updatedAt: 3 }]
            : [],
      };
    });
    const hub: HubHandle = track(
      await startHub({ port: 0, host: "127.0.0.1", token: TOKEN }),
      (h) => h.close(),
    );
    const register = (id: string, port: number, startedAt: number) =>
      fetch(`http://127.0.0.1:${hub.port}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: TOKEN,
          id,
          port,
          pid: 1,
          workspace: "/proj/a",
          startedAt,
          sessions: [],
        }),
      });
    // Same workspace twice (editor + serve shape): the dead duplicate must
    // not produce a second group.
    await register("new", await deadPort(), 2);
    await register("old", bridge.port, 1);

    const res = await fetch(`http://127.0.0.1:${hub.port}/api/workflow-overview`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      groups: Array<{ scope: string; instanceId: string }>;
      activeRuns: Array<{ runId?: string }>;
    };
    const projects = body.groups.filter((g) => g.scope === "project");
    expect(projects).toHaveLength(1);
    expect(projects[0]!.instanceId).toBe("old"); // fallen back to the live sibling
    expect(body.activeRuns.map((r) => r.runId)).toEqual(["r1"]);

    const denied = await fetch(`http://127.0.0.1:${hub.port}/api/workflow-overview`);
    expect(denied.status).toBe(401);
  });
});
