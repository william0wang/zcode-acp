/**
 * `GET /settings/models` — the models payload the clients join against for a
 * model's context window. Both clients (the mobile/web `ModelsPage` and the
 * desktop workbench's `rule_for`) take the FIRST `modelRules` row whose
 * provider id folds equal to the model's and whose model id matches.
 *
 * The stored rules alone left gaps in that join (reported 2026-11-23): a
 * coding-plan model arrives only through the provider table and has no rule
 * (GLM-5.4 showed no context suffix), and the desktop writes coding-plan
 * rules without a window. The payload now fills and appends rows so every
 * selectable model resolves — with no client change, and without touching
 * what the write routes store.
 */

import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const table = vi.hoisted(() => ({ path: "" }));

vi.mock("../src/backend/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  builtinProviderEnv: () => ({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: table.path }),
}));

const { createSettingsHandler } = await import("../src/remote/settings-endpoint.js");

/** The hermetic HOME every test file runs under (tests/setup/hermetic-home.ts). */
const V2 = path.join(process.env.HOME!, ".zcode", "v2");
const PERSONAL_FILE = path.join(V2, "provider_config.json");

const TABLE = {
  schemaVersion: 1,
  revision: 47,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "account:bigmodel-individual-coding-plan",
          providerName: "BigModel Individual Coding Plan",
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
      modelRules: [{ modelMatch: ".*", config: { properties: { contextWindow: 1000000 } } }],
      modelApiRules: [],
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [],
    },
  },
};

/** provider_config.json as the desktop leaves it on the reporting machine. */
const PERSONAL = {
  schemaVersion: 1,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "new-provider",
          providerName: "Magpie",
          config: {
            access: { type: "api-key", apiKey: "k" },
            api: { type: "openai-responses", baseUrl: "http://127.0.0.1:3425/v1" },
            personalModelIds: ["glm-5.3", "group/hy4-flash", "group/gemini-3.8-flash"],
          },
        },
      ],
    },
    modelConfigRules: {
      providerModelRules: [
        // Written by the desktop for a coding-plan model: no window.
        {
          providerId: "account:bigmodel-individual-coding-plan",
          modelId: "GLM-5.3",
          config: { enabled: true },
        },
        {
          providerId: "new-provider",
          modelId: "glm-5.3",
          config: {
            enabled: true,
            properties: { contextWindow: 1000000 },
            optionSpecs: { reasoningLevel: { values: ["max", "high", "low"] } },
          },
        },
        { providerId: "new-provider", modelId: "group/hy4-flash", config: { enabled: true } },
        // Switched off by the user.
        {
          providerId: "new-provider",
          modelId: "group/gemini-3.8-flash",
          config: { enabled: false },
        },
      ],
      manualProviderModelRules: [],
    },
  },
};

interface Rule {
  providerId: string;
  modelId: string;
  enabled: boolean;
  contextWindow?: number;
  reasoningLevels?: string[];
}

interface Models {
  available: Array<{ providerId: string; providerName?: string; modelId: string }>;
  modelRules: Rule[];
}

/** The clients' join key (TS `matchProviderId` / Rust `match_provider_id`). */
function matchProviderId(providerId: string): string {
  const m = /^account:([a-z0-9]+)-(?:(?:individual|team|start)-)?coding-plan$/.exec(providerId);
  return m ? `builtin:${m[1]}-coding-plan` : providerId;
}

/** The clients' `ruleFor` / `rule_for`: the first row that joins. */
function ruleFor(rules: Rule[], providerId: string, modelId: string): Rule | undefined {
  return rules.find(
    (r) => matchProviderId(r.providerId) === matchProviderId(providerId) && r.modelId === modelId,
  );
}

const cleanups: Array<() => Promise<void>> = [];
let tableDir: string;
let base: string;

beforeEach(async () => {
  tableDir = await mkdtemp(path.join(tmpdir(), "settings-models-"));
  table.path = path.join(tableDir, "zcode-builtin.json");
  await writeFile(table.path, JSON.stringify(TABLE));
  await mkdir(V2, { recursive: true });
  await writeFile(
    path.join(V2, "config.json"),
    JSON.stringify({
      provider: {
        "builtin:bigmodel-coding-plan": {
          name: "BigModel",
          kind: "anthropic",
          enabled: true,
          options: { apiKey: "k" },
          models: { "GLM-5.3": { limit: { context: 1000000 } } },
        },
      },
    }),
  );
  await writeFile(PERSONAL_FILE, JSON.stringify(PERSONAL));

  const handler = createSettingsHandler(null); // the hub's mount: no bridge needed
  const http = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  await rm(tableDir, { recursive: true, force: true });
  await rm(V2, { recursive: true, force: true });
});

interface ApiResponse {
  ok?: boolean;
  error?: string;
  effect?: string;
  models?: Models;
}

async function call(
  method: string,
  pathName: string,
  body?: unknown,
): Promise<{ status: number; json: ApiResponse }> {
  const resp = await fetch(base + pathName, {
    method,
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const json = (await resp.json().catch(() => null)) as ApiResponse | null;
  return { status: resp.status, json: json ?? {} };
}

async function getModels(): Promise<Models> {
  const { status, json } = await call("GET", "/settings/models");
  expect(status).toBe(200);
  return json.models!;
}

describe("GET /settings/models: every selectable model resolves a context window", () => {
  it("joins for a coding-plan model with no personal rule (GLM-5.4)", async () => {
    const { available, modelRules } = await getModels();
    expect(available).toContainEqual({
      providerId: "builtin:bigmodel-coding-plan",
      providerName: "BigModel",
      modelId: "GLM-5.4",
    });
    const row = ruleFor(modelRules, "builtin:bigmodel-coding-plan", "GLM-5.4");
    // The appended row is display-only: the window alone, the provider spelled
    // exactly as `available` spells it.
    expect(row).toEqual({
      providerId: "builtin:bigmodel-coding-plan",
      modelId: "GLM-5.4",
      enabled: true,
      contextWindow: 1000000,
    });
  });

  it("fills a stored coding-plan rule that states no window, in place", async () => {
    const { modelRules } = await getModels();
    // One row joins — the stored one, verbatim apart from the window.
    expect(ruleFor(modelRules, "builtin:bigmodel-coding-plan", "GLM-5.3")).toEqual({
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.3",
      enabled: true,
      contextWindow: 1000000,
    });
  });

  it("never replaces an explicit window and keeps a rule's reasoning levels", async () => {
    const { modelRules } = await getModels();
    expect(ruleFor(modelRules, "new-provider", "glm-5.3")).toEqual({
      providerId: "new-provider",
      modelId: "glm-5.3",
      enabled: true,
      contextWindow: 1000000,
      reasoningLevels: ["max", "high", "low"],
    });
    // A personal model with no window takes the registry's answer.
    expect(ruleFor(modelRules, "new-provider", "group/hy4-flash")).toEqual({
      providerId: "new-provider",
      modelId: "group/hy4-flash",
      enabled: true,
      contextWindow: 1000000,
    });
  });

  it("does not resurrect a model the user switched off", async () => {
    const { available, modelRules } = await getModels();
    expect(available.map((m) => m.modelId)).not.toContain("group/gemini-3.8-flash");
    expect(ruleFor(modelRules, "new-provider", "group/gemini-3.8-flash")?.enabled).toBe(false);
  });

  it("keeps the stored rows first and appends after them", async () => {
    const { available, modelRules } = await getModels();
    const storedIds = PERSONAL.config.modelConfigRules.providerModelRules.map(
      (r) => `${r.providerId}/${r.modelId}`,
    );
    expect(
      modelRules.slice(0, storedIds.length).map((r) => `${r.providerId}/${r.modelId}`),
    ).toEqual(storedIds);
    // Exactly one row joins per selectable model.
    for (const m of available) {
      expect(
        modelRules.filter(
          (r) =>
            matchProviderId(r.providerId) === matchProviderId(m.providerId) &&
            r.modelId === m.modelId,
        ),
      ).toHaveLength(1);
    }
  });

  it("/settings/all carries the same models block", async () => {
    const models = await getModels();
    const { status, json } = await call("GET", "/settings/all");
    expect(status).toBe(200);
    expect(json.models).toEqual(models);
  });
});

describe("write routes with the filled payload (R4)", () => {
  it("switching a rule-less coding-plan model off still works, and keeps it off", async () => {
    // What the edit form sends once the window is prefilled: the toggle plus
    // the value it opened with.
    const res = await call("POST", "/settings/models", {
      providerId: "builtin:bigmodel-coding-plan",
      modelId: "GLM-5.4",
      enabled: false,
      contextWindow: 1000000,
    });
    expect(res.json).toMatchObject({ ok: true, effect: "immediate" });
    const { available } = await getModels();
    expect(available.map((m) => m.modelId)).not.toContain("GLM-5.4");
  });

  it("deleting a model that has no stored rule fails as before and stores nothing", async () => {
    const before = JSON.parse(await readFile(PERSONAL_FILE, "utf8"));
    const res = await call(
      "DELETE",
      `/settings/models/${encodeURIComponent("builtin:bigmodel-coding-plan")}/GLM-5.4`,
    );
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("no rule");
    // The route rewrites the file in its canonical form even on a miss; what
    // matters is that no rule appeared or disappeared.
    expect(JSON.parse(await readFile(PERSONAL_FILE, "utf8"))).toEqual(before);
  });
});
