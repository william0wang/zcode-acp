/**
 * Backend capability table (ADR-0023, revised 2026-09-25) — the single
 * enforcement point for value-add surfaces.
 *
 * These tests pin the TABLE DATA, not the gates: zcode is all-true (gating
 * through the table is behavior-neutral while zcode is the only kind), and
 * the dsh column documents the port's starting point (verified against
 * @deepseek-ai/dsh 0.1.7-rc.2, research-dsh-017-facts.md). The dsh adapter
 * itself lands in a later PR — flipping any entry here is a deliberate
 * capability decision, not a drive-by.
 */

import { describe, expect, it } from "vitest";

import {
  backendCapabilities,
  parseBackendKind,
  type BackendCapabilities,
} from "../src/backend/adapter.js";

const ALL_ENTRIES = [
  "fork",
  "compact",
  "autoCompact",
  "modes",
  "plans",
  "elicitation",
  "sandbox",
  "mcpListing",
  "streaming",
  "image",
  "drain",
  "resumeIdempotent",
  "settings",
  "workflowCommands",
  "workflowRoutes",
  "backendRestart",
  "bootResumeHandshake",
  "quota",
] as const satisfies ReadonlyArray<keyof BackendCapabilities>;

describe("backendCapabilities table", () => {
  it("zcode: every entry is true (gates are no-ops for the only live kind)", () => {
    const caps = backendCapabilities("zcode");
    for (const key of ALL_ENTRIES) {
      expect(caps[key], `zcode.${key}`).toBe(true);
    }
  });

  it("dsh: every entry starts false (developer-preview starting point, PR2)", () => {
    const caps = backendCapabilities("dsh");
    for (const key of ALL_ENTRIES) {
      expect(caps[key], `dsh.${key}`).toBe(false);
    }
  });

  it("returns a frozen table (gates must not mutate their kind's flags)", () => {
    expect(Object.isFrozen(backendCapabilities("zcode"))).toBe(true);
    expect(Object.isFrozen(backendCapabilities("dsh"))).toBe(true);
  });
});

describe("parseBackendKind", () => {
  it("accepts the two known kinds, case-insensitive and whitespace-tolerant", () => {
    expect(parseBackendKind("zcode")).toBe("zcode");
    expect(parseBackendKind("dsh")).toBe("dsh");
    expect(parseBackendKind("  DSH ")).toBe("dsh");
    expect(parseBackendKind("Zcode")).toBe("zcode");
  });

  it("rejects everything else (empty, unknown, lookalikes)", () => {
    expect(parseBackendKind("")).toBeUndefined();
    expect(parseBackendKind("opencode")).toBeUndefined();
    expect(parseBackendKind("zcode-dsh")).toBeUndefined();
  });
});
