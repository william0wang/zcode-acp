/**
 * auto-compact.ts tests — threshold parsing and the maybeAutoCompact trigger.
 *
 * The threshold reader is a pure function exercised directly. maybeAutoCompact
 * is tested with a mock backend (fake `request` returning canned projections)
 * and a mocked `compact` module so we verify the *decision* to compact without
 * running the full session/compact → waitForTurnIdle flow.
 */

import type * as acp from "@agentclientprotocol/sdk";
import {} from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeResponse } from "../src/backend/types.js";

// --- mock compact so maybeAutoCompact's compact() call is observable ---

const compactMock = vi.fn();
vi.mock("../src/handlers/extensions.js", () => ({
  compact: (...args: unknown[]) => compactMock(...args),
}));

// --- spy pushSettled so the §5.2 completion push is observable without the
// WeCom send machinery (send mechanics live in push-if-offline.test.ts) ---

const pushSettledMock = vi.fn();
vi.mock("../src/push/push.js", async (orig) => {
  const actual = await orig<typeof import("../src/push/push.js")>();
  return { ...actual, pushSettled: (...args: unknown[]) => pushSettledMock(...args) };
});

// Import AFTER mocks are registered.
import { maybeAutoCompact, runAutoCompactDetached } from "../src/config/auto-compact.js";

/** Mock AgentContext that records notify calls (sendTextChunk + emitInitialUsage). */
function mockContext(notifySpy?: ReturnType<typeof vi.fn>): acp.AgentContext {
  return {
    notify: notifySpy ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as acp.AgentContext;
}

/** Extract text payloads from all agent_message_chunk notifies. */

/** A fake backend whose `request` returns canned responses by method. */
interface FakeBackend {
  request: ReturnType<typeof vi.fn>;
}

/** Build a server with a fake backend that returns the given projection. */
function makeServerWithProjection(contextUsed: number | null): {
  server: ZcodeAcpServer;
  backend: FakeBackend;
  compactCalls: typeof compactMock;
} {
  const backend: FakeBackend = {
    request: vi.fn(async (_id: number, method: string): Promise<ZcodeResponse> => {
      if (method === "session/read") {
        return {
          id: _id,
          result: {
            projection: contextUsed === null ? {} : { contextUsed, contextWindow: 200_000 },
          },
        };
      }
      return { id: _id, result: {} };
    }),
  };
  const server = new ZcodeAcpServer();
  // Inject the fake backend so ensureBackend() returns it.
  server.backend = backend as unknown as ZcodeAcpServer["backend"];
  compactMock.mockReset();
  compactMock.mockResolvedValue({});
  return { server, backend, compactCalls: compactMock };
}

// Pin the language: asserted status lines are English and fs is not mocked
// (a real zh ~/.zcode/v2/setting.json would flip them on a zh-locale machine).
beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
  pushSettledMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("auto-compact completion push (§5.2 settled kind: compact)", () => {
  it("pushes once on success, after the done chunk", async () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    const { server } = makeServerWithProjection(150_000);
    await maybeAutoCompact(server, mockContext(), "acp_1", "zc_1");
    expect(pushSettledMock).toHaveBeenCalledTimes(1);
    expect(pushSettledMock).toHaveBeenCalledWith(
      server,
      expect.objectContaining({ kind: "compact", title: "auto-compact completed" }),
    );
  });

  it("pushes the backend-swallowed failure with a body", async () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    const { server } = makeServerWithProjection(150_000);
    compactMock.mockResolvedValueOnce({ __compactFailed: true });
    await maybeAutoCompact(server, mockContext(), "acp_1", "zc_1");
    expect(pushSettledMock).toHaveBeenCalledWith(
      server,
      expect.objectContaining({
        kind: "compact",
        title: "auto-compact failed",
        body: expect.any(String),
      }),
    );
  });
});

describe("runAutoCompactDetached (single-flight)", () => {
  it("swallows a second arm while one compaction runs, and clears the flag on settle", async () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    const { server, compactCalls } = makeServerWithProjection(150_000);
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    compactCalls.mockReset();
    compactCalls.mockReturnValue(gate.then(() => ({})));

    // Two arms while the first still runs — one compaction, flag held.
    runAutoCompactDetached(server, mockContext(), "acp_1", "zc_1");
    runAutoCompactDetached(server, mockContext(), "acp_1", "zc_1");
    await vi.waitFor(() => expect(compactCalls).toHaveBeenCalledTimes(1));
    expect(server.autoCompactInFlight.has("zc_1")).toBe(true);

    release({});
    await vi.waitFor(() => expect(server.autoCompactInFlight.has("zc_1")).toBe(false));

    // Flag cleared → a later arm runs again.
    compactCalls.mockResolvedValue({});
    runAutoCompactDetached(server, mockContext(), "acp_1", "zc_1");
    await vi.waitFor(() => expect(compactCalls).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(server.autoCompactInFlight.has("zc_1")).toBe(false));
  });
});
