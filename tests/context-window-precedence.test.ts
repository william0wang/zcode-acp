/**
 * Context-gauge `size` precedence regression tests.
 *
 * `usage_update.size` comes from ONE ladder (`usageWindowSize`): the user's
 * config.json `limit.context`, the personal rule, then the provider table's
 * own rule walk, and only then the size the backend reported. The CLI's
 * projection seeds `contextWindow` with a hardcoded 200K default
 * (bundle-verified: the initial reducer state carries `contextWindow: 2e5`)
 * and reports a model's real window only through turn-time usage events — so
 * every value the bridge emits OUTSIDE that moment (initial usage, the
 * post-switch refresh, the TUI's boot reading) has to come from the ladder.
 *
 * History: config.json alone used to be the ladder, and the gauge
 * flip-flopped — 1M at boot/model-switch (config-filled) but 200K during
 * turns (backend event value passed through nonzero). Then (2026-11-23) a
 * model that arrives only through the provider table (GLM-5.4) exposed the
 * opposite hole: no config.json entry, so the turn-time gauge was right (the
 * backend knows the window) while the post-switch refresh emitted size 0 —
 * the table walk is the rung that closes it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";
import { dispatchEvent } from "../src/handlers/dispatch.js";
import { emitInitialUsage, currentModelCached } from "../src/config/model-cache.js";
import { emitConfigOptionUpdate } from "../src/config/options.js";
import { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeBackend } from "../src/backend/client.js";

const FAKE_CONFIG = {
  provider: {
    "builtin:bigmodel-coding-plan": {
      name: "GLM Coding Plan",
      kind: "anthropic",
      enabled: true,
      options: { baseURL: "https://example.test/api", apiKey: "plan-token" },
      models: {
        "GLM-5.3": { limit: { context: 1000000 } },
      },
      // No GLM-5.4 entry: that model is known to the provider table alone.
    },
    "custom:other": {
      name: "Other",
      kind: "anthropic",
      enabled: true,
      options: { baseURL: "https://other.test/api", apiKey: "k" },
      // No models entry → modelContextWindow() returns 0 → backend fallback.
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

const table = vi.hoisted(() => ({ path: "" }));

vi.mock("../src/backend/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  builtinProviderEnv: () => ({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: table.path }),
}));

/**
 * A miniature provider table: the coding-plan provider GLM-5.4 arrives
 * through, a 1M baseline, and one rule that resets a model's window — the
 * case where even a registry-known model falls back to the backend's size.
 */
const TABLE = {
  schemaVersion: 1,
  revision: 47,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "account:bigmodel-individual-coding-plan",
          config: {
            access: {
              type: "zhipu-account",
              mode: "individual-coding-plan",
              accountType: "bigmodel",
            },
            api: { type: "anthropic-messages", baseUrl: "https://open.bigmodel.cn/api/anthropic" },
            builtinModelIds: ["GLM-5.4", "GLM-5.3"],
          },
        },
      ],
    },
    modelConfigRules: {
      modelRules: [
        { modelMatch: ".*", config: { properties: { contextWindow: 1000000 } } },
        { modelMatch: ".*nowin.*", config: { properties: null } },
      ],
      modelApiRules: [],
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [],
    },
  },
};

interface Update {
  sessionId: string;
  update: Record<string, unknown>;
}

function collectCx(): { cx: acp.AgentContext; updates: Update[] } {
  const updates: Update[] = [];
  const cx = {
    notify: async (_method: string, params: Record<string, unknown>) => {
      updates.push(params as unknown as Update);
    },
    request: async () => ({}),
  } as unknown as acp.AgentContext;
  return { cx, updates };
}

/**
 * Fake backend answering session/read with a placeholder 200K projection and
 * (when configured) the session's current model in settings.
 */
function fakeBackend(settings: Record<string, unknown> = {}): ZcodeBackend {
  return {
    isDead: false,
    request: async (_id: number, method: string) => {
      if (method === "session/read") {
        return {
          result: {
            projection: { contextUsed: 46000, totalTokenCount: 46000, contextWindow: 200000 },
            settings,
          },
        };
      }
      return { result: {} };
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
}

function setup(settings: Record<string, unknown>): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = fakeBackend(settings);
  server.registerSession("sess_cw", "zs_cw");
  server.markBackendLoaded("sess_cw");
  return server;
}

const GLM_54 = {
  providerId: "account:bigmodel-individual-coding-plan",
  modelId: "GLM-5.4",
};
const ON_GLM_54 = { model: { current: GLM_54 } };
const PLACEHOLDER_TURN = { kind: "UsageDelta", used: 46000, size: 200000 } as const;

let tableDir: string;

beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
  tableDir = mkdtempSync(path.join(tmpdir(), "context-window-"));
  table.path = path.join(tableDir, "zcode-builtin.json");
  writeFileSync(table.path, JSON.stringify(TABLE));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tableDir, { recursive: true, force: true });
});

describe("usage_update size precedence (config limit beats backend placeholder)", () => {
  it("a UsageDelta carrying the backend 200K placeholder emits the configured 1M", async () => {
    const server = setup({
      model: {
        current: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3" },
      },
    });
    // Prime the model cache the way a real turn would (session/read).
    await currentModelCached(server, "zs_cw");
    const { cx, updates } = collectCx();
    await dispatchEvent(server, cx, "sess_cw", { kind: "UsageDelta", used: 46000, size: 200000 });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.update).toEqual({
      sessionUpdate: "usage_update",
      used: 46000,
      size: 1000000,
    });
  });

  it("falls back to the backend value when config.json has no limit for the model", async () => {
    const server = setup({
      model: { current: { providerId: "custom:other", modelId: "mystery-model" } },
    });
    await currentModelCached(server, "zs_cw");
    const { cx, updates } = collectCx();
    await dispatchEvent(server, cx, "sess_cw", { kind: "UsageDelta", used: 1000, size: 200000 });
    expect(updates[0]!.update).toEqual({ sessionUpdate: "usage_update", used: 1000, size: 200000 });
  });

  it("emitInitialUsage uses the configured window over the projection's placeholder", async () => {
    const server = setup({
      model: {
        current: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3" },
      },
    });
    const { cx, updates } = collectCx();
    await emitInitialUsage(server, cx, "sess_cw", "zs_cw", undefined);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.update).toEqual({
      sessionUpdate: "usage_update",
      used: 46000,
      size: 1000000,
    });
  });
});

describe("usage_update size precedence (the provider table is the third rung)", () => {
  it("a turn on GLM-5.4 — known to the table alone — reports the table's window", async () => {
    const server = setup(ON_GLM_54);
    await currentModelCached(server, "zs_cw");
    const { cx, updates } = collectCx();
    await dispatchEvent(server, cx, "sess_cw", PLACEHOLDER_TURN);
    expect(updates[0]!.update).toEqual({
      sessionUpdate: "usage_update",
      used: 46000,
      size: 1000000,
    });
  });

  it("the initial usage after a load reports the same window", async () => {
    const server = setup(ON_GLM_54);
    const { cx, updates } = collectCx();
    await emitInitialUsage(server, cx, "sess_cw", "zs_cw", undefined);
    expect(updates[0]!.update).toEqual({
      sessionUpdate: "usage_update",
      used: 46000,
      size: 1000000,
    });
  });

  it("the refresh after a model switch reports it too — the three sites never disagree", async () => {
    // The backend's 200K is the input at every site; the answer must be the
    // same 1M, never the 0 the switch refresh used to emit for this model.
    const server = setup(ON_GLM_54);
    const { cx, updates } = collectCx();
    await emitConfigOptionUpdate(server, cx, "sess_cw", "zs_cw", "model");
    const usage = updates.map((u) => u.update).filter((u) => u.sessionUpdate === "usage_update");
    expect(usage).toEqual([{ sessionUpdate: "usage_update", used: 46000, size: 1000000 }]);
  });

  it("a registry-known model whose rules reset the window falls back to the backend size", async () => {
    const server = setup({
      model: {
        current: { providerId: "account:bigmodel-individual-coding-plan", modelId: "nowin-model" },
      },
    });
    await currentModelCached(server, "zs_cw");
    const { cx, updates } = collectCx();
    await dispatchEvent(server, cx, "sess_cw", PLACEHOLDER_TURN);
    expect(updates[0]!.update).toEqual({
      sessionUpdate: "usage_update",
      used: 46000,
      size: 200000,
    });
  });

  it("a provider the registry does not know keeps the backend-reported size", async () => {
    // `custom:other` is in config.json alone: the table's `.*` baseline must
    // not reach it — the backend enforces its own number there.
    const server = setup({
      model: { current: { providerId: "custom:other", modelId: "mystery-model" } },
    });
    await currentModelCached(server, "zs_cw");
    const { cx, updates } = collectCx();
    await dispatchEvent(server, cx, "sess_cw", PLACEHOLDER_TURN);
    expect(updates[0]!.update).toEqual({
      sessionUpdate: "usage_update",
      used: 46000,
      size: 200000,
    });
  });
});
