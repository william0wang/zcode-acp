/**
 * Dynamic-workflow gate resolution tests (desktop-host parity).
 *
 * resolveWorkflowGate reads the anonymous /api/v1/client/configs endpoint and
 * folds data.configs.dynamicWorkflow.mode into {mode, enabled, source}. Every
 * failure shape collapses to a fail-closed disabled verdict and never throws —
 * split into two observability shapes since 2026-09-29: "server answered but
 * the key is absent/invalid" reads mode "disabled" (upstream contract: pulling
 * the key IS the off signal), while a fetch that never produced a verdict
 * (HTTP error, throw, timeout, invalid JSON) reads mode "unknown" (unresolved).
 * The local override (workflowOverrideNow) and the effective folds are covered
 * too. All fetches are injected fakes; no network.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  captureGate,
  effectiveWorkflowGate,
  effectiveWorkflowGateNow,
  resolveWorkflowGate,
  workflowGateNow,
  workflowOverrideNow,
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

/** Server answered but the key is absent/invalid — OFF, not broken (upstream fold). */
const KEY_ABSENT_VERDICT = { mode: "disabled", enabled: false, source: "default" };
/** The fetch never produced a verdict — UNRESOLVED (bridge-only observability split). */
const UNRESOLVED_VERDICT = { mode: "unknown", enabled: false, source: "default" };

describe("resolveWorkflowGate mode mapping", () => {
  it("disabled maps to enabled:false with source remote (server-said-off, not failed)", async () => {
    await expect(
      resolveWorkflowGate(fakeFetch(async () => jsonResponse(gateBody("disabled")))),
    ).resolves.toEqual({ mode: "disabled", enabled: false, source: "remote" });
  });
});

describe("resolveWorkflowGate fail-closed", () => {
  // 200-without-key family: the upstream contract reads this as the server
  // pulling the flag — a plain disabled verdict, mode "disabled".
  it("missing dynamicWorkflow key collapses to disabled", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ data: { configs: {} } }));
    await expect(resolveWorkflowGate(fetchImpl)).resolves.toEqual(KEY_ABSENT_VERDICT);
  });

  // Fetch-failure family: no verdict arrived — mode "unknown" so clients can
  // tell "the feature was pulled" from "the config fetch is broken".
  it("HTTP error status collapses to unresolved", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ error: "boom" }, 503));
    await expect(resolveWorkflowGate(fetchImpl)).resolves.toEqual(UNRESOLVED_VERDICT);
  });

  it("fetch rejection collapses to unresolved", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error("network down");
    });
    await expect(resolveWorkflowGate(fetchImpl)).resolves.toEqual(UNRESOLVED_VERDICT);
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

  it("captureGate folds a rejected promise to the unresolved verdict", async () => {
    const promise = captureGate(Promise.reject(new Error("spawn-side catch missing")));
    await promise.catch(() => undefined); // settle; captureGate handled the rejection
    expect(workflowGateNow(holderWith(promise))).toEqual(UNRESOLVED_VERDICT);
  });

  it("a pending promise still reads null (fail-closed while unsettled)", () => {
    const promise = captureGate(new Promise<never>(() => undefined));
    expect(workflowGateNow(holderWith(promise))).toBeNull();
  });
});

describe("workflowOverrideNow (local switch: config file > env)", () => {
  /** A scratch XDG root with one config.json written into it. */
  function xdgWithConfig(config: Record<string, unknown>): Record<string, string> {
    const dir = mkdtempSync(`${tmpdir()}/wf-gate-`);
    mkdirSync(`${dir}/zcode-acp`, { recursive: true });
    writeFileSync(`${dir}/zcode-acp/config.json`, JSON.stringify(config));
    return { XDG_CONFIG_HOME: dir };
  }

  function xdgEmpty(): Record<string, string> {
    return { XDG_CONFIG_HOME: mkdtempSync(`${tmpdir()}/wf-gate-`) };
  }

  it("config workflow.mode wins with source override", () => {
    expect(workflowOverrideNow(xdgWithConfig({ workflow: { mode: "alwaysOn" } }))).toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "override",
    });
  });

  it("config override disabled reads enabled:false with source override", () => {
    expect(workflowOverrideNow(xdgWithConfig({ workflow: { mode: "disabled" } }))).toEqual({
      mode: "disabled",
      enabled: false,
      source: "override",
    });
  });

  it("config wins over the env var (file > env precedence)", () => {
    const env = {
      ...xdgWithConfig({ workflow: { mode: "disabled" } }),
      ZCODE_DYNAMIC_WORKFLOW_MODE: "alwaysOn",
    };
    expect(workflowOverrideNow(env)?.mode).toBe("disabled");
  });

  it("env var applies when the config carries no workflow section", () => {
    expect(workflowOverrideNow({ ...xdgEmpty(), ZCODE_DYNAMIC_WORKFLOW_MODE: "onDemand" })).toEqual(
      { mode: "onDemand", enabled: true, source: "override" },
    );
  });

  it("env value is trimmed (upstream normalize parity)", () => {
    expect(
      workflowOverrideNow({ ...xdgEmpty(), ZCODE_DYNAMIC_WORKFLOW_MODE: "  alwaysOn  " })?.mode,
    ).toBe("alwaysOn");
  });

  it("invalid env value is dropped (falls through to the remote verdict)", () => {
    expect(workflowOverrideNow({ ...xdgEmpty(), ZCODE_DYNAMIC_WORKFLOW_MODE: "yes" })).toBeNull();
  });

  it("no config, no env → null (follow the remote verdict)", () => {
    expect(workflowOverrideNow(xdgEmpty())).toBeNull();
  });
});

describe("effective gate folds (override > pinned remote)", () => {
  /** Point the DEFAULT-env reads (effectiveWorkflowGateNow) at a scratch XDG root. */
  function withScratchXdg<T>(fn: (xdg: string) => T): T {
    const dir = mkdtempSync(`${tmpdir()}/wf-gate-`);
    const saved = process.env.XDG_CONFIG_HOME;
    const savedMode = process.env.ZCODE_DYNAMIC_WORKFLOW_MODE;
    delete process.env.ZCODE_DYNAMIC_WORKFLOW_MODE;
    process.env.XDG_CONFIG_HOME = dir;
    try {
      return fn(dir);
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
      if (savedMode !== undefined) process.env.ZCODE_DYNAMIC_WORKFLOW_MODE = savedMode;
    }
  }

  it("effectiveWorkflowGateNow: override answers even while the remote fetch is pending", () => {
    withScratchXdg((dir) => {
      // Pending remote (never settles) + an override written after "boot":
      // the live re-read must answer without the pinned verdict.
      const holder: WorkflowGateHolder = {
        backendWorkflowGate: new Promise<WorkflowGate>(() => undefined),
      };
      expect(effectiveWorkflowGateNow(holder)).toBeNull(); // no override yet
      mkdirSync(`${dir}/zcode-acp`, { recursive: true });
      writeFileSync(
        `${dir}/zcode-acp/config.json`,
        JSON.stringify({ workflow: { mode: "alwaysOn" } }),
      );
      expect(effectiveWorkflowGateNow(holder)).toEqual({
        mode: "alwaysOn",
        enabled: true,
        source: "override",
      });
    });
  });

  it("effectiveWorkflowGateNow: no override falls back to the pinned verdict", async () => {
    await withScratchXdg(async () => {
      const promise = captureGate(
        resolveWorkflowGate(fakeFetch(async () => jsonResponse(gateBody("onDemand")))),
      );
      await promise;
      const holder: WorkflowGateHolder = { backendWorkflowGate: promise };
      expect(effectiveWorkflowGateNow(holder)).toEqual({
        mode: "onDemand",
        enabled: true,
        source: "remote",
      });
    });
  });

  it("effectiveWorkflowGate: override short-circuits without awaiting the pinned verdict", async () => {
    await withScratchXdg(async (dir) => {
      mkdirSync(`${dir}/zcode-acp`, { recursive: true });
      writeFileSync(
        `${dir}/zcode-acp/config.json`,
        JSON.stringify({ workflow: { mode: "alwaysOn" } }),
      );
      const holder: WorkflowGateHolder = {
        backendWorkflowGate: new Promise<WorkflowGate>(() => undefined), // never settles
      };
      expect(await effectiveWorkflowGate(holder)).toEqual({
        mode: "alwaysOn",
        enabled: true,
        source: "override",
      });
    });
  });

  it("effectiveWorkflowGate: no override awaits and returns the pinned verdict", async () => {
    await withScratchXdg(async () => {
      const promise = captureGate(
        resolveWorkflowGate(fakeFetch(async () => jsonResponse(gateBody("disabled")))),
      );
      const holder: WorkflowGateHolder = { backendWorkflowGate: promise };
      expect(await effectiveWorkflowGate(holder)).toEqual({
        mode: "disabled",
        enabled: false,
        source: "remote",
      });
    });
  });
});
