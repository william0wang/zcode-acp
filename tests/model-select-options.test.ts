/**
 * ACP model option values always encode as providerId\modelId, including
 * builtins. Bare GLM-5.3 collided when two coding plans shipped the same id
 * and crashed clients that key on uniqueness (Paseo Command Center). A
 * collision-only prefix would have advertised different id shapes depending
 * on the user's enabled-provider set.
 *
 * parseModelValue still accepts a legacy bare modelId (first enabled builtin).
 * Dropdown labels stay the bare modelId for a single builtin; colliding
 * modelIds are qualified with the provider name.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_PROVIDER_ENV } from "../src/backend/resolve.js";
import { ZCODE_CREDS_PATH } from "../src/utils.js";
import { ZcodeAcpServer } from "../src/server.js";

function codingPlan(name: string, baseURL: string) {
  return {
    name,
    kind: "anthropic",
    enabled: true,
    options: { apiKey: "plan-token", apiKeyRequired: true, baseURL },
    models: {
      "GLM-5.3": { limit: { context: 200000 } },
      "GLM-5.3-Flash": { limit: { context: 200000 } },
    },
  };
}

function collidingPlansConfig() {
  return {
    provider: {
      "builtin:zai-coding-plan": codingPlan("Z.ai - Coding Plan", "https://api.z.ai/api/anthropic"),
      "builtin:zai-start-plan": codingPlan(
        "Z.ai - Start Plan",
        "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
      ),
    },
  };
}

let fakeConfig: unknown = collidingPlansConfig();

vi.mock("../src/backend/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // Hermetic table lookup (importOriginal keeps the rest): the REAL
  // builtinProviderEnv discovers the live desktop bundle and derives its
  // table path, which on a bridge-attached host exists and unions live
  // catalog models (GLM-5.4) into every fixed-list expectation below. An
  // empty derivation makes builtinTablePath() fall through to the ambient
  // env / real-bundle probes, both killed below.
  builtinProviderEnv: () => ({}),
}));

// Same direct-assignment rule as tests/setup/hermetic-home.ts: vi.stubEnv
// would be undone by this file's own afterEach (vi.unstubAllEnvs), resurrecting
// the bridge-injected ZCODE_BUILTIN_PROVIDER_CONFIG_FILE (a revision-48
// runtime table with GLM-5.4) after the first test. A delete cannot be
// un-stubbed back.
delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  // Hermetic bundle probe: builtinTablePath()'s last resort checks the real
  // desktop bundle path (/Applications/ZCode.app/.../zcode-builtin.json) via
  // existsSync — on a machine with the app installed that file exists and
  // leaks the live catalog into fixed-list expectations. Only tables the
  // tests themselves write (temp "zcode-builtin-table-" dirs) may resolve.
  return {
    ...actual,
    existsSync: (p: string) => {
      if (typeof p === "string" && p.includes("zcode-builtin.json")) {
        return actual.existsSync(p) && p.includes("zcode-builtin-table-");
      }
      return actual.existsSync(p);
    },
    readFileSync: (p: string) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(fakeConfig);
      return actual.readFileSync(p);
    },
  };
});

const {
  buildConfigOptions,
  buildInitialConfigOptions,
  buildModes,
  formatModelValue,
  loadAllModels,
  modesFromResolution,
  parseModelValue,
  resolveSessionMode,
} = await import("../src/config/options.js");

const tempDirs: string[] = [];

afterEach(() => {
  fakeConfig = collidingPlansConfig();
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("model configOptions uniqueness", () => {
  it("does not advertise duplicate values when two builtins share GLM-5.3", async () => {
    const options = await buildConfigOptions(new ZcodeAcpServer(), null);
    const model = options.find((option) => option.id === "model");
    const values = model?.options.map((option) => option.value) ?? [];

    expect(values).toEqual([...new Set(values)]);
    expect(values).toHaveLength(4);
    expect(model?.currentValue).toBeDefined();
    expect(values).toContain(model?.currentValue);
  });

  it("keeps both colliding coding plans selectable", async () => {
    const options = await buildConfigOptions(new ZcodeAcpServer(), null);
    const model = options.find((option) => option.id === "model");
    const parsed = (model?.options ?? []).map((option) => parseModelValue(option.value));

    expect(parsed).toEqual([
      { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3" },
      { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3-Flash" },
      { providerId: "builtin:zai-start-plan", modelId: "GLM-5.3" },
      { providerId: "builtin:zai-start-plan", modelId: "GLM-5.3-Flash" },
    ]);
    expect(model?.options.map((option) => option.name)).toEqual([
      "Z.ai - Coding Plan › GLM-5.3",
      "Z.ai - Coding Plan › GLM-5.3-Flash",
      "Z.ai - Start Plan › GLM-5.3",
      "Z.ai - Start Plan › GLM-5.3-Flash",
    ]);
  });

  it("encodes a single builtin as providerId\\modelId too", async () => {
    fakeConfig = {
      provider: {
        "builtin:zai-coding-plan": codingPlan(
          "Z.ai - Coding Plan",
          "https://api.z.ai/api/anthropic",
        ),
      },
    };

    const options = await buildConfigOptions(new ZcodeAcpServer(), null);
    const model = options.find((option) => option.id === "model");
    const values = model?.options.map((option) => option.value) ?? [];

    expect(values).toEqual([
      "builtin:zai-coding-plan\\GLM-5.3",
      "builtin:zai-coding-plan\\GLM-5.3-Flash",
    ]);
    expect(model?.options.map((option) => option.name)).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    expect(model?.currentValue).toBe(formatModelValue("builtin:zai-coding-plan", "GLM-5.3"));
    expect(parseModelValue("GLM-5.3")).toEqual({
      providerId: "builtin:zai-coding-plan",
      modelId: "GLM-5.3",
    });
    expect(loadAllModels()).toHaveLength(2);
  });
});

describe("registry snapshot dialect (account: refs)", () => {
  it("normalizes snapshot refs and the current onto the config dialect with display names", async () => {
    // A materialized session's modelAvailability carries the registry's
    // `account:` provider spellings with no display names; the dropdown must
    // not leak them (a coding-plan choice read as the raw
    // `account:…-individual-coding-plan › GLM-5.3` pair — an unreadable id
    // string on clients). Values and the current land on the config dialect.
    fakeConfig = {
      provider: {
        "builtin:zai-coding-plan": codingPlan(
          "Z.ai - Coding Plan",
          "https://api.z.ai/api/anthropic",
        ),
      },
    };
    const server = new ZcodeAcpServer();
    server.modelAvailability.set("zc-acct-1", [
      { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3" },
    ]);
    server.currentModelIdentity.set("zc-acct-1", {
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3",
    });
    server.backend = {
      isDead: false,
      request: async () => ({
        result: {
          settings: {
            mode: { current: "build" },
            model: {
              current: { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3" },
            },
            thoughtLevel: { current: "max", available: [] },
          },
        },
      }),
    } as unknown as NonNullable<ZcodeAcpServer["backend"]>;

    const options = await buildConfigOptions(server, "zc-acct-1");
    const model = options.find((option) => option.id === "model");
    // The display name is the bare model id — never the raw registry pair.
    // Values and the current KEEP the registry dialect (identity-preserving:
    // colliding legacy plans stay distinct, the switch round-trip works).
    expect(model?.options.map((option) => option.name)).toEqual(["GLM-5.3"]);
    expect(model?.currentValue).toBe("account:zai-individual-coding-plan\\GLM-5.3");
    expect(model?.options.map((option) => option.value)).toEqual([
      "account:zai-individual-coding-plan\\GLM-5.3",
    ]);
  });

  it("canonicalizes pending session/new coding-plan options to account: dialect when builtin table exists", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zcode-builtin-table-"));
    tempDirs.push(dir);
    const tablePath = path.join(dir, "zcode-builtin.json");
    writeFileSync(
      tablePath,
      JSON.stringify({
        revision: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "account:zai-individual-coding-plan",
                providerName: "Z.ai - Coding Plan",
                config: {
                  builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"],
                  access: {
                    type: "zhipu-account",
                    accountType: "zai",
                    mode: "individual-coding-plan",
                  },
                },
              },
              {
                providerId: "account:zai-start-plan",
                providerName: "Z.ai - Start Plan",
                config: {
                  builtinModelIds: ["GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"],
                  access: { type: "zhipu-account", accountType: "zai", mode: "start-plan" },
                },
              },
            ],
          },
        },
      }),
    );
    vi.stubEnv(BUILTIN_PROVIDER_ENV, tablePath);
    fakeConfig = {
      provider: {
        "builtin:zai-coding-plan": codingPlan(
          "Z.ai - Coding Plan",
          "https://api.z.ai/api/anthropic",
        ),
        "builtin:zai-start-plan": {
          name: "Z.ai - Start Plan",
          kind: "anthropic",
          enabled: true,
          options: {
            apiKey: "plan-token",
            apiKeyRequired: true,
            baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
          },
          models: { "GLM-5.3-Flash": { limit: { context: 200000 } } },
        },
      },
    };

    const options = await buildInitialConfigOptions(new ZcodeAcpServer(), undefined, null);
    const model = options.find((option) => option.id === "model");
    expect(model?.type).toBe("select");
    if (model?.type !== "select") throw Error("model option missing");

    expect(model.currentValue).toBe("account:zai-individual-coding-plan\\GLM-5.3");
    expect(model.options).toEqual([
      { value: "account:zai-individual-coding-plan\\GLM-5.3", name: "GLM-5.3" },
      {
        value: "account:zai-individual-coding-plan\\GLM-5.3-Flash",
        name: "Z.ai - Coding Plan › GLM-5.3-Flash",
      },
      {
        value: "account:zai-start-plan\\GLM-5.3-Flash",
        name: "Z.ai - Start Plan › GLM-5.3-Flash",
      },
      { value: "account:zai-start-plan\\GLM-5.2", name: "GLM-5.2" },
      { value: "account:zai-start-plan\\GLM-5-Turbo", name: "GLM-5-Turbo" },
    ]);
  });
});

describe("thought option display clamp", () => {
  it("never advertises a current outside the model's available levels (stale after setModel)", async () => {
    // The runtime can briefly keep the PREVIOUS model's thoughtLevel after a
    // setModel (upstream clamps its own snapshot for the same reason). The
    // bridge must not relay the stale value: the CLI would display — and
    // re-send — the old model's level.
    const server = new ZcodeAcpServer();
    server.backend = {
      isDead: false,
      request: async () => ({
        result: {
          settings: {
            mode: { current: "build" },
            model: { current: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3" } },
            thoughtLevel: {
              current: "max", // stale: the previous model's level
              defaultLevel: "high",
              available: [
                { value: "low", label: "Low" },
                { value: "high", label: "High" },
              ],
            },
          },
        },
      }),
    } as unknown as NonNullable<ZcodeAcpServer["backend"]>;

    const options = await buildConfigOptions(server, "zc-clamp-1");
    const thought = options.find((option) => option.id === "thought");
    expect(thought?.currentValue).toBe("high");
    expect(thought?.options.map((option) => option.value)).toEqual(["low", "high"]);
  });

  it("falls back to the first available level when the default is also outside the list", async () => {
    const server = new ZcodeAcpServer();
    server.backend = {
      isDead: false,
      request: async () => ({
        result: {
          settings: {
            mode: { current: "build" },
            model: { current: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3" } },
            thoughtLevel: {
              current: "max",
              defaultLevel: "max", // stale too
              available: [
                { value: "enabled", label: "Enabled" },
                { value: "off", label: "Off" },
              ],
            },
          },
        },
      }),
    } as unknown as NonNullable<ZcodeAcpServer["backend"]>;

    const options = await buildConfigOptions(server, "zc-clamp-2");
    const thought = options.find((option) => option.id === "thought");
    expect(thought?.currentValue).toBe("enabled");
  });
});

describe("plan-mode display fold", () => {
  // The runtime's EnterPlanMode flips the execution state's planEnabled
  // WITHOUT touching settings.mode — session/read keeps reporting the
  // underlying mode (verified upstream). The runtime-confirmed Plan record
  // must fold every advertised mode while it is on.
  function planServer(mode = "yolo"): ZcodeAcpServer {
    const server = new ZcodeAcpServer();
    server.backend = {
      isDead: false,
      request: async () => ({
        result: {
          settings: {
            mode: { current: mode },
            model: { current: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3" } },
            thoughtLevel: { current: "max" },
          },
        },
      }),
    } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
    return server;
  }

  it("buildModes advertises plan while Plan is confirmed on", async () => {
    const server = planServer("build");
    server.notePlanState("zc-plan-1", true);
    expect((await buildModes(server, "zc-plan-1"))?.currentModeId).toBe("plan");
  });

  it("buildModes shows the base mode when Plan is confirmed off — base build reads build", async () => {
    const server = planServer("build");
    server.notePlanState("zc-plan-2", false);
    expect((await buildModes(server, "zc-plan-2"))?.currentModeId).toBe("build");
  });

  it("buildConfigOptions sets the mode dropdown to plan while Plan is confirmed on", async () => {
    const server = planServer("yolo");
    server.notePlanState("zc-plan-3", true);
    const options = await buildConfigOptions(server, "zc-plan-3");
    const mode = options.find((option) => option.id === "mode");
    expect(mode?.currentValue).toBe("plan");
  });

  it("an UNKNOWN Plan switch withholds the effective mode (base build, plan never confirmed)", async () => {
    // A cold-resumed runtime may have restored Plan independently — the
    // bridge must not answer for it with the bare base mode.
    const server = planServer("build");
    expect(await buildModes(server, "zc-plan-4")).toBeNull();
    const options = await buildConfigOptions(server, "zc-plan-4");
    expect(options.find((option) => option.id === "mode")).toBeUndefined();
    // The rest of the options stay presentable.
    expect(options.some((option) => option.id === "model")).toBe(true);
    expect(options.some((option) => option.id === "thought")).toBe(true);
  });

  it("a later runtime confirmation restores the display — off shows build, on shows plan", async () => {
    const server = planServer("build");
    expect(await buildModes(server, "zc-plan-5")).toBeNull(); // unknown → withheld
    server.notePlanState("zc-plan-5", false);
    expect((await buildModes(server, "zc-plan-5"))?.currentModeId).toBe("build");
    server.notePlanState("zc-plan-5", true);
    expect((await buildModes(server, "zc-plan-5"))?.currentModeId).toBe("plan");
  });
});

/**
 * The two ACP mode fields share a snapshot or one confirming read. A newer
 * mode event or a runtime replacement invalidates an in-flight observation.
 */
describe("unified mode resolution", () => {
  interface ReadStub {
    result?: unknown;
    error?: { message: string };
    /** Runs before the stub answers — simulates mid-read races. */
    onRead?: (server: ZcodeAcpServer) => void;
  }

  function readCountingServer(stub: ReadStub): { server: ZcodeAcpServer; reads: () => number } {
    let count = 0;
    const server = new ZcodeAcpServer();
    server.backend = {
      isDead: false,
      request: async (_id: number, method: string) => {
        if (method === "session/read") {
          count++;
          stub.onRead?.(server);
          if (stub.error) return { error: stub.error };
          return { result: stub.result ?? {} };
        }
        return { result: {} };
      },
    } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
    return { server, reads: () => count };
  }

  const fullSettings = {
    mode: { current: "build" },
    model: { current: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3" } },
    thoughtLevel: { current: "max", available: [{ value: "max", label: "Max" }] },
  };

  it("pending sessions resolve both representations with ZERO backend reads", async () => {
    vi.stubEnv("ZCODE_ACP_MODE", "build");
    const { server, reads } = readCountingServer({});
    const modes = await buildModes(server, null);
    const options = await buildConfigOptions(server, null);
    expect(reads()).toBe(0);
    expect(modes?.currentModeId).toBe("build");
    const mode = options.find((option) => option.id === "mode");
    expect(mode?.currentValue).toBe("build");
    // The two representations must agree.
    expect(mode?.currentValue).toBe(modes?.currentModeId);
  });

  it("a complete trusted snapshot decides the mode with zero re-reads; both representations agree", async () => {
    const { server, reads } = readCountingServer({ result: { settings: fullSettings } });
    // Plan confirmed off (a fresh create seeds it from the accepted mode).
    server.notePlanState("zc-uni-1", false);
    const input = {
      snapshot: { settings: fullSettings, generation: server.backendGeneration },
      complete: true,
    };
    const modes = await buildModes(server, "zc-uni-1", input);
    const options = await buildConfigOptions(server, "zc-uni-1", undefined, input);
    expect(reads()).toBe(0);
    expect(modes?.currentModeId).toBe("build");
    expect(options.find((option) => option.id === "mode")?.currentValue).toBe("build");
  });

  it("a mode-less snapshot re-reads AT MOST once and shares the result with the options build", async () => {
    const { server, reads } = readCountingServer({ result: { settings: fullSettings } });
    server.notePlanState("zc-uni-2", false);
    const input = {
      snapshot: {
        settings: { model: fullSettings.model, thoughtLevel: fullSettings.thoughtLevel },
        generation: server.backendGeneration,
      },
    };
    const resolution = await resolveSessionMode(server, "zc-uni-2", input);
    const modes = modesFromResolution(resolution);
    const options = await buildConfigOptions(server, "zc-uni-2", undefined, { resolution });
    expect(reads()).toBe(1); // the ONE re-read; the options build reused it
    expect(modes?.currentModeId).toBe("build");
    expect(options.find((option) => option.id === "mode")?.currentValue).toBe("build");
  });

  it.each([
    [true, "plan"],
    [false, "build"],
  ])("uses planEnabled=%s from a confirming session/read", async (planEnabled, expected) => {
    const { server, reads } = readCountingServer({
      result: { settings: { mode: { current: "build", planEnabled } } },
    });
    expect((await buildModes(server, "zc-new-runtime"))?.currentModeId).toBe(expected);
    expect(reads()).toBe(1);
  });

  it("a failed read omits the mode instead of guessing a fallback", async () => {
    const { server } = readCountingServer({ error: { message: "session not active" } });
    expect(await buildModes(server, "zc-uni-3")).toBeNull();
    const options = await buildConfigOptions(server, "zc-uni-3");
    expect(options.find((option) => option.id === "mode")).toBeUndefined();
  });

  it("a read missing settings.mode.current withholds instead of falling back", async () => {
    const { server } = readCountingServer({
      result: { settings: { thoughtLevel: { current: "max" } } },
    });
    expect(await buildModes(server, "zc-uni-4")).toBeNull();
  });

  it("keeps an earlier read out of a later response when the current read fails", async () => {
    const stub: ReadStub = {
      result: { settings: { mode: { current: "edit", planEnabled: false } } },
    };
    const { server } = readCountingServer(stub);
    const sid = "zc-loss-of-contact";
    expect((await buildModes(server, sid))?.currentModeId).toBe("edit");
    stub.error = { message: "timeout" };
    expect(await buildModes(server, sid)).toBeNull();
    expect((await buildConfigOptions(server, sid)).some((o) => o.id === "mode")).toBe(false);
  });

  it("withholds an unrecognized base mode even when Plan is confirmed off", async () => {
    const { server } = readCountingServer({
      result: { settings: { mode: { current: "invalid" } } },
    });
    server.notePlanState("zc-invalid", false);
    expect(await buildModes(server, "zc-invalid")).toBeNull();
  });

  it("a newer mode event landing mid-read discards the stale read", async () => {
    const { server, reads } = readCountingServer({
      result: { settings: { mode: { current: "edit" } } },
      onRead: (s) => s.noteModeConfirmation("zc-uni-5"), // an event confirmed a newer update
    });
    const resolution = await resolveSessionMode(server, "zc-uni-5");
    expect(reads()).toBe(1);
    // The stale read (edit) must NOT decide the display.
    expect(resolution.effective).toBeUndefined();
    expect(modesFromResolution(resolution)).toBeNull();
  });

  it("a read answered by a REPLACED backend generation is discarded", async () => {
    const { server } = readCountingServer({
      result: { settings: { mode: { current: "edit" } } },
      onRead: (s) => s.resetBackendGeneration(), // the backend died mid-read
    });
    const resolution = await resolveSessionMode(server, "zc-uni-6");
    expect(resolution.effective).toBeUndefined();
  });

  it("same-process runtime recycling invalidates the Plan record — the old switch cannot answer for the new runtime", async () => {
    const { server } = readCountingServer({ result: { settings: { mode: { current: "build" } } } });
    server.notePlanState("zc-uni-7", true);
    expect((await buildModes(server, "zc-uni-7"))?.currentModeId).toBe("plan");
    // The resume flight rebuilds the runtime → invalidate (what
    // resumePreservingModel does on every performed resume).
    server.invalidatePlanState("zc-uni-7");
    expect(server.planStateOf("zc-uni-7")).toBeUndefined();
    // Base mode still readable, but Plan unknown → withheld.
    expect(await buildModes(server, "zc-uni-7")).toBeNull();
  });

  it("a backend generation change invalidates the Plan record", async () => {
    const { server } = readCountingServer({});
    server.notePlanState("zc-uni-8", true);
    expect(server.planStateOf("zc-uni-8")).toBe(true);
    server.resetBackendGeneration();
    expect(server.planStateOf("zc-uni-8")).toBeUndefined();
  });
});
