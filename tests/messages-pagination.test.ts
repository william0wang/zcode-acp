/**
 * Native pagination coverage for the bridge's history reads.
 *
 * `session/messages` takes `{sessionId, afterMessageId?, limit?}` and
 * `session/read` takes `messageLimit` (zcode-protocol index.ts:1648-1665).
 * The handler slices after-id then tail-limits in memory
 * (server-operations.ts:1865-1876) — the backend still reads the whole
 * store, so these options shrink the bridge-side payload and per-message
 * work, which is what made every turn-internal read on a huge session pay
 * the full-store cost.
 *
 * The turn loop's correctness contract lives in ProjectionDiffer.
 * historyAnchor: reads scoped to the anchor never re-emit pre-anchor
 * history (it was marked seen at turn entry) and never miss post-anchor
 * messages (the anchor advances with every baseline).
 */

import { describe, expect, it } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { TurnMonitor } from "../src/backend/listener.js";
import {
  fetchMessages,
  fetchMessagesSinceAnchor,
  type ZcodeMessage,
} from "../src/handlers/replay.js";
import { ProjectionDiffer } from "../src/translators/projection-differ.js";
import { ZcodeAcpServer } from "../src/server.js";

/** Fake backend recording every request's params. */
function recordingBackend(replies: Record<string, unknown> = {}): {
  backend: ZcodeBackend;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const backend = {
    isDead: false,
    request: async (_id: number, method: string, params: unknown) => {
      calls.push({ method, params });
      return { result: replies[method] ?? {} };
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, calls };
}

function serverWith(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  return server;
}

const msg = (id: string, role = "assistant"): ZcodeMessage =>
  ({ info: { id, role }, parts: [] }) as ZcodeMessage;

describe("fetchMessages native pagination", () => {
  it("sends the bare sessionId when no cursor options are given", async () => {
    const { backend, calls } = recordingBackend({ "session/messages": { messages: [] } });
    await fetchMessages(serverWith(backend), "sess_p");
    expect(calls).toEqual([{ method: "session/messages", params: { sessionId: "sess_p" } }]);
  });

  it("forwards afterMessageId and limit verbatim", async () => {
    const { backend, calls } = recordingBackend({
      "session/messages": { messages: [msg("m9")] },
    });
    const out = await fetchMessages(serverWith(backend), "sess_p", {
      afterMessageId: "m8",
      limit: 60,
    });
    expect(calls[0]!.params).toEqual({ sessionId: "sess_p", afterMessageId: "m8", limit: 60 });
    expect(out.map((m) => m.info?.id)).toEqual(["m9"]);
  });

  it("omits a null anchor (fresh differ degrades to a full read)", async () => {
    const { backend, calls } = recordingBackend({ "session/messages": { messages: [] } });
    await fetchMessages(serverWith(backend), "sess_p", { afterMessageId: null });
    expect(calls[0]!.params).toEqual({ sessionId: "sess_p" });
  });

  it("fetchMessagesSinceAnchor passes the anchor through", async () => {
    const { backend, calls } = recordingBackend({ "session/messages": { messages: [] } });
    await fetchMessagesSinceAnchor(serverWith(backend), "sess_p", "m_anchor");
    expect(calls[0]!.params).toEqual({ sessionId: "sess_p", afterMessageId: "m_anchor" });
  });
});

describe("ProjectionDiffer.historyAnchor", () => {
  it("advances to the newest baselined message id", () => {
    const differ = new ProjectionDiffer();
    expect(differ.historyAnchor).toBeNull();
    differ.markSeen([msg("m1", "user"), msg("m2"), msg("m3")]);
    expect(differ.historyAnchor).toBe("m3");
  });

  it("survives a failed (empty) read without losing the anchor", () => {
    const differ = new ProjectionDiffer();
    differ.markSeen([msg("m1"), msg("m2")]);
    // A read that degraded to [] (backend error) must not reset the anchor to
    // null — the next scoped read would silently become a full-history one.
    differ.markSeen([]);
    expect(differ.historyAnchor).toBe("m2");
  });

  it("takes the last id of the baselined list (full history or post-anchor window)", () => {
    const differ = new ProjectionDiffer();
    differ.markSeen([msg("m1"), msg("m2")]);
    // Both real call shapes end at the newest message: the turn-entry baseline
    // reads the full history, the re-baselines read the post-anchor window.
    differ.markSeen([msg("m3"), msg("m4")]);
    expect(differ.historyAnchor).toBe("m4");
  });

  it("a post-anchor read keeps the differ from re-emitting history", () => {
    const differ = new ProjectionDiffer();
    // Turn entry: the full history is the baseline (what makes the backend's
    // cursor-not-found full-list fallback safe — every pre-anchor id is seen).
    differ.markSeen([msg("h1", "user"), msg("h2"), msg("h3")]);
    // The turn appends; the completion diff only ever sees those messages.
    const events = differ.diff({
      projection: {},
      messages: [msg("t1"), msg("t2")],
      todos: [],
    } as never);
    expect(events.filter((e) => e.kind === "TextDelta")).toHaveLength(0);
    expect(differ.historyAnchor).toBe("h3");
  });
});

describe("session/read messageLimit", () => {
  it("the per-second projection poll caps the snapshot's message array", async () => {
    const { backend, calls } = recordingBackend({
      "session/read": { projection: { status: "idle" } },
    });
    const monitor = new TurnMonitor(backend, "sess_p", () => 1);
    const proj = await monitor.pollOnce();
    expect(proj).toEqual({ status: "idle" });
    // The bridge reads `projection` only; without the cap the backend
    // serializes the session's whole message array on every poll.
    expect(calls[0]!.params).toEqual({ sessionId: "sess_p", messageLimit: 1 });
  });
});
