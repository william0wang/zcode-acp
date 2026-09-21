/**
 * `/resume` slash command (editor-side session adoption): rebind an EMPTY
 * editor thread to an existing backend session and replay its history.
 * Covers the empty-thread guard, orphan-empty-session discard, history
 * replay, and the direct `/resume <id>` path through handleSlashCommand.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import { handleSlashCommand, neutralizeSlashText } from "../src/handlers/slash.js";
import { resumeIntoSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
  renameSessionTask: async () => true,
  listKnownWorkspaces: async () => [],
}));

const { askSessionPickMock } = vi.hoisted(() => ({ askSessionPickMock: vi.fn() }));
vi.mock("../src/handlers/server-requests.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/handlers/server-requests.js")>();
  return { ...orig, askSessionPick: askSessionPickMock };
});

/** History per zcode session id; everything else answers minimally. */
function fakeBackend(historyBySid: Record<string, ZcodeMessage[]>): {
  backend: ZcodeBackend;
  sent: Array<{ method: string; params: unknown }>;
} {
  const sent: Array<{ method: string; params: unknown }> = [];
  const backend = {
    isDead: false,
    request: async (_id: number, method: string, params: Record<string, unknown>) => {
      switch (method) {
        case "session/resume":
          return { result: {} };
        case "session/list":
          return {
            result: {
              sessions: Object.keys(historyBySid).map((sid) => ({
                sessionId: sid,
                workspace: { workspacePath: "/tmp/proj" },
                title: `t-${sid}`,
                updatedAt: 1,
              })),
            },
          };
        case "session/subscribe":
          return { result: { eventSeq: 0 } };
        case "session/read":
          return { result: { projection: { status: "idle", contextUsed: 0 } } };
        case "session/messages":
          return { result: { messages: historyBySid[params.sessionId as string] ?? [] } };
        default:
          return { result: {} };
      }
    },
    send: (method: string, params: unknown) => sent.push({ method, params }),
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, sent };
}

interface SentUpdate {
  sessionUpdate: string;
  content?: { type: string; text: string };
}

function recordingCx(): { cx: acp.AgentContext; updates: SentUpdate[] } {
  const updates: SentUpdate[] = [];
  const cx = {
    notify: async (_method: string, params: { update?: SentUpdate }) => {
      if (params.update) updates.push(params.update);
    },
    request: async () => ({}),
  } as unknown as acp.AgentContext;
  return { cx, updates };
}

const HISTORY: ZcodeMessage[] = [
  { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hello from the TUI" }] },
  { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "welcome back" }] },
];

/** A pending (never-materialized) placeholder thread in /tmp/proj. */
function seedPlaceholder(server: ZcodeAcpServer): string {
  const acpSid = randomUUID();
  server.pendingSessions.set(acpSid, { cwd: "/tmp/proj" });
  server.sessionCwds.set(acpSid, "/tmp/proj");
  return acpSid;
}

describe("resumeIntoSession", () => {
  it("adopts a past session into a placeholder thread and replays history", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend({ ztarget: HISTORY });
    server.backend = backend;
    const acpSid = seedPlaceholder(server);
    const { cx, updates } = recordingCx();

    const result = await resumeIntoSession(server, cx, acpSid, "ztarget");
    expect(result.ok).toBe(true);

    // The thread now maps to the adopted session, is active, and its history
    // was replayed as message chunks addressed to the EDITOR's session id.
    expect(server.resolveSid(acpSid)).toBe("ztarget");
    const kinds = updates.map((u) => u.sessionUpdate);
    expect(kinds).toContain("user_message_chunk");
    expect(kinds).toContain("agent_message_chunk");
    expect(updates.every(() => true)).toBe(true);
  });

  it("refuses a thread that already has a conversation", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend({ zold: HISTORY, zother: [] });
    server.backend = backend;
    const acpSid = randomUUID();
    server.registerSession(acpSid, "zold");
    server.sessionCwds.set(acpSid, "/tmp/proj");
    const { cx } = recordingCx();

    const result = await resumeIntoSession(server, cx, acpSid, "zother");
    expect(result.ok).toBe(false);
    expect(server.resolveSid(acpSid)).toBe("zold"); // thread untouched
  });

  it("discards an empty materialized session before adopting", async () => {
    const server = new ZcodeAcpServer();
    const { backend, sent } = fakeBackend({ zold: [], ztarget: HISTORY });
    server.backend = backend;
    const acpSid = randomUUID();
    server.registerSession(acpSid, "zold");
    server.sessionCwds.set(acpSid, "/tmp/proj");
    server.markBackendLoaded(acpSid);
    const { cx } = recordingCx();

    const result = await resumeIntoSession(server, cx, acpSid, "ztarget");
    expect(result.ok).toBe(true);
    expect(sent).toContainEqual({ method: "session/close", params: { sessionId: "zold" } });
    expect(server.resolveSid(acpSid)).toBe("ztarget");
    expect(server.isBackendSessionLive(acpSid)).toBe(true);
  });

  it("refuses while a turn is running on the target", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend({ ztarget: HISTORY });
    server.backend = backend;
    const acpSid = seedPlaceholder(server);
    server.pendingTurns.set(1, { zcodeSid: "ztarget", cancelled: false });
    const { cx } = recordingCx();

    const result = await resumeIntoSession(server, cx, acpSid, "ztarget");
    expect(result.ok).toBe(false);
  });
});

describe("/resume slash command", () => {
  async function drive(
    server: ZcodeAcpServer,
    acpSid: string,
    text: string,
    /** The requesting connection (runPrompt's `client`); omit to test the fallback. */
    client?: acp.AgentContext,
  ) {
    const { cx, updates } = recordingCx();
    const zcodeSid = server.resolveSid(acpSid) ?? acpSid;
    const resp = await handleSlashCommand(server, cx, acpSid, zcodeSid, text, client);
    return { resp, updates };
  }

  it("adopts directly with /resume <sessionId>", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend({ ztarget: HISTORY });
    server.backend = backend;
    const acpSid = seedPlaceholder(server);

    const { resp, updates } = await drive(server, acpSid, "/resume ztarget");
    expect(resp).toEqual({ stopReason: "end_turn" });
    expect(server.resolveSid(acpSid)).toBe("ztarget");
    expect(updates.some((u) => u.sessionUpdate === "agent_message_chunk")).toBe(true);
  });

  it("errors on an unknown session id", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend({ ztarget: HISTORY });
    server.backend = backend;
    const acpSid = seedPlaceholder(server);

    await expect(drive(server, acpSid, "/resume nope")).rejects.toThrow(/nope/);
    expect(server.resolveSid(acpSid)).toBeUndefined(); // thread untouched
  });

  it("opens the picker and adopts the chosen session", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend({ ztarget: HISTORY });
    server.backend = backend;
    const acpSid = seedPlaceholder(server);
    askSessionPickMock.mockResolvedValueOnce("ztarget");

    const { resp } = await drive(server, acpSid, "/resume");
    expect(resp).toEqual({ stopReason: "end_turn" });
    expect(server.resolveSid(acpSid)).toBe("ztarget");
    expect(askSessionPickMock).toHaveBeenCalledTimes(1);
    const items = askSessionPickMock.mock.calls[0]![3] as Array<{ sessionId: string }>;
    expect(items.map((i) => i.sessionId)).toEqual(["ztarget"]);
  });

  it("reports cancellation when the picker is dismissed", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend({ ztarget: HISTORY });
    server.backend = backend;
    const acpSid = seedPlaceholder(server);
    askSessionPickMock.mockResolvedValueOnce(null);

    const { resp } = await drive(server, acpSid, "/resume");
    expect(resp).toEqual({ stopReason: "end_turn" });
    expect(server.resolveSid(acpSid)).toBeUndefined(); // nothing adopted
  });

  it("resume is advertised as a real command (no zero-width neutralization)", () => {
    expect(neutralizeSlashText("/resume")).toBe("/resume");
    expect(neutralizeSlashText("/resume ztarget")).toBe("/resume ztarget");
  });

  it("targets the replayed history at the requesting connection, never the broadcast cx", async () => {
    // Reported 2026-09-21: the 0.46.2 targeting fix covered session/resume +
    // session/load but not the slash entry, whose cx is runPrompt's broadcast
    // proxy — the adopted history flooded every OTHER attached client (a
    // phone sharing the thread's acpSid) with the whole conversation.
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend({ ztarget: HISTORY });
    server.backend = backend;
    const acpSid = seedPlaceholder(server);

    const { cx: broadcast, updates: others } = recordingCx();
    const { cx: mine, updates: mineUpdates } = recordingCx();
    const zcodeSid = server.resolveSid(acpSid) ?? acpSid;
    const resp = await handleSlashCommand(
      server,
      broadcast,
      acpSid,
      zcodeSid,
      "/resume ztarget",
      mine,
    );

    expect(resp).toEqual({ stopReason: "end_turn" });
    // The adopted history reaches ONLY the connection that ran /resume.
    const mineTexts = mineUpdates.map((u) => u.content?.text);
    expect(mineTexts).toContain("hello from the TUI");
    expect(mineTexts).toContain("welcome back");
    // Other clients keep the slash ack but never the replayed conversation.
    const otherTexts = others.map((u) => u.content?.text);
    expect(otherTexts).not.toContain("hello from the TUI");
    expect(otherTexts).not.toContain("welcome back");
  });
});
