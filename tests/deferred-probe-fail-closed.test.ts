import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { probeInitialModelCatalog } from "../src/config/initial-model-catalog.js";
import { newSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";
import { ZCODE_CREDS_PATH } from "../src/utils.js";

it("never starts an unverified backend that would silently persist a deferred create", async () => {
  vi.stubEnv("ZCODE_BIN", "/nonexistent/unverified-zcode");
  const persist = vi.fn();
  const legacyBackend = {
    request: vi.fn(async () => {
      persist();
      return { result: { session: { sessionId: "persisted" } } };
    }),
  };
  const factory = vi.fn(
    async () => ({ ensureBackend: async () => legacyBackend }) as unknown as ZcodeAcpServer,
  );
  expect(await probeInitialModelCatalog(process.env.HOME!, factory)).toBeNull();
  expect(factory).not.toHaveBeenCalled();
  expect(legacyBackend.request).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});

it("retains local model fallback without spawning an unverified backend after the flight settles", async () => {
  vi.stubEnv("ZCODE_BIN", "/nonexistent/unverified-zcode");
  expect(ZCODE_CREDS_PATH.startsWith(`${process.env.HOME}/`)).toBe(true);
  mkdirSync(path.dirname(ZCODE_CREDS_PATH), { recursive: true });
  writeFileSync(
    ZCODE_CREDS_PATH,
    JSON.stringify({
      provider: {
        "local-fixture": {
          enabled: true,
          options: { apiKeyRequired: false },
          models: { "local-model": {} },
        },
      },
    }),
  );
  const server = new ZcodeAcpServer();
  const spawn = vi.spyOn(ZcodeAcpServer.prototype, "ensureBackend");
  try {
    const cwd = process.env.HOME!;
    const response = await newSession(server, { cwd, mcpServers: [] });
    const flight = server.initialCatalogFlights.get(cwd);
    expect(flight).toBeDefined();
    expect(await flight).toBeNull();
    await vi.waitFor(() => expect(server.initialCatalogFlights.has(cwd)).toBe(false));
    expect(response.sessionId).toBeTruthy();
    expect(response.configOptions?.find((option) => option.id === "model")).toMatchObject({
      id: "model",
      type: "select",
      currentValue: "local-fixture\\local-model",
    });
    expect(server.backend).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(server.initialCatalogCache.size).toBe(0);
  } finally {
    server.dispose();
    spawn.mockRestore();
    vi.unstubAllEnvs();
  }
});
