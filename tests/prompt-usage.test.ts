/**
 * Prompt-turn usage passthrough tests.
 *
 * The backend merges every model call's usage into one billing-grade object on
 * `turn.completed`; `EventTranslator.turnUsage` captures it and `turnResult`
 * maps it onto the ACP `PromptResponse.usage` shape (UNSTABLE field, per-turn
 * semantics). Guards the field renames (reasoningTokens→thoughtTokens,
 * cacheRead/Write→cachedRead/Write), the required-counter 0-fill, and the
 * absent-when-absent contract (no synthetic zeros).
 */

import { describe, expect, it } from "vitest";

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

  it("renames backend fields onto the ACP Usage shape", () => {
    expect(toAcpTurnUsage(FULL_USAGE)).toEqual({
      totalTokens: 1550,
      inputTokens: 1200,
      outputTokens: 350,
      thoughtTokens: 200,
      cachedReadTokens: 900,
      cachedWriteTokens: 120,
    });
  });

  it("0-fills missing required counters and nulls missing optional ones", () => {
    // VFe can keep a usage object that reported only, say, cache tokens; the
    // ACP schema requires the three counters (as numbers), the rest nullable.
    expect(
      toAcpTurnUsage({ cacheReadTokens: 42, reasoningTokens: 7 }),
    ).toEqual({
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
        inputTokens: 1200,
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
          },
        },
      },
    });
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
});
