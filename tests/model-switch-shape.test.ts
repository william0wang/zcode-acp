/**
 * session/setModel wire-shape contract against the open-sourced 0.16.9 schema.
 *
 * `zcodeSessionSetModelParamsSchema` is STRICT and `model` must be the
 * modelSelectionSchema OBJECT (zcode-protocol/index.ts:1952-1959;
 * model-selection.ts:4-15): no `runtimeModel` key, no string form. The bridge
 * used to retry a failed switch once with the legacy `{model, runtimeModel}`
 * overlay — dead code on this build (a guaranteed second rejection, observed
 * in logs as a confusing double error), removed 2026-09-21. A switch is now
 * exactly ONE request carrying the modern shape.
 */

import { describe, expect, it } from "vitest";

import { applyModelSwitch } from "../src/config/runtime-model.js";
import { ZcodeAcpServer } from "../src/server.js";

const SID_Z = "zc-switch-1";
/** Encoded `providerId\modelId` value (parseModelValue's new-format spelling). */
const VALUE = "builtin:bigmodel-coding-plan\\GLM-5";

function boot(responder: (method: string) => unknown) {
  const server = new ZcodeAcpServer();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  server.backend = {
    isDead: false,
    request: async (_id: number, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return responder(method);
    },
  } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
  return { server, calls };
}

describe("applyModelSwitch wire shape (0.16.9)", () => {
  it("sends exactly one strict-shape request, no runtimeModel retry", async () => {
    const { server, calls } = boot(() => ({ result: {} }));
    const ok = await applyModelSwitch(server, SID_Z, VALUE);
    expect(ok).toBe(true);
    const setModels = calls.filter((c) => c.method === "session/setModel");
    expect(setModels).toHaveLength(1);
    expect(setModels[0]!.params).not.toHaveProperty("runtimeModel");
    expect(setModels[0]!.params).toEqual({
      sessionId: SID_Z,
      model: { providerId: expect.any(String), modelId: "GLM-5" },
      persistAsWorkspaceLastUsed: false,
    });
  });

  it("does NOT retry with the legacy overlay when the modern shape is rejected", async () => {
    const { server, calls } = boot(() => ({
      error: { message: "Unrecognized key: runtimeModel" },
    }));
    const ok = await applyModelSwitch(server, SID_Z, VALUE);
    expect(ok).toBe(false);
    expect(calls.filter((c) => c.method === "session/setModel")).toHaveLength(1);
  });

  it("carries the target's default reasoning level when the availability cache knows it", async () => {
    // Learn the registry spelling first: the bridge translates config.json's
    // `builtin:*` id through the builtin provider table when one is present
    // (accountProviderIdFor), and the cache is keyed by the translated id.
    const probe = boot(() => ({ result: {} }));
    await applyModelSwitch(probe.server, SID_Z, VALUE);
    const registryId = (probe.calls[0]!.params["model"] as { providerId: string }).providerId;
    const { server, calls } = boot(() => ({ result: {} }));
    server.modelAvailability.set(SID_Z, [
      { providerId: registryId, modelId: "GLM-5", defaultLevel: "high" },
    ]);
    const ok = await applyModelSwitch(server, SID_Z, VALUE);
    expect(ok).toBe(true);
    const model = calls[0]!.params["model"] as { options?: { reasoningLevel?: string } };
    expect(model.options?.reasoningLevel).toBe("high");
  });
});
