/**
 * Resume single-flight + read-back settle (ADR-0017 first-entry race).
 *
 * The hub answers the App's incubation POST as soon as the TUI's bridge
 * REGISTERS — before the TUI's boot-resume finishes — so the App's
 * session/load races the boot-resume for the SAME backend session. Both used
 * to send `session/resume` concurrently, and the loser's session/messages
 * query could land mid-hydration, replaying a PREFIX (the conversation "ends
 * in the middle" on first entry; re-entry is fine).
 *
 * Fix under test: resumePreservingModel single-flights per backend session id
 * (concurrent callers join the in-flight resume), and the call that
 * PERFORMED the resume reads history through fetchMessagesSettled (poll
 * until the count stabilizes, capped).
 *
 * Mock layout mirrors tests/load-tail.test.ts.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import { fetchMessagesSettled, loadSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

vi.mock("../src/lazy-sessions.js", () => ({
  rememberLazySession: () => {},
  recordMaterializedSession: () => {},
  lookupLazySession: () => undefined,
}));

function hist(n: number): ZcodeMessage[] {
  const m = (id: string, role: "user" | "assistant", text: string): ZcodeMessage => ({
    info: { id, role },
    parts: [{ type: "text", text }],
  });
  const out: ZcodeMessage[] = [];
  for (let i = 0; i < n; i++) out.push(m(`m${i}`, i % 2 ? "assistant" : "user", `msg ${i}`));
  return out;
}

interface FakeBackendSpec {
  /** Successive session/messages reads (last entry repeats) — hydration sim. */
  messagesQueue: ZcodeMessage[][];
  /** Gate holding session/resume in flight until released (undefined: resolve at once). */
  resumeGate?: Promise<unknown>;
  /** Result payload for session/resume when no gate is set (default: {}). */
  resumeResult?: unknown;
}

/** Fake backend with per-method call counts. */
function makeBackend(spec: FakeBackendSpec): {
  backend: ZcodeBackend;
  counts: Map<string, number>;
} {
  const counts = new Map<string, number>();
  let mi = 0;
  const backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      counts.set(method, (counts.get(method) ?? 0) + 1);
      switch (method) {
        case "session/resume":
          return spec.resumeGate ?? (spec.resumeResult ? { result: spec.resumeResult } : {});
        case "workspace/updateProviderRegistry":
          return { result: {} };
        case "session/read":
          return { result: { projection: { contextUsed: 0 }, settings: {} } };
        case "session/messages":
          return {
            result: { messages: spec.messagesQueue[Math.min(mi++, spec.messagesQueue.length - 1)] },
          };
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, counts };
}

/** cx that collects session/update payloads. */
function collectCx(): { cx: acp.AgentContext; updates: acp.SessionUpdate[] } {
  const updates: acp.SessionUpdate[] = [];
  const cx = {
    notify: async (_method: string, params: { update: acp.SessionUpdate }) => {
      updates.push(params.update);
    },
    request: async () => ({}),
  } as unknown as acp.AgentContext;
  return { cx, updates };
}

function chunks(updates: acp.SessionUpdate[]): string[] {
  return updates
    .filter(
      (u) => u.sessionUpdate === "user_message_chunk" || u.sessionUpdate === "agent_message_chunk",
    )
    .map((u) => (u as { content?: { text?: string } }).content?.text ?? "");
}

function loadParams(): acp.LoadSessionRequest {
  return { sessionId: "sess_race", cwd: "/tmp/ws", mcpServers: [] } as acp.LoadSessionRequest;
}

const tick = () => new Promise((r) => setImmediate(r));

/** Drain enough ticks for a load to park on (or join) the resume flight. */
const park = async () => {
  for (let i = 0; i < 3; i++) await tick();
};

beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});

describe("resume single-flight (ADR-0017 first-entry race)", () => {
  it("one flight, one resume RPC — the JOINER is also ordered after hydration settle", async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise<unknown>((r) => (release = r));
    // Slow hydration ladder: 3 → 3 (plateau!) → 8. The settle inside the
    // flight reads 3, 3, 8, 8, 8 (two-pair stability). A joiner that only
    // awaited the RPC (the pre-fix shape) read right after the resume —
    // landing on the second "3" and replaying a prefix; the flight-shared
    // settled snapshot must carry 8 to BOTH loads.
    const { backend, counts } = makeBackend({
      messagesQueue: [hist(3), hist(3), hist(8)],
      resumeGate: gate,
    });

    const server = new ZcodeAcpServer();
    server.backend = backend;
    const cx1 = collectCx();
    const cx2 = collectCx();

    const p1 = loadSession(server, loadParams(), cx1.cx);
    await park();
    const p2 = loadSession(server, loadParams(), cx2.cx);
    await park();
    // Both loads are now parked: p1 performing the resume, p2 joined the
    // in-flight one instead of sending its own.
    release({});
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(counts.get("session/resume")).toBe(1);
    for (const [label, r] of [
      ["performer", r1],
      ["joiner", r2],
    ] as const) {
      expect(
        (r as { replayMeta?: { totalMessages?: number } }).replayMeta?.totalMessages,
        `${label} saw a settled history`,
      ).toBe(8);
    }
    expect(chunks(cx1.updates)).toHaveLength(8);
    expect(chunks(cx2.updates)).toHaveLength(8);
    expect(server.resumeInFlight.size).toBe(0);
  }, 10_000);

  it("joiners await the first flight's failure (both loads fail with the same error)", async () => {
    // The gate rejects only AFTER both loads are parked on the flight — an
    // eagerly-rejected gate lets p1 finish (and delete its in-flight entry)
    // before p2 starts, which would not exercise the joiner path at all.
    let explode!: () => void;
    const gate = new Promise<unknown>((_, rej) => (explode = () => rej(new Error("boom"))));
    // No-op guard so an un-joined gate is never "unhandled"; the rejection
    // still reaches every real awaiter.
    gate.catch(() => {});
    const { backend, counts } = makeBackend({ messagesQueue: [hist(8)], resumeGate: gate });

    const server = new ZcodeAcpServer();
    server.backend = backend;
    const cx1 = collectCx();
    const cx2 = collectCx();

    const p1 = loadSession(server, loadParams(), cx1.cx);
    await park();
    const p2 = loadSession(server, loadParams(), cx2.cx);
    await park();
    // Exactly one flight: p2 joined p1's, it did not send its own resume.
    expect(counts.get("session/resume")).toBe(1);
    explode();

    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");
    expect(server.resumeInFlight.size).toBe(0);
  });
});

describe("resume snapshot model-availability mining", () => {
  it("caches the FULL settings.model.available list from the resume snapshot", async () => {
    // session/resume (like create/fork, unlike session/read) returns the
    // complete list with reasoning metadata (server-operations.ts:1518-1521
    // builds the snapshot without options → app.listModels(); read hardcodes
    // "current" at :1828-1831). A model added after session/create must enter
    // the switch-time level lookup for free — the bridge used to cache
    // create-only, so level-bearing switches on it hard-failed.
    const { backend } = makeBackend({
      messagesQueue: [hist(2)],
      resumeResult: {
        session: { sessionId: "sess_race" },
        settings: {
          model: {
            available: [
              {
                ref: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.2" },
                reasoning: { defaultLevel: "high", levels: [{ value: "low" }, { value: "high" }] },
              },
            ],
          },
        },
      },
    });
    const server = new ZcodeAcpServer();
    server.backend = backend;
    const { cx } = collectCx();

    await loadSession(server, loadParams(), cx);
    expect(server.modelAvailability.get("sess_race")).toEqual([
      {
        providerId: "account:bigmodel-individual-coding-plan",
        modelId: "GLM-5.2",
        defaultLevel: "high",
      },
    ]);
  });
});

describe("read-back settle (fetchMessagesSettled via loadSession)", () => {
  it("a hydrating store is polled until the count stabilizes — replay uses the FULL history", async () => {
    // Hydration ladder: 3 → 8 → 8 (stable). The first read is a prefix; the
    // settle poll must not ship it as the whole conversation.
    const { backend } = makeBackend({ messagesQueue: [hist(3), hist(8), hist(8)] });
    const server = new ZcodeAcpServer();
    server.backend = backend;
    const { cx, updates } = collectCx();

    const r = await loadSession(server, loadParams(), cx);

    expect((r as { replayMeta?: { totalMessages?: number } }).replayMeta?.totalMessages).toBe(8);
    expect(chunks(updates)).toHaveLength(8);
  });

  it("an already-live session skips resume and the settle poll alike", async () => {
    const { backend, counts } = makeBackend({ messagesQueue: [hist(8)] });
    const server = new ZcodeAcpServer();
    server.backend = backend;
    const cx1 = collectCx();
    const cx2 = collectCx();

    await loadSession(server, loadParams(), cx1.cx);
    await loadSession(server, loadParams(), cx2.cx);

    // Second load: alreadyLive → no second resume; its plain history read may
    // settle-share the performer's ladder, but never a THIRD resume.
    expect(counts.get("session/resume")).toBe(1);
    expect(chunks(cx2.updates)).toHaveLength(8);
    expect(server.resumeInFlight.size).toBe(0);
  });
});

describe("cap-truncated settle + alreadyLive re-settle (hydration gap)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a capped flight arms the unsettled marker; the next (alreadyLive) load re-settles and replays the FULL history", async () => {
    // Hydration slower than the settle cap, then stable: the ladder grows on
    // every read past the 30s cap, then flattens at 122 — the shape a long
    // session shows on the App's cold-incubation first entry. (Fake-timer
    // reads are instant; only the 300ms gaps consume the cap, so the ladder
    // must outgrow ~100 iterations for the cap to fire.)
    const ladder: ZcodeMessage[][] = [];
    for (let n = 3; n <= 122; n++) ladder.push(hist(n));
    ladder.push(hist(122), hist(122));
    const { backend } = makeBackend({ messagesQueue: ladder });
    const server = new ZcodeAcpServer();
    server.backend = backend;
    const cx1 = collectCx();

    const p1 = loadSession(server, loadParams(), cx1.cx);
    await vi.advanceTimersByTimeAsync(31_000);
    const r1 = await p1;

    // Cap exit: the largest partial snapshot shipped AND the marker armed.
    const total1 = (r1 as { replayMeta?: { totalMessages?: number } }).replayMeta?.totalMessages;
    expect(total1).toBeGreaterThan(0);
    expect(total1).toBeLessThan(122);
    expect(server.hydrationUnsettled.has("sess_race")).toBe(true);

    // Second client, alreadyLive (no resume flight): the plain read is
    // marker-guarded — it re-settles through the remaining ladder and replays
    // the COMPLETE history instead of another prefix.
    const cx2 = collectCx();
    const p2 = loadSession(server, loadParams(), cx2.cx);
    await vi.advanceTimersByTimeAsync(15_000);
    const r2 = await p2;

    expect((r2 as { replayMeta?: { totalMessages?: number } }).replayMeta?.totalMessages).toBe(122);
    expect(chunks(cx2.updates)).toHaveLength(122);
    expect(server.hydrationUnsettled.size).toBe(0);
  }, 15_000);

  it("a re-settle with a watermark clears the marker after ONE confirming read (slow-reader catch-up)", async () => {
    // The 0.44.1 regression: big sessions read in seconds, the two-stable
    // plateau never fit the cap again, and every load re-paid a capped
    // settle. With a watermark from the capped exit, one non-growing read
    // that reaches it is caught-up — two reads total, marker cleared.
    const { backend, counts } = makeBackend({ messagesQueue: [hist(8)] });
    const server = new ZcodeAcpServer();
    server.backend = backend;
    server.hydrationUnsettled.add("sess_race");
    server.hydrationWatermark.set("sess_race", 8);
    const { cx, updates } = collectCx();

    const p = loadSession(server, loadParams(), cx);
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await p;

    expect((r as { replayMeta?: { totalMessages?: number } }).replayMeta?.totalMessages).toBe(8);
    expect(chunks(updates)).toHaveLength(8);
    expect(server.hydrationUnsettled.size).toBe(0);
    // Settle reads: initial + ONE confirming read (+1 buildSnapshot baseline).
    expect(counts.get("session/messages")).toBe(3);
  });

  it("a stable session never arms the marker — alreadyLive loads do no settle poll", async () => {
    const { backend, counts } = makeBackend({ messagesQueue: [hist(8)] });
    const server = new ZcodeAcpServer();
    server.backend = backend;
    const cx1 = collectCx();
    const cx2 = collectCx();

    const p1 = loadSession(server, loadParams(), cx1.cx);
    await vi.advanceTimersByTimeAsync(1_000);
    await p1;
    expect(server.hydrationUnsettled.size).toBe(0);
    const readsAfterFirst = counts.get("session/messages") ?? 0;

    // AlreadyLive + no marker: the replay does ONE plain read (+1 for
    // buildSnapshot's differ baseline) and completes without a single timer
    // tick — a settle poll would need two 300ms gaps and show up here as
    // extra reads (or as a hang, with the 0ms advance above).
    const p2 = loadSession(server, loadParams(), cx2.cx);
    await vi.advanceTimersByTimeAsync(0);
    await p2;
    expect(counts.get("session/messages") ?? 0).toBe(readsAfterFirst + 2);
  });

  it("fast-path needs the CONFIRMING read to reach the watermark — a dipping read falls back to the plateau rule", async () => {
    // Marker armed by a capped settle that saw 3 of a still-growing store.
    // The re-settle's entry read jumps to 5 (raising the live watermark), the
    // next read DIPS to 3: the running max (5) reaches the watermark but the
    // confirming read (3) does not — no fast exit. The pre-hardening code
    // exited here on the running max alone, shipping whatever prefix the
    // max-read caught if hydration was merely stalled.
    const { backend, counts } = makeBackend({
      messagesQueue: [hist(3), hist(5), hist(3), hist(3), hist(3)],
    });
    const server = new ZcodeAcpServer();
    server.backend = backend;
    server.hydrationUnsettled.add("sess_race");
    server.hydrationWatermark.set("sess_race", 3);

    const p = fetchMessagesSettled(server, "sess_race");
    await vi.advanceTimersByTimeAsync(2_000);
    const out = await p;

    // Entry + growth read + TWO plateau reads (no fast exit): 4 total.
    expect(counts.get("session/messages")).toBe(4);
    expect(out).toHaveLength(5); // largest snapshot wins
    expect(server.hydrationUnsettled.size).toBe(0); // plateau cleared the marker
    expect(server.hydrationWatermark.get("sess_race")).toBe(5); // monotonic
  });

  it("watermark writes are monotonic — a settle on a smaller store never trades it down", async () => {
    // A capped settle once saw 8; compaction then shrank the store to 4. The
    // re-settle can never reach 8, exits via the plateau rule, and must leave
    // the watermark at 8 — trading down would break a future re-hydration's
    // catch-up anchor.
    const { backend } = makeBackend({ messagesQueue: [hist(4), hist(4), hist(4)] });
    const server = new ZcodeAcpServer();
    server.backend = backend;
    server.hydrationUnsettled.add("sess_race");
    server.hydrationWatermark.set("sess_race", 8);

    const p = fetchMessagesSettled(server, "sess_race");
    await vi.advanceTimersByTimeAsync(2_000);
    const out = await p;

    expect(out).toHaveLength(4);
    expect(server.hydrationUnsettled.size).toBe(0);
    expect(server.hydrationWatermark.get("sess_race")).toBe(8);
  });
});
