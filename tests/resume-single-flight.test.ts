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
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import { loadSession } from "../src/handlers/session.js";
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
          return spec.resumeGate ?? {};
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
