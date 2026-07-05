/**
 * Interaction adapter unit tests — ported from Python test_interaction.
 * Pure function tests: classification, permission mapping, ExitPlanMode,
 * AskUserQuestion split (single + multi-select), response parsing.
 */

import { describe, expect, it } from "vitest";

import {
  acpPermissionResponseToExitPlanMode,
  acpPermissionResponseToZcode,
  buildAskUserAcpParams,
  buildAskUserElicitationForm,
  buildExitPlanModeElicitationForm,
  exitPlanModeToAcpPermission,
  isAskUserQuestion,
  isExitPlanMode,
  isPermissionRequest,
  isUserInputRequest,
  parseAskUserElicitationResponse,
  parseAskUserResponse,
  parseExitPlanModeElicitationResponse,
  splitAskUserQuestions,
  zcodePermissionToAcp,
} from "../src/interaction/adapter.js";

describe("classification", () => {
  it("distinguishes permission vs userInput methods", () => {
    expect(isPermissionRequest("interaction/requestPermission")).toBe(true);
    expect(isPermissionRequest("interaction/requestUserInput")).toBe(false);
    expect(isUserInputRequest("interaction/requestUserInput")).toBe(true);
    expect(isUserInputRequest("interaction/requestPermission")).toBe(false);
  });

  it("detects ExitPlanMode by schema.interaction=plan_approval", () => {
    expect(isExitPlanMode({ schema: { interaction: "plan_approval" } })).toBe(true);
    expect(isExitPlanMode({ schema: { toolName: "X" } })).toBe(false);
    expect(isExitPlanMode({})).toBe(false);
  });

  it("AskUserQuestion = userInput without plan_approval", () => {
    expect(
      isAskUserQuestion("interaction/requestUserInput", {
        schema: { toolName: "AskUserQuestion" },
      }),
    ).toBe(true);
    expect(
      isAskUserQuestion("interaction/requestUserInput", {
        schema: { interaction: "plan_approval" },
      }),
    ).toBe(false);
    expect(isAskUserQuestion("interaction/requestPermission", {})).toBe(false);
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

  it("returns null when no valid options", () => {
    expect(zcodePermissionToAcp({ toolCallId: "t", options: [] } as never, "acp_1")).toBeNull();
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

  it("maps legacy allow/reject/unknown kinds to ACP-legal values", () => {
    const params = {
      toolCallId: "tc",
      options: [
        { optionId: "a", kind: "allow", name: "a" },
        { optionId: "r", kind: "reject", name: "r" },
        { optionId: "u", kind: "something_weird", name: "u" },
      ],
    };
    const acp = zcodePermissionToAcp(params, "acp_1");
    // allow→allow_always; reject/unknown→reject_once (fail-safe, never auto-allow)
    expect(acp!.options.map((o) => o.kind)).toEqual(["allow_always", "reject_once", "reject_once"]);
  });
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
  it("allow_once / allow_project optionId → decision allow", () => {
    expect(
      acpPermissionResponseToZcode({ outcome: { outcome: "selected", optionId: "allow_once" } })
        .decision,
    ).toBe("allow");
    expect(
      acpPermissionResponseToZcode({ outcome: { outcome: "selected", optionId: "allow_project" } })
        .decision,
    ).toBe("allow");
  });

  it("deny optionId → decision deny", () => {
    expect(
      acpPermissionResponseToZcode({ outcome: { outcome: "selected", optionId: "deny" } }).decision,
    ).toBe("deny");
  });
});

describe("ExitPlanMode", () => {
  it("synthesizes approve/reject options", () => {
    const acp = exitPlanModeToAcpPermission({ toolCallId: "tc_2" } as never, "acp_1");
    expect(acp.options.map((o) => o.optionId)).toEqual(["approve", "reject"]);
  });
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

  it("multiple questions → separate entries", () => {
    const qs = splitAskUserQuestions({
      toolCallId: "tc",
      questions: [
        { question: "Q1?", options: [{ label: "A" }] },
        { question: "Q2?", multiSelect: true, options: [{ label: "X" }] },
      ],
    } as never);
    expect(qs).toHaveLength(2);
    expect(qs![0].question).toBe("Q1?");
    expect(qs![1].question).toBe("Q2?");
  });

  it("returns null when no valid questions", () => {
    expect(splitAskUserQuestions({ toolCallId: "tc", questions: [] } as never)).toBeNull();
  });

  it("falls back to input.questions when top-level absent", () => {
    const qs = splitAskUserQuestions({
      toolCallId: "tc",
      input: { questions: [{ question: "From input?", options: [{ label: "Y" }] }] },
    } as never);
    expect(qs).toHaveLength(1);
    expect(qs![0].question).toBe("From input?");
  });
});

describe("buildAskUserAcpParams", () => {
  it("constructs the ACP params with options + toolCall", () => {
    const params = buildAskUserAcpParams(
      { toolCallId: "tc", input: { some: "in" } } as never,
      "acp_1",
      [{ optionId: "A", kind: "allow_once", name: "A" }],
    );
    expect(params.sessionId).toBe("acp_1");
    expect(params.options).toHaveLength(1);
    expect(params.toolCall.toolCallId).toBe("tc");
  });
});

describe("parseAskUserResponse", () => {
  it("single-select returns the label", () => {
    expect(parseAskUserResponse({ outcome: { outcome: "selected", optionId: "Option A" } })).toBe(
      "Option A",
    );
  });
  it("multi-select yes → 'yes'", () => {
    expect(parseAskUserResponse({ outcome: { outcome: "selected", optionId: "auth:yes" } })).toBe(
      "yes",
    );
  });
  it("multi-select no → 'no'", () => {
    expect(parseAskUserResponse({ outcome: { outcome: "selected", optionId: "log:no" } })).toBe(
      "no",
    );
  });
  it("skip → null", () => {
    expect(
      parseAskUserResponse({ outcome: { outcome: "selected", optionId: "__skip__" } }),
    ).toBeNull();
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

  it("single-select enum includes a trailing Skip option", () => {
    const form = buildAskUserElicitationForm(baseParams, "acp_1");
    const prop = form.requestedSchema.properties.q_0 as { enum: string[] };
    expect(prop.enum).toEqual(["Red", "Blue", "__skip__"]);
    expect(form.requestedSchema.required).toEqual(["q_0"]);
  });

  it("multi-select fields are arrays and not required", () => {
    const params = {
      ...baseParams,
      questions: [
        {
          question: "Pick files",
          multiSelect: true,
          options: [
            { label: "a.ts", value: "a" },
            { label: "b.ts", value: "b" },
          ],
        },
      ],
    };
    const form = buildAskUserElicitationForm(params, "acp_1");
    const prop = form.requestedSchema.properties.q_0 as {
      type: string;
      items: { type: string; enum: string[] };
    };
    expect(prop.type).toBe("array");
    expect(prop.items.type).toBe("string");
    expect(prop.items.enum).toEqual(["a.ts", "b.ts"]);
    expect(form.requestedSchema.required).not.toContain("q_0");
  });

  it("attaches toolCallId scope when provided", () => {
    const form = buildAskUserElicitationForm(baseParams, "acp_1", "tc_1");
    expect(form.toolCallId).toBe("tc_1");
    expect(form.sessionId).toBe("acp_1");
  });

  it("omits toolCallId when not provided", () => {
    const form = buildAskUserElicitationForm(baseParams, "acp_1");
    expect(form.toolCallId).toBeUndefined();
  });

  it("parse maps answers back by question text", () => {
    const answers = parseAskUserElicitationResponse(
      { action: "accept", content: { q_0: "Red" } },
      baseParams,
    );
    expect(answers).toEqual({ "Pick a color": "Red" });
  });

  it("parse multi-select joins with ', '", () => {
    const params = {
      ...baseParams,
      questions: [
        {
          question: "Pick files",
          multiSelect: true,
          options: [
            { label: "a.ts", value: "a" },
            { label: "b.ts", value: "b" },
          ],
        },
      ],
    };
    const answers = parseAskUserElicitationResponse(
      { action: "accept", content: { q_0: ["a.ts", "b.ts"] } },
      params,
    );
    expect(answers).toEqual({ "Pick files": "a.ts, b.ts" });
  });

  it("parse skips the __skip__ sentinel (single-select)", () => {
    const answers = parseAskUserElicitationResponse(
      { action: "accept", content: { q_0: "__skip__" } },
      baseParams,
    );
    // Skipped question is omitted from the answers map (parity with
    // request_permission path leaving it unanswered on Skip).
    expect(answers).toEqual({});
  });

  it("parse returns null on decline/cancel", () => {
    expect(parseAskUserElicitationResponse({ action: "decline" }, baseParams)).toBeNull();
    expect(parseAskUserElicitationResponse({ action: "cancel" }, baseParams)).toBeNull();
  });
});

describe("elicitation form: ExitPlanMode", () => {
  const epmParams = {
    requestId: "req_2",
    sessionId: "sess_1",
    toolCallId: "tc_2",
    schema: { interaction: "plan_approval" },
    input: { plan: "Step 1\nStep 2" },
  };

  it("embeds the plan text in the message", () => {
    const form = buildExitPlanModeElicitationForm(epmParams, "acp_1");
    expect(form.message).toContain("Step 1");
    expect(form.message).toContain("Ready to code?");
  });

  it("attaches toolCallId scope when provided", () => {
    const form = buildExitPlanModeElicitationForm(epmParams, "acp_1", "tc_2");
    expect(form.toolCallId).toBe("tc_2");
  });

  it("approve → accept with answer_0", () => {
    const resp = parseExitPlanModeElicitationResponse({
      action: "accept",
      content: { decision: "approve" },
    });
    expect(resp).toEqual({ action: "accept", content: { answer_0: "approve" } });
  });

  it("reject → decline", () => {
    const resp = parseExitPlanModeElicitationResponse({
      action: "accept",
      content: { decision: "reject" },
    });
    expect(resp.action).toBe("decline");
  });

  it("cancel → decline", () => {
    const resp = parseExitPlanModeElicitationResponse({ action: "cancel" });
    expect(resp.action).toBe("decline");
  });
});
