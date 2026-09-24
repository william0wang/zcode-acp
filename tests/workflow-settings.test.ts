/**
 * Dynamic-workflow Settings API tests (plan §7) — the management plane.
 *
 * Two layers, mirroring settings-api.test.ts:
 * - a REAL hub (machine-level mount, no server) for the 409 per-instance
 *   pointer and the `/settings/all` degrade block, plus the per-instance
 *   proxy proving a workflow route reaches the bridge's loopback mount;
 * - the handler itself against a rich fake bridge: a REAL ZcodeAcpServer
 *   with an in-memory fake backend (request recorder + canned results) and a
 *   pre-settled `backendWorkflowGate` — the launch protocol then runs the
 *   genuine lazy-materialization path (session/create → alias registration →
 *   durable store → v4/command ack), not a re-implementation of it.
 *
 * The fake backend never touches the network; the hermetic HOME (plus the
 * per-file temp HOME below) carries the lazy-session store writes.
 */

import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { captureGate, type WorkflowGate } from "../src/config/workflow-gate.js";
import { startHub, type HubHandle } from "../src/remote/hub-server.js";
import { createSettingsHandler } from "../src/remote/settings-endpoint.js";
import { ZcodeAcpServer } from "../src/server.js";

// The real module writes the App's tasks-index.sqlite — mocked for the same
// reason as workflow-enable.test.ts: the create path must stay cheap and
// side-effect-free in tests.
vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

const TOKEN = "test-workflow-settings-token";

const GATE_ON = Promise.resolve({
  mode: "alwaysOn",
  enabled: true,
  source: "remote",
} satisfies WorkflowGate);
const GATE_OFF = Promise.resolve({
  mode: "disabled",
  enabled: false,
  source: "remote",
} satisfies WorkflowGate);

const cleanups: Array<() => Promise<void> | void> = [];

let home: string;
let hub: HubHandle;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "workflow-settings-test-"));
  vi.stubEnv("HOME", home);
  hub = await startHub({ port: 0, host: "127.0.0.1", token: TOKEN });
  cleanups.push(() => hub.close());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
  await rm(home, { recursive: true, force: true });
});

/** Per-test backend script: the v4/command ack plus canned read results. */
interface BackendScript {
  ack?: Record<string, unknown>;
  results?: Record<string, unknown>;
  /** RPC error for `v4/command` (transport failure shape — no ack exists). */
  commandError?: { message: string };
}

/**
 * A rich fake bridge: a real ZcodeAcpServer whose backend records every
 * request and answers from the script. session/create echoes a fresh sid so
 * the genuine lazy-materialization path runs end to end.
 */
function makeBridge(
  gate: Promise<WorkflowGate> | null,
  script: BackendScript = {},
): {
  server: ZcodeAcpServer;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  let created = 0;
  const backend = {
    isDead: false,
    request: async (id: number, method: string, params: unknown) => {
      calls.push({ method, params });
      switch (method) {
        case "session/create":
          created += 1;
          return { id, result: { session: { sessionId: `sess_zcode_${created}`, title: "" } } };
        case "v4/command":
          if (script.commandError) return { id, error: script.commandError };
          return {
            id,
            result: script.ack ?? {
              status: "accepted",
              result: { type: "startSavedWorkflow", runId: "r1", toolCallId: "launch-1" },
            },
          };
        default: {
          const canned = script.results?.[method];
          return { id, result: canned ?? {} };
        }
      }
    },
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.backendWorkflowGate = gate;
  return { server, calls };
}

/** Mount a settings handler on a loopback server; returns its port. */
async function serveSettings(server?: ZcodeAcpServer): Promise<number> {
  const handler = createSettingsHandler(server);
  const http = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  return port;
}

function get(port: number, sub: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/settings/${sub}`);
}

function send(port: number, method: string, sub: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/settings/${sub}`, {
    method,
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

/** GET on the hub's machine-level settings route. */
function hubGet(sub: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${hub.port}/api/settings/${sub}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

async function registerInstance(port: number, id = "inst-1"): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${hub.port}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: TOKEN,
      id,
      port,
      pid: process.pid,
      workspace: "/tmp/wf-proj",
      sessions: [],
    }),
  });
  expect(res.ok).toBe(true);
}

/** Register an APP-provided session alias on the bridge (mapping + cwd). */
function provideSession(
  server: ZcodeAcpServer,
  acpSid = "sess_app",
  zcodeSid = "sess_zcode_app",
): void {
  server.registerSession(acpSid, zcodeSid);
  server.sessionCwds.set(acpSid, "/tmp/wf-proj");
}

describe("workflow settings — gate and mount guards", () => {
  it("gate disabled answers 403 workflow_disabled on list, start, and runs", async () => {
    const { server, calls } = makeBridge(GATE_OFF);
    const port = await serveSettings(server);

    for (const res of [await get(port, "workflows"), await get(port, "workflows/runs")]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ ok: false, error: "workflow_disabled" });
    }
    const start = await send(port, "POST", "workflows/project/deploy/start", {});
    expect(start.status).toBe(403);
    expect(((await start.json()) as { error: string }).error).toBe("workflow_disabled");
    // Refused before any backend RPC — the guard is the bridge's own.
    expect(calls).toHaveLength(0);
  });

  it("gate disabled also refuses the create-prompt route (whole surface, one gate)", async () => {
    const { server } = makeBridge(GATE_OFF);
    const port = await serveSettings(server);
    const res = await get(port, "workflow-create-prompt");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("workflow_disabled");
  });

  it("the machine-level (hub) mount answers 409 pointing at the per-instance spelling", async () => {
    const list = await hubGet("workflows");
    expect(list.status).toBe(409);
    expect(((await list.json()) as { error: string }).error).toMatch(
      /per-bridge.*\/api\/instances\/\{id\}\/settings/u,
    );

    const start = await fetch(
      `http://127.0.0.1:${hub.port}/api/settings/workflows/project/deploy/start`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(start.status).toBe(409);

    const runs = await hubGet("workflow-runs?sessionId=sess_app");
    expect(runs.status).toBe(409);
  });

  it("machine-level /settings/all degrades the workflow block to {available:false}", async () => {
    const body = (await (await hubGet("all")).json()) as { workflow: unknown };
    expect(body.workflow).toEqual({ available: false });
  });

  it("with-server /settings/all reports the resolved gate verdict", async () => {
    const { server } = makeBridge(GATE_ON);
    const port = await serveSettings(server);
    const body = (await (await get(port, "all")).json()) as {
      workflow: { enabled: boolean; mode: string; source: string };
    };
    expect(body.workflow).toEqual({ enabled: true, mode: "alwaysOn", source: "remote" });
  });

  it("COLD bridge (gate null, no backend ever spawned) — the guard ensures a backend, not a 403", async () => {
    const { server, calls } = makeBridge(null, {
      results: {
        "workflows/list": {
          workflows: [{ name: "deploy", scope: "project" }],
          invalid: [],
          dir: "/d",
        },
      },
    });
    // Simulate ensureBackend's spawn branch: the real spawn cannot run in a
    // test — the branch under test is that it STARTS the gate fetch (assigns
    // the captured promise) alongside the backend, and the guard re-reads.
    const original = server.ensureBackend.bind(server);
    vi.spyOn(server, "ensureBackend").mockImplementation(async () => {
      server.backendWorkflowGate = captureGate(GATE_ON);
      return original();
    });
    const port = await serveSettings(server);

    const res = await get(port, "workflows");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: Array<{ name: string }> };
    expect(body.workflows[0]!.name).toBe("deploy");
    expect(calls.find((c) => c.method === "workflows/list")).toBeTruthy();
  });

  it("COLD bridge /settings/all reports the real verdict (not a false disabled)", async () => {
    const { server } = makeBridge(null);
    vi.spyOn(server, "ensureBackend").mockImplementation(async () => {
      server.backendWorkflowGate = captureGate(GATE_ON);
      return server.backend!;
    });
    const port = await serveSettings(server);
    const body = (await (await get(port, "all")).json()) as {
      workflow: { enabled: boolean; mode: string; source: string };
    };
    expect(body.workflow).toEqual({ enabled: true, mode: "alwaysOn", source: "remote" });
  });

  it("the hub per-instance proxy passes a workflow route through to the bridge", async () => {
    const { server } = makeBridge(GATE_ON, {
      results: {
        "workflows/list": {
          workflows: [{ name: "deploy", scope: "project" }],
          invalid: [],
          dir: "/d",
        },
      },
    });
    const port = await serveSettings(server);
    await registerInstance(port);
    const res = await fetch(
      `http://127.0.0.1:${hub.port}/api/instances/inst-1/settings/workflows`,
      {
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: Array<{ name: string }> };
    expect(body.workflows[0]!.name).toBe("deploy");
  });
});

describe("workflow settings — management passthrough", () => {
  it("list forwards the bridge cwd as the workspace and passes the result through", async () => {
    const { server, calls } = makeBridge(GATE_ON, {
      results: {
        "workflows/list": {
          workflows: [{ name: "deploy", scope: "project" }],
          invalid: [{ path: "/d/bad.md", reason: "parse" }],
          dir: "/tmp/wf-proj/.zcode/workflows",
        },
      },
    });
    const port = await serveSettings(server);

    const body = (await (await get(port, "workflows?scope=project")).json()) as Record<
      string,
      unknown
    >;
    expect(body.ok).toBe(true);
    expect(body.workflows).toEqual([{ name: "deploy", scope: "project" }]);
    expect(body.invalid).toEqual([{ path: "/d/bad.md", reason: "parse" }]);
    expect(body.dir).toBe("/tmp/wf-proj/.zcode/workflows");

    const call = calls.find((c) => c.method === "workflows/list")!;
    expect(call.params).toMatchObject({
      workspace: { workspacePath: server.projectCwd(), workspaceKey: server.projectCwd() },
      scope: "project",
    });
  });

  it("runs listing clamps the limit into the 1..50 window (default 20)", async () => {
    const { server, calls } = makeBridge(GATE_ON, { results: { "workflows/runs": { runs: [] } } });
    const port = await serveSettings(server);

    await get(port, "workflows/runs?name=deploy&limit=500");
    expect(calls.find((c) => c.method === "workflows/runs")!.params).toMatchObject({
      name: "deploy",
      limit: 50,
    });

    await get(port, "workflows/runs");
    expect(calls.filter((c) => c.method === "workflows/runs").at(-1)!.params).toMatchObject({
      limit: 20,
    });
  });

  it("rejects an unknown scope with 400", async () => {
    const { server } = makeBridge(GATE_ON);
    const port = await serveSettings(server);
    const res = await get(port, "workflows?scope=team");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
  });

  it("a not-found get folds the backend's ok:false result into a 404", async () => {
    const { server } = makeBridge(GATE_ON, {
      results: { "workflows/get": { ok: false, reason: "not_found" } },
    });
    const port = await serveSettings(server);
    const res = await get(port, "workflows/project/ghost");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });
});

describe("workflow settings — run queries", () => {
  it("workflow-runs resolves the acp sid, forwards the limit, passes Summary rows through", async () => {
    const { server, calls } = makeBridge(GATE_ON, {
      results: {
        "v4/conversation/workflowRuns": {
          runs: [{ runId: "r1", status: "stopped", resumable: true }],
        },
      },
    });
    provideSession(server);
    const port = await serveSettings(server);

    const body = (await (await get(port, "workflow-runs?sessionId=sess_app")).json()) as {
      runs: Array<{ resumable: boolean }>;
    };
    expect(body.runs[0]!.resumable).toBe(true);
    expect(calls.find((c) => c.method === "v4/conversation/workflowRuns")!.params).toEqual({
      sessionId: "sess_zcode_app",
      limit: 64,
    });
  });

  it("run events forward afterSequence under the backend session id", async () => {
    const { server, calls } = makeBridge(GATE_ON, {
      results: { "v4/conversation/workflowRunEvents": { events: [], hasMore: false } },
    });
    provideSession(server);
    const port = await serveSettings(server);

    const res = await get(port, "workflow-runs/run-1/events?sessionId=sess_app&afterSequence=42");
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.method === "v4/conversation/workflowRunEvents")!.params).toEqual({
      sessionId: "sess_zcode_app",
      runId: "run-1",
      afterSequence: 42,
    });
  });

  it("artifact data and node result routes forward their parameter shapes", async () => {
    const { server, calls } = makeBridge(GATE_ON, {
      results: {
        "v4/conversation/workflowRunArtifactData": { items: [], hasMore: false },
        "v4/conversation/workflowRunNodeResult": { status: "ok" },
      },
    });
    provideSession(server);
    const port = await serveSettings(server);

    expect(
      (
        await get(
          port,
          "workflow-runs/run-1/artifacts/a1/data?sessionId=sess_app&afterSequence=3&limit=10",
        )
      ).status,
    ).toBe(200);
    expect(
      calls.find((c) => c.method === "v4/conversation/workflowRunArtifactData")!.params,
    ).toEqual({
      sessionId: "sess_zcode_app",
      runId: "run-1",
      artifactId: "a1",
      afterSequence: 3,
      limit: 10,
    });

    expect((await get(port, "workflow-runs/run-1/nodes/site-2/3?sessionId=sess_app")).status).toBe(
      200,
    );
    expect(calls.find((c) => c.method === "v4/conversation/workflowRunNodeResult")!.params).toEqual(
      {
        sessionId: "sess_zcode_app",
        runId: "run-1",
        siteId: "site-2",
        ordinal: 3,
      },
    );
  });

  it("an unknown acp session id answers 404 with a clear message", async () => {
    const { server } = makeBridge(GATE_ON);
    const port = await serveSettings(server);
    const res = await get(port, "workflow-runs?sessionId=ghost");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("unknown_session");
    expect(body.message).toMatch(/not known to this bridge/u);
  });

  it("a missing sessionId on a run query answers 400", async () => {
    const { server } = makeBridge(GATE_ON);
    const port = await serveSettings(server);
    expect((await get(port, "workflow-runs")).status).toBe(400);
    expect((await get(port, "workflow-runs/run-1/events")).status).toBe(400);
  });

  it("non-numeric limit/afterSequence query params answer 400 (not the route 500)", async () => {
    const { server } = makeBridge(GATE_ON);
    provideSession(server);
    const port = await serveSettings(server);

    for (const sub of [
      "workflows/runs?limit=abc",
      "workflow-runs?sessionId=sess_app&limit=abc",
      "workflow-runs/run-1/events?sessionId=sess_app&afterSequence=abc",
      "workflow-runs/run-1/artifacts/a1/data?sessionId=sess_app&afterSequence=soon",
    ]) {
      const res = await get(port, sub);
      expect(res.status, sub).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_query");
    }
  });

  it("negative afterSequence answers 400", async () => {
    const { server } = makeBridge(GATE_ON);
    provideSession(server);
    const port = await serveSettings(server);
    const res = await get(port, "workflow-runs/run-1/events?sessionId=sess_app&afterSequence=-1");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_query");
  });

  it("artifact read clamps the chunk limit to the upstream 512KiB cap", async () => {
    const { server, calls } = makeBridge(GATE_ON, {
      results: { "v4/conversation/workflowRunArtifactRead": { dataBase64: "", totalBytes: 0 } },
    });
    provideSession(server);
    const port = await serveSettings(server);
    const res = await get(
      port,
      "workflow-runs/run-1/artifacts/a1/read?sessionId=sess_app&version=1&offset=0&limit=999999",
    );
    expect(res.status).toBe(200);
    expect(
      calls.find((c) => c.method === "v4/conversation/workflowRunArtifactRead")!.params,
    ).toMatchObject({ limit: 512 * 1024 });
  });
});

describe("workflow settings — start protocol", () => {
  it("start without sessionId creates a visible session and returns the ack ids", async () => {
    const { server, calls } = makeBridge(GATE_ON);
    const port = await serveSettings(server);

    const res = await send(port, "POST", "workflows/project/deploy/start", {
      args: { env: "staging" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      acpSessionId: string;
      runId: string;
      toolCallId: string;
    };
    expect(body.runId).toBe("r1");
    expect(body.toolCallId).toBe("launch-1");

    // The created session is registered: the acp↔backend mapping resolves
    // and discovery advertises it (the App can list, load and resume it).
    expect(body.acpSessionId).toEqual(expect.any(String));
    expect(server.resolveSid(body.acpSessionId)).toBe("sess_zcode_1");
    expect(server.remoteCreatedSessions.has(body.acpSessionId)).toBe(true);

    // The create ran through the bridge's registration path and carried the
    // dynamic-workflow flag (gate enabled).
    expect(calls.find((c) => c.method === "session/create")!.params).toMatchObject({
      dynamicWorkflowEnabled: true,
    });

    // The v4/command envelope matches the launch protocol.
    expect(calls.find((c) => c.method === "v4/command")!.params).toMatchObject({
      commandId: expect.any(String),
      clientId: "zcode-acp-server",
      sessionId: "sess_zcode_1",
      type: "startSavedWorkflow",
      payload: { name: "deploy", scope: "project", args: { env: "staging" } },
      issuedAt: expect.any(Number),
    });
  });

  it("start rejected session_busy on an APP-provided session answers 409 and never closes it", async () => {
    const { server, calls } = makeBridge(GATE_ON, {
      ack: {
        status: "rejected",
        reasonCode: "fault.command.savedWorkflowStartRejected.session_busy",
        message: "A prompt is already running for this session",
      },
    });
    provideSession(server);
    const port = await serveSettings(server);

    const res = await send(port, "POST", "workflows/project/deploy/start", {
      sessionId: "sess_app",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("session_busy");
    expect(body.message).toBe("A prompt is already running for this session");
    // The provided session was reused as-is: no create, and NO cleanup close.
    expect(calls.some((c) => c.method === "session/create")).toBe(false);
    expect(calls.some((c) => c.method === "session/close")).toBe(false);
  });

  it("start rejected compile_failed on a bridge-created session closes that session", async () => {
    const { server, calls } = makeBridge(GATE_ON, {
      ack: {
        status: "rejected",
        reasonCode: "fault.command.savedWorkflowStartRejected.compile_failed",
        message: "syntax error at line 3",
      },
    });
    const port = await serveSettings(server);

    const res = await send(port, "POST", "workflows/global/deploy/start", {});
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("compile_failed");
    expect(body.message).toMatch(/syntax error at line 3/u);

    // The session WE created was closed and its registrations dropped.
    expect(calls.find((c) => c.method === "session/close")?.params).toMatchObject({
      sessionId: "sess_zcode_1",
    });
    expect(server.remoteCreatedSessions.size).toBe(0);
    expect([...server.sessionMap.values()]).not.toContain("sess_zcode_1");
    expect(server.pendingSessions.size).toBe(0);
  });

  it("start rejected capabilityUnsupported answers 501", async () => {
    const { server } = makeBridge(GATE_ON, {
      ack: { status: "failed", reasonCode: "fault.command.capabilityUnsupported" },
    });
    const port = await serveSettings(server);
    const res = await send(port, "POST", "workflows/project/deploy/start", {});
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toBe("capabilityUnsupported");
  });

  it("start with a non-object args body answers 400", async () => {
    const { server, calls } = makeBridge(GATE_ON);
    const port = await serveSettings(server);
    const res = await send(port, "POST", "workflows/project/deploy/start", { args: "staging" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    // Refused before creating anything.
    expect(calls.some((c) => c.method === "session/create")).toBe(false);
  });

  it("start whose v4/command ERRORS (timeout shape) → 502 and the created session is discarded", async () => {
    const { server, calls } = makeBridge(GATE_ON, { commandError: { message: "timeout" } });
    const port = await serveSettings(server);

    const res = await send(port, "POST", "workflows/project/deploy/start", {});
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("command_failed");
    expect(body.message).toMatch(/timeout/u);

    // The ack-path cleanup also covers the THROW path: the bridge-created
    // session was closed and every registration dropped (no phantom alias
    // for the App to attach to, no double-run surface on retry).
    expect(calls.find((c) => c.method === "session/close")?.params).toMatchObject({
      sessionId: "sess_zcode_1",
    });
    expect(server.remoteCreatedSessions.size).toBe(0);
    expect([...server.sessionMap.values()]).not.toContain("sess_zcode_1");
    expect(server.pendingSessions.size).toBe(0);
  });
});

describe("workflow settings — resume", () => {
  it("resume accepted answers 200 and sends the resume envelope", async () => {
    const { server, calls } = makeBridge(GATE_ON, { ack: { status: "accepted" } });
    provideSession(server);
    const port = await serveSettings(server);

    const res = await send(port, "POST", "workflow-runs/run-9/resume", {
      sessionId: "sess_app",
      name: "deploy",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(calls.find((c) => c.method === "v4/command")!.params).toMatchObject({
      type: "resumeWorkflowRun",
      sessionId: "sess_zcode_app",
      payload: { workId: "run-9", name: "deploy" },
    });
  });

  it("resume not_resumable answers 409", async () => {
    const { server } = makeBridge(GATE_ON, {
      ack: {
        status: "rejected",
        reasonCode: "fault.command.workflowRunResumeRejected.not_resumable",
        message: "run completed successfully",
      },
    });
    provideSession(server);
    const port = await serveSettings(server);

    const res = await send(port, "POST", "workflow-runs/run-9/resume", { sessionId: "sess_app" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_resumable");
  });

  it("resume without a sessionId answers 400", async () => {
    const { server } = makeBridge(GATE_ON);
    const port = await serveSettings(server);
    const res = await send(port, "POST", "workflow-runs/run-9/resume", {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });
});

describe("workflow settings — create prompt", () => {
  it("returns the frozen desktop text (stable, non-empty, scope-aware)", async () => {
    const { server } = makeBridge(GATE_ON);
    const port = await serveSettings(server);

    const body = (await (await get(port, "workflow-create-prompt")).json()) as { prompt: string };
    expect(body.prompt).toBe(
      "Help me design a workflow and save it to this project once it works: ",
    );
    // Frozen constant: two reads answer the same bytes.
    const again = (await (await get(port, "workflow-create-prompt")).json()) as { prompt: string };
    expect(again.prompt).toBe(body.prompt);

    const global = (await (await get(port, "workflow-create-prompt?scope=global")).json()) as {
      prompt: string;
    };
    expect(global.prompt).toBe(
      'Help me design a workflow and save it as a global workflow (scope: "global") with SaveWorkflow once it works: ',
    );
  });
});
