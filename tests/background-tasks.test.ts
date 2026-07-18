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
}
type TestServer = FakeServer & Pick<ZcodeAcpServer, "notifyByZcodeSid">;

function makeServer(): TestServer {
  const calls: TestServer["calls"] = [];
  const server = {
    calls,
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
    l.handleEvent(
      zcodeEvent("session.updated", { taskId: "agent_abc", status: "completed" }),
    );
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
    l.handleEvent(zcodeEvent("session.updated", { usage: { inputTokens: 123 }, contextWindow: 1000 }));
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
