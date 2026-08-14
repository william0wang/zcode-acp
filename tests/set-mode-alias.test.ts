/**
 * session/set_mode (spec spelling) regression tests.
 *
 * The session-modes spec spells the request `session/set_mode` with a
 * `modeId` param; the bridge historically exposed only a camelCase extension
 * `session/setMode` with `mode`. Paseo sends the spec spelling and agent
 * creation in any non-default mode failed with -32601 before the alias
 * existed. These tests lock both spellings onto the same backend call.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";
import { setMode } from "../src/handlers/extensions.js";
import { ZcodeAcpServer } from "../src/server.js";

// Minimal fake config so buildConfigOptions' loadAllModels() never touches
// the real ~/.zcode/v2/config.json (keeps the test deterministic).
const FAKE_CONFIG = {
  provider: {
    "builtin:bigmodel-coding-plan": {
      name: "GLM Coding Plan",
      kind: "anthropic",
      enabled: true,
      options: { baseURL: "https://example.test/api" },
      models: {
        "GLM-5.3": { limit: { context: 1000000 }, reasoning: { variants: ["low", "high", "max"] } },
      },
    },
  },
};

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(FAKE_CONFIG);
      return actual.readFileSync(p);
    },
  };
});

/** Fake backend: records every request; answers reads and setters. */
class FakeBackend {
  isDead = false;
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  modeNow = "yolo";

  async request(
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: number; result?: unknown; error?: unknown }> {
    this.calls.push({ method, params });
    if (method === "session/read") {
      return {
        id,
        result: {
          projection: { status: "idle" },
          settings: { mode: { current: this.modeNow } },
        },
      };
    }
    if (method === "session/setMode") {
      this.modeNow = String(params?.mode);
      return { id, result: {} };
    }
    return { id, result: {} };
  }
}

/** Mock AgentContext that records every session/update notification. */
function mockContext(): { cx: acp.AgentContext; sent: acp.SessionUpdate[] } {
  const sent: acp.SessionUpdate[] = [];
  const cx = {
    notify(method: string, params: { sessionId: string; update: acp.SessionUpdate }) {
      expect(method).toBe("session/update");
      sent.push(params.update);
      return Promise.resolve();
    },
  } as unknown as acp.AgentContext;
  return { cx, sent };
}

function makeServer(): { server: ZcodeAcpServer; backend: FakeBackend } {
  const server = new ZcodeAcpServer();
  server.registerSession("sess_acp", "sess_zcode");
  const backend = new FakeBackend();
  server.backend = backend as unknown as ZcodeAcpServer["backend"];
  return { server, backend };
}

describe("setMode param normalization", () => {
  it("spec spelling session/set_mode with modeId reaches the backend as mode", async () => {
    const { server, backend } = makeServer();
    const { cx } = mockContext();
    await setMode(server, { sessionId: "sess_acp", modeId: "build" }, cx);
    const call = backend.calls.find((c) => c.method === "session/setMode");
    expect(call?.params).toEqual({ sessionId: "sess_zcode", mode: "build" });
  });

  it("camelCase extension spelling (mode) keeps working unchanged", async () => {
    const { server, backend } = makeServer();
    const { cx } = mockContext();
    await setMode(server, { sessionId: "sess_acp", mode: "plan" }, cx);
    const call = backend.calls.find((c) => c.method === "session/setMode");
    expect(call?.params).toEqual({ sessionId: "sess_zcode", mode: "plan" });
  });

  it("spec spelling emits current_mode_update so the client UI follows", async () => {
    const { server } = makeServer();
    const { cx, sent } = mockContext();
    await setMode(server, { sessionId: "sess_acp", modeId: "build" }, cx);
    const modeUpdate = sent.find((u) => u.sessionUpdate === "current_mode_update");
    expect(modeUpdate).toMatchObject({ sessionUpdate: "current_mode_update", currentModeId: "build" });
  });

  it("missing both mode and modeId is rejected", async () => {
    const { server } = makeServer();
    const { cx } = mockContext();
    await expect(setMode(server, { sessionId: "sess_acp" }, cx)).rejects.toThrow(/mode/);
  });
});
