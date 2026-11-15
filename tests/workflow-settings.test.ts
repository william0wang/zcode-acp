/**
 * Dynamic-workflow Settings API tests (plan §7) — the management plane.
 *
 * Two layers:
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
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

  it("a 403 body carries the verdict's mode and source (pulled vs broken fetch)", async () => {
    const { server } = makeBridge(GATE_OFF);
    const port = await serveSettings(server);
    const res = await get(port, "workflows");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("workflow_disabled");
    expect(body.message).toBe("gate mode=disabled source=remote");
  });
});

describe("workflow settings — gate switch (PUT /settings/workflow-gate)", () => {
  /** The per-test temp home's user config path (HOME is stubbed per test). */
  function configPath(): string {
    return path.join(home, ".config", "zcode-acp", "config.json");
  }

  it("PUT alwaysOn persists workflow.mode and answers the override verdict", async () => {
    const { server } = makeBridge(GATE_OFF); // pinned remote says disabled…
    const port = await serveSettings(server);

    const res = await send(port, "PUT", "workflow-gate", { mode: "alwaysOn" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      gate: { enabled: true, mode: "alwaysOn", source: "override", override: "alwaysOn" },
    });
    const saved = JSON.parse(await readFile(configPath(), "utf8")) as {
      workflow?: { mode?: string };
    };
    expect(saved.workflow?.mode).toBe("alwaysOn");

    // …and the override now wins live: the same GATE_OFF bridge serves the
    // workflow surface, and the policy push reaches the backend process.
    const list = await get(port, "workflows");
    expect(list.status).toBe(200);
  });

  it("a local override on a disabled gate also fires the per-generation policy push", async () => {
    const { server, calls } = makeBridge(GATE_OFF, {
      results: { "workflows/list": { workflows: [], invalid: [], dir: "/d" } },
    });
    const port = await serveSettings(server);
    await send(port, "PUT", "workflow-gate", { mode: "alwaysOn" });
    await get(port, "workflows");
    expect(calls.find((c) => c.method === "workspace/updateDynamicWorkflowPolicy")).toBeTruthy();
  });

  it("PUT auto deletes the key — the gate falls back to the pinned remote verdict", async () => {
    const { server } = makeBridge(GATE_OFF);
    const port = await serveSettings(server);
    await send(port, "PUT", "workflow-gate", { mode: "alwaysOn" });

    const res = await send(port, "PUT", "workflow-gate", { mode: "auto" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      gate: { enabled: false, mode: "disabled", source: "remote" },
    });
    const saved = JSON.parse(await readFile(configPath(), "utf8")) as Record<string, unknown>;
    expect(saved.workflow).toBeUndefined();

    const list = await get(port, "workflows");
    expect(list.status).toBe(403);
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
});

describe("workflow settings — run settings amendment", () => {
  it("`null` is a real value (clears), not an omission — three-state on the wire", async () => {
    const { server, calls } = makeBridge(GATE_ON, {
      ack: {
        status: "accepted",
        result: { type: "amendWorkflowRunSettings", runId: "run-9", toolCallId: "settings-3" },
      },
    });
    provideSession(server);
    const port = await serveSettings(server);

    const res = await send(port, "POST", "workflow-runs/run-9/settings?sessionId=sess_app", {
      subagentModel: null,
      maxConcurrency: null,
    });
    expect(res.status).toBe(200);
    const command = calls.find((c) => c.method === "v4/command")!;
    expect(command.params).toMatchObject({
      payload: { workId: "run-9", subagentModel: null, maxConcurrency: null },
    });
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

// ---------- run dismissal (bridge-side hide list) ----------

describe("workflow settings — run dismissal", () => {
  // Factories, not shared constants: stripDismissedRuns mutates the canned
  // result in place, and a shared object would leak one test's strip into
  // the next test's canned data.
  const journalRuns = () => ({
    runs: [
      { runId: "r-done", parentSessionId: "sess_zcode_app", status: "completed" },
      { runId: "r-live", parentSessionId: "sess_zcode_app", status: "running" },
    ],
  });
  const convRuns = () => ({
    runs: [
      { runId: "r-done", status: "completed" },
      { runId: "r-fail", status: "failed" },
      { runId: "r-live", status: "running" },
    ],
  });

  it("dismisses a settled run and hides it from both list paths", async () => {
    const { server } = makeBridge(GATE_ON, {
      results: {
        "workflows/runs": journalRuns(),
        "v4/conversation/workflowRuns": convRuns(),
      },
    });
    provideSession(server);
    const port = await serveSettings(server);

    const res = await send(port, "POST", "workflow-runs/r-done/dismiss");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, dismissed: true });

    const journal = (await (await get(port, "workflows/runs")).json()) as {
      runs: Array<{ runId: string }>;
    };
    expect(journal.runs.map((r) => r.runId)).toEqual(["r-live"]);

    const conv = (await (await get(port, "workflow-runs?sessionId=sess_app")).json()) as {
      runs: Array<{ runId: string }>;
    };
    expect(conv.runs.map((r) => r.runId)).toEqual(["r-fail", "r-live"]);
  });

  it("refuses to dismiss a flying run with 409 run_active", async () => {
    const { server } = makeBridge(GATE_ON, {
      results: { "workflows/runs": journalRuns() },
    });
    const port = await serveSettings(server);

    const res = await send(port, "POST", "workflow-runs/r-live/dismiss");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "run_active" });
    // Nothing was recorded — the row still lists.
    const journal = (await (await get(port, "workflows/runs")).json()) as {
      runs: Array<{ runId: string }>;
    };
    expect(journal.runs.map((r) => r.runId)).toContain("r-live");
  });
});
