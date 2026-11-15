/**
 * Tail replay kernel tests — turn-aligned slicing, cursor pagination and
 * expiry, the `_meta.zcode.limit` reader, and the per-session replay batch
 * lock (live sends queue behind an in-flight batch for the same session).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeMessage } from "../src/backend/types.js";
import { sendSessionUpdate, withReplayBatch } from "../src/handlers/io.js";
import {
  normalizeWireMessages,
  replayMessages,
  sliceBefore,
  sliceTail,
} from "../src/handlers/replay.js";

// Asserts English collapsed titles; pin the language regardless of host env.
beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function msg(id: string, role: "user" | "assistant" | "system", text: string): ZcodeMessage {
  return { info: { id, role }, parts: [{ type: "text", text }] };
}

// Layout: 8 messages, 4 turns. Turn starts at 0 (leading system), 1, 3, 6.
const MSGS: ZcodeMessage[] = [
  msg("s0", "system", "sys"),
  msg("u1", "user", "one"),
  msg("a1", "assistant", "A1"),
  msg("u2", "user", "two"),
  msg("a2a", "assistant", "A2a"),
  msg("a2b", "assistant", "A2b"),
  msg("u3", "user", "three"),
  msg("a3", "assistant", "A3"),
];

function ids(batch: ZcodeMessage[]): string[] {
  return batch.map((m) => m.info.id!);
}

describe("sliceTail", () => {
  it("slices the last N messages aligned to the containing turn's start", () => {
    const s = sliceTail(MSGS, 2);
    expect(ids(s.batch)).toEqual(["u3", "a3"]);
    expect(s.meta).toMatchObject({
      hasMore: true,
      replayedMessages: 2,
      replayedTurns: 1,
      totalMessages: 8,
      totalTurns: 4,
      lastMessageId: "a3",
    });
  });

  it("alignment may extend past the limit — never a mid-turn cut", () => {
    // cut = 7 lands inside turn 3 (start 6) → batch extends back to u3.
    expect(ids(sliceTail(MSGS, 1).batch)).toEqual(["u3", "a3"]);
    // cut = 5 lands inside turn 2 (start 3) → five messages, two turns.
    const s = sliceTail(MSGS, 3);
    expect(ids(s.batch)).toEqual(["u2", "a2a", "a2b", "u3", "a3"]);
    expect(s.meta.replayedTurns).toBe(2);
  });

  it("hidden tool-result user messages are not turn anchors (cursor must survive replay)", () => {
    // The backend stores tool results as user-role messages with
    // transcriptVisibility "hidden"; replay skips them, so a slice aligned on
    // one would mint a cursor anchored at a message the client never sees.
    const hidden = (id: string, text: string): ZcodeMessage => ({
      info: { id, role: "user", semantics: { transcriptVisibility: "hidden" } },
      parts: [{ type: "text", text }],
    });
    const msgs: ZcodeMessage[] = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "A1"),
      hidden("tr1", '{"ok":true}'),
      msg("a2", "assistant", "A2"),
      msg("u2", "user", "two"),
      msg("a3", "assistant", "A3"),
    ];

    const s = sliceTail(msgs, 1);
    // Aligns to u2 (the visible turn start), never to hidden tr1.
    expect(ids(s.batch)).toEqual(["u2", "a3"]);
    expect(s.meta.totalTurns).toBe(2);
    // Cursor anchor is the message at the slice start — a replayed one.
    const anchorId = JSON.parse(Buffer.from(s.meta.cursor, "base64url").toString("utf8")) as {
      id?: string;
    };
    expect(anchorId.id).toBe("u2");

    // The discriminating cut: pos 3 falls inside the FIRST turn, whose next
    // turn start below u2 is hidden tr1 (old code) vs u1 (fixed code).
    const wide = sliceTail(msgs, 3);
    expect(ids(wide.batch)).toEqual(["u1", "a1", "tr1", "a2", "u2", "a3"]);
    const wideAnchor = JSON.parse(Buffer.from(wide.meta.cursor, "base64url").toString("utf8")) as {
      id?: string;
    };
    expect(wideAnchor.id).toBe("u1");
  });
});

describe("sliceBefore pagination", () => {
  it("keeps paging when turns were appended after the cursor was minted", () => {
    const grown = [...MSGS, msg("u4", "user", "four"), msg("a4", "assistant", "A4")];
    const cursor = sliceTail(MSGS, 2).meta.cursor;
    const page = sliceBefore(grown, cursor, 2);
    expect(ids(page.batch)).toEqual(["u2", "a2a", "a2b"]);
    expect(page.meta).toMatchObject({ hasMore: true, totalMessages: 10, totalTurns: 5 });
  });

  it("throws cursor expired on totalTurns mismatch (compaction)", () => {
    const cursor = sliceTail(MSGS, 2).meta.cursor;
    const compacted = MSGS.slice(4); // fewer turns → cursor's totalTurns stale
    expect(() => sliceBefore(compacted, cursor, 2)).toThrow("cursor expired");
  });
});

describe("replay batch lock", () => {
  function cx(label: string, events: string[]) {
    return {
      notify: async () => {
        events.push(label);
      },
    } as never;
  }

  it("queues live sends behind an in-flight batch for the same session", async () => {
    const events: string[] = [];
    let releaseBatch!: () => void;
    const batch = withReplayBatch("lock-s1", async () => {
      events.push("batch-start");
      await new Promise<void>((resolve) => (releaseBatch = resolve));
      events.push("batch-end");
    });
    const live = sendSessionUpdate(cx("live", events), "lock-s1", {
      sessionUpdate: "plan",
      entries: [],
    });
    await Promise.resolve();
    expect(events).toEqual(["batch-start"]);
    releaseBatch();
    await Promise.all([batch, live]);
    expect(events).toEqual(["batch-start", "batch-end", "live"]);
  });

  it("serializes concurrent batches for the same session", async () => {
    const events: string[] = [];
    const [r1, r2] = await Promise.all([
      withReplayBatch("lock-c", async () => {
        events.push("b1-start");
        await new Promise((r) => setTimeout(r, 10));
        events.push("b1-end");
      }),
      withReplayBatch("lock-c", async () => {
        events.push("b2-start");
        await new Promise((r) => setTimeout(r, 1));
        events.push("b2-end");
      }),
    ]);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    expect(events).toEqual(["b1-start", "b1-end", "b2-start", "b2-end"]);
  });
});

const HANDOFF_TEXT =
  "This session is being continued from a previous conversation that ran out " +
  "of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. …";

describe("replayMessages collapsed harness blocks", () => {
  function collectCx(): {
    cx: { notify: (method: string, params: unknown) => Promise<void> };
    updates: Array<{ update?: { sessionUpdate?: string } } & Record<string, unknown>>;
  } {
    const updates: Array<Record<string, unknown>> = [];
    return {
      cx: {
        notify: async (_method: string, params: unknown) => {
          updates.push(params as Record<string, unknown>);
        },
      },
      updates,
    };
  }

  it("keys the card to the store's callId so later live updates can address it", async () => {
    const { cx, updates } = collectCx();
    await replayMessages(cx, "s", [
      {
        info: { id: "m1", role: "assistant" },
        parts: [{ type: "tool", callId: "call_9", tool: "Agent", state: { status: "running" } }],
      },
    ]);
    expect((updates[0]!.update as Record<string, unknown>).toolCallId).toBe("call_9");
  });

  it("derives deterministic fallback ids so repeated replays replace, not duplicate", async () => {
    // No info.id AND no callId — both fallback chains engaged. A fresh
    // random id per replay would re-attach the same card/text as a new item
    // on every reconnect; index-derived ids keep replays idempotent.
    const history: ZcodeMessage[] = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool", tool: "Bash", state: { status: "completed", input: "ls" } },
          { type: "text", text: "done" },
        ],
      },
    ];
    const run = async (): Promise<(string | undefined)[]> => {
      const { cx, updates } = collectCx();
      await replayMessages(cx, "s", history);
      return updates.map((p) => {
        const u = p.update as Record<string, unknown>;
        return (u.toolCallId as string) ?? (u.messageId as string);
      });
    };
    const first = await run();
    expect(first).toEqual(["histtool_hist_0_0", "hist_0"]);
    expect(await run()).toEqual(first);
  });
  it("collapses a semantics-tagged compact_summary under the store's title", async () => {
    const { cx, updates } = collectCx();
    const m: ZcodeMessage = {
      info: {
        id: "cs1",
        role: "user",
        semantics: { kind: "compact_summary", transcriptVisibility: "hidden" },
        summary: { title: "Compact summary", body: "…" },
      },
      parts: [{ type: "text", text: HANDOFF_TEXT }],
    };
    await replayMessages(cx, "s", [m]);
    expect(updates).toHaveLength(1);
    const u = updates[0]!.update as Record<string, unknown>;
    expect(u.sessionUpdate).toBe("tool_call");
    expect(u.title).toBe("Compact summary");
    expect((u._meta as { zcode: { kind: string } }).zcode.kind).toBe("compact");
    // The hidden flag never suppresses the compaction card itself.
    expect((u.content as Array<{ content: { text: string } }>)[0]!.content.text).toBe(HANDOFF_TEXT);
  });

  it("keeps replaying visible user messages (no semantics gate)", async () => {
    const { cx, updates } = collectCx();
    await replayMessages(cx, "s", [msg("u9", "user", "real question")]);
    const u = updates[0]!.update as Record<string, unknown>;
    expect(u.sessionUpdate).toBe("user_message_chunk");
    expect((u.content as { text: string }).text).toBe("real question");
  });

  it("emits one collapsed tool_call per compaction", async () => {
    const { cx, updates } = collectCx();
    await replayMessages(cx, "s", [
      msg("h1", "user", HANDOFF_TEXT),
      msg("u1", "user", "hi"),
      msg("h2", "user", HANDOFF_TEXT),
    ]);
    const kinds = updates.map((p) => p.update!.sessionUpdate);
    expect(kinds).toEqual(["tool_call", "user_message_chunk", "tool_call"]);
    expect(updates[0]!.update!.toolCallId).toBe("histfold_h1");
    expect(updates[2]!.update!.toolCallId).toBe("histfold_h2");
  });
});

describe("replayMessages toolTurnWindow (TUI condensation)", () => {
  function collectCx() {
    const updates: Array<Record<string, unknown>> = [];
    return {
      cx: {
        notify: async (_m: string, params: unknown) => {
          updates.push(params as Record<string, unknown>);
        },
      },
      updates,
    };
  }
  const toolMsg = (id: string): ZcodeMessage => ({
    info: { id, role: "assistant" },
    parts: [
      {
        type: "tool",
        callId: `tool_${id}`,
        tool: "Bash",
        state: { title: `Run ${id}`, status: "completed", input: "ls", output: "file" },
      },
    ],
  });
  const READ_TEXT =
    'Called the Read tool with the following input: {"file_path":"/tmp/a"}\nResult…';
  const batch = [
    msg("u1", "user", "one"),
    toolMsg("t1"),
    msg("a1", "assistant", "A1"),
    msg("u2", "user", "two"),
    toolMsg("t2"),
    msg("a2", "assistant", "A2"),
    msg("u3", "user", READ_TEXT), // tool-transcript in the LAST turn stays
    msg("a3", "assistant", "A3"),
  ];

  it("keeps tool records only in the most recent turns; chat text always replays", async () => {
    const { cx, updates } = collectCx();
    await replayMessages(cx, "s", batch, { toolTurnWindow: 1 });
    const shapes = updates.map((p) => {
      const u = p.update as Record<string, unknown>;
      return u.sessionUpdate === "tool_call" ? (u.title as string) : "text";
    });
    // Turn 1 (u1..a1): tool dropped. Turn 2 (u2..a2): still outside the
    // 1-turn window → dropped. Last turn: the tool-transcript stays.
    expect(shapes).toEqual(["text", "text", "text", "text", "Read · /tmp/a", "text"]);
  });
});

describe("normalizeWireMessages (3.18+ wire shape: info.messageId, no info.id)", () => {
  it("maps the wire messageId spelling onto info.id", () => {
    const wire = [
      {
        info: { messageId: "msg_u1", sessionId: "sess", role: "user" },
        parts: [{ type: "text", text: "one" }],
      },
      {
        info: { messageId: "msg_a1", sessionId: "sess", role: "assistant" },
        parts: [{ type: "text", text: "A1" }],
      },
    ] as unknown as ZcodeMessage[];
    const out = normalizeWireMessages(wire);
    expect(out.map((m) => m.info.id)).toEqual(["msg_u1", "msg_a1"]);
  });
});
