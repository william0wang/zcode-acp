/**
 * Turn-read reduction (ADR-0035): a tool result mid-turn no longer triggers
 * per-result whole-store reads (session/messages edit-diff fetch, session/read
 * todo sync). The live result event still closes the card; the rich payload
 * (diff/locations) and the todo list ride the turn-completion reconciliation,
 * which reads the store once regardless of tool count.
 *
 * Level 1 (unit): ProjectionDiffer.deferToolPayload holds the completed
 * transition back so diffToolPart's status-transition branch fires from the
 * completion snapshot and attaches the diff.
 * Level 2 (prompt-level): the fake-backend turn loop counts session/messages
 * and session/read calls across a 2-tool turn — the pre-0035 shape made 3
 * per-tool-result reads; the contract now is baseline + completion only.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prompt } from "../src/handlers/session.js";
import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { ZcodeAcpServer } from "../src/server.js";
import { ProjectionDiffer } from "../src/translators/projection-differ.js";
import { EventTranslator } from "../src/translators/event-translator.js";

beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Level 1: the differ's deferred completed transition.
// ---------------------------------------------------------------------------

const diffToolPart = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "tool",
  callId: "c1",
  tool: "Edit",
  state: {
    status: "completed",
    input: { file_path: "/tmp/a.ts" },
    metadata: {
      display: {
        kind: "file_diff",
        filePath: "/tmp/a.ts",
        structuredPatch: [{ oldStart: 1, newStart: 1, lines: ["-old", "+new", " ctx"] }],
      },
    },
  },
  ...over,
});

type DiffToolPartArg = Parameters<ProjectionDiffer["diffToolPart"]>[0];

describe("ProjectionDiffer.deferToolPayload", () => {
  it("delivers the diff from the completion snapshot after the live result closed the card", () => {
    const differ = new ProjectionDiffer();
    // Live path: scheduled + result events dispatched the card and closed it.
    differ.markToolSeen("c1");
    differ.deferToolPayload("c1");

    // Completion snapshot: the completed transition was withheld, so the
    // status-transition branch fires and carries the rich payload.
    const events = differ.diffToolPart(diffToolPart() as DiffToolPartArg);
    expect(events).toHaveLength(1);
    const ev = events[0] as unknown as Record<string, unknown>;
    expect(ev["kind"]).toBe("ToolCallUpdate");
    expect(ev["status"]).toBe("completed");
    expect(Array.isArray(ev["diffContent"])).toBe(true);
    expect(ev["locations"]).toEqual([{ path: "/tmp/a.ts", line: 1 }]);

    // The completion diff consumed the deferral: a second snapshot read is a
    // no-op (status map now completed).
    expect(differ.diffToolPart(diffToolPart() as DiffToolPartArg)).toHaveLength(0);
  });

  it("emits a content-less transition when the snapshot never wrote a diff", () => {
    const differ = new ProjectionDiffer();
    differ.markToolSeen("c1");
    differ.deferToolPayload("c1");

    const bare = diffToolPart({
      state: { status: "completed", input: { file_path: "/tmp/a.ts" } },
    }) as DiffToolPartArg;
    const events = differ.diffToolPart(bare);
    expect(events).toHaveLength(1);
    const ev = events[0] as unknown as Record<string, unknown>;
    expect(ev["kind"]).toBe("ToolCallUpdate");
    expect(ev["diffContent"]).toBeUndefined();
  });

  it("ignores ids the live path never saw (no withheld status, new-tool branch as usual)", () => {
    const differ = new ProjectionDiffer();
    differ.deferToolPayload("nope");
    // c1 was never seen live → the snapshot's part takes the new-tool branch.
    const events = differ.diffToolPart(diffToolPart({ callId: "c1" }) as DiffToolPartArg);
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as Record<string, unknown>)["kind"]).toBe("ToolCallNew");
  });
});

// ---------------------------------------------------------------------------
// Level 2: the turn loop makes no per-tool-result store reads.
// ---------------------------------------------------------------------------

type EvFactory = (
  type: string,
  turnId: string | undefined,
  payload?: Record<string, unknown>,
) => ZcodeEvent;

function fakeBackend(): {
  backend: ZcodeBackend;
  calls: Array<{ method: string; params: unknown }>;
  push: (events: ZcodeEvent[]) => void;
  ev: EvFactory;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
  let seq = 0;
  const push = (events: ZcodeEvent[]): void => {
    for (const e of events) for (const l of [...listeners]) l.handleEvent(e);
  };
  const ev: EvFactory = (type, turnId, payload = {}) => ({
    sessionId: "zs_rr",
    seq: ++seq,
    type: type as ZcodeEvent["type"],
    ...(turnId !== undefined ? { turnId } : {}),
    payload,
  });
  const backend = {
    isDead: false,
    request: async (_id: number, method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "session/send") {
        // Two completed tools (Bash + Edit) plus streamed text so the
        // no-text fallback (fetchLastReply) never fires.
        push([
          ev("turn.started", "T1"),
          ev("model.streaming", "T1", {
            kind: "text_delta",
            delta: "reply text",
            assistantMessageId: "m1",
          }),
          ev("tool.updated", "T1", {
            kind: "scheduled",
            toolCallId: "c1",
            toolName: "Bash",
            input: { command: "ls" },
          }),
          ev("tool.updated", "T1", {
            kind: "result",
            toolCallId: "c1",
            toolName: "Bash",
            result: "ok",
          }),
          ev("tool.updated", "T1", {
            kind: "scheduled",
            toolCallId: "c2",
            toolName: "Edit",
            input: { file_path: "/tmp/a.ts" },
          }),
          ev("tool.updated", "T1", {
            kind: "result",
            toolCallId: "c2",
            toolName: "Edit",
            result: { content: "done" },
          }),
          ev("turn.completed", "T1", { resultType: "success" }),
        ]);
        return { result: { accepted: true } };
      }
      if (method === "session/messages") return { result: { messages: [] } };
      if (method === "session/read")
        return { result: { projection: { status: "idle", contextUsed: 0 }, settings: {} } };
      if (method === "session/subagents")
        return { error: { code: -32601, message: "Method not found" } };
      return { result: {} };
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      listeners.push(l);
    },
    unregisterEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      const idx = listeners.indexOf(l);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  } as unknown as ZcodeBackend;
  return { backend, calls, push, ev };
}

function setup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_rr", "zs_rr");
  server.markBackendLoaded("sess_rr");
  return server;
}

describe("turn loop: no per-tool-result whole-store reads", () => {
  it("completes a 2-tool turn with only the baseline and completion reads", async () => {
    const f = fakeBackend();
    const server = setup(f.backend);
    const cx = {
      notify: async () => {},
      request: async () => ({}),
    } as unknown as acp.AgentContext;

    const params = {
      sessionId: "sess_rr",
      prompt: [{ type: "text" as const, text: "go" }],
    } as acp.PromptRequest;
    const result = await prompt(server, params, cx, 1);

    expect(result.stopReason).toBe("end_turn");
    // Pre-0035 this turn made 3 per-tool-result reads (2× edit-diff
    // session/messages + 2× todo session/read + rechecks). Now: baseline
    // session/messages (turn entry), completion-diff session/messages + todo
    // session/read, and the light messageLimit:1 mode re-read.
    const msgs = f.calls.filter((c) => c.method === "session/messages").map((c) => c.params);
    const reads = f.calls.filter((c) => c.method === "session/read").map((c) => c.params);
    expect(msgs.length).toBeLessThanOrEqual(2); // baseline + completion diff
    expect(reads.length).toBeLessThanOrEqual(3); // completion todos + mode reconcile (buildModes+options can read twice)
    // No per-result edit-diff read shape survives: every session/messages call
    // is either the unscoped baseline or the completion afterMessageId read.
    for (const p of msgs) {
      const params = p as { limit?: number };
      expect(params.limit).toBeUndefined();
    }
  }, 15_000);

  it("translates the Edit result event live (card closes) without a store read", () => {
    // Unit-level sanity: the event translator alone produces a completed
    // update for the Edit result — the live path never needed the store.
    const t = new EventTranslator();
    const out: unknown[] = [];
    for (const p of [
      { kind: "scheduled", toolCallId: "c1", toolName: "Edit", input: { file_path: "/tmp/a.ts" } },
      { kind: "result", toolCallId: "c1", toolName: "Edit", result: { content: "done" } },
    ] as Record<string, unknown>[]) {
      out.push(
        ...t.translate({
          type: "tool.updated",
          turnId: "T1",
          payload: p,
        } as never),
      );
    }
    const kinds = out.map((e) => (e as { kind: string }).kind);
    expect(kinds).toContain("ToolCallNew");
    expect(kinds).toContain("ToolCallUpdate");
    const upd = out.find((e) => (e as { kind: string }).kind === "ToolCallUpdate") as unknown as {
      status: string;
    };
    expect(upd.status).toBe("completed");
  });
});
