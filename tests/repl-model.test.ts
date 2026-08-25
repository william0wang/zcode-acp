/**
 * Tests for the REPL turn state machine (src/repl/model.ts) and the code
 * fence colorizer (src/repl/App.tsx).
 *
 * The state machine folds raw ACP SessionUpdate notifications into render
 * entries; these tests lock the chunk-ordering rules (thought flush on first
 * message chunk, tool row upsert by toolCallId, stop-reason note) that the
 * Ink view relies on.
 */

import { describe, expect, it } from "vitest";

import { colorizeCodeFences } from "../src/repl/App.js";
import {
  applyUpdate,
  createTurnState,
  finishTurn,
  parseCommand,
  splitBulkInput,
  type SessionUpdateLike,
} from "../src/repl/model.js";

function chunk(
  kind: "agent_message_chunk" | "agent_thought_chunk",
  text: string,
): SessionUpdateLike {
  return { sessionUpdate: kind, content: { type: "text", text } } as SessionUpdateLike;
}

describe("applyUpdate", () => {
  it("buffers thought and message chunks separately", () => {
    let s = createTurnState();
    s = applyUpdate(s, chunk("agent_thought_chunk", "thinking…"));
    expect(s.thinkBuf).toBe("thinking…");
    expect(s.textBuf).toBe("");
    // A second thought chunk keeps accumulating before any prose starts.
    s = applyUpdate(s, chunk("agent_thought_chunk", " more"));
    expect(s.thinkBuf).toBe("thinking… more");
  });

  it("flushes the thought buffer as an entry when prose starts", () => {
    let s = createTurnState();
    s = applyUpdate(s, chunk("agent_thought_chunk", "plan the answer"));
    s = applyUpdate(s, chunk("agent_message_chunk", "Here it is"));
    expect(s.entries).toEqual([{ kind: "thinking", text: "plan the answer" }]);
    expect(s.thinkBuf).toBe("");
  });

  it("upserts tool rows by toolCallId and keeps last status", () => {
    let s = createTurnState();
    s = applyUpdate(s, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read README.md",
      status: "in_progress",
    } as SessionUpdateLike);
    s = applyUpdate(s, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    } as SessionUpdateLike);
    expect(s.entries).toEqual([
      { kind: "tool", id: "t1", title: "Read README.md", status: "completed" },
    ]);
  });

  it("renders a tool_call_update for an unseen call as a fresh row", () => {
    const s = applyUpdate(createTurnState(), {
      sessionUpdate: "tool_call_update",
      toolCallId: "late",
      title: "Late call",
      status: "completed",
    } as SessionUpdateLike);
    expect(s.entries).toEqual([
      { kind: "tool", id: "late", title: "Late call", status: "completed" },
    ]);
  });
});

describe("finishTurn", () => {
  it("flushes pending buffers and only notes non-end_turn stops", () => {
    let s = createTurnState();
    s = applyUpdate(s, chunk("agent_thought_chunk", "hmm"));
    s = applyUpdate(s, chunk("agent_message_chunk", "answer"));
    const entries = finishTurn(s, "end_turn");
    expect(entries).toEqual([
      { kind: "thinking", text: "hmm" },
      { kind: "assistant", text: "answer" },
    ]);
  });

  it("adds a stopped note for cancelled turns", () => {
    const entries = finishTurn(createTurnState(), "cancelled");
    expect(entries).toEqual([{ kind: "note", text: "stopped: cancelled" }]);
  });
});

describe("parseCommand", () => {
  it("recognizes exit aliases and treats everything else as a prompt", () => {
    expect(parseCommand("/exit")).toBe("exit");
    expect(parseCommand("/quit")).toBe("exit");
    expect(parseCommand("/q")).toBe("exit");
    expect(parseCommand("fix the bug")).toBe(null);
    expect(parseCommand("")).toBe(null);
  });
});

describe("splitBulkInput", () => {
  it("splits a multi-line paste into submits plus a trailing buffer", () => {
    // Three embedded newlines: first line completes the in-progress value,
    // the middle line must NOT be dropped, the last stays buffered.
    expect(splitBulkInput("AB", "CD\r\nEF\r\nGH")).toEqual({
      submits: ["ABCD", "EF"],
      buffer: "GH",
    });
  });

  it("submits the current line when the event ends with a newline", () => {
    expect(splitBulkInput("", "one-shot\r")).toEqual({ submits: ["one-shot"], buffer: "" });
    expect(splitBulkInput("AB", "CD\n")).toEqual({ submits: ["ABCD"], buffer: "" });
  });

  it("treats a lone newline as submitting the in-progress value", () => {
    expect(splitBulkInput("AB", "\n")).toEqual({ submits: ["AB"], buffer: "" });
  });
});

describe("colorizeCodeFences", () => {
  it("leaves plain prose untouched and marks fenced lines", () => {
    const out = colorizeCodeFences("intro\n```ts\nconst x = 1;\n```\nafter");
    // ANSI codes wrap the fenced region; plain lines stay identical.
    expect(out).toContain("intro");
    expect(out).toContain("after");
    expect(out).toMatch(/const x = 1;/);
    // The fence content is colorized (an ANSI escape sequence directly
    // precedes it); avoid a literal escape in the regex to satisfy lint.
    const idx = out.indexOf("const x = 1;");
    const esc = String.fromCharCode(27);
    expect(out.slice(idx - 6, idx)).toContain(esc + "[");
  });
});
