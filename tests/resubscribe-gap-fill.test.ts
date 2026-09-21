/**
 * Resubscribe gap-fill: `session/subscribe` with `afterSeq` returns the
 * missed window IN the response (`events` — source: subscribeSession replays
 * every event with seq > afterSeq). resubscribe() must queue that window
 * into the stream (seq-ordered, deduped against the watermark) so the turn
 * loop sees the gap, and the initial subscribe() must OMIT afterSeq — an
 * explicit afterSeq makes the backend materialize the window into the
 * response, and afterSeq: 0 meant the FULL event log computed and discarded
 * on every turn.
 */

import { describe, expect, it } from "vitest";

import { EventStreamListener } from "../src/backend/listener.js";
import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";

interface ScriptedBackend {
  backend: ZcodeBackend;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  /** Script the NEXT subscribe response. */
  answer: (result: unknown, error?: { code?: number; message?: string }) => void;
}

function scriptedBackend(): ScriptedBackend {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let responder: () => { result?: unknown; error?: { code?: number; message?: string } } = () => ({
    result: {},
  });
  const backend = {
    isDead: false,
    request: async (_id: number, method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method !== "session/subscribe") return { result: {} };
      return responder();
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return {
    backend,
    requests,
    answer: (result, error) => {
      responder = () => ({ result, error });
    },
  };
}

function ev(seq: number, type = "message.upserted"): ZcodeEvent {
  return { sessionId: "zs_gf", seq, type: type as ZcodeEvent["type"], payload: {} };
}

describe("EventStreamListener resubscribe gap-fill", () => {
  it("initial subscribe omits afterSeq (no full-log materialization)", async () => {
    const f = scriptedBackend();
    f.answer({ eventSeq: 7 });
    const listener = new EventStreamListener(f.backend, "zs_gf");

    await listener.subscribe(() => 1);

    const params = f.requests[0]!.params;
    expect("afterSeq" in params).toBe(false);
    expect(listener.lastSeq).toBe(7);
  });

  it("resubscribe queues the missed window in seq order and dedupes", async () => {
    const f = scriptedBackend();
    const listener = new EventStreamListener(f.backend, "zs_gf");
    // Simulate a stream that already consumed up to seq 5: 3/4 below the
    // watermark are stale (live push already delivered them), 6/7 are the gap.
    listener.lastSeq = 5;
    f.answer({
      eventSeq: 7,
      events: [ev(7), ev(3), ev(6), ev(4)],
    });

    await listener.resubscribe(() => 2);

    expect(f.requests[0]!.params).toMatchObject({ afterSeq: 5 });
    // Only events ABOVE the pre-resubscribe watermark queue; 3/4 are dropped.
    await expect(listener.pollEvent(0)).resolves.toMatchObject({ seq: 6 });
    await expect(listener.pollEvent(0)).resolves.toMatchObject({ seq: 7 });
    await expect(listener.pollEvent(0)).resolves.toBeNull();
    expect(listener.lastSeq).toBe(7);
  });

  it("resubscribe failure is non-fatal and returns false", async () => {
    const f = scriptedBackend();
    const listener = new EventStreamListener(f.backend, "zs_gf");
    f.answer(undefined, { code: -32004, message: "Session is not active" });

    await expect(listener.resubscribe(() => 3)).resolves.toBe(false);
    await expect(listener.pollEvent(0)).resolves.toBeNull();
  });
});
