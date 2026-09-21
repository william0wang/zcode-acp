/**
 * `/model` and `/thought` slash switches must remember the choice exactly
 * like the dropdown path (setConfigOption → rememberModelChoice).
 *
 * Reported 2026-09-21: both slash cases dispatched straight to the backend
 * without recording, so a switch made in the TUI (martty has no dropdown —
 * `/model` IS its main switch path) was invisible to the post-resume
 * re-assert. Two failures followed: the TUI had no stickiness at all, and a
 * remembered dropdown choice silently rolled back a NEWER `/model` switch on
 * the next resume flight.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { handleSlashCommand } from "../src/handlers/slash.js";
import {
  lookupLazySession,
  recordMaterializedSession,
  rememberLazySession,
} from "../src/lazy-sessions.js";
import { ZcodeAcpServer } from "../src/server.js";

interface SentUpdate {
  sessionUpdate: string;
  content?: { type: string; text: string };
}

/** Backend answering every RPC successfully unless scripted otherwise. */
function fakeBackend(
  overrides: Record<string, () => { error?: { code: number; message: string } }> = {},
): { backend: ZcodeBackend; calls: string[] } {
  const calls: string[] = [];
  const backend = {
    isDead: false,
    request: async (id: number, method: string) => {
      calls.push(method);
      if (overrides[method]) return { id, ...overrides[method]!() };
      return { id, result: {} };
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, calls };
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

/** A materialized thread with a durable alias record (so the durable half of
 *  rememberModelChoice has somewhere to write). */
function seedSession(server: ZcodeAcpServer, zcodeSid: string): string {
  const acpSid = randomUUID();
  server.registerSession(acpSid, zcodeSid);
  server.sessionCwds.set(acpSid, "/tmp/proj");
  rememberLazySession(acpSid, "/tmp/proj");
  recordMaterializedSession(acpSid, zcodeSid, "/tmp/proj");
  return acpSid;
}

describe("slash switches remember the model choice", () => {
  it("/model records the switch in memory AND the durable alias store", async () => {
    const server = new ZcodeAcpServer();
    const { backend, calls } = fakeBackend();
    server.backend = backend;
    const acpSid = seedSession(server, "zc-mem-1");
    const { cx, updates } = recordingCx();

    const resp = await handleSlashCommand(server, cx, acpSid, "zc-mem-1", "/model GLM-5.2");

    expect(resp).toEqual({ stopReason: "end_turn" });
    expect(calls).toContain("session/setModel");
    // In-memory: the post-resume re-assert reads this map.
    expect(server.sessionModelChoices.get("zc-mem-1")).toMatchObject({ model: "GLM-5.2" });
    // Durable: a bridge restart recovers it through the alias record.
    expect(lookupLazySession(acpSid)?.modelChoice).toMatchObject({ model: "GLM-5.2" });
    // The editor UI still learns about the switch.
    expect(updates.some((u) => u.sessionUpdate === "config_option_update")).toBe(true);
  });

  it("/thought records the level in memory AND the durable alias store", async () => {
    const server = new ZcodeAcpServer();
    const { backend, calls } = fakeBackend();
    server.backend = backend;
    const acpSid = seedSession(server, "zc-mem-2");
    const { cx } = recordingCx();

    const resp = await handleSlashCommand(server, cx, acpSid, "zc-mem-2", "/thought high");

    expect(resp).toEqual({ stopReason: "end_turn" });
    expect(calls).toContain("session/setThoughtLevel");
    expect(server.sessionModelChoices.get("zc-mem-2")).toMatchObject({ thought: "high" });
    expect(lookupLazySession(acpSid)?.modelChoice).toMatchObject({ thought: "high" });
  });

  it("a failed switch is NOT remembered", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend({
      "session/setModel": () => ({ error: { code: -32004, message: "nope" } }),
    });
    server.backend = backend;
    const acpSid = seedSession(server, "zc-mem-3");
    const { cx } = recordingCx();

    await expect(
      handleSlashCommand(server, cx, acpSid, "zc-mem-3", "/model GLM-5.2"),
    ).rejects.toThrow();
    expect(server.sessionModelChoices.has("zc-mem-3")).toBe(false);
    expect(lookupLazySession(acpSid)?.modelChoice).toBeUndefined();
  });

  it("/mode is NOT remembered (mode is not part of the model choice)", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend();
    server.backend = backend;
    const acpSid = seedSession(server, "zc-mem-4");
    const { cx } = recordingCx();

    const resp = await handleSlashCommand(server, cx, acpSid, "zc-mem-4", "/mode plan");

    expect(resp).toEqual({ stopReason: "end_turn" });
    expect(server.sessionModelChoices.has("zc-mem-4")).toBe(false);
    expect(lookupLazySession(acpSid)?.modelChoice).toBeUndefined();
  });
});
