/**
 * Tests for AskUserQuestion fallback path cancellation behaviour.
 *
 * Bug: when an AskUserQuestion carries multiple questions (especially
 * multi-select ones), the fallback `request_permission` path emitted one
 * popup per question / per option in a tight loop with no cancel/interrupt
 * check. If the user sent a new prompt (preempting the turn) or a popup was
 * interrupted, the remaining popups still fired and blocked the new task.
 *
 * These tests verify the fix: the loop now aborts immediately on
 * `turn.cancelled` or `resp === null`, returning a single decline instead
 * of continuing to pop.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { PendingTurn, ZcodeAcpServer } from "../src/server.js";
import type { ZcodeInteractionUserInputParams } from "../src/backend/types.js";

// Mock sendSessionUpdate so emitAskToolCall does not need a real cx.notify.
vi.mock("../src/handlers/io.js", () => ({
  sendSessionUpdate: vi.fn().mockResolvedValue(undefined),
}));

import { handleAskUserQuestion } from "../src/handlers/server-requests.js";

/** Minimal server stub: elicitation NOT supported (forces fallback path). */
function makeServer(): ZcodeAcpServer {
  return {
    supportsElicitationForm: () => false,
    nextId: () => 1,
  } as unknown as ZcodeAcpServer;
}

/** Build a cx whose `request` resolves to a sequence of canned outcomes. */
function makeCx(outcomes: Array<Record<string, unknown> | null>): {
  cx: acp.AgentContext;
  callCount: () => number;
} {
  let i = 0;
  const request = vi.fn(async (): Promise<unknown> => {
    const out = outcomes[i] ?? outcomes[outcomes.length - 1] ?? null;
    i++;
    return out;
  });
  const cx = { request } as unknown as acp.AgentContext;
  return { cx, callCount: () => request.mock.calls.length };
}

/** One multi-select question with two options. */
function multiSelectParams(): ZcodeInteractionUserInputParams {
  return {
    requestId: "r1",
    sessionId: "s1",
    toolCallId: "tc1",
    questions: [
      {
        question: "Which frameworks?",
        multiSelect: true,
        options: [{ label: "React" }, { label: "Vue" }, { label: "Svelte" }],
      },
    ],
  };
}

/** Two single-select questions. */
function twoSingleSelectParams(): ZcodeInteractionUserInputParams {
  return {
    requestId: "r2",
    sessionId: "s1",
    toolCallId: "tc2",
    questions: [
      {
        question: "Language?",
        multiSelect: false,
        options: [{ label: "TS" }, { label: "JS" }],
      },
      {
        question: "Bundler?",
        multiSelect: false,
        options: [{ label: "vite" }, { label: "webpack" }],
      },
    ],
  };
}

describe("AskUserQuestion multi-select fallback: cancel/timeout aborts loop", () => {
  it("stops after the first option returns null (declined) and declines", async () => {
    const server = makeServer();
    const { cx, callCount } = makeCx([null, null, null]); // all declined
    const result = await handleAskUserQuestion(server, cx, "s1", multiSelectParams());
    expect(result).toEqual({ action: "decline", reason: "cancelled or interrupted" });
    // Only ONE request_permission should have fired (the first option), not 3.
    expect(callCount()).toBe(1);
  });

  it("stops when turn.cancelled flips mid-loop", async () => {
    const server = makeServer();
    const turn: PendingTurn = {
      zcodeSid: "s1",
      cancelled: false,
    } as PendingTurn;
    // First option: user picks React (optionId "React:yes"). Then we flip
    // cancelled before the second option popup fires.
    const { cx, callCount } = makeCx([{ outcome: { outcome: "selected", optionId: "React:yes" } }]);
    // Flip cancelled right after the first request resolves.
    const origRequest = cx.request;
    let firstDone = false;
    (cx as { request: typeof origRequest }).request = (async (...args: unknown[]) => {
      const r = await (origRequest as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
      if (!firstDone) {
        firstDone = true;
        turn.cancelled = true;
      }
      return r;
    }) as typeof origRequest;
    const result = await handleAskUserQuestion(server, cx, "s1", multiSelectParams(), turn);
    expect(result).toEqual({ action: "decline", reason: "cancelled or interrupted" });
    // Only one popup fired despite 3 options.
    expect(callCount()).toBe(1);
  });

  it("completes normally when all options answered (no cancellation)", async () => {
    const server = makeServer();
    const { cx, callCount } = makeCx([
      { outcome: { outcome: "selected", optionId: "React:yes" } },
      { outcome: { outcome: "selected", optionId: "Vue:no" } },
      { outcome: { outcome: "selected", optionId: "Svelte:yes" } },
    ]);
    const result = await handleAskUserQuestion(server, cx, "s1", multiSelectParams());
    expect(result).toMatchObject({ action: "accept" });
    expect(callCount()).toBe(3); // all three options asked
  });
});

describe("AskUserQuestion single-select fallback: cancel aborts multi-question loop", () => {
  it("stops after first question when turn.cancelled flips", async () => {
    const server = makeServer();
    const turn: PendingTurn = {
      zcodeSid: "s1",
      cancelled: false,
    } as PendingTurn;
    const { cx, callCount } = makeCx([{ outcome: { outcome: "selected", optionId: "TS" } }]);
    const origRequest = cx.request;
    let firstDone = false;
    (cx as { request: typeof origRequest }).request = (async (...args: unknown[]) => {
      const r = await (origRequest as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
      if (!firstDone) {
        firstDone = true;
        turn.cancelled = true;
      }
      return r;
    }) as typeof origRequest;
    const result = await handleAskUserQuestion(server, cx, "s1", twoSingleSelectParams(), turn);
    expect(result).toEqual({ action: "decline", reason: "turn cancelled" });
    // Only the first question's popup fired; the second was never asked.
    expect(callCount()).toBe(1);
  });

  it("declines on first-question skip and does not ask the second", async () => {
    const server = makeServer();
    // __skip__ → parseAskUserResponse returns null → decline, no second popup.
    const { cx, callCount } = makeCx([{ outcome: { outcome: "selected", optionId: "__skip__" } }]);
    const result = await handleAskUserQuestion(server, cx, "s1", twoSingleSelectParams());
    expect(result).toEqual({ action: "decline", reason: "skipped or cancelled" });
    expect(callCount()).toBe(1);
  });
});
