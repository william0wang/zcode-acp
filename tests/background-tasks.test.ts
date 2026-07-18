/**
 * BackgroundTaskListener unit tests.
 *
 * Drives handleEvent() with synthetic zcode events (the shapes captured by the
 * real app-server probe — see docs/PROTOCOL.md "Background Tasks") and asserts
 * the session/update notifications it pushes back via the server. No real
 * backend or ACP client — `notifyByZcodeSid` is stubbed to record calls.
 */

import { describe, expect, it } from "vitest";

import { BackgroundTaskListener } from "../src/handlers/background-tasks.js";
import type { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeEvent } from "../src/backend/types.js";

/** A minimal fake server: records every session/update it would send. */
interface FakeServer {
  calls: Array<{ zcodeSid: string; update: Record<string, unknown> }>;
  /** Mirrors ZcodeAcpServer.terminalSentData — set by tests to simulate a
   *  tracked launch card so BackgroundTaskListener reuses it. */
  terminalSentData: Map<string, string>;
}
type TestServer = FakeServer & Pick<ZcodeAcpServer, "notifyByZcodeSid">;

function makeServer(): TestServer {
  const calls: TestServer["calls"] = [];
  const server = {
    calls,
    terminalSentData: new Map<string, string>(),
    async notifyByZcodeSid(zcodeSid: string, update: Record<string, unknown>): Promise<boolean> {
      calls.push({ zcodeSid, update });
      return true;
    },
  };
  return server as TestServer;
}

function zcodeEvent(
  type: string,
  payload: Record<string, unknown>,
  extra: Partial<ZcodeEvent> = {},
): ZcodeEvent {
  return {
    sessionId: "sess_test",
    seq: 0,
    type: type as ZcodeEvent["type"],
    payload,
    ...extra,
  };
}

describe("BackgroundTaskListener", () => {
  it("emits a tool_call card on the first running session.updated(taskId)", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "agent_abc",
        toolCallId: "call_orig",
        status: "running",
        description: "research src/",
        outputPath: "/tmp/out.txt",
        terminalId: "agent_abc",
      }),
    );
    // notifyByZcodeSid is async; flush microtasks.
    await Promise.resolve();
    expect(server.calls).toHaveLength(1);
    const { update, zcodeSid } = server.calls[0]!;
    expect(zcodeSid).toBe("sess_test");
    expect(update["sessionUpdate"]).toBe("tool_call");
    expect(update["title"]).toBe("[background] research src/");
    expect(update["kind"]).toBe("other");
    expect(update["status"]).toBe("in_progress");
    expect(String(update["toolCallId"]).startsWith("bg_")).toBe(true);
    const meta = update["_meta"] as { backgroundTask: Record<string, unknown> };
    expect(meta.backgroundTask.taskId).toBe("agent_abc");
    expect(meta.backgroundTask.agentId).toBe("agent_abc");
    expect(meta.backgroundTask.outputPath).toBe("/tmp/out.txt");
  });

  it("emits a tool_call_update on status transition to completed", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "running" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "completed" }));
    await Promise.resolve();
    expect(server.calls).toHaveLength(2);
    const update = server.calls[1]!.update;
    expect(update["sessionUpdate"]).toBe("tool_call_update");
    expect(update["status"]).toBe("completed");
    // Same toolCallId as the first card.
    expect(update["toolCallId"]).toBe(server.calls[0]!.update["toolCallId"]);
  });

  it("skips no-op status updates (same status as last advertised)", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "running" }));
    await Promise.resolve();
    // Another running event with no status change → suppressed.
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "running" }));
    await Promise.resolve();
    expect(server.calls).toHaveLength(1);
  });

  it("ignores session.updated without taskId (e.g. usage updates)", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", { usage: { inputTokens: 123 }, contextWindow: 1000 }),
    );
    await Promise.resolve();
    expect(server.calls).toHaveLength(0);
  });

  it("forwards background_task turn text_delta as agent_message_chunk", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    // A notification turn starts.
    l.handleEvent(
      zcodeEvent("turn.started", { inputSource: "background_task", turnId: "turn_bg1" }),
    );
    await Promise.resolve();
    // Its text deltas are forwarded.
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "result part 1 " }));
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "part 2" }));
    await Promise.resolve();
    // turn.completed ends the notification turn.
    l.handleEvent(zcodeEvent("turn.completed", { resultType: "success" }));
    await Promise.resolve();
    // Subsequent text_delta (no active bg turn) is NOT forwarded.
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "leak" }));
    await Promise.resolve();
    const chunks = server.calls.filter((c) => c.update["sessionUpdate"] === "agent_message_chunk");
    expect(chunks).toHaveLength(2);
    expect((chunks[0]!.update["content"] as { text: string }).text).toBe("result part 1 ");
    expect((chunks[1]!.update["content"] as { text: string }).text).toBe("part 2");
    // All chunks share one messageId (the bg result message).
    expect(chunks[0]!.update["messageId"]).toBe(chunks[1]!.update["messageId"]);
  });

  it("allocates a fresh messageId per background task (no cross-task reuse)", async () => {
    // Regression guard: firstMessageId must be reset when a background
    // notification turn ends, else two tasks in the same session share one
    // messageId and the editor merges/overwrites their output.
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    // Task 1's notification turn.
    l.handleEvent(zcodeEvent("turn.started", { inputSource: "background_task", turnId: "t1" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "task1 result" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("turn.completed", { resultType: "success" }));
    await Promise.resolve();
    // Task 2's notification turn (same session, same listener instance).
    l.handleEvent(zcodeEvent("turn.started", { inputSource: "background_task", turnId: "t2" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "task2 result" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("turn.completed", { resultType: "success" }));
    await Promise.resolve();
    const chunks = server.calls.filter((c) => c.update["sessionUpdate"] === "agent_message_chunk");
    expect(chunks).toHaveLength(2);
    // Distinct messageIds — the second task does NOT reuse the first's id.
    expect(chunks[0]!.update["messageId"]).not.toBe(chunks[1]!.update["messageId"]);
  });

  it("does NOT forward a normal (non-background) turn's text_delta", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(zcodeEvent("turn.started", { inputSource: "user_prompt", turnId: "turn_user" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "user reply" }));
    await Promise.resolve();
    expect(server.calls).toHaveLength(0);
  });

  it("markCancelled emits a failed update with cancelled flag and clears state", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "running" }));
    await Promise.resolve();
    await l.markCancelled("agent_abc");
    expect(server.calls).toHaveLength(2);
    const cancel = server.calls[1]!.update;
    expect(cancel["sessionUpdate"]).toBe("tool_call_update");
    expect(cancel["status"]).toBe("failed");
    expect(
      (cancel["_meta"] as { backgroundTask: { cancelled: boolean } }).backgroundTask.cancelled,
    ).toBe(true);
    // State cleared: a subsequent status event re-creates the card (new callId).
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "running" }));
    await Promise.resolve();
    expect(server.calls).toHaveLength(3);
  });

  it("never throws on a malformed payload (best-effort)", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    expect(() =>
      l.handleEvent(zcodeEvent("session.updated", { taskId: "x" } as never)),
    ).not.toThrow();
    expect(() => l.handleEvent(zcodeEvent("unknown.type", {}))).not.toThrow();
    await Promise.resolve();
  });
});

describe("BackgroundTaskListener: background Bash reuses launch card", () => {
  it("reuses the launch toolCallId when terminalSentData tracks it (no new bg_ card)", async () => {
    const server = makeServer();
    // Simulate the dispatcher having already seeded the launch card.
    server.terminalSentData.set("call_bash1", "Command running in background with ID: exec_x\n");
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_x",
        toolCallId: "call_bash1",
        toolName: "Bash",
        status: "running",
        description: "sleep 3",
        outputPath: "/tmp/out.log",
      }),
    );
    await Promise.resolve();
    expect(server.calls).toHaveLength(1);
    const update = server.calls[0]!.update;
    // Routes to the launch card id, NOT a fresh bg_*.
    expect(update["toolCallId"]).toBe("call_bash1");
    expect(update["sessionUpdate"]).toBe("tool_call_update");
    expect(update["status"]).toBe("in_progress");
    expect((update["_meta"] as { backgroundTask: { taskId: string } }).backgroundTask.taskId).toBe(
      "exec_x",
    );
    // No tool_call (new card) was emitted.
    expect(server.calls.some((c) => c.update["sessionUpdate"] === "tool_call")).toBe(false);
  });

  it("streams the real command output on completion even when launch text was already streamed", async () => {
    // Regression: launch acknowledgement text ("Command running in background
    // with ID: …") is written to terminalSentData by the dispatcher, but it is
    // NOT the command's actual output. The real output (outputTail) must still
    // be streamed via terminal_output on completion, or the user never sees
    // what the background command printed.
    const server = makeServer();
    server.terminalSentData.set("call_bash2", "Command running in background with ID: exec_y\n");
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_y",
        toolCallId: "call_bash2",
        status: "running",
      }),
    );
    await Promise.resolve();
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_y",
        toolCallId: "call_bash2",
        status: "completed",
        outputTail: "done\n",
      }),
    );
    // onTaskStatus awaits multiple notifyByZcodeSid calls; flush enough
    // microtasks for the whole async chain (including terminalSentData.delete)
    // to settle.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    // Exactly three updates: in_progress + terminal_output + terminal_exit.
    expect(server.calls).toHaveLength(3);
    const outputCall = server.calls[1]!.update;
    expect(outputCall["sessionUpdate"]).toBe("tool_call_update");
    expect(
      (outputCall["_meta"] as { terminal_output: { data: string } }).terminal_output.data,
    ).toBe("done\n");
    const exitCall = server.calls[2]!.update;
    expect(exitCall["status"]).toBe("completed");
    expect(exitCall["content"]).toEqual([{ type: "terminal", terminalId: "call_bash2" }]);
    const meta = exitCall["_meta"] as {
      terminal_exit: { terminal_id: string; exit_code: number };
      backgroundTask: { completed: boolean };
      claudeCode: { toolName: string };
    };
    expect(meta.terminal_exit.terminal_id).toBe("call_bash2");
    expect(meta.terminal_exit.exit_code).toBe(0);
    expect(meta.backgroundTask.completed).toBe(true);
    expect(meta.claudeCode.toolName).toBe("Bash");
    // terminalSentData cleared so the launch card is fully retired.
    expect(server.terminalSentData.has("call_bash2")).toBe(false);
  });

  it("streams terminal_output when launch text was never streamed (empty marker)", async () => {
    const server = makeServer();
    // Dispatcher seeded an empty marker (no launch text streamed yet).
    server.terminalSentData.set("call_bash3", "");
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_z",
        toolCallId: "call_bash3",
        status: "running",
      }),
    );
    await Promise.resolve();
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_z",
        toolCallId: "call_bash3",
        status: "completed",
        outputTail: "result\n",
      }),
    );
    await Promise.resolve();
    // running update + terminal_output + terminal_exit.
    expect(server.calls).toHaveLength(3);
    const termOutput = server.calls[1]!.update;
    const termMeta = termOutput["_meta"] as { terminal_output: { data: string } };
    expect(termMeta.terminal_output.data).toBe("result\n");
  });

  it("diffs cumulative outputTail snapshots during running progress (no duplication)", async () => {
    // The backend pushes session.updated multiple times during a long-running
    // background task, each carrying a CUMULATIVE outputTail snapshot. Only the
    // suffix beyond what we last streamed must be emitted.
    const server = makeServer();
    server.terminalSentData.set("call_bash5", "");
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_progress",
        toolCallId: "call_bash5",
        status: "running",
        outputTail: "line1\n",
      }),
    );
    await Promise.resolve();
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_progress",
        toolCallId: "call_bash5",
        status: "running",
        outputTail: "line1\nline2\n",
      }),
    );
    await Promise.resolve();
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_progress",
        toolCallId: "call_bash5",
        status: "completed",
        outputTail: "line1\nline2\nline3\n",
      }),
    );
    await Promise.resolve();
    // running(status update) + terminal_output(line1) + terminal_output(line2)
    // + terminal_output(line3) + terminal_exit.
    const outputs = server.calls
      .filter((c) => (c.update["_meta"] as { terminal_output?: unknown }).terminal_output)
      .map(
        (c) => (c.update["_meta"] as { terminal_output: { data: string } }).terminal_output.data,
      );
    expect(outputs).toEqual(["line1\n", "line2\n", "line3\n"]);
  });

  it("falls back to a fresh bg_* card when toolCallId is absent (sub-agent case)", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "agent_sub1",
        status: "running",
        description: "research src/",
        terminalId: "agent_sub1",
      }),
    );
    await Promise.resolve();
    // No toolCallId → no terminalSentData entry → falls back to new bg_* card.
    const update = server.calls[0]!.update;
    expect(update["sessionUpdate"]).toBe("tool_call");
    expect(String(update["toolCallId"]).startsWith("bg_")).toBe(true);
    expect(update["title"]).toBe("[background] research src/");
  });

  it("falls back to a fresh bg_* card when terminalSentData does not track the toolCallId", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    // toolCallId present but dispatcher never seeded it (e.g. old backend).
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_untracked",
        toolCallId: "call_orphan",
        status: "running",
        description: "mystery task",
      }),
    );
    await Promise.resolve();
    const update = server.calls[0]!.update;
    expect(update["sessionUpdate"]).toBe("tool_call");
    expect(String(update["toolCallId"]).startsWith("bg_")).toBe(true);
    expect(update["title"]).toBe("[background] mystery task");
  });

  it("markCancelled emits terminal_exit for a reused launch card", async () => {
    const server = makeServer();
    server.terminalSentData.set("call_bash4", "bg launch text\n");
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("session.updated", {
        taskId: "exec_cancel",
        toolCallId: "call_bash4",
        status: "running",
      }),
    );
    await Promise.resolve();
    await l.markCancelled("exec_cancel");
    // running update + cancel (terminal_exit with cancelled flag).
    expect(server.calls).toHaveLength(2);
    const cancel = server.calls[1]!.update;
    expect(cancel["status"]).toBe("failed");
    expect(cancel["content"]).toEqual([{ type: "terminal", terminalId: "call_bash4" }]);
    const meta = cancel["_meta"] as {
      backgroundTask: { cancelled: boolean };
      terminal_exit: { exit_code: number };
    };
    expect(meta.backgroundTask.cancelled).toBe(true);
    expect(meta.terminal_exit.exit_code).toBe(1);
    expect(server.terminalSentData.has("call_bash4")).toBe(false);
  });
});
