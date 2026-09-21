/**
 * Model-choice stickiness across resumes. Root cause (source-verified
 * 2026-09-21, ZCode 0.16.9): the backend persists the per-session model
 * selection as a session_entry with a session FK, but the session row is
 * only created at FIRST INPUT (ensureSessionPersisted, core events.ts) — a
 * setModel before the first prompt loses persistence
 * (`session.model_selection.persist_failed`, FOREIGN KEY), and a resumed
 * session without an entry silently reverts to the workspace default while
 * the editor dropdown keeps showing the user's last choice. The bridge now
 * remembers the choice (in-memory per zcodeSid + durably per acpSid in the
 * lazy-alias store) and re-applies it after every resume.
 */

import { describe, expect, it, vi } from "vitest";

import type { ZcodeResponse } from "../src/backend/types.js";
import {
  lookupLazySession,
  recordMaterializedSession,
  recordModelChoice,
  rememberLazySession,
} from "../src/lazy-sessions.js";
import { setConfigOption, rememberModelChoice } from "../src/config/options.js";
import { ensureRealSession, reloadBackendSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

const SID_A = "acp-mc-1";
const SID_Z = "zc-mc-1";

/** Fake backend recording method calls; per-method scriptable results. */
function makeBackend(overrides: Record<string, () => ZcodeResponse> = {}): {
  backend: NonNullable<ZcodeAcpServer["backend"]>;
  calls: string[];
} {
  const calls: string[] = [];
  let messageReads = 0;
  const backend = {
    isDead: false,
    request: async (id: number, method: string): Promise<ZcodeResponse> => {
      calls.push(method);
      if (overrides[method]) return overrides[method]!();
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
        case "session/setModel":
        case "session/setThoughtLevel":
          return { id, result: {} } as ZcodeResponse;
        case "session/messages": {
          messageReads++; // stable plateau for fetchMessagesSettled
          return {
            id,
            result: { messages: Array.from({ length: messageReads === 1 ? 2 : 3 }, () => ({})) },
          } as ZcodeResponse;
        }
        case "session/read":
          return {
            id,
            result: { settings: {}, projection: { contextUsed: 1, contextWindow: 100 } },
          } as ZcodeResponse;
        default:
          return { id, result: {} } as ZcodeResponse;
      }
    },
    send: vi.fn(),
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
  return { backend, calls };
}

function makeServer(backend: NonNullable<ZcodeAcpServer["backend"]>): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  return server;
}

/** Seed the durable alias record exactly as production would have. */
function seedStore(model?: string, thought?: string): void {
  rememberLazySession(SID_A, "/tmp/proj");
  recordMaterializedSession(SID_A, SID_Z, "/tmp/proj");
  recordModelChoice(SID_A, {
    ...(model ? { model } : {}),
    ...(thought ? { thought } : {}),
  });
}

describe("model choice stickiness", () => {
  it("setConfigOption remembers model + thought in memory AND the lazy store", async () => {
    seedStore();
    const { backend } = makeBackend();
    const server = makeServer(backend);
    server.registerSession(SID_A, SID_Z);

    expect(await setConfigOption(server, SID_Z, "model", "GLM-5.3", SID_A)).toMatchObject({
      kind: "model",
    });
    expect(await setConfigOption(server, SID_Z, "thought", "high", SID_A)).toMatchObject({
      kind: "thought",
    });

    expect(server.sessionModelChoices.get(SID_Z)).toMatchObject({
      model: "GLM-5.3",
      thought: "high",
    });
    expect(lookupLazySession(SID_A)?.modelChoice).toMatchObject({
      model: "GLM-5.3",
      thought: "high",
    });
  });

  it("reloadBackendSession re-applies the remembered choice after resume", async () => {
    const { backend, calls } = makeBackend();
    const server = makeServer(backend);
    server.registerSession(SID_A, SID_Z);
    server.sessionCwds.set(SID_A, "/tmp/proj");
    server.sessionModelChoices.set(SID_Z, { model: "GLM-5.3", thought: "high" });

    await reloadBackendSession(server, SID_A, SID_Z);

    const resumeAt = calls.indexOf("session/resume");
    const setModelAt = calls.indexOf("session/setModel");
    const setThoughtAt = calls.indexOf("session/setThoughtLevel");
    expect(resumeAt).toBeGreaterThanOrEqual(0);
    expect(setModelAt).toBeGreaterThan(resumeAt);
    expect(setThoughtAt).toBeGreaterThan(setModelAt);
  });

  it("no remembered choice → resume sends no setModel", async () => {
    const { backend, calls } = makeBackend();
    const server = makeServer(backend);
    server.registerSession(SID_A, SID_Z);
    server.sessionCwds.set(SID_A, "/tmp/proj");

    await reloadBackendSession(server, SID_A, SID_Z);

    expect(calls).not.toContain("session/setModel");
  });

  it("a failed re-assert never fails the resume", async () => {
    const { backend } = makeBackend({
      "session/setModel": () =>
        ({ error: { code: -32004, message: "Provider Registry 中不存在 Model" } }) as ZcodeResponse,
    });
    const server = makeServer(backend);
    server.registerSession(SID_A, SID_Z);
    server.sessionCwds.set(SID_A, "/tmp/proj");
    server.sessionModelChoices.set(SID_Z, { model: "GLM-5.3" });

    await expect(reloadBackendSession(server, SID_A, SID_Z)).resolves.toBeUndefined();
  });

  it("a reset thought level (empty) is remembered and NOT resurrected on resume", async () => {
    seedStore("GLM-5.3", "high");
    const { backend, calls } = makeBackend();
    const server = makeServer(backend);
    server.registerSession(SID_A, SID_Z);
    server.sessionCwds.set(SID_A, "/tmp/proj");
    server.sessionModelChoices.set(SID_Z, { model: "GLM-5.3", thought: "high" });

    // The reset path in extensions.setThoughtLevel records an EMPTY level
    // (not "no record") so the re-assert skips it instead of flipping
    // thinking back on.
    rememberModelChoice(server, SID_A, SID_Z, { thought: "" });
    expect(lookupLazySession(SID_A)?.modelChoice).toMatchObject({
      model: "GLM-5.3",
      thought: "",
    });

    await reloadBackendSession(server, SID_A, SID_Z);

    expect(calls).toContain("session/setModel");
    expect(calls).not.toContain("session/setThoughtLevel");
  });

  it("a thought-only choice is re-applied without touching the model", async () => {
    const { backend, calls } = makeBackend();
    const server = makeServer(backend);
    server.registerSession(SID_A, SID_Z);
    server.sessionCwds.set(SID_A, "/tmp/proj");
    server.sessionModelChoices.set(SID_Z, { thought: "high" });

    await reloadBackendSession(server, SID_A, SID_Z);

    const resumeAt = calls.indexOf("session/resume");
    expect(resumeAt).toBeGreaterThanOrEqual(0);
    expect(calls).not.toContain("session/setModel");
    expect(calls.indexOf("session/setThoughtLevel")).toBeGreaterThan(resumeAt);
  });

  it("a stale alias record cannot overwrite a fresher choice on re-seed", async () => {
    // Two aliases, same backend session (editor + TUI attach): acp-mc-2
    // holds the most recent switch.
    rememberLazySession(SID_A, "/tmp/proj");
    recordMaterializedSession(SID_A, SID_Z, "/tmp/proj");
    recordModelChoice(SID_A, { model: "GLM-4.5", at: 1_000 });
    const SID_A2 = "acp-mc-2";
    rememberLazySession(SID_A2, "/tmp/proj");
    recordMaterializedSession(SID_A2, SID_Z, "/tmp/proj");
    recordModelChoice(SID_A2, { model: "GLM-5.3", at: 2_000 });

    const { backend } = makeBackend();
    const server = makeServer(backend); // fresh process: no mappings

    await ensureRealSession(server, SID_A2); // fresher alias recovered first
    await ensureRealSession(server, SID_A); // stale alias re-seeds second

    expect(server.sessionModelChoices.get(SID_Z)).toMatchObject({ model: "GLM-5.3" });
  });

  it("bridge restart: ensureRealSession recovers the choice from the store and re-applies it", async () => {
    seedStore("GLM-5.3", "high");
    const { backend, calls } = makeBackend();
    const server = makeServer(backend); // fresh process: no mappings

    const zcodeSid = await ensureRealSession(server, SID_A);

    expect(zcodeSid).toBe(SID_Z);
    expect(server.sessionModelChoices.get(SID_Z)).toMatchObject({
      model: "GLM-5.3",
      thought: "high",
    });
    // The recovery's eviction guard reloads the session — the re-assert must
    // ride that resume and re-apply the choice.
    expect(calls).toContain("session/setModel");
    expect(calls).toContain("session/setThoughtLevel");
  });

  it("bridge restart: re-seed scans EVERY alias of the backend session, not just this one", async () => {
    // Reported 2026-09-21: the re-seed read only the recovering alias's own
    // store record, so a STALE alias resurrected an older choice a fresher
    // alias (a TUI/phone attachment to the same conversation) had already
    // replaced — a silent model revert after every restart.
    rememberLazySession(SID_A, "/tmp/proj");
    recordMaterializedSession(SID_A, SID_Z, "/tmp/proj");
    recordModelChoice(SID_A, { model: "GLM-4.5", at: 1_000 });
    const SID_A3 = "acp-mc-3";
    rememberLazySession(SID_A3, "/tmp/proj");
    recordMaterializedSession(SID_A3, SID_Z, "/tmp/proj");
    recordModelChoice(SID_A3, { model: "GLM-5.2", at: 9_000_000_000_000 });

    const { backend, calls } = makeBackend();
    const server = makeServer(backend); // fresh process: no mappings

    await ensureRealSession(server, SID_A); // the STALE alias recovers first

    expect(server.sessionModelChoices.get(SID_Z)).toMatchObject({ model: "GLM-5.2" });
    // The re-assert rides the recovery's eviction-guard resume with the
    // fresher choice, not the stale alias's own.
    expect(calls).toContain("session/setModel");
  });
});
