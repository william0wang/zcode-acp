import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("../src/config/initial-model-catalog.js", () => ({
  probeInitialModelCatalog: state.probe,
}));
vi.mock("../src/lazy-sessions.js", () => ({
  rememberLazySession: () => {},
  lookupLazySession: () => undefined,
}));
vi.mock("../src/tasks-index.js", () => ({ reviveTombstonesOnActivity: async () => 0 }));

import { newSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

it("shares one flight per workspace and starts a fresh probe after it settles", async () => {
  const server = new ZcodeAcpServer();
  const cwd = process.env.HOME!;
  let release!: (value: null) => void;
  state.probe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  state.probe.mockResolvedValue(null);
  const first = newSession(server, { cwd, mcpServers: [] });
  const second = newSession(server, { cwd, mcpServers: [] });
  await vi.waitFor(() => expect(state.probe).toHaveBeenCalledTimes(1));
  release(null);
  await Promise.all([first, second]);
  expect(server.initialCatalogFlights.size).toBe(0);
  await newSession(server, { cwd, mcpServers: [] });
  expect(state.probe).toHaveBeenCalledTimes(2);
});

it("bounds simultaneous probes for different workspaces and falls back without waiting", async () => {
  state.probe.mockReset();
  const server = new ZcodeAcpServer();
  const releases: Array<(value: null) => void> = [];
  state.probe.mockImplementation(
    () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
  );
  const first = newSession(server, { cwd: process.env.HOME!, mcpServers: [] });
  await vi.waitFor(() => expect(state.probe).toHaveBeenCalledTimes(1));
  const second = newSession(server, { cwd: process.cwd(), mcpServers: [] });
  const outcome = await Promise.race([
    second.then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
  ]);
  for (const release of releases) release(null);
  await first;
  await second;
  expect(outcome).toBe("returned");
  expect(state.probe).toHaveBeenCalledTimes(1);
});
