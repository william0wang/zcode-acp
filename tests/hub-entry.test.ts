import { beforeEach, describe, expect, it, vi } from "vitest";

const startHubMock = vi.hoisted(() => vi.fn());
const parseHubConfigMock = vi.hoisted(() => vi.fn());
const sandboxBornMock = vi.hoisted(() => vi.fn());
const selfRelaunchMock = vi.hoisted(() => vi.fn());

vi.mock("../src/remote/hub-server.js", () => ({ startHub: startHubMock }));
vi.mock("../src/remote/config.js", () => ({
  parseHubConfig: parseHubConfigMock,
}));
vi.mock("../src/remote/hub-sandbox.js", () => ({
  sandboxBorn: sandboxBornMock,
  selfRelaunchOutsideSandbox: selfRelaunchMock,
}));

import { main } from "../src/bin/hub.js";

/**
 * Wiring contract for the hub entry (the ordering IS the fix): the sandbox
 * self-relaunch must happen BEFORE startHub binds the port — otherwise the
 * sandboxed hub owns the port, the clean launchd instance EADDRINUSE-exits,
 * and the broken hub keeps serving.
 */
describe("hub entry wiring (sandbox self-relaunch)", () => {
  beforeEach(() => {
    startHubMock.mockReset().mockResolvedValue({ port: 18377, close: async () => {} });
    parseHubConfigMock
      .mockReset()
      .mockReturnValue({ hubPort: 18377, hubHost: "127.0.0.1", token: "t" });
    sandboxBornMock.mockReset().mockReturnValue(false);
    selfRelaunchMock.mockReset().mockReturnValue(false);
  });

  it("when born sandboxed and the relaunch succeeds: exits without binding", async () => {
    sandboxBornMock.mockReturnValue(true);
    selfRelaunchMock.mockReturnValue(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit:0");
    }) as never);
    try {
      await expect(main()).rejects.toThrow("exit:0");
      expect(startHubMock).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("when not born sandboxed: binds normally and never attempts a relaunch", async () => {
    await main();
    expect(sandboxBornMock).toHaveBeenCalled();
    expect(selfRelaunchMock).not.toHaveBeenCalled();
    expect(startHubMock).toHaveBeenCalledTimes(1);
  });

  it("when born sandboxed but the relaunch fails: continues degraded and binds", async () => {
    sandboxBornMock.mockReturnValue(true);
    selfRelaunchMock.mockReturnValue(false);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    try {
      await main();
      expect(startHubMock).toHaveBeenCalledTimes(1);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
