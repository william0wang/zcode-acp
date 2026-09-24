/**
 * /workflow and /workflows slash three-state tests (dynamic-workflow gate).
 *
 * - gate disabled or unresolved → BOTH commands intercept with the
 *   workflowDisabled notice (fail-closed; raw text never reaches the model)
 * - gate enabled → /workflow PASSES THROUGH (backend's builtin prompt
 *   expansion owns it) and /workflows renders a local listing from the
 *   backend's session-less workflows/list + workflows/runs RPCs (zero model
 *   turns)
 * - the advertised `/` menu filter (filterWorkflowCommands) drops the two
 *   workflow commands unless the settled gate is enabled
 *
 * Pattern: tests/goal-slash.test.ts — real ZcodeAcpServer, notify-recording
 * AgentContext, FakeBackend assigned to server.backend, handleSlashCommand
 * called directly.
 */

import { describe, expect, it, vi } from "vitest";

import type * as acp from "@agentclientprotocol/sdk";

import { captureGate, filterWorkflowCommands } from "../src/config/workflow-gate.js";
import { messages } from "../src/i18n.js";
import { handleSlashCommand } from "../src/handlers/slash.js";
import { SLASH_COMMANDS } from "../src/utils.js";
import { ZcodeAcpServer } from "../src/server.js";

// Pin the language: asserted feedback text is compared against messages(),
// which stays deterministic under the pinned env.
vi.stubEnv("ZCODE_ACP_LANG", "en");

const SID = "sess_wf";
const CWD = "/proj/workflow-test";

/** Mock AgentContext that records notify calls (feedback chunks land here). */
function mockContext(): { cx: acp.AgentContext; sent: unknown[] } {
  const sent: unknown[] = [];
  const cx = {
    notify(_method: string, params: { update: unknown }) {
      sent.push(params.update);
      return Promise.resolve();
    },
  } as unknown as acp.AgentContext;
  return { cx, sent };
}

/** Fake backend: records every request; answers the workflows/* RPCs. */
class FakeBackend {
  isDead = false;
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  async request(
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: number; result?: unknown; error?: unknown }> {
    this.calls.push({ method, params });
    if (method === "workflows/list") {
      return {
        id,
        result: {
          workflows: [
            {
              name: "deploy",
              description: "Deploy the service",
              scope: "project",
              path: "/proj/.zcode/workflows/deploy.dwf.md",
            },
            { name: "daily-report", description: "", scope: "global", path: "/g/daily.dwf.md" },
          ],
          invalid: [{ path: "/proj/.zcode/workflows/broken.dwf.md", reason: "parse" }],
          dir: "/proj/.zcode/workflows",
        },
      };
    }
    if (method === "workflows/runs") {
      return {
        id,
        result: {
          runs: [
            {
              runId: "run_1",
              name: "deploy",
              status: "completed",
              createdAt: 1750000000000,
              updatedAt: 1750000123000,
              spentTokens: 1234,
              parentSessionId: "sess_parent_abcd1234",
            },
            {
              runId: "run_2",
              status: "errored",
              createdAt: 1750000000000,
              updatedAt: 1750000200000,
              spentTokens: 0,
            },
          ],
          truncated: true,
        },
      };
    }
    return { id, result: {} };
  }
}

function makeServer(backend?: FakeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.sessionCwds.set(SID, CWD);
  if (backend) server.backend = backend as unknown as ZcodeAcpServer["backend"];
  return server;
}

/**
 * Enable the gate the way production does (ensureBackend assigns a promise
 * wrapped in captureGate), then settle it. The FIRST workflowGateNow read
 * after settlement must already see the verdict — no priming, no microtask
 * flushes.
 */
async function enableGate(server: ZcodeAcpServer): Promise<void> {
  const gate = captureGate(
    Promise.resolve({
      mode: "alwaysOn",
      enabled: true,
      source: "remote",
    }),
  );
  server.backendWorkflowGate = gate;
  await gate;
}

describe("/workflow (gate three-state)", () => {
  it("gate unresolved (null) → intercepted with workflowDisabled, no passthrough", async () => {
    const { cx, sent } = mockContext();
    const server = makeServer();
    const result = await handleSlashCommand(server, cx, SID, SID, "/workflow build the release");
    expect(result?.stopReason).toBe("end_turn");
    expect(sent).toHaveLength(1);
    const chunk = sent[0] as { sessionUpdate: string; content: { text: string } };
    expect(chunk.sessionUpdate).toBe("agent_message_chunk");
    expect(chunk.content.text).toBe(messages().workflowDisabled);
  });

  it("gate disabled → same interception", async () => {
    const { cx, sent } = mockContext();
    const server = makeServer();
    const gate = captureGate(
      Promise.resolve({
        mode: "disabled",
        enabled: false,
        source: "remote",
      }),
    );
    server.backendWorkflowGate = gate;
    await gate; // settled disabled — the interception comes from the VERDICT
    const result = await handleSlashCommand(server, cx, SID, SID, "/workflow anything");
    expect(result?.stopReason).toBe("end_turn");
    expect((sent[0] as { content: { text: string } }).content.text).toBe(
      messages().workflowDisabled,
    );
  });

  it("gate enabled → passthrough (null; backend expands it, not the bridge)", async () => {
    const { cx, sent } = mockContext();
    const server = makeServer();
    await enableGate(server);
    const result = await handleSlashCommand(server, cx, SID, SID, "/workflow build the release");
    expect(result).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

describe("/workflows (local listing)", () => {
  it("gate enabled → renders saved workflows + recent runs, zero model turns", async () => {
    const { cx, sent } = mockContext();
    const backend = new FakeBackend();
    const server = makeServer(backend);
    await enableGate(server);

    const result = await handleSlashCommand(server, cx, SID, SID, "/workflows");

    expect(result?.stopReason).toBe("end_turn");
    expect(sent).toHaveLength(1);
    const chunk = sent[0] as { sessionUpdate: string; content: { text: string } };
    expect(chunk.sessionUpdate).toBe("agent_message_chunk");
    const text = chunk.content.text;
    expect(text).toContain("deploy");
    expect(text).toContain("Deploy the service");
    expect(text).toContain("(invalid: 1)");
    expect(text).toContain("completed");
    // Parent session hint: short suffix, never the full id.
    expect(text).toContain("…abcd1234");
    expect(text).not.toContain("sess_parent_abcd1234");

    // Session-less RPCs against the session's cwd; no model turn was started.
    const list = backend.calls.find((c) => c.method === "workflows/list");
    expect(list?.params).toEqual({ workspace: { workspacePath: CWD, workspaceKey: CWD } });
    const runs = backend.calls.find((c) => c.method === "workflows/runs");
    expect(runs?.params).toEqual({
      workspace: { workspacePath: CWD, workspaceKey: CWD },
      limit: 10,
    });
    expect(backend.calls.some((c) => c.method === "session/send")).toBe(false);
  });

  it("gate enabled, runs failure → list still rendered with the error note", async () => {
    const { cx, sent } = mockContext();
    const backend = new FakeBackend();
    backend.request = async (id, method, params) => {
      backend.calls.push({ method, params });
      if (method === "workflows/runs") {
        return { id, error: { code: -32000, message: "journal unavailable" } };
      }
      if (method === "workflows/list") {
        return {
          id,
          result: {
            workflows: [{ name: "solo", description: "Only one", scope: "project", path: "/p" }],
            invalid: [],
            dir: "/p",
          },
        };
      }
      return { id, result: {} };
    };
    const server = makeServer(backend);
    await enableGate(server);

    const result = await handleSlashCommand(server, cx, SID, SID, "/workflows");
    expect(result?.stopReason).toBe("end_turn");
    const text = (sent[0] as { content: { text: string } }).content.text;
    expect(text).toContain("solo");
    expect(text).toContain("journal unavailable");
  });

  it("gate disabled → intercepted with workflowDisabled", async () => {
    const { cx, sent } = mockContext();
    const server = makeServer();
    const gate = captureGate(
      Promise.resolve({
        mode: "disabled",
        enabled: false,
        source: "remote",
      }),
    );
    server.backendWorkflowGate = gate;
    await gate; // settled disabled — the interception comes from the VERDICT
    const result = await handleSlashCommand(server, cx, SID, SID, "/workflows");
    expect(result?.stopReason).toBe("end_turn");
    expect((sent[0] as { content: { text: string } }).content.text).toBe(
      messages().workflowDisabled,
    );
  });
});

describe("advertised command menu filter", () => {
  it("gate unresolved → both workflow commands dropped, others kept", () => {
    const server = makeServer();
    const names = filterWorkflowCommands(server, SLASH_COMMANDS).map((c) => c.name);
    expect(names).not.toContain("workflow");
    expect(names).not.toContain("workflows");
    expect(names).toContain("compact");
    expect(names).toContain("mcp");
  });

  it("gate SETTLED DISABLED → both dropped (read from the verdict, not a null cache)", async () => {
    const server = makeServer();
    const gate = captureGate(
      Promise.resolve({
        mode: "disabled",
        enabled: false,
        source: "remote",
      }),
    );
    server.backendWorkflowGate = gate;
    await gate; // settled: the filter must consult the disabled VERDICT
    const names = filterWorkflowCommands(server, SLASH_COMMANDS).map((c) => c.name);
    expect(names).not.toContain("workflow");
    expect(names).not.toContain("workflows");
    expect(names).toContain("compact");
  });

  it("gate enabled → both advertised", async () => {
    const server = makeServer();
    await enableGate(server);
    const names = filterWorkflowCommands(server, SLASH_COMMANDS).map((c) => c.name);
    expect(names).toContain("workflow");
    expect(names).toContain("workflows");
  });

  it("pending (never-settling) gate → dropped even though the promise exists (fail-closed)", async () => {
    const server = makeServer();
    server.backendWorkflowGate = new Promise(() => undefined); // never settles
    const names = filterWorkflowCommands(server, SLASH_COMMANDS).map((c) => c.name);
    expect(names).not.toContain("workflow");
    expect(names).not.toContain("workflows");
  });
});
