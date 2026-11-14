import { expect, it, vi } from "vitest";
import { probeInitialModelCatalog } from "../src/config/initial-model-catalog.js";
import { newSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

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

it("returns a lazy ACP session without spawning an unverified backend", async () => {
  vi.stubEnv("ZCODE_BIN", "/nonexistent/unverified-zcode");
  const server = new ZcodeAcpServer();
  const spawn = vi.spyOn(server, "ensureBackend");
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const response = await newSession(server, { cwd: process.env.HOME!, mcpServers: [] });
  expect(response.sessionId).toBeTruthy();
  expect(server.backend).toBeNull();
  expect(spawn).not.toHaveBeenCalled();
  expect(response.configOptions?.some((option) => option.id === "model")).toBe(false);
  expect(
    stderr.mock.calls.some(([line]) => String(line).includes("backend version unverified")),
  ).toBe(true);
  stderr.mockRestore();
  vi.unstubAllEnvs();
});
