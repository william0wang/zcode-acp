/**
 * Unknown-thread resolution: an editor thread id the bridge has never seen
 * (no mapping, no pending placeholder, no durable alias) must fail with an
 * actionable bridge-side error. The raw-id passthrough exists for REAL
 * backend session ids (imported threads) — but when the backend rejects a
 * raw id as MISSING, the cryptic "Session ID 不存在" left users stuck
 * (observed after the shared alias store lost records to concurrent
 * writers). Any other raw-id failure keeps the backend's own error: only a
 * not-found rejection means a dead session.
 *
 * The suite-wide hermetic HOME (tests/setup/hermetic-home.ts) keeps the
 * alias store lookups off the real one.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { loadSession, resumeSession } from "../src/handlers/session.js";
import { recordMaterializedSession, rememberLazySession } from "../src/lazy-sessions.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
  renameSessionTask: async () => true,
  listKnownWorkspaces: async () => [],
}));

/** Backend whose session/resume fails with the given error message. */
function fakeBackend(resumeError = "Session ID 不存在"): {
  backend: ZcodeBackend;
  sent: Array<{ method: string; params: unknown }>;
} {
  const sent: Array<{ method: string; params: unknown }> = [];
  const backend = {
    isDead: false,
    request: async (_id: number, method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === "session/resume") {
        return { error: { message: resumeError } };
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

describe("raw id with a transient backend failure", () => {
  it("keeps the backend's own error instead of blaming a lost alias", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend("session locked by another process");
    server.backend = backend;

    const err = await loadSession(server, { sessionId: "sess_real_backend_id" }, cx).catch(
      (e: Error) => e,
    );
    // The original error flows through untouched — a transient lock on a real
    // id must NOT be reported as an unrecoverable placeholder alias.
    expect(String((err as Error).message)).toContain("session locked by another process");
    expect(String((err as Error).message)).not.toContain(LOST_SID);
  });
});

describe("alias whose backend session was deleted", () => {
  it("reports the evicted-session error, not the lost-alias one", async () => {
    // Realistic eviction shape: bridge restarted, the alias (with zcodeSid)
    // survived in the store, but the backend deleted the session itself.
    rememberLazySession("acp_alias", "/tmp/ws");
    recordMaterializedSession("acp_alias", "sess_deleted_long_ago", "/tmp/ws");
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend(); // "Session ID 不存在"
    server.backend = backend;

    const err = await loadSession(server, { sessionId: "acp_alias" }, cx).catch((e: Error) => e);
    const text = String((err as Error).message);
    // The alias is fine — the backend session itself is gone. The message must
    // say so (and must not confuse it with the lost-alias case).
    expect(text).toContain("acp_alias");
    expect(text).not.toContain("zcode resume failed");
    expect(text).not.toContain("占位别名");
  });
});
