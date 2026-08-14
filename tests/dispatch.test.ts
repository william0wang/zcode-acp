/**
 * dispatch.ts tests — verify the ACP session/update notifications emitted for
 * each InternalEvent kind. Uses a mock AgentContext that records every notify
 * call so we can assert on the exact JSON shape.
 *
 * Focus areas: the Bash terminal 2-notification split (terminal_output +
 * terminal_exit), the non-terminal generic path, and tool_call _meta.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { dispatchEvent } from "../src/handlers/dispatch.js";
import { ZcodeAcpServer } from "../src/server.js";
import type { InternalEvent } from "../src/translators/types.js";

/** Mock AgentContext that records every notify call. */
function mockContext(): { cx: acp.AgentContext; sent: acp.SessionUpdate[] } {
  const sent: acp.SessionUpdate[] = [];
  const cx = {
    notify(method: string, params: { sessionId: string; update: acp.SessionUpdate }) {
      expect(method).toBe("session/update");
      sent.push(params.update);
      return Promise.resolve();
    },
  } as unknown as acp.AgentContext;
  return { cx, sent };
}

/** Build a server with terminal_output capability toggled. */
function makeServer(terminalOutput: boolean): ZcodeAcpServer {
  const s = new ZcodeAcpServer();
  s.clientCapabilities = { _meta: { terminal_output: terminalOutput } };
  return s;
}

const SID = "sess_test";
const CHUNK = "chunk-1";

describe("dispatchEvent", () => {
  it("ToolCallNew emits tool_call with claudeCode toolName _meta", async () => {
    const { cx, sent } = mockContext();
    const server = makeServer(false);
    const ev: InternalEvent = {
      kind: "ToolCallNew",
      callId: "c1",
      tool: "Read",
      acpKind: "read",
      status: "pending",
      title: "Read: foo.py",
      input: { file_path: "foo.py" },
    };
    await dispatchEvent(server, cx, SID, ev, CHUNK);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Read: foo.py",
      kind: "read",
      _meta: { claudeCode: { toolName: "Read" } },
    });
  });

  it("Bash ToolCallNew with terminal_output support adds terminal_info + content", async () => {
    const { cx, sent } = mockContext();
    const server = makeServer(true);
    const ev: InternalEvent = {
      kind: "ToolCallNew",
      callId: "c1",
      tool: "Bash",
      acpKind: "execute",
      status: "pending",
      title: "Bash: ls",
    };
    await dispatchEvent(server, cx, SID, ev, CHUNK);
    expect(sent[0]).toMatchObject({
      _meta: { claudeCode: { toolName: "Bash" }, terminal_info: { terminal_id: "c1" } },
      content: [{ type: "terminal", terminalId: "c1" }],
    });
  });

  it("Bash progress splits into terminal_output only (no status)", async () => {
    const { cx, sent } = mockContext();
    const server = makeServer(true);
    const ev: InternalEvent = {
      kind: "ToolCallUpdate",
      callId: "c1",
      tool: "Bash",
      status: "in_progress",
      rawOutput: "running...",
      output: "running...",
    };
    await dispatchEvent(server, cx, SID, ev, CHUNK);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      _meta: { terminal_output: { terminal_id: "c1", data: "running..." } },
    });
    // No status field on the data-only notification.
    expect((sent[0] as { status?: string }).status).toBeUndefined();
  });

  it("Bash progress emits only the delta between cumulative stdout snapshots", async () => {
    // zcode sends stdoutTail as a CUMULATIVE tail snapshot on every progress
    // event. terminal_output.data is append semantics, so the bridge must diff
    // consecutive snapshots and emit only the suffix — otherwise long-running
    // commands show their output N times.
    const { cx, sent } = mockContext();
    const server = makeServer(true);
    const base: Partial<Extract<InternalEvent, { kind: "ToolCallUpdate" }>> = {
      kind: "ToolCallUpdate",
      callId: "c1",
      tool: "Bash",
      status: "in_progress",
    };
    await dispatchEvent(server, cx, SID, { ...base, rawOutput: "line1\n" }, CHUNK);
    await dispatchEvent(server, cx, SID, { ...base, rawOutput: "line1\nline2\n" }, CHUNK);
    await dispatchEvent(server, cx, SID, { ...base, rawOutput: "line1\nline2\nline3\n" }, CHUNK);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({
      _meta: { terminal_output: { terminal_id: "c1", data: "line1\n" } },
    });
    expect(sent[1]).toMatchObject({
      _meta: { terminal_output: { terminal_id: "c1", data: "line2\n" } },
    });
    expect(sent[2]).toMatchObject({
      _meta: { terminal_output: { terminal_id: "c1", data: "line3\n" } },
    });
  });

  it("Bash completed emits 2 notifications: terminal_output delta + terminal_exit", async () => {
    const { cx, sent } = mockContext();
    const server = makeServer(true);
    const ev: InternalEvent = {
      kind: "ToolCallUpdate",
      callId: "c1",
      tool: "Bash",
      status: "completed",
      rawOutput: "done",
      output: "done",
      rawResult: { success: true, content: "done", perf: { exitCode: 0 } },
    };
    await dispatchEvent(server, cx, SID, ev, CHUNK);
    expect(sent).toHaveLength(2);
    // ① terminal_output (pure data)
    expect(sent[0]).toMatchObject({
      _meta: { terminal_output: { terminal_id: "c1", data: "done" } },
    });
    // ② terminal_exit (terminal state) — no rawOutput: the output was already
    //    streamed via terminal_output, and including rawOutput makes Zed render
    //    it a second time (the duplication bug).
    expect(sent[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "terminal", terminalId: "c1" }],
      _meta: {
        claudeCode: { toolName: "Bash" },
        terminal_exit: { terminal_id: "c1", exit_code: 0, signal: null },
      },
    });
    expect((sent[1] as { rawOutput?: string }).rawOutput).toBeUndefined();
  });

  it("Bash result after streamed progress skips terminal_output (no replay)", async () => {
    // Progress already streamed the full output; zcode's result re-sends the
    // complete tail. terminal_output must NOT fire again — only terminal_exit.
    const { cx, sent } = mockContext();
    const server = makeServer(true);
    const base: Partial<Extract<InternalEvent, { kind: "ToolCallUpdate" }>> = {
      kind: "ToolCallUpdate",
      callId: "c1",
      tool: "Bash",
    };
    await dispatchEvent(
      server,
      cx,
      SID,
      { ...base, status: "in_progress", rawOutput: "line1\nline2\nline3\n" },
      CHUNK,
    );
    await dispatchEvent(
      server,
      cx,
      SID,
      {
        ...base,
        status: "completed",
        rawOutput: "line1\nline2\nline3\n",
        output: "line1\nline2\nline3\n",
        rawResult: { success: true, content: "line1\nline2\nline3\n", perf: { exitCode: 0 } },
      },
      CHUNK,
    );
    // progress terminal_output (1) + result terminal_exit (1). No second data.
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      _meta: { terminal_output: { data: "line1\nline2\nline3\n" } },
    });
    expect(sent[1]).toMatchObject({ status: "completed" });
  });

  it("Bash result with no prior progress emits full output once", async () => {
    // Short command: scheduled → result, no progress event. Nothing was streamed
    // yet, so the result must emit terminal_output once so output is visible.
    const { cx, sent } = mockContext();
    const server = makeServer(true);
    const ev: InternalEvent = {
      kind: "ToolCallUpdate",
      callId: "c1",
      tool: "Bash",
      status: "completed",
      rawOutput: "quick result\n",
      output: "quick result\n",
      rawResult: { success: true, content: "quick result\n", perf: { exitCode: 0 } },
    };
    await dispatchEvent(server, cx, SID, ev, CHUNK);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      _meta: { terminal_output: { data: "quick result\n" } },
    });
    expect(sent[1]).toMatchObject({ status: "completed" });
  });

  it("Bash failed extracts exit code 1 when no perf.exitCode", async () => {
    const { cx, sent } = mockContext();
    const server = makeServer(true);
    const ev: InternalEvent = {
      kind: "ToolCallUpdate",
      callId: "c1",
      tool: "Bash",
      status: "failed",
      rawResult: { success: false, content: "boom" },
      output: "boom",
    };
    await dispatchEvent(server, cx, SID, ev, CHUNK);
    const exitNotif = sent[1] as unknown as { _meta: { terminal_exit: { exit_code: number } } };
    expect(exitNotif._meta.terminal_exit.exit_code).toBe(1);
  });

  it("non-Bash ToolCallUpdate emits single update with status + content", async () => {
    const { cx, sent } = mockContext();
    const server = makeServer(true); // terminal supported but tool is Read, not Bash
    const ev: InternalEvent = {
      kind: "ToolCallUpdate",
      callId: "c2",
      tool: "Read",
      status: "completed",
      output: "file body",
      content: [{ type: "content", content: { type: "text", text: "file body" } }],
    };
    await dispatchEvent(server, cx, SID, ev, CHUNK);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "c2",
      status: "completed",
      _meta: { claudeCode: { toolName: "Read" } },
      rawOutput: "file body",
    });
  });

  it("TextDelta emits agent_message_chunk with chunk messageId", async () => {
    const { cx, sent } = mockContext();
    await dispatchEvent(makeServer(false), cx, SID, { kind: "TextDelta", text: "hi" }, CHUNK);
    expect(sent[0]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
      messageId: CHUNK,
    });
  });

  it("PlanUpdate emits plan sessionUpdate with entries", async () => {
    const { cx, sent } = mockContext();
    await dispatchEvent(
      makeServer(false),
      cx,
      SID,
      { kind: "PlanUpdate", entries: [{ content: "do X", status: "pending", priority: "high" }] },
      CHUNK,
    );
    expect(sent[0]).toMatchObject({
      sessionUpdate: "plan",
      entries: [{ content: "do X", status: "pending", priority: "high" }],
    });
  });

  it("ConfigChanged (mode) emits config_option_update + current_mode_update", async () => {
    const { cx, sent } = mockContext();
    const server = makeServer(false);
    await dispatchEvent(
      server,
      cx,
      SID,
      {
        kind: "ConfigChanged",
        mode: "plan",
        model: { providerId: "anthropic", modelId: "GLM-5.2" },
      },
      CHUNK,
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      sessionUpdate: "config_option_update",
      configOptions: [
        { id: "model", currentValue: "anthropic\\GLM-5.2" },
        { id: "mode", currentValue: "plan" },
        // The default thought value is config-derived (per-model
        // reasoning.variants of the enabled provider), so it legitimately
        // varies with the machine the test runs on.
        { id: "thought", currentValue: expect.any(String) },
      ],
    });
    expect(sent[1]).toEqual({
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    });
    // Reconciliation mirror: lastMode reflects the advertised value.
    expect(server.lastMode.get(SID)).toBe("plan");
  });

  it("ConfigChanged (thought only) emits config_option_update, no mode update", async () => {
    const { cx, sent } = mockContext();
    await dispatchEvent(
      makeServer(false),
      cx,
      SID,
      { kind: "ConfigChanged", thought: "max" },
      CHUNK,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sessionUpdate: "config_option_update",
      configOptions: [{ id: "model" }, { id: "mode" }, { id: "thought", currentValue: "max" }],
    });
  });

  it("ConfigChanged without model keeps the session's current model (no default reset)", async () => {
    const { cx, sent } = mockContext();
    const server = makeServer(false);
    server.registerSession(SID, "sess_real");
    // Fake backend: session/read reports DeepSeek as the session's current
    // model. A mid-turn state.updated that changes only mode/thought must NOT
    // reset the model dropdown to the default — regression for the model
    // jumping back to the default when sending a message.
    server.backend = {
      isDead: false,
      request: async () => ({
        result: {
          settings: {
            model: { current: { providerId: "deepseek", modelId: "DeepSeek-V3.5" } },
            mode: { current: "build" },
            thoughtLevel: { current: "high" },
          },
        },
      }),
    } as unknown as NonNullable<ZcodeAcpServer["backend"]>;

    await dispatchEvent(
      server,
      cx,
      SID,
      { kind: "ConfigChanged", mode: "plan", thought: "high" },
      CHUNK,
    );
    expect(sent).toHaveLength(2);
    const options = (sent[0] as { configOptions: acp.SessionConfigOption[] }).configOptions;
    expect(options[0]).toMatchObject({ id: "model", currentValue: "deepseek\\DeepSeek-V3.5" });
    expect(options[1]).toMatchObject({ id: "mode", currentValue: "plan" });
    expect(options[2]).toMatchObject({ id: "thought", currentValue: "high" });
  });
});
