/**
 * Unknown-thread resolution: an editor thread id the bridge has never seen
 * (no mapping, no pending placeholder, no durable alias) must fail with an
 * actionable bridge-side error. The raw-id passthrough exists for REAL
 * backend session ids (imported threads) — but when the backend rejects a
 * raw id, the cryptic "Session ID 不存在" left users stuck (observed after
 * the shared alias store lost records to concurrent writers).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { loadSession, resumeSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
  renameSessionTask: async () => true,
  listKnownWorkspaces: async () => [],
}));

/** Backend whose session/resume rejects unknown ids like the real one. */
function fakeBackend(): {
  backend: ZcodeBackend;
  sent: Array<{ method: string; params: unknown }>;
} {
  const sent: Array<{ method: string; params: unknown }> = [];
  const backend = {
    isDead: false,
    request: async (_id: number, method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === "session/resume") {
        return { error: { message: "Session ID 不存在" } };
      }
      return { result: {} };
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, sent };
}

const cx = { notify: async () => {}, request: async () => ({}) } as unknown as acp.AgentContext;
const LOST_SID = "996b7c79-219b-4b89-8df1-b1313a2c2007";

beforeEach(() => {
  vi.stubEnv("HOME", mkdtempSync(path.join(tmpdir(), "zacp-unknown-sid-")));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("unknown thread id (alias lost)", () => {
  it("session/load fails with the actionable alias-lost error", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend();
    server.backend = backend;

    const err = await loadSession(server, { sessionId: LOST_SID }, cx).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const text = String((err as Error).message);
    // Locale-independent: names the id, and is NOT the raw backend failure.
    expect(text).toContain(LOST_SID);
    expect(text).not.toContain("zcode resume failed");
  });

  it("session/resume fails with the same actionable error", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend();
    server.backend = backend;

    const err = await resumeSession(server, { sessionId: LOST_SID }, cx).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const text = String((err as Error).message);
    expect(text).toContain(LOST_SID);
    expect(text).not.toContain("zcode resume failed");
  });

  it("still passes raw backend-shaped ids through to the backend resume", async () => {
    const server = new ZcodeAcpServer();
    const { backend, sent } = fakeBackend();
    server.backend = backend;

    await loadSession(server, { sessionId: "sess_real_backend_id" }, cx).catch(() => undefined);
    // The passthrough attempt happened (imported-thread support) — only the
    // failure MESSAGE changed, not the wire behavior.
    expect(sent).toContainEqual({
      method: "session/resume",
      params: expect.objectContaining({ sessionId: "sess_real_backend_id" }),
    });
  });
});
