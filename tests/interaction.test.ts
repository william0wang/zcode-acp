/**
 * Interaction adapter unit tests — ported from Python test_interaction.
 * Pure function tests: classification, permission mapping, ExitPlanMode,
 * AskUserQuestion split (single + multi-select), response parsing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acpPermissionResponseToExitPlanMode,
  acpPermissionResponseToZcode,
  buildAskUserElicitationForm,
  clientPrefersPermissionPopups,
  isPermissionRequest,
  isUserInputRequest,
  parseAskUserElicitationResponse,
  parseAskUserResponse,
  splitAskUserQuestions,
  zcodePermissionToAcp,
} from "../src/interaction/adapter.js";

// Asserts English popup option names; pin the language regardless of host env.
beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("classification", () => {
  it("distinguishes permission vs userInput methods", () => {
    expect(isPermissionRequest("interaction/requestPermission")).toBe(true);
    expect(isPermissionRequest("interaction/requestUserInput")).toBe(false);
    expect(isUserInputRequest("interaction/requestUserInput")).toBe(true);
    expect(isUserInputRequest("interaction/requestPermission")).toBe(false);
  });
});

describe("clientPrefersPermissionPopups", () => {
  it("gates off the elicitation form for T3 Code (per-field wizard stepper)", () => {
    expect(clientPrefersPermissionPopups("t3-code-session-manager")).toBe(true);
    expect(clientPrefersPermissionPopups("t3-code-provider-test")).toBe(true);
    expect(clientPrefersPermissionPopups("T3-Code")).toBe(true);
  });

  it("keeps the elicitation form for other clients", () => {
    expect(clientPrefersPermissionPopups("Zed")).toBe(false);
    expect(clientPrefersPermissionPopups("martty")).toBe(false);
    expect(clientPrefersPermissionPopups(null)).toBe(false);
    expect(clientPrefersPermissionPopups(undefined)).toBe(false);
    expect(clientPrefersPermissionPopups("")).toBe(false);
  });
});

describe("zcode permission → ACP", () => {
  it("passes options through and wraps toolCall", () => {
    const params = {
      requestId: "r1",
      toolCallId: "tc_1",
      toolName: "Bash",
      input: { command: "ls" },
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    };
    const acp = zcodePermissionToAcp(params, "acp_1");
    expect(acp).not.toBeNull();
    expect(acp!.options).toHaveLength(2);
    expect(acp!.options[0].optionId).toBe("allow");
    expect(acp!.toolCall.toolCallId).toBe("tc_1");
    expect(acp!.sessionId).toBe("acp_1");
  });

  // Regression: zcode backend emits `kind: "deny"` (and other non-ACP values)
  // which Zed rejects at schema deserialization ("unknown variant `deny`"),
  // making every permission popup fail instantly without user action.
  // The adapter MUST normalize kinds to the 4 ACP-legal values. optionId is
  // free text and must be preserved verbatim (zcode identifies the choice by it).
  it("normalizes non-ACP kinds (deny → reject_once), preserves optionId", () => {
    // Real payload observed from zcode backend (Zed.log deserialization error).
    const params = {
      requestId: "r1",
      toolCallId: "tc_1",
      toolName: "Bash",
      input: { command: "ls" },
      options: [
        { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
        { optionId: "allow_project", kind: "allow_always", name: "Always allow in this project" },
        { optionId: "deny", kind: "deny", name: "Deny" },
      ],
    };
    const acp = zcodePermissionToAcp(params, "acp_1");
    expect(acp).not.toBeNull();
    expect(acp!.options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    // optionId untouched so the response mapping still recognizes the choice.
    expect(acp!.options.map((o) => o.optionId)).toEqual(["allow_once", "allow_project", "deny"]);
  });

  // The approval popup must show WHAT is being approved. martty renders only
  // toolCall.title in its overlay (untitled → a bare "tool" prompt), so the
  // title carries "Tool: command/path" and content carries the full input.
});

describe("ACP response → zcode permission", () => {
  it("allow → decision allow", () => {
    expect(
      acpPermissionResponseToZcode({ outcome: { outcome: "selected", optionId: "allow" } })
        .decision,
    ).toBe("allow");
  });
  it("reject → decision deny", () => {
    expect(
      acpPermissionResponseToZcode({ outcome: { outcome: "selected", optionId: "reject" } })
        .decision,
    ).toBe("deny");
  });
  it("cancelled → decision deny", () => {
    expect(acpPermissionResponseToZcode({ outcome: { outcome: "cancelled" } }).decision).toBe(
      "deny",
    );
  });

  // Regression: zcode backend's allow-class options carry optionId "allow_once"
  // / "allow_project" (not "allow"/"allow_always"). The response mapper must
  // recognize these as allow, otherwise selecting "Allow once" in the popup
  // is reported back to zcode as a rejection.
  // The backend's options each carry the authoritative response object
  // (zcodePermissionOptionSchema, zcode-protocol/index.ts:589-597): "Always
  // allow in this project" ships permissionUpdates the runtime persists
  // (core/src/tool/executor/permission-flow.ts:359-366), and deny ships the
  // normalized STOP reason (bootstrap/src/permission-options.ts:75-99).
  // Echoing the selected option's response verbatim is what the desktop host
  // does (interaction-broker.ts:70-124) — synthesizing {decision:"allow"}
  // instead degraded "always allow" to a one-shot allow.
  it("echoes the selected option's response verbatim (permissionUpdates + reason)", () => {
    const options = [
      {
        optionId: "allow_once",
        kind: "allow_once",
        name: "Allow once",
        response: { decision: "allow" },
      },
      {
        optionId: "allow_project",
        kind: "allow_always",
        name: "Always allow in this project",
        response: {
          decision: "allow",
          reason: "Approved for this project",
          permissionUpdates: [
            { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] },
          ],
        },
      },
      {
        optionId: "deny",
        kind: "deny",
        name: "Deny",
        response: { decision: "deny", reason: "PERMISSION_DENIED_BY_USER" },
      },
    ];
    expect(
      acpPermissionResponseToZcode(
        { outcome: { outcome: "selected", optionId: "allow_project" } },
        options,
      ),
    ).toEqual({
      decision: "allow",
      reason: "Approved for this project",
      permissionUpdates: [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] }],
    });
    // Deny's normalized reason rides along too.
    expect(
      acpPermissionResponseToZcode({ outcome: { outcome: "selected", optionId: "deny" } }, options),
    ).toEqual({ decision: "deny", reason: "PERMISSION_DENIED_BY_USER" });
  });

  // The v3 projection crops BOTH always tiers for the session-always tools
  // (toLegacyPermissionOptionsPolicy) — the bridge re-offers the session tier
  // itself so a client can stop re-approving every workflow-design call.
  // SaveWorkflow stays OUT (upstream allowAlways:false — every save is an
  // explicit ask even on the desktop).
});

describe("ExitPlanMode", () => {
  it("approve → accept with content.answer_0", () => {
    const r = acpPermissionResponseToExitPlanMode({
      outcome: { outcome: "selected", optionId: "approve" },
    });
    expect(r.action).toBe("accept");
    expect((r as { content: { answer_0: string } }).content.answer_0).toBe("approve");
  });
  it("reject → decline", () => {
    expect(
      acpPermissionResponseToExitPlanMode({ outcome: { outcome: "selected", optionId: "reject" } })
        .action,
    ).toBe("decline");
  });
});

describe("AskUserQuestion split", () => {
  it("single-select: one option per label + Skip", () => {
    const qs = splitAskUserQuestions({
      toolCallId: "tc",
      questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
    } as never);
    expect(qs).not.toBeNull();
    expect(qs).toHaveLength(1);
    expect(qs![0].multiSelect).toBe(false);
    expect(qs![0].options.map((o) => o.optionId)).toEqual(["A", "B", "__skip__"]);
  });

  it("multi-select: each option becomes a yes/no pair", () => {
    const qs = splitAskUserQuestions({
      toolCallId: "tc",
      questions: [
        { question: "Which?", multiSelect: true, options: [{ label: "auth" }, { label: "log" }] },
      ],
    } as never);
    expect(qs).toHaveLength(1);
    expect(qs![0].multiSelect).toBe(true);
    const ids = qs![0].options.map((o) => o.optionId);
    expect(ids).toEqual(["auth:yes", "auth:no", "log:yes", "log:no"]);
  });

  it("returns null when no valid questions", () => {
    expect(splitAskUserQuestions({ toolCallId: "tc", questions: [] } as never)).toBeNull();
  });
});

describe("parseAskUserResponse", () => {
  it("single-select returns the label", () => {
    expect(parseAskUserResponse({ outcome: { outcome: "selected", optionId: "Option A" } })).toBe(
      "Option A",
    );
  });
  it("multi-select no → 'no'", () => {
    expect(parseAskUserResponse({ outcome: { outcome: "selected", optionId: "log:no" } })).toBe(
      "no",
    );
  });
  it("cancelled → null", () => {
    expect(parseAskUserResponse({ outcome: { outcome: "cancelled" } })).toBeNull();
  });
});

describe("elicitation form: AskUserQuestion", () => {
  const baseParams = {
    requestId: "req_1",
    sessionId: "sess_1",
    toolCallId: "tc_1",
    questions: [
      {
        question: "Pick a color",
        multiSelect: false,
        options: [
          { label: "Red", value: "red" },
          { label: "Blue", value: "blue" },
        ],
      },
    ],
  };

  it("single-select: enum dropdown + companion free-text field", () => {
    const form = buildAskUserElicitationForm(baseParams, "acp_1");
    const prop = form.requestedSchema.properties.q_0 as {
      type: string;
      oneOf?: Array<{ const: string; title: string }>;
    };
    expect(prop.type).toBe("string");
    expect(prop.oneOf).toEqual([
      { const: "Red", title: "Red" },
      { const: "Blue", title: "Blue" },
      { const: "__skip__", title: "Skip this question" },
    ]);
    // Companion free-text override field — "↳" + padding marks it as a
    // continuation of the question above; self-contained title, no description.
    const other = form.requestedSchema.properties.q_0_other as {
      type: string;
      title: string;
      description?: string;
    };
    expect(other.type).toBe("string");
    expect(other.title).toMatch(/^↳\s+/);
    expect(other.title).toContain("custom value");
    expect(other.title).toContain("overrides");
    expect(other.description).toBeUndefined();
    expect(form.requestedSchema.required).toEqual([]);
  });

  it("parse: free-text override wins over dropdown (single-select)", () => {
    const answers = parseAskUserElicitationResponse(
      { action: "accept", content: { q_0: "Red", q_0_other: "magenta" } },
      baseParams,
    );
    expect(answers).toEqual({ "Pick a color": "magenta" });
  });

  it("parse: empty dropdown + empty free-text = skipped (single-select)", () => {
    const answers = parseAskUserElicitationResponse(
      { action: "accept", content: { q_0: "", q_0_other: "   " } },
      baseParams,
    );
    expect(answers).toEqual({});
  });
});

// ExitPlanMode has two client paths, both covered above: form-capable clients
// get the elicitation form (plan markdown in the field description); everyone
// else gets session/request_permission with the plan in toolCall.content.
