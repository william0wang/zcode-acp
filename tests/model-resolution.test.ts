/**
 * Unified inbound model-value resolution (#403).
 *
 * The backend registry validates (providerId, modelId) by exact string match
 * with no alias layer, so every dialect the bridge accepts — `provider\model`,
 * `/`-separated refs, `custom:` URL-encoded spellings, legacy bare ids, and
 * config (`builtin:`) vs registry (`account:`) provider dialects — must
 * normalize against a registry snapshot before session/setModel. The
 * regression these tests pin: a stale advertisement (`builtin:…\GLM-5.3` from
 * a frozen config.json) reaching setModel raw failed with "Provider Registry
 * 中不存在 Model" and aborted client session opens (T3 Code, issue #403).
 */

import { describe, expect, it } from "vitest";

import { parseModelRefValue, resolveModelTarget } from "../src/config/model-resolution.js";
import { applyModelSwitch } from "../src/config/runtime-model.js";
import { ZcodeAcpServer } from "../src/server.js";

const SNAP = [
  { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3" },
  { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3-Flash" },
  { providerId: "custom:other", modelId: "GLM-5.3" },
];

describe("parseModelRefValue", () => {
  it("splits the backslash encoding", () => {
    expect(parseModelRefValue("account:zai-individual-coding-plan\\GLM-5.3")).toEqual({
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3",
      encoded: true,
    });
  });

  it("decodes the custom: agent-definition spelling", () => {
    expect(parseModelRefValue("custom:account%3Ap1:GLM-5.3")).toEqual({
      providerId: "account:p1",
      modelId: "GLM-5.3",
      encoded: true,
    });
  });

  it("accepts the /-separated ref only when the prefix names a provider", () => {
    expect(parseModelRefValue("account:p1/GLM-5.3")).toEqual({
      providerId: "account:p1",
      modelId: "GLM-5.3",
      encoded: true,
    });
    // A bare model id never contains ":" — stays whole.
    expect(parseModelRefValue("GLM-4-Flash-250414")).toEqual({
      modelId: "GLM-4-Flash-250414",
      encoded: false,
    });
  });
});

describe("resolveModelTarget against a snapshot", () => {
  it("resolves exact and dialect-folded refs", () => {
    expect(resolveModelTarget("account:zai-individual-coding-plan\\GLM-5.3", SNAP)).toMatchObject({
      ok: true,
      target: { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3" },
    });
    // `custom:other` is not builtin: — accountProviderIdFor passes it through.
    expect(resolveModelTarget("custom:other\\GLM-5.3", SNAP)).toMatchObject({
      ok: true,
      target: { providerId: "custom:other", modelId: "GLM-5.3", via: "exact" },
    });
  });

  it("case-folds the model id against the snapshot vocabulary", () => {
    expect(
      resolveModelTarget("account:zai-individual-coding-plan\\glm-5.3-flash", SNAP),
    ).toMatchObject({
      ok: true,
      target: {
        providerId: "account:zai-individual-coding-plan",
        modelId: "GLM-5.3-Flash",
        via: "case-fold",
      },
    });
  });

  it("resolves the /-separated ref dialect", () => {
    expect(resolveModelTarget("account:zai-individual-coding-plan/GLM-5.3", SNAP)).toMatchObject({
      ok: true,
      target: { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3" },
    });
  });

  it("never substitutes across providers — a miss is a miss", () => {
    // GLM-5.3 exists under custom:other, but the ref names another provider.
    expect(resolveModelTarget("account:absent-plan\\GLM-5.3", SNAP).ok).toBe(false);
  });

  it("bare ids resolve only when unique across the snapshot", () => {
    expect(resolveModelTarget("GLM-5.3-Flash", SNAP)).toMatchObject({
      ok: true,
      target: {
        providerId: "account:zai-individual-coding-plan",
        modelId: "GLM-5.3-Flash",
        via: "unique",
      },
    });
    // GLM-5.3 sits under two providers — ambiguous, not guessed.
    expect(resolveModelTarget("GLM-5.3", SNAP).ok).toBe(false);
    expect(resolveModelTarget("GLM-4.6", SNAP).ok).toBe(false);
  });

  it("without a snapshot: provider-qualified refs pass through dialect-folded, bare ids fail", () => {
    expect(
      resolveModelTarget("account:zai-individual-coding-plan\\GLM-9", undefined),
    ).toMatchObject({
      ok: true,
      target: { modelId: "GLM-9", via: "unverified" },
    });
    expect(resolveModelTarget("GLM-5.3", undefined).ok).toBe(false);
    expect(resolveModelTarget("GLM-5.3", []).ok).toBe(false);
  });
});

describe("applyModelSwitch resolves before sending (#403)", () => {
  const SID_Z = "zc-resolution-1";

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
  const modelOf = (params: Record<string, unknown>): { providerId?: string; modelId?: string } =>
    params["model"] as { providerId?: string; modelId?: string };

  it("sends the SNAPSHOT's canonical spelling for a case-folded ref", async () => {
    const { server, calls } = boot(() => ({ result: {} }));
    server.modelAvailability.set(SID_Z, [
      { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3-Flash" },
    ]);
    const ok = await applyModelSwitch(
      server,
      SID_Z,
      "account:zai-individual-coding-plan\\glm-5.3-flash",
    );
    expect(ok).toBe(true);
    expect(modelOf(calls[0]!.params)).toEqual({
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3-Flash",
    });
  });

  it("still sends an unresolved provider-qualified ref — the backend is the final authority", async () => {
    // The snapshot may lag a just-added model; resolution must not block a
    // switch the backend would accept. The stale `GLM-5.3` id from #403 takes
    // this path and the backend's verdict decides.
    const { server, calls } = boot(() => ({ result: {} }));
    server.modelAvailability.set(SID_Z, [
      { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3-Flash" },
    ]);
    const ok = await applyModelSwitch(server, SID_Z, "account:zai-individual-coding-plan\\GLM-5.3");
    expect(ok).toBe(true);
    const setModels = calls.filter((c) => c.method === "session/setModel");
    expect(setModels).toHaveLength(1);
    expect(modelOf(setModels[0]!.params)).toMatchObject({ modelId: "GLM-5.3" });
  });

  it("a bare id absent from a live snapshot is final — no request is sent", async () => {
    const { server, calls } = boot(() => ({ result: {} }));
    server.modelAvailability.set(SID_Z, [
      { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3-Flash" },
    ]);
    const ok = await applyModelSwitch(server, SID_Z, "GLM-4.6");
    expect(ok).toBe(false);
    expect(calls.filter((c) => c.method === "session/setModel")).toHaveLength(0);
  });
});
