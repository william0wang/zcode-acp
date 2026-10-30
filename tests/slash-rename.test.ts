/**
 * `/rename <title>` slash command: the editor/TUI-side manual rename channel.
 * Covers the interception early-return (end_turn, no model turn), title
 * normalization, the missing-argument error, the alias-group pin, the backend
 * v4 renameSession notify, and the placeholder (pre-materialization) path.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { handleSlashCommand } from "../src/handlers/slash.js";
import { ZcodeAcpServer } from "../src/server.js";

const mockRenames: Array<{ taskId: string; title: string }> = [];
vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
  renameSessionTask: async (taskId: string, title: string) => {
    mockRenames.push({ taskId, title });
    return true;
  },
}));

beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
  mockRenames.length = 0;
});

function fakeBackend(): {
  backend: ZcodeBackend;
  requests: Array<{ method: string; params: unknown }>;
} {
  const requests: Array<{ method: string; params: unknown }> = [];
  const backend = {
    isDead: false,
    request: async (id: number, method: string, params: unknown) => {
      requests.push({ method, params });
      void id;
      return { result: {} };
    },
    send: () => {},
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, requests };
}

interface SentUpdate {
  sessionUpdate: string;
  content?: { type: string; text: string };
  title?: string;
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

/** A live, materialized session with an auto title already set. */
function seedTitledSession(server: ZcodeAcpServer): { acpSid: string; zcodeSid: string } {
  const acpSid = randomUUID();
  const zcodeSid = `sess_${randomUUID().slice(0, 8)}`;
  server.registerSession(acpSid, zcodeSid);
  server.markSessionActive(acpSid);
  server.titleEligibleSessions.delete(acpSid);
  server.sessionTitles.set(acpSid, "auto title");
  server.touchSessionSummary(acpSid, "auto title");
  return { acpSid, zcodeSid };
}

describe("/rename slash command", () => {
  it("renames the current session without a model turn and notifies the backend", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid, zcodeSid } = seedTitledSession(server);
    const { backend, requests } = fakeBackend();
    server.backend = backend;
    const { cx, updates } = recordingCx();
    // session_info_update fans out through the client registry, not the
    // request cx — register the recorder so the broadcast is observable.
    server.clients.add(cx);

    const resp = await handleSlashCommand(server, cx, acpSid, zcodeSid, "/rename  my name\n");
    expect(resp).toEqual({ stopReason: "end_turn" });

    expect(server.sessionTitles.get(acpSid)).toBe("my name");
    expect(server.titleUserSetBy.has(acpSid)).toBe(true);
    // The ack chunk renders in-chat; the title lands via session_info_update.
    expect(updates.some((u) => u.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(
      updates.some((u) => u.sessionUpdate === "session_info_update" && u.title === "my name"),
    ).toBe(true);
    // The backend notify is awaited inside the rename core — already landed.
    const cmd = requests.find((r) => r.method === "v4/command");
    expect(cmd?.params).toMatchObject({
      type: "renameSession",
      sessionId: zcodeSid,
      payload: { title: "my name" },
    });
    expect(mockRenames).toEqual([{ taskId: zcodeSid, title: "my name" }]);
  });

  it("covers every alias of the conversation", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid, zcodeSid } = seedTitledSession(server);
    const sibling = randomUUID();
    server.registerSession(sibling, zcodeSid);
    server.sessionTitles.set(sibling, "auto title");
    const { backend } = fakeBackend();
    server.backend = backend;
    const { cx } = recordingCx();

    await handleSlashCommand(server, cx, acpSid, zcodeSid, "/rename user name");
    expect(server.sessionTitles.get(acpSid)).toBe("user name");
    expect(server.sessionTitles.get(sibling)).toBe("user name");
    expect(server.titleUserSetBy.has(sibling)).toBe(true);
  });

  it("requires an argument", async () => {
    const server = new ZcodeAcpServer();
    const { acpSid, zcodeSid } = seedTitledSession(server);
    const { backend } = fakeBackend();
    server.backend = backend;
    const { cx } = recordingCx();

    await expect(handleSlashCommand(server, cx, acpSid, zcodeSid, "/rename")).rejects.toMatchObject(
      { code: -32602 },
    );
    await expect(
      handleSlashCommand(server, cx, acpSid, zcodeSid, "/rename    "),
    ).rejects.toMatchObject({ code: -32602 });
    expect(server.sessionTitles.get(acpSid)).toBe("auto title");
  });

  it("pins a placeholder session in memory (persisted at materialization)", async () => {
    const server = new ZcodeAcpServer();
    const acpSid = randomUUID();
    server.pendingSessions.set(acpSid, { cwd: "/tmp/proj" });
    server.sessionCwds.set(acpSid, "/tmp/proj");
    server.titleEligibleSessions.add(acpSid);
    const { backend, requests } = fakeBackend();
    server.backend = backend;
    const { cx } = recordingCx();

    const resp = await handleSlashCommand(server, cx, acpSid, undefined as never, "/rename early");
    expect(resp).toEqual({ stopReason: "end_turn" });
    expect(server.sessionTitles.get(acpSid)).toBe("early");
    // No backend id yet: nothing sent, but the auto-title eligibility is gone.
    expect(requests).toHaveLength(0);
    expect(server.titleEligibleSessions.has(acpSid)).toBe(false);
  });
});
