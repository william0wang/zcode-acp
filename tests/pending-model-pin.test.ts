/**
 * Pending-session model advertisement vs. what the turn actually runs.
 *
 * The lazy `session/new` has no backend session yet, so the model
 * `currentValue` it advertises is a projection (the dropdown leader, or the
 * deferred catalog probe's snapshot). `session/create` is the first moment a
 * model actually exists, and the backend's own default can differ — e.g. a
 * desktop-side account family selected in setting.json wins over the bridge's
 * configured-provider leader. ACP clients skip a requested model switch when
 * it equals the advertised current value, so that disagreement silently ran
 * turns on a model the client never selected (observed with T3 Code: the
 * thread stored a custom-provider model, the turn billed the desktop's
 * unentitled coding plan and failed with provider code 1113).
 *
 * The bridge now pins the advertised model at materialization, so the
 * advertisement stays true whether or not the client re-sends its selection.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeResponse } from "../src/backend/types.js";
import { ensureRealSession, newSession } from "../src/handlers/session.js";
import { lookupLazySession } from "../src/lazy-sessions.js";
import { ZcodeAcpServer } from "../src/server.js";
import { ZCODE_CREDS_PATH, zcodePersonalProviderPath } from "../src/utils.js";

// The deferred catalog probe spawns an isolated backend; keep it inert unless a
// test opts in (none do today — the initial projection is what this file locks).
vi.mock("../src/config/initial-model-catalog.js", () => ({
  probeInitialModelCatalog: async () => null,
}));

// The real module writes the App's ~/.zcode/v2/tasks-index.sqlite.
vi.mock("../src/tasks-index.js", () => ({
  reviveTombstonesOnActivity: async () => 0,
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
  renameSessionTask: async () => true,
  readTaskTitle: async () => null,
  overriddenTaskTitles: async () => new Map(),
}));

/**
 * Config.json fixture: a custom provider FIRST (so `loadAllModels()[0]` is
 * `custom-first\first-model`, exactly the value the pending menu advertises),
 * plus an enabled coding-plan provider whose family the backend would
 * otherwise pick on its own.
 */
const FAKE_CONFIG = {
  provider: {
    "custom-first": {
      name: "CustomFirst",
      kind: "anthropic",
      enabled: true,
      options: { apiKey: "test-key", baseURL: "http://127.0.0.1:9999" },
      models: { "first-model": { limit: { context: 200000 } } },
    },
    "builtin:bigmodel-coding-plan": {
      name: "BigModel",
      kind: "anthropic",
      enabled: true,
      options: {
        apiKey: "plan-token",
        baseURL: "https://open.bigmodel.cn/api/anthropic",
      },
      models: { "GLM-5.3": { limit: { context: 200000 } } },
    },
  },
};

/**
 * A personal provider_config.json fixture whose provider exists NOWHERE in
 * config.json — the advertised leader is personal-only. Swapped in by the
 * personal-only test; null (absent file) otherwise.
 */
let fakePersonal: unknown = null;
/** Swapped by the personal-only test; the shared FAKE_CONFIG otherwise. */
let fakeConfig: unknown = FAKE_CONFIG;
const PERSONAL_ONLY = {
  schemaVersion: 1,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "uuid-personal",
          providerName: "PersonalOnly",
          enabled: true,
          config: {
            access: { type: "api-key", apiKey: "personal-key" },
            api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:8/v1" },
          },
        },
      ],
    },
    modelConfigRules: {
      providerModelRules: [
        {
          providerId: "uuid-personal",
          modelId: "pm-1",
          config: { enabled: true, properties: { contextWindow: 200000 } },
        },
      ],
    },
  },
};

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(fakeConfig);
      if (p === zcodePersonalProviderPath() && fakePersonal !== null) {
        return JSON.stringify(fakePersonal);
      }
      return actual.readFileSync(p);
    },
  };
});

const ADVERTISED = "custom-first\\first-model";
const ACCOUNT_DEFAULT = "account:bigmodel-individual-coding-plan\\GLM-5.3";

/** Fake backend: records calls, answers create/setModel/registry RPCs. */
function fakeBackend(
  setModel: () => ZcodeResponse = () => ({ id: 0, result: {} }) as ZcodeResponse,
): {
  backend: NonNullable<ZcodeAcpServer["backend"]>;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  let created = 0;
  const backend = {
    isDead: false,
    request: async (id: number, method: string, params: unknown): Promise<ZcodeResponse> => {
      calls.push({ method, params });
      switch (method) {
        case "session/create":
          created += 1;
          return {
            id,
            result: {
              session: { sessionId: `sess_pin_${created}`, title: "", traceId: "trace_pin" },
              settings: {
                model: {
                  current: {
                    providerId: "account:bigmodel-individual-coding-plan",
                    modelId: "GLM-5.3",
                  },
                  available: [
                    { ref: { providerId: "custom-first", modelId: "first-model" } },
                    {
                      ref: {
                        providerId: "account:bigmodel-individual-coding-plan",
                        modelId: "GLM-5.3",
                      },
                    },
                  ],
                },
              },
            },
          } as ZcodeResponse;
        case "session/setModel":
          return setModel();
        case "workspace/updateProviderRegistry":
          return { id, result: {} } as ZcodeResponse;
        case "provider/updateAccountConfig":
          return {
            id,
            result: { receivedRevision: "account:test", providerCount: 0, status: "received" },
          } as ZcodeResponse;
        case "session/read":
          return { id, result: { settings: {}, projection: {} } } as ZcodeResponse;
        case "session/messages":
          return { id, result: { messages: [] } } as ZcodeResponse;
        default:
          return { id, result: {} } as ZcodeResponse;
      }
    },
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
  return { backend, calls };
}

function newSessionParams(cwd: string): acp.NewSessionRequest {
  return { cwd } as acp.NewSessionRequest;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  fakePersonal = null;
  fakeConfig = FAKE_CONFIG;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pending model advertisement", () => {
  it("advertises the configured leader as the pending current model", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/pin-ws"));

    const model = resp.configOptions.find((o) => o.id === "model");
    expect(model?.type).toBe("select");
    expect(model?.type === "select" ? model.currentValue : undefined).toBe(ADVERTISED);
    expect(server.pendingSessions.get(resp.sessionId)?.advertisedModel).toBe(ADVERTISED);
  });

  it("pins the advertised model at materialization (client may skip its switch)", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/pin-ws"));
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    const sid = await ensureRealSession(server, resp.sessionId);

    const createAt = calls.findIndex((c) => c.method === "session/create");
    const setAt = calls.findIndex((c) => c.method === "session/setModel");
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(setAt).toBeGreaterThan(createAt);
    expect(calls[setAt]?.params).toMatchObject({
      sessionId: sid,
      model: { providerId: "custom-first", modelId: "first-model" },
      persistAsWorkspaceLastUsed: false,
    });
    // Another setModel (e.g. a reasoning-level retry) would mean the ladder
    // mis-fired on a level-less model.
    expect(calls.filter((c) => c.method === "session/setModel")).toHaveLength(1);

    // Remembered in memory AND durably, so a backend resume re-asserts it.
    expect(server.sessionModelChoices.get(sid)?.model).toBe(ADVERTISED);
    expect(lookupLazySession(resp.sessionId)?.modelChoice?.model).toBe(ADVERTISED);
  });

  it("does not override a client-recorded choice", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/pin-ws"));
    const { backend, calls } = fakeBackend();
    // A switch recorded before materialization (e.g. a raced config change)
    // owns the selection; the pin must not override it.
    server.sessionModelChoices.set("sess_pin_1", { model: ACCOUNT_DEFAULT });
    server.backend = backend;

    await ensureRealSession(server, resp.sessionId);

    expect(calls.filter((c) => c.method === "session/setModel")).toHaveLength(0);
  });

  it("keeps the backend default when the pin is refused, without failing materialization", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/pin-ws"));
    const { backend, calls } = fakeBackend(
      () => ({ id: 0, error: { message: "model unavailable" } }) as ZcodeResponse,
    );
    server.backend = backend;

    await expect(ensureRealSession(server, resp.sessionId)).resolves.toBe("sess_pin_1");
    expect(calls.filter((c) => c.method === "session/setModel")).toHaveLength(1);
    expect(server.sessionModelChoices.get("sess_pin_1")).toBeUndefined();
  });

  it("honors ZCODE_ACP_PIN_DEFAULT_MODEL=0 (inherit the backend default)", async () => {
    vi.stubEnv("ZCODE_ACP_PIN_DEFAULT_MODEL", "0");
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/pin-ws"));
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await ensureRealSession(server, resp.sessionId);

    expect(calls.filter((c) => c.method === "session/setModel")).toHaveLength(0);
    expect(server.sessionModelChoices.get("sess_pin_1")).toBeUndefined();
  });

  it("lets the ZCODE_PROVIDER/ZCODE_MODEL pin own the selection", async () => {
    vi.stubEnv("ZCODE_PROVIDER", "builtin:bigmodel-coding-plan");
    vi.stubEnv("ZCODE_MODEL", "GLM-5.3");
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/pin-ws"));
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    const sid = await ensureRealSession(server, resp.sessionId);

    const setModels = calls.filter((c) => c.method === "session/setModel");
    expect(setModels).toHaveLength(1);
    // Provider spelling is environment-dependent (the bundled builtin table
    // rewrites builtin:* → account:* when the desktop app is installed), so
    // only the model id and the session target are stable here.
    expect(setModels[0]?.params).toMatchObject({
      sessionId: sid,
      model: { modelId: "GLM-5.3" },
    });
  });

  it("re-pins the advertised model after a bridge restart via the durable record", async () => {
    const first = new ZcodeAcpServer();
    const resp = await newSession(first, newSessionParams("/tmp/pin-ws"));
    // The advertisement survives in the durable store, not just in memory.
    expect(lookupLazySession(resp.sessionId)?.advertisedModel).toBe(ADVERTISED);

    const second = new ZcodeAcpServer(); // fresh process: no in-memory pending
    const { backend, calls } = fakeBackend();
    second.backend = backend;
    const sid = await ensureRealSession(second, resp.sessionId);

    const setModels = calls.filter((c) => c.method === "session/setModel");
    expect(setModels).toHaveLength(1);
    expect(setModels[0]?.params).toMatchObject({
      sessionId: sid,
      model: { providerId: "custom-first", modelId: "first-model" },
    });
  });

  it("pins a personal-only advertised provider (absent from config.json)", async () => {
    // Every config.json provider disabled — the personal rule is the leader
    // (loadAllModels leaks no default provider since #156).
    fakeConfig = {
      provider: {
        "custom-first": { ...FAKE_CONFIG.provider["custom-first"]!, enabled: false },
        "builtin:bigmodel-coding-plan": {
          ...FAKE_CONFIG.provider["builtin:bigmodel-coding-plan"]!,
          enabled: false,
        },
      },
    };
    fakePersonal = PERSONAL_ONLY;
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/pin-ws"));
    const model = resp.configOptions.find((o) => o.id === "model");
    expect(model?.type === "select" ? model.currentValue : undefined).toBe("uuid-personal\\pm-1");

    const { backend, calls } = fakeBackend();
    server.backend = backend;
    await ensureRealSession(server, resp.sessionId);

    // The old findProviderConfig guard skipped exactly this case; the backend
    // registry resolves personal providers fine, so the pin must fire.
    const setModels = calls.filter((c) => c.method === "session/setModel");
    expect(setModels).toHaveLength(1);
    expect(setModels[0]?.params).toMatchObject({
      model: { providerId: "uuid-personal", modelId: "pm-1" },
    });
  });
});
