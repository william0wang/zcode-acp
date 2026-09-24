/**
 * Dynamic-workflow run progress poller tests.
 *
 * Drives armWorkflowRunPoller against a real ZcodeAcpServer with a FakeBackend
 * (no spawn, no network) and a notify-recording client registered in the
 * server's client registry — the emission path is the production
 * notifyByZcodeSid → per-alias broadcast chain. Fake timers advance the poll
 * chain; the interval is injected so nothing ever waits real seconds.
 *
 * Also covers the BackgroundTaskListener integration: a workflow background
 * task (taskKind "workflow") folds into the visible CreateWorkflow card when
 * one was dispatched, else into the fallback [background] card — the poller
 * arms against whichever card won (the listener is the single arm point),
 * and the fold decision is sticky across dispatchedToolCalls eviction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as acp from "@agentclientprotocol/sdk";

import { BackgroundTaskListener } from "../src/handlers/background-tasks.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import {
  armWorkflowRunPoller,
  stopAllWorkflowRunPollers,
  workflowPollerActive,
  WORKFLOW_POLL_INTERVAL_MS,
} from "../src/workflow/poller.js";
import { ZcodeAcpServer } from "../src/server.js";

// Pin the language: asserted card titles are English.
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});

afterEach(() => {
  stopAllWorkflowRunPollers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const SID_ACP = "sess_wf_acp";
const SID_Z = "sess_wf_zcode";
const INTERVAL = 100;

/** Fake backend: records requests; answers workflowRunEvents from a script. */
class FakeBackend {
  isDead = false;
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  /** Scripted workflowRunEvents responses, popped per call. */
  pages: Array<{ result?: unknown; error?: { code?: number; message: string } }> = [];

  async request(
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: number; result?: unknown; error?: { code?: number; message: string } }> {
    this.calls.push({ method, params });
    if (method === "v4/conversation/workflowRunEvents") {
      const page = this.pages.shift();
      if (page) return { id, ...page };
      return { id, result: { events: [], hasMore: false } };
    }
    return { id, result: {} };
  }
}

function makeServer(): { server: ZcodeAcpServer; backend: FakeBackend; sent: unknown[] } {
  const sent: unknown[] = [];
  const server = new ZcodeAcpServer();
  server.registerSession(SID_ACP, SID_Z);
  server.clients.add({
    notify(method: string, params: { update: unknown }) {
      expect(method).toBe("session/update");
      sent.push(params.update);
      return Promise.resolve();
    },
    request: () => Promise.resolve({}),
  } as unknown as acp.AgentContext);
  const backend = new FakeBackend();
  server.backend = backend as unknown as ZcodeAcpServer["backend"];
  return { server, backend, sent };
}

/** The text body of a tool_call_update emission. */
function cardText(update: unknown): string {
  const u = update as {
    sessionUpdate: string;
    toolCallId: string;
    content: Array<{ type: string; content: { type: string; text: string } }>;
  };
  expect(u.sessionUpdate).toBe("tool_call_update");
  return u.content.map((c) => c.content.text).join("\n");
}

const wfCalls = (backend: FakeBackend) =>
  backend.calls.filter((c) => c.method === "v4/conversation/workflowRunEvents");

describe("workflow run poller", () => {
  it("exports the documented poll interval default", () => {
    expect(WORKFLOW_POLL_INTERVAL_MS).toBe(3000);
  });

  it("polls with an advancing cursor and folds only meaningful events", async () => {
    const { server, backend, sent } = makeServer();
    backend.pages = [
      {
        result: {
          events: [
            { sequence: 1, type: "actor-created", payload: { name: "researcher", ordinal: 1 } },
            { sequence: 2, type: "usage-updated", payload: { spentTokens: 42 } },
          ],
          hasMore: true,
        },
      },
      {
        result: {
          events: [
            {
              sequence: 3,
              type: "actor-created",
              payload: { name: "writer", ordinal: 2, actorSessionId: "sess_dwf-abc123" },
            },
            { sequence: 4, type: "log", payload: { text: "chatty" } },
            {
              sequence: 5,
              type: "node-settled",
              payload: { siteId: "ask", ordinal: 1, outcome: "ok" },
            },
            { sequence: 6, type: "run-settled", payload: { status: "completed" } },
          ],
          hasMore: false,
        },
      },
    ];

    armWorkflowRunPoller(server, SID_Z, {
      runId: "run_cursor",
      toolCallId: "call_wf",
      intervalMs: INTERVAL,
    });
    await vi.advanceTimersByTimeAsync(INTERVAL);

    // Cursor advanced across the drained pages; page 2 starts after seq 2.
    const calls = wfCalls(backend);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.params).toEqual({
      sessionId: SID_Z,
      runId: "run_cursor",
      afterSequence: 0,
      limit: 100,
    });
    expect(calls[1]!.params).toMatchObject({ afterSequence: 2 });

    // One card update carrying the accumulated lines; chatty events skipped;
    // no raw child-session ids.
    expect(sent).toHaveLength(1);
    const text = cardText(sent[0]);
    expect(text).toContain("researcher");
    expect(text).toContain("writer");
    expect(text).toContain("node");
    expect(text).toContain("run settled: completed");
    expect(text).not.toContain("usage");
    expect(text).not.toContain("chatty");
    expect(text).not.toContain("sess_dwf-abc123");

    // Settled → no further polls.
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(wfCalls(backend)).toHaveLength(2);
    expect(workflowPollerActive("run_cursor")).toBe(false);
  });

  it("re-arm is single-flight per runId", async () => {
    const { server, backend } = makeServer();
    backend.pages = [{ result: { events: [], hasMore: false } }];

    armWorkflowRunPoller(server, SID_Z, {
      runId: "run_dup",
      toolCallId: "c1",
      intervalMs: INTERVAL,
    });
    armWorkflowRunPoller(server, SID_Z, {
      runId: "run_dup",
      toolCallId: "c2",
      intervalMs: INTERVAL,
    });
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);

    // One chain only: EXACTLY three polls for three intervals — a dead arm
    // (0 polls) or a second chain (6 polls) both fail this.
    expect(wfCalls(backend).length).toBe(3);
    expect(wfCalls(backend).every((c) => c.params?.toolCallId === undefined)).toBe(true);
  });

  it("emits append DELTAS — the second emission carries only the new lines", async () => {
    const { server, backend, sent } = makeServer();
    backend.pages = [
      {
        result: {
          events: [{ sequence: 1, type: "actor-created", payload: { name: "alpha", ordinal: 1 } }],
          hasMore: false,
        },
      },
      {
        result: {
          events: [{ sequence: 2, type: "actor-created", payload: { name: "beta", ordinal: 2 } }],
          hasMore: false,
        },
      },
    ];

    armWorkflowRunPoller(server, SID_Z, {
      runId: "run_delta",
      toolCallId: "c",
      intervalMs: INTERVAL,
    });
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await vi.advanceTimersByTimeAsync(INTERVAL);

    // Two ticks with one event each → two emissions, each ONLY its own lines
    // (full-body re-sends would quadratically duplicate card content on
    // append-semantics clients).
    expect(sent).toHaveLength(2);
    expect(cardText(sent[0])).toContain("alpha");
    expect(cardText(sent[0])).not.toContain("beta");
    expect(cardText(sent[1])).toContain("beta");
    expect(cardText(sent[1])).not.toContain("alpha");
  });

  it("stops silently on -32601 (old backend)", async () => {
    const { server, backend, sent } = makeServer();
    backend.pages = [{ error: { code: -32601, message: "method not found" } }];

    armWorkflowRunPoller(server, SID_Z, {
      runId: "run_old",
      toolCallId: "c",
      intervalMs: INTERVAL,
    });
    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(wfCalls(backend)).toHaveLength(1);
    expect(sent).toHaveLength(0); // no notice, no lines — silent stop
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(wfCalls(backend)).toHaveLength(1);
    expect(workflowPollerActive("run_old")).toBe(false);
  });

  it("stops with a card notice after 5 consecutive errors (timeouts are transient)", async () => {
    const { server, backend, sent } = makeServer();
    backend.pages = Array.from({ length: 10 }, () => ({ error: { message: "timeout" } }));

    armWorkflowRunPoller(server, SID_Z, {
      runId: "run_err",
      toolCallId: "c",
      intervalMs: INTERVAL,
    });
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);

    expect(wfCalls(backend)).toHaveLength(5);
    expect(sent).toHaveLength(1);
    expect(cardText(sent[0])).toContain("repeated errors");

    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(wfCalls(backend)).toHaveLength(5);
    expect(workflowPollerActive("run_err")).toBe(false);
  });

  it("a successful poll resets the error streak", async () => {
    const { server, backend } = makeServer();
    // error, error, success(empty), error, error, error — never 5 in a row.
    backend.pages = [
      { error: { message: "timeout" } },
      { error: { message: "timeout" } },
      { result: { events: [], hasMore: false } },
      { error: { message: "timeout" } },
      { error: { message: "timeout" } },
      { error: { message: "timeout" } },
      { error: { message: "timeout" } },
      { error: { message: "timeout" } },
    ];

    armWorkflowRunPoller(server, SID_Z, {
      runId: "run_mix",
      toolCallId: "c",
      intervalMs: INTERVAL,
    });
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    // Still polling: the success at tick 3 reset the streak, so 5 ticks with
    // at most 2+3 consecutive errors must not have stopped anything.
    expect(workflowPollerActive("run_mix")).toBe(true);
    expect(wfCalls(backend).length).toBe(5);
  });
});

describe("BackgroundTaskListener workflow integration", () => {
  function zcodeEvent(type: string, payload: Record<string, unknown>): ZcodeEvent {
    return { sessionId: SID_Z, seq: 0, type: type as ZcodeEvent["type"], payload };
  }

  it("workflow task with a VISIBLE card → no [background] card, poller armed", async () => {
    const { server, sent } = makeServer();
    server.noteDispatchedToolCall("call_wf", "call_wf");
    const l = new BackgroundTaskListener(server, SID_Z);

    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "run_visible",
        toolCallId: "call_wf",
        taskKind: "workflow",
        status: "running",
        description: "release workflow",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(workflowPollerActive("run_visible")).toBe(true);
    expect(sent).toHaveLength(0); // no tool_call card, no status update
  });

  it("workflow task with an UNSEEN toolCallId → bg card minted AND poller armed against it", async () => {
    const { server, backend, sent } = makeServer();
    backend.pages = [
      {
        result: {
          events: [{ sequence: 1, type: "phase-entered", payload: { phaseName: "plan" } }],
          hasMore: false,
        },
      },
    ];
    const l = new BackgroundTaskListener(server, SID_Z);

    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "run_unseen",
        toolCallId: "call_never_dispatched",
        taskKind: "workflow",
        status: "running",
        description: "orphan run",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    // The fallback [background] card exists…
    expect(sent).toHaveLength(1);
    const card = sent[0] as { sessionUpdate: string; title: string; toolCallId: string };
    expect(card.sessionUpdate).toBe("tool_call");
    expect(card.title).toBe("[background] orphan run");
    // …and the poller is armed against the BG CARD's own id — settings-launched
    // runs dispatch no live tool event, so this card is their progress surface.
    expect(workflowPollerActive("run_unseen")).toBe(true);
    // The listener-side arm uses the production default interval (3000ms).
    await vi.advanceTimersByTimeAsync(WORKFLOW_POLL_INTERVAL_MS);
    expect(sent).toHaveLength(2);
    const update = sent[1] as { sessionUpdate: string; toolCallId: string };
    expect(update.sessionUpdate).toBe("tool_call_update");
    expect(update.toolCallId).toBe(card.toolCallId);
    expect(cardText(sent[1])).toContain("phase plan");
  });

  it("workflow task without toolCallId → background card kept, poller armed on it", async () => {
    const { server, sent } = makeServer();
    const l = new BackgroundTaskListener(server, SID_Z);
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "run_notool",
        taskKind: "workflow",
        status: "running",
        description: "bare run",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(workflowPollerActive("run_notool")).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("suppression is STICKY: registry eviction mid-run never mints a second card", async () => {
    const { server, sent } = makeServer();
    server.noteDispatchedToolCall("call_sticky", "call_sticky");
    const l = new BackgroundTaskListener(server, SID_Z);

    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "run_sticky",
        toolCallId: "call_sticky",
        taskKind: "workflow",
        status: "running",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(workflowPollerActive("run_sticky")).toBe(true);
    expect(sent).toHaveLength(0);

    // The dispatchedToolCalls registry is a bounded FIFO — the entry ages out
    // (>2048 distinct calls) while the run is still going.
    server.dispatchedToolCalls.delete("call_sticky");

    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "run_sticky",
        toolCallId: "call_sticky",
        taskKind: "workflow",
        status: "running",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Decision was made at first sight: no [background] card beside the tool
    // card, no status updates onto it, the fold simply persists.
    expect(sent).toHaveLength(0);
    expect(workflowPollerActive("run_sticky")).toBe(true);
  });

  it("non-workflow task → background card as before", async () => {
    const { server, sent } = makeServer();
    const l = new BackgroundTaskListener(server, SID_Z);
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "agent_1",
        status: "running",
        description: "research src/",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    const card = sent[0] as { sessionUpdate: string; title: string };
    expect(card.sessionUpdate).toBe("tool_call");
    expect(card.title).toBe("[background] research src/");
  });

  it("terminal workflow task status stops the poller", async () => {
    const { server } = makeServer();
    server.noteDispatchedToolCall("call_t", "call_t");
    const l = new BackgroundTaskListener(server, SID_Z);

    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "run_term",
        toolCallId: "call_t",
        taskKind: "workflow",
        status: "running",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(workflowPollerActive("run_term")).toBe(true);

    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "run_term",
        toolCallId: "call_t",
        taskKind: "workflow",
        status: "completed",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(workflowPollerActive("run_term")).toBe(false);
  });
});
