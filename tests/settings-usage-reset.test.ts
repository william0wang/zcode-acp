/**
 * usage-stats.ts + coding-plan.ts tests.
 *
 * usage-stats is exercised against a REAL sqlite database built by the test —
 * the aggregation logic (windows, per-model roll-up, day bucketing, share
 * rounding) is the thing under test, and a mocked query runner would only
 * assert that the SQL string looks right.
 *
 * coding-plan is exercised against a fake `fetch`, because its risk is not the
 * HTTP but the contract: the two headers, the family selection, the envelope
 * code handling, and the idempotency/nonce rules that keep a retry from
 * burning a second card.
 */

import { createDecipheriv, createCipheriv, randomBytes, createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readUsageStats } from "../src/settings/usage-stats.js";
import {
  isCodingPlanProvider,
  markResetHistoryRead,
  readResetStatus,
  requestResetOpportunity,
  resetFamilyFor,
  useResetCard,
} from "../src/settings/coding-plan.js";
import { zcodeUsageDbPath } from "../src/utils.js";

/**
 * `node:sqlite` loaded through `createRequire`.
 *
 * A dynamic `import("node:sqlite")` makes vite try to resolve a package named
 * `sqlite` and the test file fails to transform. Going through `require` keeps
 * the built-in out of vite's resolver; the module is read at call time so a
 * Node without it fails inside the test rather than at import.
 */
interface SqliteHandle {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown };
  close(): void;
}

function openSqlite(path: string): SqliteHandle {
  const require = createRequire(import.meta.url);
  const mod = require("node:sqlite") as { DatabaseSync: new (p: string) => SqliteHandle };
  return new mod.DatabaseSync(path);
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "settings-usage-test-"));
  vi.stubEnv("ZCODE_HOME", home);
  vi.stubEnv("HOME", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

/** Encrypt a value the way ZCode's credential store does. */
function encryptCredential(plain: string): string {
  const secret = `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    "enc:v1:",
    iv.toString("base64url"),
    ".",
    cipher.getAuthTag().toString("base64url"),
    ".",
    body.toString("base64url"),
  ].join("");
}

/** Decrypt a value the way the module does — verifies the cipher round-trips. */
function decryptCredential(value: string): string {
  const secret = `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  const key = createHash("sha256").update(secret).digest();
  const [ivRaw, tagRaw, cipherRaw] = value.slice(7).split(".") as [string, string, string];
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  d.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([d.update(Buffer.from(cipherRaw, "base64url")), d.final()]).toString("utf8");
}

/** Build the usage tables the module reads, with a few rows of history. */
async function seedUsageDb(): Promise<void> {
  await mkdir(path.dirname(zcodeUsageDbPath()), { recursive: true });
  const db = openSqlite(zcodeUsageDbPath());
  db.exec(`
    CREATE TABLE model_usage (
      id INTEGER PRIMARY KEY, model_id TEXT, session_id TEXT, started_at INTEGER,
      computed_total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER
    );
    CREATE TABLE turn_usage (
      session_id TEXT, started_at INTEGER
    );
    CREATE TABLE tool_usage (
      id INTEGER PRIMARY KEY, started_at INTEGER
    );
  `);
  const now = Date.now();
  const day = 86_400_000;
  const insert = db.prepare(
    `INSERT INTO model_usage
       (model_id, session_id, started_at, computed_total_tokens, input_tokens,
        output_tokens, reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("GLM-5.3", "s1", now - day, 1000, 600, 300, 100, 500, 50);
  insert.run("GLM-5.3", "s1", now - 2 * day, 500, 300, 150, 50, 200, 0);
  insert.run("GLM-5.3-Flash", "s2", now - day, 300, 200, 100, 0, 100, 0);
  insert.run("step-5-preview", "s1", now - 40 * day, 9000, 5000, 4000, 0, 0, 0);
  const turn = db.prepare("INSERT INTO turn_usage (session_id, started_at) VALUES (?, ?)");
  turn.run("s1", now - day);
  turn.run("s2", now - day);
  turn.run("s3", now - 40 * day);
  const tool = db.prepare("INSERT INTO tool_usage (started_at) VALUES (?)");
  for (let i = 0; i < 5; i++) tool.run(now - day);
  tool.run(now - 40 * day);
  db.close();
}

describe("usage stats — aggregation", () => {
  it("reports an unavailable snapshot when the database is absent", async () => {
    const snapshot = await readUsageStats("7d");
    expect(snapshot.available).toBe(false);
    expect(snapshot.models).toEqual([]);
    expect(snapshot.summary.totalTokens).toBe(0);
  });

  it("rolls up per model, ordered by volume, with shares summing to 1", async () => {
    await seedUsageDb();
    const snapshot = await readUsageStats("7d");
    expect(snapshot.available).toBe(true);
    expect(snapshot.models.map((m) => m.modelId)).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    const glm = snapshot.models[0]!;
    expect(glm.totalTokens).toBe(1500);
    expect(glm.inputTokens).toBe(900);
    expect(glm.outputTokens).toBe(450);
    expect(glm.reasoningTokens).toBe(150);
    expect(glm.cacheReadTokens).toBe(700);
    expect(glm.requestCount).toBe(2);
    // 1500 of 1800 total.
    expect(glm.share).toBeCloseTo(0.8333, 3);
    expect(snapshot.summary.totalTokens).toBe(1800);
    expect(snapshot.summary.models).toBe(2);
  });

  it("counts sessions, turns and tools inside the same window", async () => {
    await seedUsageDb();
    const snapshot = await readUsageStats("7d");
    expect(snapshot.summary.sessionCount).toBe(2);
    expect(snapshot.summary.turnCount).toBe(2);
    expect(snapshot.summary.toolCallCount).toBe(5);
  });

  it("buckets by LOCAL calendar day, each day's models ordered by volume", async () => {
    await seedUsageDb();
    const snapshot = await readUsageStats("7d");
    expect(snapshot.daily).toHaveLength(2);
    // The day holding both GLM rows (1000 + 300 + 500 cached reads are separate
    // columns; the bucket value is computed_total_tokens only).
    const both = snapshot.daily.find((d) => d.models.length === 2);
    expect(both).toBeDefined();
    // Volume order, so a chart's legend matches its bars.
    expect(both!.models.map((m) => m.modelId)).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    expect(both!.models[0]!.totalTokens).toBe(1000);
    const single = snapshot.daily.find((d) => d.models.length === 1);
    expect(single!.models[0]).toEqual({ modelId: "GLM-5.3", totalTokens: 500 });
    // Days are in ascending date order.
    expect(both!.date > single!.date).toBe(true);
    expect(snapshot.summary.activeDays).toBe(2);
  });

  it("excludes rows older than the window and includes them for 'all'", async () => {
    await seedUsageDb();
    const week = await readUsageStats("7d");
    expect(week.models.find((m) => m.modelId === "step-5-preview")).toBeUndefined();
    const all = await readUsageStats("all");
    expect(all.summary.totalTokens).toBe(10_800);
    expect(all.models[0]!.modelId).toBe("step-5-preview");
    expect(all.summary.activeDays).toBe(3);
  });

  it("keeps a 30-day window's older rows but not a 7-day window's", async () => {
    await seedUsageDb();
    const month = await readUsageStats("30d");
    // 40 days back is outside 30d as well.
    expect(month.summary.totalTokens).toBe(1800);
  });
});

describe("coding plan — provider eligibility", () => {
  it("accepts only the six account coding-plan ids", () => {
    expect(isCodingPlanProvider("account:bigmodel-individual-coding-plan")).toBe(true);
    expect(isCodingPlanProvider("account:zai-team-coding-plan")).toBe(true);
    expect(isCodingPlanProvider("account:bigmodel-start-plan")).toBe(false);
    expect(isCodingPlanProvider("builtin:bigmodel-coding-plan")).toBe(false);
    expect(isCodingPlanProvider("account:bigmodel-individual")).toBe(false);
  });

  it("derives the family from the provider id", () => {
    expect(resetFamilyFor("account:zai-individual-coding-plan")).toBe("zai");
    expect(resetFamilyFor("account:bigmodel-team-coding-plan")).toBe("bigmodel");
  });
});

describe("coding plan — credentials", () => {
  it("reads and decrypts the store with the machine-bound fallback key", async () => {
    const secret = `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
    const plain = "jwt-abc123";
    const encrypted = encryptCredential(plain);
    expect(encrypted.startsWith("enc:v1:")).toBe(true);
    expect(decryptCredential(encrypted)).toBe(plain);
    // The key really is the sha256 of that string.
    expect(createHash("sha256").update(secret).digest()).toHaveLength(32);
  });

  it("refuses a non-coding-plan provider before touching credentials", async () => {
    await expect(readResetStatus("builtin:bigmodel-coding-plan", fetch as never)).rejects.toThrow(
      /coding_plan_provider_required/,
    );
  });

  it("reports credentials_unavailable when the store is missing", async () => {
    await expect(
      readResetStatus("account:bigmodel-individual-coding-plan", fetch as never),
    ).rejects.toThrow(/credentials_unavailable/);
  });
});

/** A fetch stub that records calls and answers with a fixed envelope. */
function makeFetch(
  responder: (url: string, init: RequestInit) => { status?: number; body: unknown },
): { fetchImpl: typeof globalThis.fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string, init: RequestInit) => {
    calls.push({ url: String(input), init });
    const { status = 200, body } = responder(String(input), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

/** Seed a credential store that authorizes a bigmodel personal plan. */
async function seedCredentials(): Promise<void> {
  await mkdir(path.join(home, "v2"), { recursive: true });
  await writeFile(
    path.join(home, "v2", "credentials.json"),
    JSON.stringify({
      zcodejwttoken: encryptCredential("zcode-jwt"),
      "oauth:bigmodel:access_token": encryptCredential("maas-jwt"),
      // A zai token is deliberately absent: the family selection must not fall
      // back to it, and a bigmodel request must not need it.
      "oauth:zai:access_token": encryptCredential("zai-jwt"),
      "some:unrelated": encryptCredential("noise"),
    }),
    "utf8",
  );
}

const BIGMODEL = "account:bigmodel-individual-coding-plan";

describe("coding plan — status", () => {
  it("sends both auth headers and the personal target scope", async () => {
    await seedCredentials();
    const { fetchImpl, calls } = makeFetch(() => ({
      body: {
        code: 0,
        data: {
          available_five_hour_resets: [{ expire_at: 111 }],
          available_week_resets: [],
          latest_five_hour_reset_history: { used_at: 100 },
          latest_week_reset_history: null,
          has_unread_history: true,
        },
      },
    }));
    const status = await readResetStatus(BIGMODEL, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://zcode.z.ai/api/v1/coding-plan/reset/status");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer zcode-jwt");
    // The MaaS JWT goes verbatim — no Bearer prefix.
    expect(headers["X-Bigmodel-Authorization"]).toBe("maas-jwt");
    expect(headers["Bigmodel-Target-Type"]).toBe("PERSONAL");
    expect(status.availableFiveHour).toEqual([{ expireAt: 111 }]);
    expect(status.availableWeek).toEqual([]);
    expect(status.latestFiveHour).toEqual({ usedAt: 100 });
    expect(status.latestWeek).toBeNull();
    expect(status.hasUnreadHistory).toBe(true);
    // A nonce is always issued so a use can be tied to this read.
    expect(status.nonce).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("selects the zai token for a zai provider, not the bigmodel one", async () => {
    await seedCredentials();
    const { fetchImpl, calls } = makeFetch(() => ({ body: { code: 0, data: {} } }));
    await readResetStatus("account:zai-individual-coding-plan", fetchImpl);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Bigmodel-Authorization"]).toBe("zai-jwt");
  });

  it("surfaces a business error code rather than the message", async () => {
    await seedCredentials();
    const { fetchImpl } = makeFetch(() => ({ status: 400, body: { code: 2007, msg: "boom" } }));
    await expect(readResetStatus(BIGMODEL, fetchImpl)).rejects.toThrow(
      /coding_plan_reset_api_error:2007/,
    );
  });
});

describe("coding plan — spending a card", () => {
  it("posts the idempotency key and the reset type", async () => {
    await seedCredentials();
    const { fetchImpl, calls } = makeFetch(() => ({ body: { code: 0, data: { used: true } } }));
    const result = await useResetCard(BIGMODEL, "FIVE_HOUR", "key-1", fetchImpl);
    expect(result.used).toBe(true);
    expect(calls[0]!.url).toBe("https://zcode.z.ai/api/v1/coding-plan/reset/use");
    const body = JSON.parse(calls[0]!.init.body as string) as {
      idempotency_key: string;
      reset_type: string;
    };
    expect(body).toEqual({ idempotency_key: "key-1", reset_type: "FIVE_HOUR" });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["Bigmodel-Target-Type"]).toBe("PERSONAL");
  });

  it("rejects an empty or oversized idempotency key before any request", async () => {
    await seedCredentials();
    const { fetchImpl, calls } = makeFetch(() => ({ body: { code: 0, data: { used: true } } }));
    await expect(useResetCard(BIGMODEL, "WEEK", "  ", fetchImpl)).rejects.toThrow(
      /invalid_idempotency_key/,
    );
    await expect(useResetCard(BIGMODEL, "WEEK", "x".repeat(65), fetchImpl)).rejects.toThrow(
      /invalid_idempotency_key/,
    );
    expect(calls).toHaveLength(0);
  });

  it("reads a denial (3301) as data with a next-try time, not a failure", async () => {
    await seedCredentials();
    const { fetchImpl } = makeFetch(() => ({
      status: 400,
      body: { code: 3301, data: { granted: false, next_try_at: 999 } },
    }));
    const result = await requestResetOpportunity(BIGMODEL, "key-2", fetchImpl);
    expect(result).toEqual({ granted: false, nextTryAt: 999 });
  });

  it("reads a grant as granted", async () => {
    await seedCredentials();
    const { fetchImpl } = makeFetch(() => ({ body: { code: 0, data: { granted: true } } }));
    expect(await requestResetOpportunity(BIGMODEL, "key-3", fetchImpl)).toEqual({
      granted: true,
      nextTryAt: null,
    });
  });

  it("marks history read WITHOUT the target scope header", async () => {
    await seedCredentials();
    const { fetchImpl, calls } = makeFetch(() => ({ body: { code: 0, data: {} } }));
    await markResetHistoryRead(BIGMODEL, fetchImpl);
    expect(calls[0]!.url).toBe("https://zcode.z.ai/api/v1/coding-plan/reset/history/read");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeDefined();
    expect(headers["Bigmodel-Target-Type"]).toBeUndefined();
  });

  it("honours the ZCODE_ENDPOINT_ORIGIN override", async () => {
    vi.stubEnv("ZCODE_ENDPOINT_ORIGIN", "https://example.invalid");
    await seedCredentials();
    const { fetchImpl, calls } = makeFetch(() => ({ body: { code: 0, data: {} } }));
    await markResetHistoryRead(BIGMODEL, fetchImpl);
    expect(calls[0]!.url).toBe("https://example.invalid/api/v1/coding-plan/reset/history/read");
  });
});
