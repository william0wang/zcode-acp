/**
 * Drain-gate fast path (behavior-adaptive, 0.16.9 semantics): once THIS
 * backend process has rejected a session/send with the whole-turn busy
 * error (-32010 "A prompt is already running for this session" — source
 * sendPrompt: the activeAbortController guard spans the ENTIRE turn, so a
 * mid-turn send can never be accepted as steer), the prompt path skips the
 * drain gate's pre-send poll after a recent cancel and lets the send
 * busy-retry loop be the single authority. Backends that never showed the
 * rejection keep the full gate (0.16.5 accepts mid-generation sends as
 * silently-dropped steer input). Fast-path parity: one queued-note on busy
 * waits, and a post-accept differ re-baseline (the skipped drain used to do
 * it — without it the completion diff replays the abandoned turn's residue).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { prompt } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

// The queued-note assertions check the Chinese message table.
beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "zh");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

interface FakeOptions {
  busySends?: number;
  /** Extra session/send rejections with a NON-busy -32010 error. */
  permanentSendError?: { code: number; message: string };
}

/** Recording fake backend: every RPC method name lands in `calls`, in order. */
function fakeBackend(opts: FakeOptions = {}): {
  backend: ZcodeBackend;
  calls: string[];
  notify: Array<{ method: string; params: unknown }>;
} {
  const calls: string[] = [];
  const notify: Array<{ method: string; params: unknown }> = [];
  const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
  let sends = 0;
  const backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      calls.push(method);
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
        case "session/subscribe":
          return { result: {} };
        case "session/read":
          return { result: { projection: { status: "idle", contextUsed: 0 }, settings: {} } };
        case "session/messages":
          return { result: { messages: [] } };
        case "session/send": {
          sends += 1;
          if (opts.permanentSendError && sends === 1) {
            return { error: { ...opts.permanentSendError } };
          }
          if (sends <= (opts.busySends ?? 0)) {
            return {
              error: { code: -32010, message: "A prompt is already running for this session" },
            };
          }
          const events: ZcodeEvent[] = [
            { sessionId: "zs_fp", seq: 1, type: "turn.started", payload: {} },
            {
              sessionId: "zs_fp",
              seq: 2,
              type: "turn.completed",
              payload: { resultType: "success" },
            },
          ];
          for (const e of events) for (const l of listeners) l.handleEvent(e);
          return { result: { accepted: true } };
        }
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: (method: string, params: unknown) => {
      notify.push({ method, params });
    },
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      listeners.push(l);
    },
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, calls, notify };
}

function setup(backend: ZcodeBackend, opts: { recentCancel?: boolean; fastPath?: boolean } = {}) {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_fp", "zs_fp");
  server.markBackendLoaded("sess_fp");
  if (opts.recentCancel) server.lastCancelledAt.set("zs_fp", Date.now());
  if (opts.fastPath) server.observedSendBusyReject = true;
  return server;
}

function promptParams(text: string): acp.PromptRequest {
  return { sessionId: "sess_fp", prompt: [{ type: "text", text }] } as acp.PromptRequest;
}

function recordingCx(): { cx: acp.AgentContext; updates: unknown[][] } {
  const updates: unknown[][] = [];
  return {
    updates,
    cx: {
      notify: async (...args: unknown[]) => {
        updates.push(args);
      },
      request: async () => ({}),
    } as unknown as acp.AgentContext,
  };
}

describe("drain-gate fast path (whole-turn busy semantics)", () => {
  it("legacy backend: a recent cancel drains (session/read) BEFORE the send", async () => {
    const f = fakeBackend();
    const server = setup(f.backend, { recentCancel: true }); // flag unset

    const result = await prompt(server, promptParams("next"), recordingCx().cx, 1);

    expect(result).toEqual({ stopReason: "end_turn" });
    const readAt = f.calls.indexOf("session/read");
    const sendAt = f.calls.indexOf("session/send");
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeLessThan(sendAt);
  });

  it("fast path: recent cancel sends FIRST — no pre-send drain probe", async () => {
    const f = fakeBackend();
    const server = setup(f.backend, { recentCancel: true, fastPath: true });

    const result = await prompt(server, promptParams("next"), recordingCx().cx, 1);

    expect(result).toEqual({ stopReason: "end_turn" });
    const sendAt = f.calls.indexOf("session/send");
    expect(sendAt).toBeGreaterThanOrEqual(0);
    // Nothing probed the projection before the send went out.
    expect(f.calls.slice(0, sendAt)).not.toContain("session/read");
  });

  it("a whole-turn busy rejection arms the fast path for the process", async () => {
    const f = fakeBackend({ busySends: 1 });
    const server = setup(f.backend); // no recent cancel, flag starts unset

    const result = await prompt(server, promptParams("next"), recordingCx().cx, 1);

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(server.observedSendBusyReject).toBe(true);
  });

  it("-32010 with an unrelated message does NOT arm the fast path", async () => {
    const f = fakeBackend({
      permanentSendError: { code: -32010, message: "Subagent sessions are read-only" },
    });
    const server = setup(f.backend);

    await expect(prompt(server, promptParams("next"), recordingCx().cx, 1)).rejects.toThrow(
      /Subagent sessions are read-only/,
    );
    expect(server.observedSendBusyReject).toBe(false);
  });

  it("fast path: busy waits emit exactly ONE queued note", async () => {
    const f = fakeBackend({ busySends: 2 });
    const server = setup(f.backend, { recentCancel: true, fastPath: true });
    const { cx, updates } = recordingCx();

    const result = await prompt(server, promptParams("next"), cx, 1);

    expect(result).toEqual({ stopReason: "end_turn" });
    const notes = updates.filter((args) => JSON.stringify(args).includes("等待结束后发送"));
    expect(notes).toHaveLength(1);
  });

  it("fast path: a busy-retried send re-baselines the differ after accept", async () => {
    const f = fakeBackend({ busySends: 1 });
    const server = setup(f.backend, { recentCancel: true, fastPath: true });

    const result = await prompt(server, promptParams("next"), recordingCx().cx, 1);

    expect(result).toEqual({ stopReason: "end_turn" });
    // Pre-send baseline + post-accept re-baseline (the skipped drain's job).
    expect(f.calls.filter((m) => m === "session/messages").length).toBeGreaterThanOrEqual(2);
  });
});
