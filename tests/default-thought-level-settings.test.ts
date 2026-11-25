/**
 * GET/PUT /settings/default-thought-level — the read/write halves of the
 * user's default thought level (`session.defaultThoughtLevel`).
 *
 * Same harness idea as settings-parity.test.ts: the REAL handler factory on a
 * loopback server. The user config is pointed at a scratch XDG root so the
 * writes touch only test files.
 */

import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSettingsHandler } from "../src/remote/settings-endpoint.js";
import { ZcodeAcpServer } from "../src/server.js";

let xdg: string;
let base: string;
let http: ReturnType<typeof createServer>;

beforeEach(async () => {
  xdg = await mkdtemp(path.join(tmpdir(), "zacp-dtl-settings-"));
  vi.stubEnv("XDG_CONFIG_HOME", xdg);
  const handler = createSettingsHandler(new ZcodeAcpServer());
  http = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  vi.unstubAllEnvs();
  await rm(xdg, { recursive: true, force: true });
});

async function call(
  method: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const resp = await fetch(base + "/settings/default-thought-level", {
    method,
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return {
    status: resp.status,
    json: (await resp.json().catch(() => null)) as Record<string, unknown>,
  };
}

async function readUserConfig(): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(xdg, "zcode-acp", "config.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Seed the file with sections other writers own; they must survive a write. */
async function seedUserConfig(): Promise<void> {
  await mkdir(path.join(xdg, "zcode-acp"), { recursive: true });
  await writeFile(
    path.join(xdg, "zcode-acp", "config.json"),
    JSON.stringify({ session: { mode: "plan" }, lang: "zh" }),
  );
}

// The default model declares no vocabulary locally in the hermetic HOME, so
// the pending menu offers the static fallback.
const STATIC_LEVELS = [
  { value: "low", name: "low" },
  { value: "high", name: "high" },
  { value: "max", name: "max" },
];

describe("settings default-thought-level", () => {
  it("reads unset as the model's own default", async () => {
    const { status, json } = await call("GET");

    expect(status).toBe(200);
    expect(json).toEqual({
      ok: true,
      configured: null,
      effective: "max",
      source: "model",
      options: STATIC_LEVELS,
    });
  });

  it("stores the choice and reports it as effective", async () => {
    await seedUserConfig();

    const { status, json } = await call("PUT", { defaultThoughtLevel: " high " });

    expect(status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      configured: "high",
      effective: "high",
      source: "config",
    });
    // The other writers' sections survive byte-for-byte.
    expect(await readUserConfig()).toEqual({
      session: { mode: "plan", defaultThoughtLevel: "high" },
      lang: "zh",
    });
  });

  it("reports a level the default model does not offer instead of forcing it", async () => {
    const { json } = await call("PUT", { defaultThoughtLevel: "medium" });

    expect(json).toMatchObject({ configured: "medium", effective: "max", source: "model" });
  });

  it("matches the vocabulary case-insensitively", async () => {
    const { json } = await call("PUT", { defaultThoughtLevel: "High" });

    // Stored as written; reported with the vocabulary's spelling.
    expect(json).toMatchObject({ configured: "High", effective: "high", source: "config" });
  });

  it("clears with null and drops an emptied session section", async () => {
    await call("PUT", { defaultThoughtLevel: "high" });

    const { json } = await call("PUT", { defaultThoughtLevel: null });

    expect(json).toMatchObject({ ok: true, configured: null, effective: "max", source: "model" });
    expect(await readUserConfig()).toEqual({});
  });

  it("rejects a malformed value before writing", async () => {
    for (const body of [{ defaultThoughtLevel: 42 }, { defaultThoughtLevel: "   " }, {}]) {
      expect((await call("PUT", body)).status).toBe(400);
    }
    await expect(readUserConfig()).rejects.toThrow();
  });
});
