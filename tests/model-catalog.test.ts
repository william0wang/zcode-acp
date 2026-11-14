import { describe, expect, it } from "vitest";
import { ZcodeAcpServer } from "../src/server.js";
import { cacheModelAvailability } from "../src/handlers/session.js";
import { applyModelSwitch } from "../src/config/runtime-model.js";
import { buildConfigOptions } from "../src/config/options.js";

describe("materialized registry model catalog", () => {
  it("offers only full snapshot models while retaining the active model", async () => {
    const server = new ZcodeAcpServer();
    server.modelAvailability.set("s", [
      { providerId: "custom:fixture", modelId: "real-one", levels: [] },
      { providerId: "custom:fixture", modelId: "real-two", levels: [] },
    ]);
    server.backend = {
      isDead: false,
      request: async () => ({
        result: {
          settings: {
            model: {
              current: { providerId: "custom:fixture", modelId: "real-one" },
              available: [{ ref: { providerId: "custom:fixture", modelId: "real-one" } }],
            },
          },
        },
      }),
    } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
    const options = await buildConfigOptions(server, "s");
    const model = options.find((o) => o.id === "model")!;
    expect(model.currentValue).toBe("custom:fixture\\real-one");
    expect(model.options.map((o) => o.value)).toEqual([
      "custom:fixture\\real-one",
      "custom:fixture\\real-two",
    ]);
  });
  it("rejects ambiguous selections locally and delegates unknown pairs to the backend", async () => {
    const server = new ZcodeAcpServer();
    server.modelAvailability.set("s", [
      { providerId: "custom:a", modelId: "same", levels: [] },
      { providerId: "custom:b", modelId: "same", levels: [] },
    ]);
    let calls = 0;
    server.backend = {
      isDead: false,
      request: async (_id: unknown, _method: unknown, params: any) => {
        calls++;
        return params.model.modelId === "missing"
          ? { error: { message: "model not found" } }
          : { result: {} };
      },
    } as never;
    expect(await applyModelSwitch(server, "s", "same")).toBe(false);
    expect(await applyModelSwitch(server, "s", "custom:a\\missing")).toBe(false);
    expect(calls).toBe(1);
    expect(await applyModelSwitch(server, "s", "custom:b\\same")).toBe(true);
    expect(calls).toBe(2);
  });

  it("resolves a unique legacy bare model from the authoritative snapshot", async () => {
    const server = new ZcodeAcpServer();
    server.modelAvailability.set("s", [
      { providerId: "custom:one", modelId: "legacy", levels: [] },
    ]);
    const calls: any[] = [];
    server.backend = {
      isDead: false,
      request: async (_id: unknown, _method: unknown, params: any) => {
        calls.push(params);
        return { result: {} };
      },
    } as never;
    expect(await applyModelSwitch(server, "s", "legacy")).toBe(true);
    expect(calls[0].model).toEqual({ providerId: "custom:one", modelId: "legacy" });
  });

  it("invalidates stale snapshots on generation change and malformed refresh", () => {
    const server = new ZcodeAcpServer();
    server.modelAvailability.set("s", [{ providerId: "a", modelId: "x", levels: [] }]);
    cacheModelAvailability(server, "s", {
      settings: { model: { available: [{ ref: { modelId: "x" } }] } },
    });
    expect(server.modelAvailability.has("s")).toBe(false);
    server.modelAvailability.set("s", [{ providerId: "a", modelId: "x", levels: [] }]);
    server.resetBackendGeneration();
    expect(server.modelAvailability.has("s")).toBe(false);
  });

  it("drops the recorded identity together with an invalidated snapshot", () => {
    const server = new ZcodeAcpServer();
    server.modelAvailability.set("s", [{ providerId: "a", modelId: "x", levels: [] }]);
    server.currentModelIdentity.set("s", { providerId: "a", modelId: "x" });
    // A surviving registry-spelling identity over a deleted snapshot would
    // append a duplicate same-named current into the local-config dropdown.
    cacheModelAvailability(server, "s", { settings: { model: { available: [] } } });
    expect(server.modelAvailability.has("s")).toBe(false);
    expect(server.currentModelIdentity.has("s")).toBe(false);
  });
});
