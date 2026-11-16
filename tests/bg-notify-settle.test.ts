/**
 * Background notification turn settle-before-read (2026-11-15 bug):
 * a load/resume whose history fetch races an ACTIVE notification turn's tail
 * ships an empty-shell last reply (the assistant row exists from request
 * start; its text parts persist only at turn completion). The client caches
 * the shell as synced — same message count — so the reply stays invisible
 * until the next prompt. waitForBackgroundTurnIdle gates every history read
 * on loadSession / resumeSession / resumeIntoSession behind the turn's
 * terminal event.
 *
 * Mock layout mirrors tests/load-tail.test.ts (tasks-index and the durable
 * alias store are mocked away; the fake backend serves session/messages and
 * asserts the turn marker was already cleared when the fetch landed).
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import { loadSession, waitForBackgroundTurnIdle } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

vi.mock("../src/lazy-sessions.js", () => ({
  rememberLazySession: () => {},
  recordMaterializedSession: () => {},
  recordAdvertisedModel: () => {},
  lookupLazySession: () => undefined,
}));

const SID = "sess_bgsettle";

function hist(): ZcodeMessage[] {
  const m = (id: string, role: "user" | "assistant", text: string): ZcodeMessage => ({
    info: { id, role },
    parts: [{ type: "text", text }],
  });
  return [m("u1", "user", "run the download"), m("a1", "assistant", "started in background")];
}

/**
 * Fake backend whose session/messages handler records whether the notify-turn
 * marker was still set when the fetch landed. `onFetch` can swap the payload
 * (tests return a shell — the turn's row without text parts — when the marker
 * is still up, proving the gate order).
 */
function fakeBackend(
  server: ZcodeAcpServer,
  onFetch: (markerStillSet: boolean) => ZcodeMessage[],
): { backend: ZcodeBackend; fetchesWithMarkerSet: number } {
  const seen = { markerSet: 0, total: 0 };
  const backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      switch (method) {
        case "session/resume":
        case "workspace/updateProviderRegistry":
          return { result: {} };
        case "session/read":
          return { result: { projection: { contextUsed: 0 }, settings: {} } };
        case "session/messages": {
          seen.total += 1;
          // The marker MUST be gone by the time any history fetch runs —
          // that is the entire contract under test.
          const markerStillSet = server.notifyTurnActiveSince.has(SID);
          if (markerStillSet) seen.markerSet += 1;
          return { result: { messages: onFetch(markerStillSet) } };
        }
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return {
    backend,
    get fetchesWithMarkerSet() {
      return seen.markerSet;
    },
  };
}

function collectCx(): acp.AgentContext {
  return {
    notify: async () => {},
    request: async () => ({}),
  } as unknown as acp.AgentContext;
}

function loadParams(extra: Record<string, unknown> = {}): acp.LoadSessionRequest {
  return {
    sessionId: SID,
    cwd: "/tmp/ws",
    mcpServers: [],
    ...extra,
  } as acp.LoadSessionRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("waitForBackgroundTurnIdle", () => {
  it("returns immediately when no notification turn is active", async () => {
    const server = new ZcodeAcpServer();
    const t0 = Date.now();
    await expect(waitForBackgroundTurnIdle(server, "zs_none")).resolves.toBe(true);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("returns immediately for a stale marker (terminal event was lost)", async () => {
    const server = new ZcodeAcpServer();
    server.notifyTurnActiveSince.set("zs_stale", Date.now() - 15 * 60_000);
    const t0 = Date.now();
    await expect(waitForBackgroundTurnIdle(server, "zs_stale")).resolves.toBe(true);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("waits until the marker clears (real timers, sub-second)", async () => {
    const server = new ZcodeAcpServer();
    server.notifyTurnActiveSince.set("zs_wait", Date.now());
    setTimeout(() => server.notifyTurnActiveSince.delete("zs_wait"), 300);
    const t0 = Date.now();
    await expect(waitForBackgroundTurnIdle(server, "zs_wait")).resolves.toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  });

  it("gives up after the settle cap when the turn never ends", async () => {
    vi.useFakeTimers();
    const server = new ZcodeAcpServer();
    server.notifyTurnActiveSince.set("zs_stuck", Date.now());
    const pending = waitForBackgroundTurnIdle(server, "zs_stuck");
    // Drive the 250ms poll loop past the 45s cap.
    let settled: boolean | undefined;
    void pending.then((v) => {
      settled = v;
    });
    await vi.advanceTimersByTimeAsync(46_000);
    expect(settled).toBe(false);
  });
});

describe("session/load waits out an active notification turn", () => {
  it("fetches history only after the turn marker cleared (full attach)", async () => {
    const server = new ZcodeAcpServer();
    const full = hist();
    const shell: ZcodeMessage[] = [
      ...full,
      // The notification turn's assistant row — present (written at request
      // start) but with NO text parts (they persist at turn completion).
      { info: { id: "a2", role: "assistant" }, parts: [] },
    ];
    const fb = fakeBackend(server, (markerStillSet) => (markerStillSet ? shell : full));
    server.backend = fb.backend;
    server.notifyTurnActiveSince.set(SID, Date.now());
    setTimeout(() => server.notifyTurnActiveSince.delete(SID), 300);

    const { cx } = { cx: collectCx() };
    await loadSession(server, loadParams(), cx);

    expect(fb.fetchesWithMarkerSet).toBe(0);
  });

  it("metadata-only attach (limit 0) waits as well — its count feeds the client reconcile", async () => {
    const server = new ZcodeAcpServer();
    const full = hist();
    const fb = fakeBackend(server, () => full);
    server.backend = fb.backend;
    server.notifyTurnActiveSince.set(SID, Date.now());
    setTimeout(() => server.notifyTurnActiveSince.delete(SID), 300);

    await loadSession(server, loadParams({ _meta: { zcode: { limit: 0 } } }), collectCx());

    expect(fb.fetchesWithMarkerSet).toBe(0);
  });

  it("no marker → load proceeds with no settle delay", async () => {
    const server = new ZcodeAcpServer();
    const full = hist();
    const fb = fakeBackend(server, () => full);
    server.backend = fb.backend;

    const t0 = Date.now();
    await loadSession(server, loadParams(), collectCx());

    expect(fb.fetchesWithMarkerSet).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
