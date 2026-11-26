/**
 * session/set_mode (spec spelling) regression tests.
 *
 * The session-modes spec spells the request `session/set_mode` with a
 * `modeId` param; the bridge historically exposed only a camelCase extension
 * `session/setMode` with `mode`. Paseo sends the spec spelling and agent
 * creation in any non-default mode failed with -32601 before the alias
 * existed. These tests lock both spellings onto the same backend call.
 *
 * A confirmed switch updates both ACP controls. An empty acknowledgement
 * followed by a failed read leaves the previous display in place (#424).
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";
import { setMode } from "../src/handlers/extensions.js";
import { setConfigOptionHandler } from "../src/handlers/session.js";
import { handleSlashCommand } from "../src/handlers/slash.js";
import { ZcodeAcpServer } from "../src/server.js";

// Minimal fake config so buildConfigOptions' loadAllModels() never touches
// the real ~/.zcode/v2/config.json (keeps the test deterministic).
const FAKE_CONFIG = {
  provider: {
    "builtin:bigmodel-coding-plan": {
      name: "GLM Coding Plan",
      kind: "anthropic",
      enabled: true,
      options: { baseURL: "https://example.test/api", apiKey: "plan-token" },
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

interface BackendSpec {
  /** What session/setMode answers: result payload, or an error message. */
  setModeResult?: unknown;
  setModeError?: string;
  onSetMode?: (server: ZcodeAcpServer) => void;
  /** What session/read answers: result payload, or an error message. */
  readResult?: unknown;
  readError?: string;
  /** Runs before session/read answers — simulates mid-read races. */
  onRead?: (server: ZcodeAcpServer) => void;
}

/** Fake backend: records every request; answers reads and setters per spec. */
class FakeBackend {
  isDead = false;
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  modeNow = "yolo";

  constructor(private spec: BackendSpec = {}) {}

  async request(
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: number; result?: unknown; error?: unknown }> {
    this.calls.push({ method, params });
    if (method === "session/read") {
      this.spec.onRead?.(this.serverRef!);
      if (this.spec.readError) return { id, error: { message: this.spec.readError } };
      if (this.spec.readResult !== undefined) return { id, result: this.spec.readResult };
      return {
        id,
        result: {
          projection: { status: "idle" },
          settings: { mode: { current: this.modeNow } },
        },
      };
    }
    if (method === "session/setMode") {
      this.spec.onSetMode?.(this.serverRef!);
      if (this.spec.setModeError) return { id, error: { message: this.spec.setModeError } };
      this.modeNow = String(params?.mode);
      return { id, result: this.spec.setModeResult ?? {} };
    }
    return { id, result: {} };
  }

  /** Set by makeServer so onRead hooks can reach the server. */
  serverRef: ZcodeAcpServer | null = null;
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

function makeServer(spec: BackendSpec = {}): { server: ZcodeAcpServer; backend: FakeBackend } {
  const server = new ZcodeAcpServer();
  server.registerSession("sess_acp", "sess_zcode");
  const backend = new FakeBackend(spec);
  backend.serverRef = server;
  server.backend = backend as unknown as ZcodeAcpServer["backend"];
  server.markBackendLoaded("sess_acp");
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
    expect(modeUpdate).toMatchObject({
      sessionUpdate: "current_mode_update",
      currentModeId: "build",
    });
  });

  it("missing both mode and modeId is rejected", async () => {
    const { server } = makeServer();
    const { cx } = mockContext();
    await expect(setMode(server, { sessionId: "sess_acp" }, cx)).rejects.toThrow(/mode/);
  });
});

describe("mode-switch publish under an unconfirmable mode", () => {
  it("a COMPLETE success response publishes edit even when any re-read would fail", async () => {
    // The switch response itself carries the effective mode — no re-read is
    // needed and a (would-be) failing read cannot unpublish it.
    const { server, backend } = makeServer({
      setModeResult: {
        settings: {
          mode: { current: "edit" },
          model: { current: { providerId: "test", modelId: "selected" } },
          thoughtLevel: { current: "high", available: [{ value: "high", label: "High" }] },
        },
      },
      readError: "session not active",
    });
    server.lastMode.set("sess_acp", "build");
    const { cx, sent } = mockContext();
    await setMode(server, { sessionId: "sess_acp", modeId: "edit" }, cx);
    const configUpdate = sent.find((u) => u.sessionUpdate === "config_option_update");
    expect(configUpdate).toBeDefined();
    expect(
      (
        configUpdate as { configOptions: Array<{ id: string; currentValue?: string }> }
      ).configOptions.find((o) => o.id === "mode")?.currentValue,
    ).toBe("edit");
    expect(sent).toContainEqual({
      sessionUpdate: "current_mode_update",
      currentModeId: "edit",
    });
    expect(server.lastMode.get("sess_acp")).toBe("edit");
    expect(backend.calls.filter((c) => c.method === "session/read")).toHaveLength(0);
    expect(
      (
        configUpdate as { configOptions: Array<{ id: string; currentValue?: string }> }
      ).configOptions.find((o) => o.id === "model"),
    ).toMatchObject({ currentValue: "test\\selected" });
  });

  it.each(["set_mode", "set_config_option", "/mode"])(
    "ignores a retired backend's %s acknowledgement",
    async (entry) => {
      const { server } = makeServer({
        setModeResult: { settings: { mode: { current: "build", planEnabled: true } } },
        onSetMode: (s) => s.resetBackendGeneration(),
      });
      server.lastMode.set("sess_acp", "edit");
      const { cx, sent } = mockContext();
      if (entry === "set_mode") {
        await setMode(server, { sessionId: "sess_acp", modeId: "plan" }, cx);
      } else if (entry === "/mode") {
        const reply = await handleSlashCommand(server, cx, "sess_acp", "sess_zcode", "/mode plan");
        expect(reply?.stopReason).toBe("end_turn");
      } else {
        const result = await setConfigOptionHandler(
          server,
          {
            sessionId: "sess_acp",
            configId: "mode",
            value: "plan",
          },
          cx,
        );
        expect(result.configOptions.map((o) => o.id)).toEqual(["model", "thought"]);
      }
      expect(
        sent.filter((u) =>
          ["config_option_update", "current_mode_update"].includes(u.sessionUpdate),
        ),
      ).toEqual([]);
      expect(server.planStateOf("sess_zcode")).toBeUndefined();
      expect(server.lastMode.get("sess_acp")).toBe("edit");
    },
  );

  it.each<[string, BackendSpec]>([
    ["RPC error", { readError: "session not active" }],
    ["timeout", { readError: "timeout" }],
    ["replacement during the read", { onRead: (s) => s.resetBackendGeneration() }],
    ["missing mode", { readResult: { settings: {} } }],
  ])("preserves the required configuration response after %s", async (_cause, spec) => {
    const { server, backend } = makeServer(spec);
    server.lastMode.set("sess_acp", "build");
    const { cx, sent } = mockContext();
    const response = await setConfigOptionHandler(
      server,
      { sessionId: "sess_acp", configId: "mode", value: "edit" },
      cx,
    );
    expect(response.configOptions.map((o) => o.id)).toEqual(["model", "thought"]);
    expect(backend.calls.filter((call) => call.method === "session/read")).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(server.lastMode.get("sess_acp")).toBe("build");
  });

  it("an EMPTY success response + a failing re-read keeps the switch successful, sends ZERO mode notifications and keeps lastMode", async () => {
    const { server } = makeServer({ readError: "session not active" });
    server.lastMode.set("sess_acp", "build");
    const { cx, sent } = mockContext();
    // The switch itself SUCCEEDED (no throw) — the failure is only the
    // confirmation read.
    await setMode(server, { sessionId: "sess_acp", modeId: "edit" }, cx);
    expect(sent.filter((u) => u.sessionUpdate === "config_option_update")).toHaveLength(0);
    expect(sent.filter((u) => u.sessionUpdate === "current_mode_update")).toHaveLength(0);
    expect(server.lastMode.get("sess_acp")).toBe("build");
  });

  it("a re-read TIMEOUT keeps the switch successful with zero notifications", async () => {
    const { server } = makeServer({ readError: "timeout" });
    server.lastMode.set("sess_acp", "build");
    const { cx, sent } = mockContext();
    await setMode(server, { sessionId: "sess_acp", modeId: "edit" }, cx);
    expect(sent.filter((u) => u.sessionUpdate === "config_option_update")).toHaveLength(0);
    expect(sent.filter((u) => u.sessionUpdate === "current_mode_update")).toHaveLength(0);
    expect(server.lastMode.get("sess_acp")).toBe("build");
  });

  it("a re-read answered by a REPLACED backend generation publishes nothing", async () => {
    const { server } = makeServer({
      readResult: { settings: { mode: { current: "edit" } } },
      onRead: (s) => s.resetBackendGeneration(),
    });
    server.lastMode.set("sess_acp", "build");
    const { cx, sent } = mockContext();
    await setMode(server, { sessionId: "sess_acp", modeId: "edit" }, cx);
    expect(sent.filter((u) => u.sessionUpdate === "config_option_update")).toHaveLength(0);
    expect(sent.filter((u) => u.sessionUpdate === "current_mode_update")).toHaveLength(0);
    expect(server.lastMode.get("sess_acp")).toBe("build");
  });

  it("a re-read missing the mode field keeps the previous display (no build/yolo fallback pair)", async () => {
    // The read succeeds but settings.mode.current is absent — nothing
    // confirmable. The stale read must NOT fabricate a fallback value.
    const { server } = makeServer({
      readResult: { settings: { thoughtLevel: { current: "max" } } },
    });
    server.lastMode.set("sess_acp", "build");
    const { cx, sent } = mockContext();
    await setMode(server, { sessionId: "sess_acp", modeId: "edit" }, cx);
    expect(sent.filter((u) => u.sessionUpdate === "current_mode_update")).toHaveLength(0);
    expect(server.lastMode.get("sess_acp")).toBe("build");
  });

  it("the backend REJECTING the switch returns the original error untouched", async () => {
    const { server } = makeServer({ setModeError: "Unsupported mode: nope" });
    const { cx, sent } = mockContext();
    await expect(setMode(server, { sessionId: "sess_acp", modeId: "nope" }, cx)).rejects.toThrow(
      "setMode failed: Unsupported mode: nope",
    );
    // A rejected switch publishes nothing.
    expect(sent.filter((u) => u.sessionUpdate === "config_option_update")).toHaveLength(0);
    expect(sent.filter((u) => u.sessionUpdate === "current_mode_update")).toHaveLength(0);
  });

  it("a successful switch to plan confirms the Plan switch; other modes confirm off", async () => {
    const { server } = makeServer();
    const { cx } = mockContext();
    await setMode(server, { sessionId: "sess_acp", modeId: "plan" }, cx);
    expect(server.planStateOf("sess_zcode")).toBe(true);
    await setMode(server, { sessionId: "sess_acp", modeId: "build" }, cx);
    expect(server.planStateOf("sess_zcode")).toBe(false);
  });
});
