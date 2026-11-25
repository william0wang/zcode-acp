/**
 * The user's default thought level (`session.defaultThoughtLevel`): what a
 * pending session advertises, and what a new session really starts on.
 *
 * Same shape as pending-model-pin.test.ts — the lazy `session/new` has no
 * backend session yet, so its thought `currentValue` is a projection; the
 * first use materializes the session and applies the default against the
 * backend's own vocabulary.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeResponse } from "../src/backend/types.js";
import { ensureRealSession, newSession } from "../src/handlers/session.js";
import { lookupLazySession } from "../src/lazy-sessions.js";
import { ZcodeAcpServer } from "../src/server.js";
import { ZCODE_CREDS_PATH } from "../src/utils.js";

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

/** One custom provider whose only model declares low/high/max (default max). */
const FAKE_CONFIG = {
  provider: {
    "custom-first": {
      name: "CustomFirst",
      kind: "anthropic",
      enabled: true,
      options: { apiKey: "test-key", baseURL: "http://127.0.0.1:9999" },
      models: {
        "first-model": {
          limit: { context: 200000 },
          reasoning: { variants: ["low", "high", "max"], defaultVariant: "max" },
        },
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

const GLM_LEVELS = [
  { value: "low", label: "low" },
  { value: "high", label: "high" },
  { value: "max", label: "max" },
];

/** A scratch XDG config root; `configure()` writes the user config into it. */
let xdg: string;

/** Write (or, for undefined, omit) `session.defaultThoughtLevel` in the user config. */
function configure(defaultThoughtLevel?: string): void {
  const dir = path.join(xdg, "zcode-acp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify(
      defaultThoughtLevel === undefined
        ? { session: { mode: "plan" } }
        : { session: { mode: "plan", defaultThoughtLevel } },
    ),
  );
}

interface FakeBackend {
  backend: NonNullable<ZcodeAcpServer["backend"]>;
  calls: Array<{ method: string; params: unknown }>;
}

/** Fake backend: records calls; `session/read` answers the given vocabulary. */
function fakeBackend(opts: {
  levels?: Array<{ value: string; label: string }>;
  defaultLevel?: string;
  refuseThoughtLevel?: boolean;
}): FakeBackend {
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
              session: { sessionId: `sess_thought_${created}`, title: "", traceId: "trace_t" },
              settings: {
                model: {
                  current: { providerId: "custom-first", modelId: "first-model" },
                  available: [{ ref: { providerId: "custom-first", modelId: "first-model" } }],
                },
              },
            },
          } as ZcodeResponse;
        case "session/read":
          return {
            id,
            result: {
              settings: {
                model: { current: { providerId: "custom-first", modelId: "first-model" } },
                thoughtLevel: {
                  defaultLevel: opts.defaultLevel ?? opts.levels?.[0]?.value,
                  available: opts.levels,
                },
              },
              projection: {},
            },
          } as ZcodeResponse;
        case "session/setThoughtLevel":
          return opts.refuseThoughtLevel
            ? ({ id, error: { message: "level not supported" } } as ZcodeResponse)
            : ({ id, result: {} } as ZcodeResponse);
        default:
          return { id, result: {} } as ZcodeResponse;
      }
    },
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
  return { backend, calls };
}

const thoughtCalls = (fake: FakeBackend) =>
  fake.calls.filter((c) => c.method === "session/setThoughtLevel");

function thoughtOption(
  options: acp.SessionConfigOption[],
): Extract<acp.SessionConfigOption, { type: "select" }> {
  const option = options.find((o) => o.id === "thought");
  if (option?.type !== "select") throw new Error("no thought select option");
  return option;
}

beforeEach(() => {
  xdg = mkdtempSync(path.join(tmpdir(), "zacp-dtl-"));
  vi.stubEnv("XDG_CONFIG_HOME", xdg);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(xdg, { recursive: true, force: true });
});

describe("default thought level — pending menu", () => {
  it("advertises the default as the pending current level", async () => {
    configure("high");
    const resp = await newSession(new ZcodeAcpServer(), {
      cwd: "/tmp/dtl-ws",
    } as acp.NewSessionRequest);

    const thought = thoughtOption(resp.configOptions);
    expect(thought.currentValue).toBe("high");
    expect(thought.options).toEqual([
      { value: "low", name: "low" },
      { value: "high", name: "high" },
      { value: "max", name: "max" },
    ]);
  });

  it("keeps the model's own default when none is configured", async () => {
    configure();
    const resp = await newSession(new ZcodeAcpServer(), {
      cwd: "/tmp/dtl-ws",
    } as acp.NewSessionRequest);

    expect(thoughtOption(resp.configOptions).currentValue).toBe("max");
  });

  it("keeps the model's own default when the advertised vocabulary lacks the level", async () => {
    configure("medium");
    const resp = await newSession(new ZcodeAcpServer(), {
      cwd: "/tmp/dtl-ws",
    } as acp.NewSessionRequest);

    // Never advertised, never forced: a client that relays currentValue into
    // a picker must not be offered a token the model rejects.
    expect(thoughtOption(resp.configOptions).currentValue).toBe("max");
  });
});

describe("default thought level — materialization", () => {
  it("starts the session on the default and remembers it as the session's choice", async () => {
    configure("high");
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, { cwd: "/tmp/dtl-ws" } as acp.NewSessionRequest);
    const fake = fakeBackend({ levels: GLM_LEVELS, defaultLevel: "max" });
    server.backend = fake.backend;

    const sid = await ensureRealSession(server, resp.sessionId);

    const setModelAt = fake.calls.findIndex((c) => c.method === "session/setModel");
    const setLevel = thoughtCalls(fake);
    expect(setLevel).toHaveLength(1);
    expect(setLevel[0]?.params).toEqual({ sessionId: sid, thoughtLevel: "high" });
    // After the model pin: the level is validated against the model the
    // session actually landed on.
    expect(fake.calls.indexOf(setLevel[0]!)).toBeGreaterThan(setModelAt);
    // In memory AND durably, so a backend resume re-asserts it. The model the
    // pin recorded just before survives this second write (merge-write).
    expect(server.sessionModelChoices.get(sid)).toMatchObject({
      thought: "high",
      model: "custom-first\\first-model",
    });
    expect(lookupLazySession(resp.sessionId)?.modelChoice).toMatchObject({
      thought: "high",
      model: "custom-first\\first-model",
    });
  });

  it("sends the backend's spelling of a level that differs only by case", async () => {
    configure("High");
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, { cwd: "/tmp/dtl-ws" } as acp.NewSessionRequest);
    const fake = fakeBackend({ levels: GLM_LEVELS, defaultLevel: "max" });
    server.backend = fake.backend;

    await ensureRealSession(server, resp.sessionId);

    expect(thoughtCalls(fake)[0]?.params).toMatchObject({ thoughtLevel: "high" });
  });

  it("keeps the model's default when the model does not offer the level", async () => {
    configure("high");
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, { cwd: "/tmp/dtl-ws" } as acp.NewSessionRequest);
    const fake = fakeBackend({
      levels: [
        { value: "enabled", label: "enabled" },
        { value: "off", label: "off" },
      ],
      defaultLevel: "enabled",
    });
    server.backend = fake.backend;

    const sid = await ensureRealSession(server, resp.sessionId);

    expect(thoughtCalls(fake)).toHaveLength(0);
    expect(server.sessionModelChoices.get(sid)?.thought).toBeUndefined();
  });

  it("keeps the model default when the backend refuses the level", async () => {
    configure("high");
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, { cwd: "/tmp/dtl-ws" } as acp.NewSessionRequest);
    const fake = fakeBackend({ levels: GLM_LEVELS, defaultLevel: "max", refuseThoughtLevel: true });
    server.backend = fake.backend;

    const sid = await ensureRealSession(server, resp.sessionId);

    expect(thoughtCalls(fake)).toHaveLength(1);
    expect(server.sessionModelChoices.get(sid)?.thought).toBeUndefined();
  });

  it("does not override a choice already recorded for the session", async () => {
    configure("high");
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, { cwd: "/tmp/dtl-ws" } as acp.NewSessionRequest);
    const fake = fakeBackend({ levels: GLM_LEVELS, defaultLevel: "max" });
    // A recovered store record — including a remembered RESET ("") — owns
    // the selection.
    server.sessionModelChoices.set("sess_thought_1", { thought: "" });
    server.backend = fake.backend;

    await ensureRealSession(server, resp.sessionId);

    expect(thoughtCalls(fake)).toHaveLength(0);
    expect(server.sessionModelChoices.get("sess_thought_1")?.thought).toBe("");
  });

  it("is inert without a configured default (no extra backend reads)", async () => {
    configure();
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, { cwd: "/tmp/dtl-ws" } as acp.NewSessionRequest);
    const fake = fakeBackend({ levels: GLM_LEVELS, defaultLevel: "max" });
    server.backend = fake.backend;

    await ensureRealSession(server, resp.sessionId);

    expect(thoughtCalls(fake)).toHaveLength(0);
    expect(fake.calls.filter((c) => c.method === "session/read")).toHaveLength(0);
  });

  it("leaves the session alone when the read carries no vocabulary", async () => {
    configure("high");
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, { cwd: "/tmp/dtl-ws" } as acp.NewSessionRequest);
    const fake = fakeBackend({});
    server.backend = fake.backend;

    await ensureRealSession(server, resp.sessionId);

    // Unknown is not "unsupported": nothing applied, nothing recorded.
    expect(thoughtCalls(fake)).toHaveLength(0);
    expect(server.sessionModelChoices.get("sess_thought_1")?.thought).toBeUndefined();
  });

  it("applies the default again when a placeholder outlives a bridge restart", async () => {
    configure("high");
    const resp = await newSession(new ZcodeAcpServer(), {
      cwd: "/tmp/dtl-ws",
    } as acp.NewSessionRequest);

    const second = new ZcodeAcpServer(); // fresh process: no in-memory pending
    const fake = fakeBackend({ levels: GLM_LEVELS, defaultLevel: "max" });
    second.backend = fake.backend;
    const sid = await ensureRealSession(second, resp.sessionId);

    expect(thoughtCalls(fake)[0]?.params).toEqual({ sessionId: sid, thoughtLevel: "high" });
  });
});
