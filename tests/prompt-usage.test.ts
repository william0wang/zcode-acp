/**
 * Prompt-turn usage passthrough tests.
 *
 * The backend merges every model call's usage into one billing-grade object on
 * `turn.completed`; `EventTranslator.turnUsage` captures it and `turnResult`
 * maps it onto the ACP `PromptResponse.usage` shape (UNSTABLE field, per-turn
 * semantics). Guards the field renames (reasoningTokens→thoughtTokens,
 * cacheRead/Write→cachedRead/Write), the cache-exclusive inputTokens
 * normalization (backend input is OpenAI-style cache-INCLUSIVE; ACP's de-facto
 * convention — claude-agent-acp, dsh-token-meter — is exclusive, so the
 * mapping subtracts cachedRead+cachedWrite and clamps at 0), the
 * required-counter 0-fill, the rawInputTokens `_meta` passthrough, and the
 * absent-when-absent contract (no synthetic zeros).
 */

import { describe, expect, it, vi } from "vitest";

import { toAcpTurnUsage, turnResult } from "../src/handlers/session.js";
import { EventTranslator } from "../src/translators/event-translator.js";

const FULL_USAGE = {
  source: "provider",
  modelRequestCount: 3,
  inputTokens: 1200,
  outputTokens: 350,
  totalTokens: 1550,
  cacheReadTokens: 900,
  cacheWriteTokens: 120,
  reasoningTokens: 200,
  webFetchRequests: 1,
  webSearchRequests: 0,
};

describe("toAcpTurnUsage", () => {
  it("maps null/absent usage to undefined (no synthetic zeros)", () => {
    expect(toAcpTurnUsage(null)).toBeUndefined();
  });

  it("renames backend fields and normalizes inputTokens to be cache-exclusive", () => {
    const mapped = toAcpTurnUsage(FULL_USAGE);
    expect(mapped).toEqual({
      totalTokens: 1550,
      inputTokens: 180, // 1200 − 900 cacheRead − 120 cacheWrite
      outputTokens: 350,
      thoughtTokens: 200,
      cachedReadTokens: 900,
      cachedWriteTokens: 120,
    });
    // The backend's totalTokens (input+output, cache-inclusive) must equal
    // the ACP convention's four-bucket sum after normalization — the hit-rate
    // denominators clients derive from these fields stay coherent.
    expect(
      (mapped?.inputTokens ?? 0) +
        (mapped?.outputTokens ?? 0) +
        (mapped?.cachedReadTokens ?? 0) +
        (mapped?.cachedWriteTokens ?? 0),
    ).toBe(mapped?.totalTokens);
  });

  it("clamps inputTokens at 0 when the cache buckets exceed it", () => {
    // Defensive against a future backend switch to cache-EXCLUSIVE input:
    // subtraction must not go negative.
    expect(
      toAcpTurnUsage({ inputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 50 }),
    ).toEqual({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: null,
      cachedReadTokens: 400,
      cachedWriteTokens: 50,
    });
  });

  it("normalizes a full cache hit to inputTokens 0 (input == cache sum)", () => {
    expect(toAcpTurnUsage({ inputTokens: 500, cacheReadTokens: 500, outputTokens: 2 })).toEqual({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 2,
      thoughtTokens: null,
      cachedReadTokens: 500,
      cachedWriteTokens: null,
    });
  });

  it("treats explicit null cache fields as absent (no subtraction)", () => {
    expect(
      toAcpTurnUsage({ inputTokens: 100, cacheReadTokens: null, cacheWriteTokens: null }),
    ).toEqual({
      totalTokens: 0,
      inputTokens: 100,
      outputTokens: 0,
      thoughtTokens: null,
      cachedReadTokens: null,
      cachedWriteTokens: null,
    });
  });

  it("0-fills missing required counters and nulls missing optional ones", () => {
    // VFe can keep a usage object that reported only, say, cache tokens; the
    // ACP schema requires the three counters (as numbers), the rest nullable.
    expect(toAcpTurnUsage({ cacheReadTokens: 42, reasoningTokens: 7 })).toEqual({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 7,
      cachedReadTokens: 42,
      cachedWriteTokens: null,
    });
  });

  it("ignores non-numeric values instead of trusting them", () => {
    expect(toAcpTurnUsage({ totalTokens: "many", inputTokens: null, outputTokens: 3 })).toEqual({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 3,
      thoughtTokens: null,
      cachedReadTokens: null,
      cachedWriteTokens: null,
    });
  });
});

describe("turnResult", () => {
  it("returns a bare stopReason when the turn reported no usage", () => {
    const t = new EventTranslator();
    t.translate({ type: "turn.completed", payload: { resultType: "success" } });
    expect(turnResult(t, "end_turn")).toEqual({ stopReason: "end_turn" });
  });

  it("attaches usage + _meta.zcode extras when the backend reported usage", () => {
    const t = new EventTranslator();
    t.translate({ type: "turn.completed", payload: { resultType: "success", usage: FULL_USAGE } });
    expect(turnResult(t, "end_turn")).toEqual({
      stopReason: "end_turn",
      usage: {
        totalTokens: 1550,
        inputTokens: 180,
        outputTokens: 350,
        thoughtTokens: 200,
        cachedReadTokens: 900,
        cachedWriteTokens: 120,
      },
      _meta: {
        zcode: {
          usage: {
            source: "provider",
            modelRequestCount: 3,
            webFetchRequests: 1,
            webSearchRequests: 0,
            rawInputTokens: 1200,
          },
        },
      },
    });
  });

  it("omits rawInputTokens when normalization left inputTokens untouched", () => {
    const t = new EventTranslator();
    t.translate({
      type: "turn.completed",
      payload: {
        resultType: "success",
        usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
      },
    });
    expect(turnResult(t, "end_turn")._meta).toEqual({ zcode: { usage: {} } });
  });

  it("attaches partial usage on a cancelled turn that reached turn.completed", () => {
    const t = new EventTranslator();
    t.translate({
      type: "turn.completed",
      payload: { resultType: "cancelled", usage: { inputTokens: 50, totalTokens: 60 } },
    });
    expect(turnResult(t, "cancelled")).toEqual({
      stopReason: "cancelled",
      usage: {
        totalTokens: 60,
        inputTokens: 50,
        outputTokens: 0,
        thoughtTokens: null,
        cachedReadTokens: null,
        cachedWriteTokens: null,
      },
      _meta: {
        zcode: {
          usage: {},
        },
      },
    });
  });

  it("publishes the bridge-measured llmMs in _meta.zcode.usage (ADR-0037)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const t = new EventTranslator();
      t.translate({ type: "turn.started", payload: {} });
      vi.setSystemTime(4_000);
      t.translate({
        type: "turn.completed",
        payload: { resultType: "success", usage: { inputTokens: 50, outputTokens: 10 } },
      });
      const res = turnResult(t, "end_turn");
      // llmMs rides the extras, NOT the ACP usage shape.
      expect(res._meta).toEqual({ zcode: { usage: { llmMs: 3_000 } } });
      expect(res.usage).toEqual({
        totalTokens: 0, // absent on the raw block → 0-filled, never invented
        inputTokens: 50,
        outputTokens: 10,
        thoughtTokens: null,
        cachedReadTokens: null,
        cachedWriteTokens: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
