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
 * A fake bridge serving the workflow routes: the journal LIST+RUNS pair and
 * the live session-scoped runs read. `answer` decides the body per (kind,
 * scope); an undefined answer rejects with a 404 — the "old bridge" shape.
 */
function startFakeBridge(
  answer: (
    kind: "list" | "runs" | "sessionRuns",
    scope: string,
  ) => { workflows?: unknown[]; runs?: unknown[]; invalid?: unknown[] } | undefined,
): Promise<FakeBridge> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const scope = url.searchParams.get("scope") ?? "project";
    calls.push(
      `${url.pathname}?${url.searchParams.get("scope") ?? url.searchParams.get("sessionId") ?? ""}`,
    );
    const kind =
      url.pathname === "/settings/workflow-runs"
        ? "sessionRuns"
        : url.pathname.endsWith("/runs")
          ? "runs"
          : "list";
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
    expect(overview).toEqual({ ok: true, groups: [], activeRuns: [], recentRuns: [] });
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

  it("serves recently finished runs newest-first, capped, owners annotated", async () => {
    // 22 terminal rows around one live row: the recent list keeps the newest
    // 20 terminal rows (RECENT_RUNS_LIMIT), the live one never leaks in, and
    // a settled row whose session an instance still lists gets the owner
    // annotation so the client can address its detail view.
    const terminal = Array.from({ length: 22 }, (_, i) => ({
      runId: `t${i}`,
      name: `wf${i}`,
      status: i % 2 === 0 ? "completed" : "errored",
      updatedAt: 100 - i,
      ...(i === 0 ? { acpSessionId: "sess_done" } : {}),
    }));
    const bridge = await startFakeBridge((kind, scope) => {
      if (kind === "list") return { workflows: [], invalid: [] };
      if (scope === "global") {
        return {
          runs: [
            ...terminal,
            { runId: "live", status: "running", updatedAt: 999, acpSessionId: "sess_a" },
          ],
        };
      }
      return { runs: [] };
    });

    const overview = await buildWorkflowOverview([
      inst("A", bridge.port, "/proj/a", 200, [{ sessionId: "sess_a", status: "running" }]),
      inst("B", bridge.port, "/proj/b", 100, [{ sessionId: "sess_done", status: "idle" }]),
    ]);

    expect(overview.recentRuns).toHaveLength(20);
    expect(overview.recentRuns.map((r) => r.runId)).toEqual(
      terminal.slice(0, 20).map((r) => r.runId),
    );
    expect(overview.recentRuns.some((r) => r.runId === "live")).toBe(false);
    expect(overview.recentRuns[0]!.ownerInstanceId).toBe("B");
  });

  it("overrides a falsely interrupted row when the owner's live read says running", async () => {
    // The journal row was written by upstream's orphan reconciliation while
    // the run kept executing ("the owning process exited" is the lie); the
    // owner's live session read is the truth. The session is reported IDLE —
    // exactly how the observed case looked (a workflow keeps flying while
    // its parent session sits between turns), so a running-gated trigger
    // would have missed it.
    const bridge = await startFakeBridge((kind) => {
      if (kind === "sessionRuns") return { runs: [{ runId: "r1", status: "running" }] };
      if (kind === "list") return { workflows: [], invalid: [] };
      // Both the global and the project journal read carry the row — same as
      // the real store (project scope just filters by cwd).
      return {
        runs: [
          {
            runId: "r1",
            name: "live",
            status: "stopped",
            stopReason: "interrupted",
            updatedAt: 30,
            acpSessionId: "sess_a",
            cwd: "/proj/a",
          },
        ],
      };
    });

    const overview = await buildWorkflowOverview([
      inst("A", bridge.port, "/proj/a", 100, [{ sessionId: "sess_a", status: "idle" }]),
    ]);

    expect(overview.activeRuns.map((r) => r.runId)).toEqual(["r1"]);
    expect(overview.activeRuns[0]!.status).toBe("running");
    expect(overview.activeRuns[0]!["stopReason"]).toBeUndefined();
    expect(overview.activeRuns[0]!.ownerInstanceId).toBe("A");
    // Live-corrected rows must not resurface as finished either.
    expect(overview.recentRuns).toEqual([]);
    // The project group's badge joins the same truth, not the journal lie.
    const project = overview.groups.find((g) => g.scope === "project")!;
    expect(project.lastRuns["live"]!.status).toBe("running");
    // One probe per (instance, session); its runId-keyed truth feeds both the
    // global and the project rows.
    expect(bridge.calls.filter((c) => c.startsWith("/settings/workflow-runs")).length).toBe(1);
  });

  it("joins the live read by runId even when the row's alias differs per bridge", async () => {
    // Alias spelling differs per bridge (one bridge's `sess_…` is another's
    // backend id), so the probe must NOT key off the row's acpSessionId:
    // it scans the workspace owner's LISTED sessions and joins on runId.
    const bridge = await startFakeBridge((kind) => {
      if (kind === "sessionRuns") return { runs: [{ runId: "r5", status: "running" }] };
      if (kind === "list") return { workflows: [], invalid: [] };
      return {
        runs: [
          {
            runId: "r5",
            name: "live",
            status: "stopped",
            stopReason: "interrupted",
            updatedAt: 30,
            acpSessionId: "backend-xyz-no-instance-lists-this",
            cwd: "/proj/a",
          },
        ],
      };
    });

    const overview = await buildWorkflowOverview([
      inst("A", bridge.port, "/proj/a", 100, [{ sessionId: "sess_listed", status: "idle" }]),
    ]);

    expect(overview.activeRuns.map((r) => r.runId)).toEqual(["r5"]);
    expect(overview.activeRuns[0]!.status).toBe("running");
    expect(overview.activeRuns[0]!.ownerInstanceId).toBe("A");
    // The probe used the instance's OWN listed spelling, not the row's.
    expect(bridge.calls.filter((c) => c === "/settings/workflow-runs?sess_listed").length).toBe(1);
  });

  it("keeps the live-truth owner when the heuristic would pick another bridge", async () => {
    // The interrupted row's acpSessionId ("sess_alias") is listed RUNNING by
    // bridge B, so the session-listing heuristic would route ownership to B —
    // but the live registry answer comes from A, the actual owner. The live
    // truth is process evidence and must win (stop/resume address correctness).
    const owner = await startFakeBridge((kind) => {
      if (kind === "sessionRuns") return { runs: [{ runId: "r1", status: "running" }] };
      if (kind === "list") return { workflows: [], invalid: [] };
      return {
        runs: [
          {
            runId: "r1",
            name: "live",
            status: "stopped",
            stopReason: "interrupted",
            updatedAt: 30,
            acpSessionId: "sess_alias",
            cwd: "/proj/a",
          },
        ],
      };
    });
    const decoy = await startFakeBridge((kind) => {
      if (kind === "sessionRuns") return { runs: [{ runId: "r1", status: "stopped" }] };
      if (kind === "list") return { workflows: [], invalid: [] };
      return { runs: [] };
    });

    const overview = await buildWorkflowOverview([
      inst("A", owner.port, "/proj/a", 200, [{ sessionId: "sess_owner", status: "idle" }]),
      inst("B", decoy.port, "/proj/a", 100, [{ sessionId: "sess_alias", status: "running" }]),
    ]);

    expect(overview.activeRuns.map((r) => r.runId)).toEqual(["r1"]);
    expect(overview.activeRuns[0]!.ownerInstanceId).toBe("A");
  });

  it("keeps an interrupted row terminal when the live read agrees it is not running", async () => {
    const bridge = await startFakeBridge((kind, scope) => {
      if (kind === "sessionRuns") return { runs: [{ runId: "r2", status: "stopped" }] };
      if (kind === "list") return { workflows: [], invalid: [] };
      if (scope === "global") {
        return {
          runs: [
            {
              runId: "r2",
              name: "dead",
              status: "stopped",
              stopReason: "interrupted",
              updatedAt: 20,
              acpSessionId: "sess_b",
              cwd: "/proj/a",
            },
          ],
        };
      }
      return { runs: [] };
    });
    const overview = await buildWorkflowOverview([
      inst("A", bridge.port, "/proj/a", 100, [{ sessionId: "sess_b", status: "running" }]),
    ]);
    expect(overview.activeRuns).toEqual([]);
    const global = overview.groups.find((g) => g.scope === "global")!;
    expect(global.lastRuns["dead"]!.status).toBe("stopped");
    // The probe DID happen (the workspace has a listed session) — it agreed.
    expect(bridge.calls.filter((c) => c === "/settings/workflow-runs?sess_b").length).toBe(1);
  });

  it("never probes when the row's workspace has no registered bridge", async () => {
    const bridge = await startFakeBridge((kind, scope) => {
      if (kind === "sessionRuns") return { runs: [{ runId: "r3", status: "running" }] };
      if (kind === "list") return { workflows: [], invalid: [] };
      if (scope === "global") {
        return {
          runs: [
            // Reconciliation signature, but its workspace has no bridge —
            // nothing to ask; the terminal verdict stands.
            {
              runId: "r3",
              name: "orphan",
              status: "stopped",
              stopReason: "interrupted",
              updatedAt: 10,
              acpSessionId: "sess_absent",
              cwd: "/proj/gone",
            },
            // A genuine supersede is terminal history, not a live run.
            {
              runId: "r4",
              name: "old",
              status: "stopped",
              stopReason: "superseded",
              updatedAt: 9,
              acpSessionId: "sess_c",
              cwd: "/proj/a",
            },
          ],
        };
      }
      return { runs: [] };
    });
    const overview = await buildWorkflowOverview([
      inst("A", bridge.port, "/proj/a", 100, [{ sessionId: "sess_c", status: "running" }]),
    ]);
    expect(overview.activeRuns).toEqual([]);
    const global = overview.groups.find((g) => g.scope === "global")!;
    expect(global.lastRuns["orphan"]!.status).toBe("stopped");
    expect(global.lastRuns["old"]!.status).toBe("stopped");
    // /proj/gone has no instance and the superseded row is not suspicious.
    expect(bridge.calls.filter((c) => c.startsWith("/settings/workflow-runs"))).toEqual([]);
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

  it("serves a falsely-interrupted run as active through the hub route", async () => {
    // End-to-end shape of the 2026-10-02 report: the journal's global read
    // carries a stopped(interrupted) row while the registered bridge's live
    // session read reports the same runId as running. The route must serve
    // the LIVE verdict (idle session included).
    const bridge = await startFakeBridge((kind) => {
      if (kind === "sessionRuns") return { runs: [{ runId: "r7", status: "running" }] };
      if (kind === "list") return { workflows: [], invalid: [] };
      return {
        runs: [
          {
            runId: "r7",
            name: "real",
            status: "stopped",
            stopReason: "interrupted",
            updatedAt: 50,
            acpSessionId: "sess_live",
            cwd: "/proj/a",
          },
        ],
      };
    });
    const hub: HubHandle = track(
      await startHub({ port: 0, host: "127.0.0.1", token: TOKEN }),
      (h) => h.close(),
    );
    await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: TOKEN,
        id: "live",
        port: bridge.port,
        pid: 1,
        workspace: "/proj/a",
        startedAt: 1,
        sessions: [{ sessionId: "sess_live", status: "idle", updatedAt: 1 }],
      }),
    });

    const res = await fetch(`http://127.0.0.1:${hub.port}/api/workflow-overview`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      activeRuns: Array<{ runId?: string; status?: string; ownerInstanceId?: string }>;
      groups: Array<{ scope: string; lastRuns: Record<string, { status?: string }> }>;
    };
    expect(body.activeRuns.map((r) => r.runId)).toEqual(["r7"]);
    expect(body.activeRuns[0]!.status).toBe("running");
    expect(body.activeRuns[0]!.ownerInstanceId).toBe("live");
    const global = body.groups.find((g) => g.scope === "global")!;
    expect(global.lastRuns["real"]!.status).toBe("running");
  });
});
