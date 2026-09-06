/**
 * Tests for the session/new boot-resume interception (ADR-0017 as amended by
 * ADR-0020): when the hub incubates a terminal window for a specific
 * conversation, ZCODE_ACP_RESUME_SESSION makes the client's opening
 * session/new load that session instead of creating a placeholder. The env is
 * consumed once; a failed load falls back to a fresh session so the window
 * still lands on a usable prompt.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import { consumeBootResumeTarget, newSession } from "../src/handlers/session.js";
import { BOOT_RESUME_TRIGGER, prompt } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

/** Fake backend recording RPCs; session/resume + messages answer minimally. */
function fakeBackend(history: ZcodeMessage[] = []): {
  backend: ZcodeBackend;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const backend = {
    isDead: false,
    request: async (_id: number, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      switch (method) {
        case "workspace/updateProviderRegistry":
          return { result: {} };
        case "session/resume":
          return { result: {} };
        case "session/subscribe":
          return { result: { eventSeq: 0 } };
        case "session/read":
          return { result: { projection: { status: "idle", contextUsed: 0 } } };
        case "session/messages":
          return { result: { messages: history } };
        case "session/list":
          return { result: { sessions: [] } };
        default:
          return { result: {} };
      }
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, calls };
}

const stubCx = { notify: async () => {} } as unknown as acp.AgentContext;

describe("consumeBootResumeTarget", () => {
  afterEach(() => {
    delete process.env.ZCODE_ACP_RESUME_SESSION;
  });

  it("returns the target and deletes the env (second read is null)", () => {
    process.env.ZCODE_ACP_RESUME_SESSION = "sess_boot1";
    expect(consumeBootResumeTarget()).toBe("sess_boot1");
    expect(consumeBootResumeTarget()).toBeNull();
  });

  it("treats empty/whitespace as unset", () => {
    process.env.ZCODE_ACP_RESUME_SESSION = "   ";
    expect(consumeBootResumeTarget()).toBeNull();
  });
});

describe("session/new boot-resume interception", () => {
  afterEach(() => {
    delete process.env.ZCODE_ACP_RESUME_SESSION;
    vi.useRealTimers();
  });

  it("serves the first session/new as a session/load of the target id", async () => {
    const server = new ZcodeAcpServer();
    const { backend, calls } = fakeBackend();
    server.backend = backend;
    server.registerSession("sess_boot", "zsess_boot");
    vi.spyOn(server.clients, "broadcast").mockReturnValue(stubCx);

    process.env.ZCODE_ACP_RESUME_SESSION = "sess_boot";
    const res = await newSession(server, { cwd: process.cwd() });

    // The client sees the resumed session id — it adopts it as live.
    expect(res.sessionId).toBe("sess_boot");
    // The load path ran: backend resume RPC with the target's zcode id.
    const resume = calls.find((c) => c.method === "session/resume");
    expect(resume?.params.sessionId).toBe("zsess_boot");
    // Env consumed: a second session/new (TUI /new) is a fresh placeholder.
    const second = await newSession(server, { cwd: process.cwd() });
    expect(second.sessionId).not.toBe("sess_boot");
    expect(second.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("falls back to a fresh placeholder when the load fails", async () => {
    const server = new ZcodeAcpServer();
    const backend = {
      isDead: false,
      request: async () => {
        throw new Error("session not found");
      },
      send: () => {},
      pollServerRequests: () => [],
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    server.backend = backend;
    vi.spyOn(server.clients, "broadcast").mockReturnValue(stubCx);

    process.env.ZCODE_ACP_RESUME_SESSION = "sess_gone";
    const res = await newSession(server, { cwd: process.cwd() });

    expect(res.sessionId).not.toBe("sess_gone");
    expect(server.pendingSessions.has(res.sessionId)).toBe(true);
  });

  it("creates a lazy placeholder when the env is absent", async () => {
    const server = new ZcodeAcpServer();
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    const res = await newSession(server, { cwd: process.cwd() });

    expect(server.pendingSessions.has(res.sessionId)).toBe(true);
    expect(calls).toHaveLength(0); // no backend RPC before first use
  });
});

describe("boot-resume banner handshake (DSH_TUI_AUTOPROMPT trigger)", () => {
  afterEach(() => {
    delete process.env.ZCODE_ACP_RESUME_SESSION;
  });

  /**
   * Server armed the way a hub-incubated martty TUI boot leaves it. The
   * booting connection is `tui` (its connectionContext root is what the
   * handshake is scoped to); `phone` simulates a remote app attached to the
   * same bridge.
   */
  async function bootedMarttyServer(): Promise<{
    server: ZcodeAcpServer;
    calls: Array<{ method: string; params: Record<string, unknown> }>;
    tui: acp.AgentContext;
    phone: acp.AgentContext;
  }> {
    const server = new ZcodeAcpServer();
    server.clientName = "martty";
    const { backend, calls } = fakeBackend();
    server.backend = backend;
    server.registerSession("sess_boot", "zsess_boot");
    vi.spyOn(server.clients, "broadcast").mockReturnValue(stubCx);
    process.env.ZCODE_ACP_RESUME_SESSION = "sess_boot";
    const tui = clientWithRoot("tui-conn");
    await newSession(server, { cwd: process.cwd() }, tui);
    return { server, calls, tui, phone: clientWithRoot("phone-conn") };
  }

  function clientWithRoot(id: string): acp.AgentContext {
    return { notify: async () => {}, connectionContext: { id } } as unknown as acp.AgentContext;
  }

  it("answers the auto-submitted trigger with an ack, never a model turn", async () => {
    const { server, calls, tui } = await bootedMarttyServer();
    expect(server.bootResumeTriggerConnection).toEqual({ id: "tui-conn" });

    const updates: Array<Record<string, unknown>> = [];
    const cx = {
      notify: async (method: string, params?: { update?: Record<string, unknown> }) => {
        if (method === "session/update") updates.push(params?.update ?? {});
      },
    } as unknown as acp.AgentContext;

    const res = await prompt(
      server,
      { sessionId: "sess_boot", prompt: [{ type: "text", text: BOOT_RESUME_TRIGGER }] },
      cx,
      1,
      tui,
    );

    expect(res).toEqual({ stopReason: "end_turn" });
    // One ack chunk (⟲ is in every locale's wording), addressed to the session.
    expect(updates).toHaveLength(1);
    expect(updates[0].sessionUpdate).toBe("agent_message_chunk");
    expect(String(updates[0].content?.text ?? "")).toContain("⟲");
    // No turn ever reached the backend.
    expect(calls.some((c) => c.method === "session/send")).toBe(false);
    // One-shot: consumed.
    expect(server.bootResumeTriggerConnection).toBeNull();
  });

  it("keeps the handshake armed while another attached client prompts first", async () => {
    // Observed live: a phone app attached to the incubated bridge prompted
    // during the TUI boot window — with a global one-shot that prompt
    // disarmed the handshake and the auto-submitted trigger leaked to the
    // model as a real prompt.
    const { server, tui, phone } = await bootedMarttyServer();

    // The phone's prompt arrives first and does NOT disarm the handshake.
    // (Unknown session id → ensureRealSession throws after the scoped check.)
    await expect(
      prompt(
        server,
        { sessionId: "sess_unknown", prompt: [{ type: "text", text: "hi" }] },
        stubCx,
        2,
        phone,
      ),
    ).rejects.toThrow();
    expect(server.bootResumeTriggerConnection).toEqual({ id: "tui-conn" });

    // The TUI's queued trigger then still lands as a no-model-turn ack.
    const res = await prompt(
      server,
      { sessionId: "sess_boot", prompt: [{ type: "text", text: BOOT_RESUME_TRIGGER }] },
      stubCx,
      3,
      tui,
    );
    expect(res).toEqual({ stopReason: "end_turn" });
    expect(server.bootResumeTriggerConnection).toBeNull();
  });

  it("disarms when the booting connection's first prompt is anything else", async () => {
    const { server, tui } = await bootedMarttyServer();
    // Same connection, different text: the auto-submit was lost — disarm so
    // the trigger typed manually later is a normal prompt.
    await expect(
      prompt(
        server,
        { sessionId: "sess_unknown", prompt: [{ type: "text", text: "hello" }] },
        stubCx,
        4,
        tui,
      ),
    ).rejects.toThrow();
    expect(server.bootResumeTriggerConnection).toBeNull();
  });

  it("never arms for non-TUI clients (editors see the trigger as plain text)", async () => {
    const server = new ZcodeAcpServer();
    server.clientName = "Zed";
    const { backend } = fakeBackend();
    server.backend = backend;
    server.registerSession("sess_boot", "zsess_boot");
    vi.spyOn(server.clients, "broadcast").mockReturnValue(stubCx);

    process.env.ZCODE_ACP_RESUME_SESSION = "sess_boot";
    await newSession(server, { cwd: process.cwd() }, clientWithRoot("zed-conn"));

    expect(server.bootResumeTriggerConnection).toBeNull();
  });
});
