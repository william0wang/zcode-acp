/**
 * repairUnavailableModel (#270): the backend persists the current model under
 * the registry's `account:*` spelling while loadAllModels() speaks config.json's
 * `builtin:*` — the availability check must normalize before comparing, or
 * every resume misreads an enabled, PINNED model as gone and silently switches
 * to an arbitrary one. A genuine repair (model really absent) must prefer the
 * ZCODE_PROVIDER/ZCODE_MODEL pin over config-file list order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeResponse } from "../src/backend/types.js";
import { ZCODE_CREDS_PATH } from "../src/utils.js";

const FAKE_CONFIG = {
  provider: {
    // Enabled + keyed, config (builtin:) spelling — the same key shape the
    // README documents for ZCODE_PROVIDER.
    "builtin:zai-coding-plan": {
      name: "Zai",
      kind: "anthropic",
      enabled: true,
      options: { apiKey: "k-zai" },
      models: {
        "GLM-5.3": { limit: { context: 200000 } },
        "GLM-5.3-Flash": { limit: { context: 200000 } },
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

// Import AFTER vi.mock is set up.
const { repairUnavailableModel } = await import("../src/handlers/session.js");
const { ZcodeAcpServer } = await import("../src/server.js");

/** Scriptable current model + recorded session/setModel params. */
function makeHarness(current: { providerId: string; modelId: string } | null) {
  const setModelParams: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const backend = {
    isDead: false,
    request: async (id: number, method: string, params?: unknown): Promise<ZcodeResponse> => {
      calls.push(method);
      if (params && typeof params === "object" && "model" in params) {
        setModelParams.push(params as Record<string, unknown>);
      }
      switch (method) {
        case "session/read":
          return {
            id,
            result: {
              settings: current
                ? { model: { current } }
                : { model: { current: { providerId: "", modelId: "" } } },
              projection: { contextUsed: 1, contextWindow: 100 },
            },
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
  const server = new ZcodeAcpServer();
  server.backend = backend;
  return { server, calls, setModelParams };
}

const SID_Z = "zc-mr-1";

beforeEach(() => {
  // ZCODE_PROVIDER is not deleted by the hermetic setup — isolate from an
  // ambient pin on a developer machine; ZCODE_MODEL is stubbed per test.
  delete process.env.ZCODE_PROVIDER;
  delete process.env.ZCODE_MODEL;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("repairUnavailableModel (#270)", () => {
  it("does not repair when only the account:/builtin: spelling differs", async () => {
    const { server, calls } = makeHarness({
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3-Flash",
    });
    await repairUnavailableModel(server, SID_Z);
    expect(calls).not.toContain("session/setModel");
  });

  it("repairs a genuinely unavailable model to the ZCODE_* pin, not list order", async () => {
    vi.stubEnv("ZCODE_PROVIDER", "builtin:zai-coding-plan");
    vi.stubEnv("ZCODE_MODEL", "GLM-5.3-Flash");
    const { server, setModelParams } = makeHarness({
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-4.5-Air", // removed upstream — absent from config.json
    });
    await repairUnavailableModel(server, SID_Z);
    expect(setModelParams.length).toBeGreaterThan(0);
    const model = setModelParams[0]!["model"] as { modelId?: string };
    expect(model.modelId).toBe("GLM-5.3-Flash"); // the pin, NOT available[0] (GLM-5.3)
  });

  it("falls back to the first enabled model when no pin is set", async () => {
    const { server, setModelParams } = makeHarness({
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-4.5-Air",
    });
    await repairUnavailableModel(server, SID_Z);
    expect(setModelParams.length).toBeGreaterThan(0);
    const model = setModelParams[0]!["model"] as { modelId?: string };
    expect(model.modelId).toBe("GLM-5.3"); // config.json's first enabled model
  });
});
