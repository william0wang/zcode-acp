/**
 * Tail replay kernel tests — turn-aligned slicing, cursor pagination and
 * expiry, the `_meta.zcode.limit` reader, and the per-session replay batch
 * lock (live sends queue behind an in-flight batch for the same session).
 */

import { describe, expect, it } from "vitest";

import type { ZcodeMessage } from "../src/backend/types.js";
import { enqueueSessionSend, sendSessionUpdate, withReplayBatch } from "../src/handlers/io.js";
import {
  MAX_REPLAY_LIMIT,
  fullSlice,
  readTailLimit,
  sliceBefore,
  sliceTail,
} from "../src/handlers/replay.js";

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

  it("limit 0 attaches with metadata only; cursor anchors at history's end", () => {
    const s = sliceTail(MSGS, 0);
    expect(s.batch).toEqual([]);
    expect(s.meta.hasMore).toBe(true);
    expect(s.meta.totalMessages).toBe(8);
    // Paging from that cursor delivers the tail.
    const page = sliceBefore(MSGS, s.meta.cursor, 2);
    expect(ids(page.batch)).toEqual(["u3", "a3"]);
  });

  it("limit >= length replays everything", () => {
    const s = sliceTail(MSGS, 99);
    expect(s.batch).toHaveLength(8);
    expect(s.meta.hasMore).toBe(false);
  });

  it("clamps oversized limits", () => {
    expect(ids(sliceTail(MSGS, MAX_REPLAY_LIMIT + 100).batch)).toHaveLength(8);
  });

  it("handles empty history", () => {
    const s = sliceTail([], 30);
    expect(s.batch).toEqual([]);
    expect(s.meta).toMatchObject({ hasMore: false, totalMessages: 0, totalTurns: 0 });
  });
});

describe("sliceBefore pagination", () => {
  it("pages backwards to the beginning of history", () => {
    let cursor = sliceTail(MSGS, 2).meta.cursor;
    const pages: string[][] = [];
    let hasMore = true;
    while (hasMore) {
      const page = sliceBefore(MSGS, cursor, 2);
      pages.push(ids(page.batch));
      hasMore = page.meta.hasMore;
      cursor = page.meta.cursor;
    }
    // hasMore:false on the last non-empty page terminates pagination — the
    // client never needs the empty page.
    expect(pages).toEqual([["u2", "a2a", "a2b"], ["u1", "a1"], ["s0"]]);
    // A redundant extra call returns an empty page, still hasMore:false.
    const extra = sliceBefore(MSGS, cursor, 2);
    expect(extra.batch).toEqual([]);
    expect(extra.meta.hasMore).toBe(false);
  });

  it("fullSlice's cursor pages nothing", () => {
    const s = fullSlice(MSGS);
    expect(s.meta.hasMore).toBe(false);
    const page = sliceBefore(MSGS, s.meta.cursor, 10);
    expect(page.batch).toEqual([]);
    expect(page.meta.hasMore).toBe(false);
  });

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

  it("throws cursor expired on out-of-range index", () => {
    const cursor = Buffer.from(JSON.stringify({ v: 1, index: 99, totalTurns: 4 })).toString(
      "base64url",
    );
    expect(() => sliceBefore(MSGS, cursor, 2)).toThrow("cursor expired");
  });

  it("throws cursor expired on anchor id mismatch", () => {
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, id: "wrong", index: 6, totalTurns: 4 }),
    ).toString("base64url");
    expect(() => sliceBefore(MSGS, cursor, 2)).toThrow("cursor expired");
  });

  it("throws cursor expired on garbage cursors", () => {
    expect(() => sliceBefore(MSGS, "!!!not-base64url-json", 2)).toThrow("cursor expired");
  });
});

describe("readTailLimit", () => {
  it("reads the limit from _meta.zcode", () => {
    expect(readTailLimit({ _meta: { zcode: { limit: 30 } } } as never)).toBe(30);
  });

  it("returns null (full replay) for absent or non-finite limits", () => {
    expect(readTailLimit({} as never)).toBeNull();
    expect(readTailLimit({ _meta: { zcode: { limit: "30" } } } as never)).toBeNull();
    expect(readTailLimit({ _meta: {} } as never)).toBeNull();
  });

  it("clamps negative and oversized values", () => {
    expect(readTailLimit({ _meta: { zcode: { limit: -5 } } } as never)).toBe(0);
    expect(readTailLimit({ _meta: { zcode: { limit: 99999 } } } as never)).toBe(MAX_REPLAY_LIMIT);
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

  it("does not block other sessions while a batch runs", async () => {
    const events: string[] = [];
    let releaseBatch!: () => void;
    const batch = withReplayBatch("lock-a", async () => {
      await new Promise<void>((resolve) => (releaseBatch = resolve));
    });
    await sendSessionUpdate(cx("other-session", events), "lock-b", {
      sessionUpdate: "plan",
      entries: [],
    });
    expect(events).toEqual(["other-session"]);
    releaseBatch();
    await batch;
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

  it("queues background sends (enqueueSessionSend) behind an in-flight batch", async () => {
    const events: string[] = [];
    let releaseBatch!: () => void;
    const batch = withReplayBatch("lock-d", async () => {
      events.push("batch-start");
      await new Promise<void>((resolve) => (releaseBatch = resolve));
      events.push("batch-end");
    });
    const bg = enqueueSessionSend("lock-d", async () => {
      events.push("background");
    });
    await Promise.resolve();
    expect(events).toEqual(["batch-start"]);
    releaseBatch();
    await Promise.all([batch, bg]);
    expect(events).toEqual(["batch-start", "batch-end", "background"]);
  });

  it("re-uses a session correctly after its guard entry was cleaned up", async () => {
    // The first batch drains with nothing chained → withReplayBatch deletes
    // the map entry. Deletion itself is unobservable by design; this guards
    // that a fresh batch on the same session still serializes afterwards.
    await withReplayBatch("lock-e", async () => {});
    const events: string[] = [];
    let releaseBatch!: () => void;
    const batch = withReplayBatch("lock-e", async () => {
      events.push("batch-start");
      await new Promise<void>((resolve) => (releaseBatch = resolve));
      events.push("batch-end");
    });
    const send = enqueueSessionSend("lock-e", async () => {
      events.push("send");
    });
    await Promise.resolve();
    expect(events).toEqual(["batch-start"]);
    releaseBatch();
    await Promise.all([batch, send]);
    expect(events).toEqual(["batch-start", "batch-end", "send"]);
  });
});
