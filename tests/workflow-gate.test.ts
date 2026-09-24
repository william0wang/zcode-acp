/**
 * Dynamic-workflow gate resolution tests (desktop-host parity).
 *
 * resolveWorkflowGate reads the anonymous /api/v1/client/configs endpoint and
 * folds data.configs.dynamicWorkflow.mode into {mode, enabled, source}. Every
 * failure shape — missing key, non-string, unknown value, HTTP error, fetch
 * rejection, timeout — must collapse to the fail-closed disabled verdict and
 * never throw. All fetches are injected fakes; no network.
 */

import { describe, expect, it, vi } from "vitest";

import {
  captureGate,
  rememberGate,
  resolveWorkflowGate,
  workflowGateNow,
  type WorkflowGate,
  type WorkflowGateHolder,
} from "../src/config/workflow-gate.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function gateBody(mode: unknown): unknown {
  return { data: { configs: { dynamicWorkflow: { mode } } } };
}

function fakeFetch(impl: () => Promise<Response>): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

/** Env keys that steer the gate origin — cleared per test, restored after. */
const ENV_KEYS = ["ZCODE_ENDPOINT_ORIGIN", "ZCODE_BASE_URL"] as const;

function clearOriginEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function restoreOriginEnv(saved: ReadonlyArray<readonly [string, string | undefined]>): void {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const DISABLED_VERDICT = { mode: "unknown", enabled: false, source: "default" };

describe("resolveWorkflowGate mode mapping", () => {
  it.each(["onDemand", "alwaysOn"] as const)("%s maps to enabled/remote", async (mode) => {
    await expect(
      resolveWorkflowGate(fakeFetch(async () => jsonResponse(gateBody(mode)))),
    ).resolves.toEqual({ mode, enabled: true, source: "remote" });
  });

  it("disabled maps to enabled:false with source remote (server-said-off, not failed)", async () => {
    await expect(
      resolveWorkflowGate(fakeFetch(async () => jsonResponse(gateBody("disabled")))),
    ).resolves.toEqual({ mode: "disabled", enabled: false, source: "remote" });
  });

  it("targets the zcode.z.ai client-config endpoint with version and platform", async () => {
    const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    clearOriginEnv();
    const fetchImpl = vi.fn(async () => jsonResponse(gateBody("disabled")));
    try {
      await resolveWorkflowGate(fetchImpl as unknown as typeof fetch);
    } finally {
      restoreOriginEnv(saved);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith("https://zcode.z.ai/api/v1/client/configs?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("app_version")).toMatch(/^\d+\.\d+\.\d+/);
    // Upstream format: `<platform>-<arch>` ("darwin-arm64"), never the bare name.
    expect(params.get("platform")).toMatch(/^[a-z0-9]+-[a-z0-9]+$/u);
    expect(init.method).toBe("GET");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("honors ZCODE_ENDPOINT_ORIGIN over the default origin", async () => {
    const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    clearOriginEnv();
    process.env.ZCODE_ENDPOINT_ORIGIN = "https://override.example.test";
    const fetchImpl = vi.fn(async () => jsonResponse(gateBody("disabled")));
    try {
      await resolveWorkflowGate(fetchImpl as unknown as typeof fetch);
    } finally {
      restoreOriginEnv(saved);
    }
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith("https://override.example.test/api/v1/client/configs?")).toBe(true);
  });
});

describe("resolveWorkflowGate fail-closed", () => {
  it("missing dynamicWorkflow key collapses to disabled", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ data: { configs: {} } }));
    await expect(resolveWorkflowGate(fetchImpl)).resolves.toEqual(DISABLED_VERDICT);
  });

  it("null dynamicWorkflow collapses to disabled", async () => {
    const fetchImpl = fakeFetch(async () =>
      jsonResponse({ data: { configs: { dynamicWorkflow: null } } }),
    );
    await expect(resolveWorkflowGate(fetchImpl)).resolves.toEqual(DISABLED_VERDICT);
  });

  it("missing mode inside dynamicWorkflow collapses to disabled", async () => {
    const fetchImpl = fakeFetch(async () =>
      jsonResponse({ data: { configs: { dynamicWorkflow: {} } } }),
    );
    await expect(resolveWorkflowGate(fetchImpl)).resolves.toEqual(DISABLED_VERDICT);
  });

  it("non-string mode collapses to disabled", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(gateBody(1)));
    await expect(resolveWorkflowGate(fetchImpl)).resolves.toEqual(DISABLED_VERDICT);
  });

  it("unknown mode value collapses to disabled", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(gateBody("always-on")));
    await expect(resolveWorkflowGate(fetchImpl)).resolves.toEqual(DISABLED_VERDICT);
  });

  it("HTTP error status collapses to disabled", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ error: "boom" }, 503));
    await expect(resolveWorkflowGate(fetchImpl)).resolves.toEqual(DISABLED_VERDICT);
  });

  it("fetch rejection collapses to disabled", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error("network down");
    });
    await expect(resolveWorkflowGate(fetchImpl)).resolves.toEqual(DISABLED_VERDICT);
  });

  it("AbortSignal.timeout rejection (TimeoutError) collapses to disabled", async () => {
    // The 6s bound fires as a fetch rejection in production; simulate the
    // exact rejection shape so the timeout path is covered without waiting.
    const fetchImpl = fakeFetch(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    await expect(resolveWorkflowGate(fetchImpl)).resolves.toEqual(DISABLED_VERDICT);
  });

  it("invalid JSON body collapses to disabled", async () => {
    const fetchImpl = fakeFetch(
      async () =>
        new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(resolveWorkflowGate(fetchImpl)).resolves.toEqual(DISABLED_VERDICT);
  });
});

describe("workflowGateNow creation-time cache (captureGate)", () => {
  // Regression: the collector used to attach on the FIRST workflowGateNow
  // call, so a settled promise still read null once — enough to filter the
  // workflow commands out of the first `/` menu of every backend generation.
  // captureGate (ensureBackend's assignment) must make the settled verdict
  // readable on the very first sync call, with no priming.

  function holderWith(promise: Promise<WorkflowGate>): WorkflowGateHolder {
    return { backendWorkflowGate: promise };
  }

  it("returns a SETTLED enabled gate on its FIRST call (no priming)", async () => {
    const promise = captureGate(
      resolveWorkflowGate(fakeFetch(async () => jsonResponse(gateBody("alwaysOn")))),
    );
    const gate = await promise; // settled — first read must already see it
    expect(gate).toEqual({ mode: "alwaysOn", enabled: true, source: "remote" });
    expect(workflowGateNow(holderWith(promise))).toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "remote",
    });
  });

  it("returns a SETTLED disabled gate on its FIRST call (no priming)", async () => {
    const promise = captureGate(
      resolveWorkflowGate(fakeFetch(async () => jsonResponse(gateBody("disabled")))),
    );
    await promise;
    expect(workflowGateNow(holderWith(promise))).toEqual({
      mode: "disabled",
      enabled: false,
      source: "remote",
    });
  });

  it("captureGate returns the SAME promise (assignment shape unchanged)", async () => {
    const original = resolveWorkflowGate(fakeFetch(async () => jsonResponse(gateBody("onDemand"))));
    const wrapped = captureGate(original);
    expect(wrapped).toBe(original);
    await wrapped;
  });

  it("captureGate folds a rejected promise to the disabled verdict", async () => {
    const promise = captureGate(Promise.reject(new Error("spawn-side catch missing")));
    await promise.catch(() => undefined); // settle; captureGate handled the rejection
    expect(workflowGateNow(holderWith(promise))).toEqual(DISABLED_VERDICT);
  });

  it("a pending promise still reads null (fail-closed while unsettled)", () => {
    const promise = captureGate(new Promise<never>(() => undefined));
    expect(workflowGateNow(holderWith(promise))).toBeNull();
  });

  it("rememberGate makes an awaited verdict readable without captureGate", async () => {
    const promise = Promise.resolve({
      mode: "onDemand",
      enabled: true,
      source: "remote",
    } satisfies WorkflowGate);
    const holder = holderWith(promise);
    const gate = await promise;
    expect(workflowGateNow(holder)).toBeNull(); // plain promise: not readable yet
    rememberGate(promise, gate);
    expect(workflowGateNow(holder)).toEqual(gate);
  });
});
