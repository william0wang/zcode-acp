/**
 * auto-compact.ts tests — threshold parsing and the maybeAutoCompact trigger.
 *
 * The threshold reader is a pure function exercised directly. maybeAutoCompact
 * is tested with a mock backend (fake `request` returning canned projections)
 * and a mocked `compact` module so we verify the *decision* to compact without
 * running the full session/compact → waitForTurnIdle flow.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeResponse } from "../src/backend/types.js";

// --- mock compact so maybeAutoCompact's compact() call is observable ---

const compactMock = vi.fn();
vi.mock("../src/handlers/extensions.js", () => ({
  compact: (...args: unknown[]) => compactMock(...args),
}));

// Import AFTER mocks are registered.
import { autoCompactThreshold, maybeAutoCompact } from "../src/config/auto-compact.js";

/** Mock AgentContext that records notify calls (sendTextChunk + emitInitialUsage). */
function mockContext(notifySpy?: ReturnType<typeof vi.fn>): acp.AgentContext {
  return {
    notify: notifySpy ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as acp.AgentContext;
}

/** Extract text payloads from all agent_message_chunk notifies. */
function chunkTexts(notifySpy: ReturnType<typeof vi.fn>): string[] {
  return notifySpy.mock.calls
    .filter(([, p]) => p?.update?.sessionUpdate === "agent_message_chunk")
    .map(([, p]) => p.update.content.text as string);
}

/** A fake backend whose `request` returns canned responses by method. */
interface FakeBackend {
  request: ReturnType<typeof vi.fn>;
}

/** Build a server with a fake backend that returns the given projection. */
function makeServerWithProjection(
  contextUsed: number | null,
): { server: ZcodeAcpServer; backend: FakeBackend; compactCalls: typeof compactMock } {
  const backend: FakeBackend = {
    request: vi.fn(async (_id: number, method: string): Promise<ZcodeResponse> => {
      if (method === "session/read") {
        return {
          id: _id,
          result: {
            projection:
              contextUsed === null ? {} : { contextUsed, contextWindow: 200_000 },
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("autoCompactThreshold", () => {
  it("returns 0 when ENV is unset", () => {
    delete process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD;
    expect(autoCompactThreshold()).toBe(0);
  });

  it("returns 0 for '0'", () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "0";
    expect(autoCompactThreshold()).toBe(0);
  });

  it("returns the absolute token count for a positive integer", () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    expect(autoCompactThreshold()).toBe(100_000);
  });

  it("returns 0 for a negative number", () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "-500";
    expect(autoCompactThreshold()).toBe(0);
  });

  it("returns 0 for a non-numeric string", () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "abc";
    expect(autoCompactThreshold()).toBe(0);
  });

  it("returns 0 for NaN-producing values", () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "  ";
    expect(autoCompactThreshold()).toBe(0);
  });
});

describe("maybeAutoCompact", () => {
  it("is a no-op when threshold is unset (no backend call)", async () => {
    delete process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD;
    const { server, backend, compactCalls } = makeServerWithProjection(150_000);
    await maybeAutoCompact(server, mockContext(), "acp_1", "zc_1");
    expect(backend.request).not.toHaveBeenCalled();
    expect(compactCalls).not.toHaveBeenCalled();
  });

  it("is a no-op when usage is below the threshold", async () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    const { server, backend, compactCalls } = makeServerWithProjection(50_000);
    await maybeAutoCompact(server, mockContext(), "acp_1", "zc_1");
    // session/read was called to check usage, but compact was NOT.
    expect(backend.request).toHaveBeenCalledWith(
      expect.any(Number),
      "session/read",
      { sessionId: "zc_1" },
      5000,
    );
    expect(compactCalls).not.toHaveBeenCalled();
  });

  it("triggers compact when usage meets the threshold", async () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    const { server, compactCalls } = makeServerWithProjection(100_000);
    const cx = mockContext();
    await maybeAutoCompact(server, cx, "acp_1", "zc_1");
    expect(compactCalls).toHaveBeenCalledTimes(1);
    // compact() receives (server, { sessionId: acpSid }, cx).
    expect(compactCalls).toHaveBeenCalledWith(server, { sessionId: "acp_1" }, cx);
  });

  it("triggers compact when usage exceeds the threshold", async () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    const { server, compactCalls } = makeServerWithProjection(150_000);
    await maybeAutoCompact(server, mockContext(), "acp_1", "zc_1");
    expect(compactCalls).toHaveBeenCalledTimes(1);
  });

  it("does not throw when compact fails (best-effort)", async () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    const { server, compactCalls } = makeServerWithProjection(150_000);
    compactCalls.mockRejectedValueOnce(new Error("compact failed: backend error"));
    await expect(
      maybeAutoCompact(server, mockContext(), "acp_1", "zc_1"),
    ).resolves.toBeUndefined();
    expect(compactCalls).toHaveBeenCalledTimes(1);
  });

  it("does not throw when session/read returns an error", async () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    const backend: FakeBackend = {
      request: vi.fn(async (_id: number, _method: string): Promise<ZcodeResponse> => ({
        id: _id,
        error: { message: "session not found" },
      })),
    };
    const server = new ZcodeAcpServer();
    server.backend = backend as unknown as ZcodeAcpServer["backend"];
    compactMock.mockReset();
    compactMock.mockResolvedValue({});

    await expect(
      maybeAutoCompact(server, mockContext(), "acp_1", "zc_1"),
    ).resolves.toBeUndefined();
    expect(compactMock).not.toHaveBeenCalled();
  });

  it("does not trigger compact when contextUsed is 0 or missing", async () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    const { server, compactCalls } = makeServerWithProjection(null);
    await maybeAutoCompact(server, mockContext(), "acp_1", "zc_1");
    expect(compactCalls).not.toHaveBeenCalled();
  });

  it("sends progress notifications (start + done) to the client", async () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    const { server } = makeServerWithProjection(150_000);
    const notifySpy = vi.fn().mockResolvedValue(undefined);
    await maybeAutoCompact(server, mockContext(notifySpy), "acp_1", "zc_1");
    const texts = chunkTexts(notifySpy);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("🔄 auto-compact");
    expect(texts[0]).toContain("150,000");
    expect(texts[1]).toContain("✓ auto-compact");
  });

  it("sends a timeout warning when __lockTimeout is true", async () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    const { server } = makeServerWithProjection(150_000);
    compactMock.mockResolvedValueOnce({ __lockTimeout: true });
    const notifySpy = vi.fn().mockResolvedValue(undefined);
    await maybeAutoCompact(server, mockContext(notifySpy), "acp_1", "zc_1");
    const texts = chunkTexts(notifySpy);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("🔄 auto-compact");
    expect(texts[1]).toContain("⚠ auto-compact timed out");
  });

  it("sends an error notification when compact throws", async () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    const { server } = makeServerWithProjection(150_000);
    compactMock.mockRejectedValueOnce(new Error("compact failed: backend error"));
    const notifySpy = vi.fn().mockResolvedValue(undefined);
    await maybeAutoCompact(server, mockContext(notifySpy), "acp_1", "zc_1");
    const texts = chunkTexts(notifySpy);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("🔄 auto-compact");
    expect(texts[1]).toContain("⚠ auto-compact failed");
    expect(texts[1]).toContain("compact failed: backend error");
  });

  it("does not send any chunk when usage is below threshold", async () => {
    process.env.ZCODE_ACP_AUTO_COMPACT_THRESHOLD = "100000";
    const { server } = makeServerWithProjection(50_000);
    const notifySpy = vi.fn().mockResolvedValue(undefined);
    await maybeAutoCompact(server, mockContext(notifySpy), "acp_1", "zc_1");
    expect(chunkTexts(notifySpy)).toHaveLength(0);
  });
});
