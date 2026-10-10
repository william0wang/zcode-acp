/**
 * Turn-end status line — `turn.completed` resultType + cacheStats surfaced as
 * one session/update text line. Covers the full path: EventTranslator extracts
 * the fields onto a TurnInfo internal event, dispatchEvent renders it as an
 * agent_message_chunk (success → cache stats, non-success → resultType verbatim).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as acp from "@agentclientprotocol/sdk";

import { dispatchEvent } from "../src/handlers/dispatch.js";
import { ZcodeAcpServer } from "../src/server.js";
import { EventTranslator } from "../src/translators/event-translator.js";
import type { InternalEvent } from "../src/translators/types.js";

const SID = "sess-turninfo";
let scratch: string;

// Pin the language: line text is locale-dependent.
beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "zacp-turninfo-"));
  vi.stubEnv("XDG_CONFIG_HOME", scratch);
  vi.stubEnv("ZCODE_ACP_SHOW_COMPLETION_STATUS", "");
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

/** Mock AgentContext that records notify calls. */
function mockContext(): { cx: acp.AgentContext; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const cx = {
    notify(_method: string, params: { update: unknown }) {
      sent.push(params.update as Record<string, unknown>);
      return Promise.resolve();
    },
  } as unknown as acp.AgentContext;
  return { cx, sent };
}

function textOf(u: Record<string, unknown>): string {
  return ((u as { content?: { text?: string } }).content ?? {}).text ?? "";
}

describe("dispatchEvent TurnInfo rendering", () => {
  it.each(["0", "false", " FALSE ", "off", "no"])(
    "omits successful status when disabled by env %s",
    async (value) => {
      vi.stubEnv("ZCODE_ACP_SHOW_COMPLETION_STATUS", value);
      const { cx, sent } = mockContext();
      await dispatchEvent(
        new ZcodeAcpServer(),
        cx,
        SID,
        { kind: "TurnInfo", resultType: "success" },
        "off",
      );
      expect(sent).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "file preference %s overrides the environment and is read live",
    async (enabled) => {
      vi.stubEnv("ZCODE_ACP_SHOW_COMPLETION_STATUS", enabled ? "0" : "1");
      const dir = path.join(scratch, "zcode-acp");
      mkdirSync(dir);
      const file = path.join(dir, "config.json");
      writeFileSync(file, JSON.stringify({ session: { showCompletionStatus: enabled } }));
      const { cx, sent } = mockContext();
      const server = new ZcodeAcpServer();
      await dispatchEvent(server, cx, SID, { kind: "TurnInfo", resultType: "success" }, "first");
      expect(sent).toHaveLength(enabled ? 1 : 0);
      writeFileSync(file, JSON.stringify({ session: { showCompletionStatus: !enabled } }));
      await dispatchEvent(server, cx, SID, { kind: "TurnInfo", resultType: "success" }, "second");
      expect(sent).toHaveLength(1);
    },
  );

  it.each(["error_max_budget", "cancelled"])(
    "keeps %s warnings when successful status is disabled",
    async (resultType) => {
      vi.stubEnv("ZCODE_ACP_SHOW_COMPLETION_STATUS", "0");
      const { cx, sent } = mockContext();
      await dispatchEvent(
        new ZcodeAcpServer(),
        cx,
        SID,
        { kind: "TurnInfo", resultType },
        "warning",
      );
      expect(textOf(sent[0]!)).toBe(`⚠ stopped early: ${resultType}`);
    },
  );

  it("success + full cacheStats renders cache counts and compacted cache-read tokens", async () => {
    const { cx, sent } = mockContext();
    await dispatchEvent(
      new ZcodeAcpServer(),
      cx,
      SID,
      {
        kind: "TurnInfo",
        resultType: "success",
        cacheStats: {
          totalMessages: 45,
          cachedMessages: 42,
          lastCacheHit: true,
          cacheReadTokens: 12300,
        },
      },
      "chunk-1",
    );
    expect(sent).toHaveLength(1);
    const u = sent[0]!;
    expect(u["sessionUpdate"]).toBe("agent_message_chunk");
    expect(textOf(u)).toBe("✓ completed · cache 42/45 messages · 12.3k cache-read tokens");
    // Distinct messageId so the line stays a separate message from the reply.
    expect(u["messageId"]).toBe("turninfo_chunk-1");
  });

  it("success + cacheStats without cacheReadTokens omits the token part", async () => {
    const { cx, sent } = mockContext();
    await dispatchEvent(
      new ZcodeAcpServer(),
      cx,
      SID,
      {
        kind: "TurnInfo",
        resultType: "success",
        cacheStats: { totalMessages: 10, cachedMessages: 4, lastCacheHit: false },
      },
      "chunk-2",
    );
    expect(textOf(sent[0]!)).toBe("✓ completed · cache 4/10 messages");
  });

  it("success without cacheStats renders the bare completion line", async () => {
    const { cx, sent } = mockContext();
    await dispatchEvent(
      new ZcodeAcpServer(),
      cx,
      SID,
      { kind: "TurnInfo", resultType: "success" },
      "chunk-3",
    );
    expect(textOf(sent[0]!)).toBe("✓ completed");
  });

  it("non-success resultType is named verbatim in a warning-flavored line", async () => {
    const { cx, sent } = mockContext();
    await dispatchEvent(
      new ZcodeAcpServer(),
      cx,
      SID,
      { kind: "TurnInfo", resultType: "error_max_budget" },
      "chunk-4",
    );
    expect(textOf(sent[0]!)).toBe("⚠ stopped early: error_max_budget");
  });

  it("cancelled resultType surfaces as stopped early too", async () => {
    const { cx, sent } = mockContext();
    await dispatchEvent(
      new ZcodeAcpServer(),
      cx,
      SID,
      { kind: "TurnInfo", resultType: "cancelled" },
      "chunk-5",
    );
    expect(textOf(sent[0]!)).toBe("⚠ stopped early: cancelled");
  });
});

describe("translate → dispatch end-to-end", () => {
  it("keeps the reply as the last assistant message when successful status is disabled", async () => {
    vi.stubEnv("ZCODE_ACP_SHOW_COMPLETION_STATUS", "0");
    const { cx, sent } = mockContext();
    const server = new ZcodeAcpServer();
    const translator = new EventTranslator();
    const events = [
      ...translator.translate({
        type: "model.streaming",
        payload: { kind: "text_delta", delta: "reply body" },
      }),
      ...translator.translate({ type: "turn.completed", payload: { resultType: "success" } }),
    ];
    for (const event of events) await dispatchEvent(server, cx, SID, event, "reply");
    expect(sent).toHaveLength(1);
    expect(textOf(sent[0]!)).toBe("reply body");
    expect(sent[0]!["messageId"]).not.toMatch(/^turninfo_/);
  });

  it("emits the status line as the LAST session/update of the turn", async () => {
    const { cx, sent } = mockContext();
    const server = new ZcodeAcpServer();
    const t = new EventTranslator();
    const events: InternalEvent[] = [
      ...t.translate({
        type: "model.streaming",
        payload: { kind: "text_delta", delta: "reply body" },
      }),
      ...t.translate({
        type: "turn.completed",
        payload: {
          resultType: "success",
          tokenCount: 5,
          usage: { totalTokens: 5, contextWindow: 200000 },
          cacheStats: {
            totalMessages: 45,
            cachedMessages: 42,
            lastCacheHit: true,
            cacheReadTokens: 12300,
          },
        },
      }),
    ];
    // Same funnel as the turn loop (session.ts dispatches every translated
    // internal event through dispatchEvent with the prompt's chunkMsgId).
    for (const iev of events) {
      await dispatchEvent(server, cx, SID, iev, "chunk-e2e");
    }
    const last = sent[sent.length - 1]!;
    expect(last["sessionUpdate"]).toBe("agent_message_chunk");
    expect(textOf(last)).toBe("✓ completed · cache 42/45 messages · 12.3k cache-read tokens");
    // The reply text streamed before it, untouched. No usage_update here:
    // turn.completed's usage is cumulative consumption, never the context
    // meter (#228) — occupancy comes from the reconciliation diff instead.
    expect(sent).toHaveLength(2); // agent text + turn line
  });
});
