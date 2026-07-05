/**
 * Interaction channel adapter: zcode `interaction/*` server→client requests
 * ↔ ACP `session/requestPermission`.
 *
 * ZCode's `createProtocolInteractionBroker` dispatches server→client requests
 * by tool. Zed supports `session/requestPermission` natively (the allow/reject
 * popup) but NOT elicitation, so all three interaction kinds map onto
 * requestPermission:
 *   - interaction/requestPermission (tool approval)         → direct mapping
 *   - interaction/requestUserInput (plan_approval / ExitPlanMode) → approve/reject
 *   - interaction/requestUserInput (AskUserQuestion)        → per-question options
 *     (single-select: one popup + Skip; multi-select: per-option Include/Skip)
 *
 * `requestPermission` is single-select, so multi-select questions are split
 * into per-option yes/no popups; the user's Include picks are comma-joined
 * into the final answer (mirrors the reference impl's `answers[q]: "a, b"`).
 */

import type { PermissionOption } from "@agentclientprotocol/sdk";

import type {
  ZcodeInteractionPermissionParams,
  ZcodeInteractionResponse,
  ZcodeInteractionUserInputParams,
} from "../backend/types.js";

// ---------- classification ----------

export function isPermissionRequest(method: string): boolean {
  return method === "interaction/requestPermission";
}

export function isUserInputRequest(method: string): boolean {
  return method === "interaction/requestUserInput";
}

export function isExitPlanMode(params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  const schema = (params as { schema?: unknown }).schema;
  if (!schema || typeof schema !== "object") return false;
  return (schema as { interaction?: string }).interaction === "plan_approval";
}

/** AskUserQuestion = requestUserInput WITHOUT the plan_approval schema. */
export function isAskUserQuestion(method: string, params: unknown): boolean {
  return isUserInputRequest(method) && !isExitPlanMode(params);
}

// ---------- zcode permission → ACP requestPermission ----------

/**
 * Normalize a zcode permission-option `kind` to one of the 4 ACP-legal values
 * (`allow_once` | `allow_always` | `reject_once` | `reject_always`).
 *
 * zcode's backend emits a wider/legacy enum that includes `deny`, `allow`,
 * `reject`, etc. The ACP schema (and Zed's deserializer) only accepts the four
 * canonical values — anything else makes the *whole* `requestPermission` fail
 * at the client with "unknown variant", so the popup never renders and the
 * request defaults to decline. `optionId` is free text and stays untouched.
 *
 * Fail-safe: any unrecognized kind maps to `reject_once` (never auto-allow).
 */
function normalizeKind(kind: string | undefined): PermissionOption["kind"] {
  switch (kind) {
    case "allow_once":
    case "allow_always":
    case "reject_once":
    case "reject_always":
      return kind;
    case "allow":
    case "allow_project":
      return "allow_always";
    case "reject":
    case "deny":
      return "reject_once";
    default:
      return "reject_once";
  }
}

/** Convert a zcode tool-permission request into ACP requestPermission params. */
export function zcodePermissionToAcp(
  params: ZcodeInteractionPermissionParams,
  acpSid: string,
): {
  options: PermissionOption[];
  sessionId: string;
  toolCall: { toolCallId: string; rawInput: unknown };
} | null {
  const options: PermissionOption[] = [];
  for (const opt of params.options ?? []) {
    options.push({
      optionId: opt.optionId ?? "",
      kind: normalizeKind(opt.kind),
      name: opt.name ?? opt.optionId ?? "",
    });
  }
  if (options.length === 0) return null;
  return {
    options,
    sessionId: acpSid,
    toolCall: { toolCallId: params.toolCallId ?? "", rawInput: params.input },
  };
}

/**
 * Allow-class optionIds that zcode's backend emits. The response mapper must
 * recognize ALL of them — selecting "Allow once" (optionId "allow_once") in
 * the popup otherwise gets reported back as a rejection. optionId is free
 * text defined by the backend, so this set mirrors the backend's naming.
 * Any optionId not in this set is treated as deny (fail-safe). */
const ALLOW_OPTION_IDS = new Set(["allow", "allow_once", "allow_always", "allow_project"]);

/** Convert an ACP requestPermission response → zcode {decision, reason?}. */
export function acpPermissionResponseToZcode(
  acpResp: unknown,
): Extract<ZcodeInteractionResponse, { decision: string }> {
  if (!acpResp || typeof acpResp !== "object") {
    return { decision: "deny", reason: "invalid client response" };
  }
  const outcome = (acpResp as { outcome?: { outcome?: string; optionId?: string } }).outcome ?? {};
  if (outcome.outcome === "cancelled") return { decision: "deny", reason: "cancelled by user" };
  const optionId = outcome.optionId ?? "";
  if (ALLOW_OPTION_IDS.has(optionId)) return { decision: "allow" };
  return { decision: "deny", reason: `rejected (${optionId})` };
}

// ---------- ExitPlanMode → ACP requestPermission ----------

/** ExitPlanMode rendered as approve/reject permission options. */
export function exitPlanModeToAcpPermission(
  params: ZcodeInteractionUserInputParams,
  acpSid: string,
): {
  options: PermissionOption[];
  sessionId: string;
  toolCall: { toolCallId: string; rawInput: unknown };
} {
  return {
    options: [
      { kind: "allow_once", name: "Approve — exit plan mode", optionId: "approve" },
      { kind: "reject_once", name: "Reject — keep planning", optionId: "reject" },
    ],
    sessionId: acpSid,
    toolCall: { toolCallId: params.toolCallId ?? "", rawInput: params.input },
  };
}

/** Convert an ACP response → zcode ExitPlanMode response. */
export function acpPermissionResponseToExitPlanMode(
  acpResp: unknown,
): Extract<ZcodeInteractionResponse, { action: string }> {
  if (!acpResp || typeof acpResp !== "object") {
    return { action: "decline", reason: "invalid client response" };
  }
  const outcome = (acpResp as { outcome?: { outcome?: string; optionId?: string } }).outcome ?? {};
  if (outcome.outcome === "cancelled") return { action: "decline", reason: "cancelled" };
  if (outcome.optionId === "approve") {
    // content must be an object with answer_0 (zcode reads content.answer_0).
    return { action: "accept", content: { answer_0: "approve" } };
  }
  return { action: "decline", reason: "rejected" };
}

// ---------- AskUserQuestion split (single + multi-select) ----------

export interface AskUserQuestion {
  question: string;
  multiSelect: boolean;
  options: PermissionOption[];
}

/**
 * Split a zcode AskUserQuestion request into per-question descriptors.
 *
 * Single-select: one ACP option per label + a trailing Skip.
 * Multi-select: each label becomes a yes/no pair (optionId `<label>:yes` /
 * `<label>:no`) so the handler can pop one Include/Skip dialog per option.
 *
 * Returns null when there are no valid questions.
 */
export function splitAskUserQuestions(
  params: ZcodeInteractionUserInputParams,
): AskUserQuestion[] | null {
  // zcode carries questions both at the top level and under input.questions; prefer top level.
  let questions = params.questions;
  if (!questions || questions.length === 0) {
    questions = params.input?.questions ?? [];
  }
  const valid = questions.filter((q) => q && typeof q.question === "string");
  if (valid.length === 0) return null;

  const result: AskUserQuestion[] = [];
  for (const q of valid) {
    const labels: string[] = [];
    for (const opt of q.options ?? []) {
      const label = opt.label ?? opt.value ?? "";
      if (label) labels.push(label);
    }
    if (labels.length === 0) continue;

    const multi = q.multiSelect === true;
    if (multi) {
      const options: PermissionOption[] = [];
      for (const lb of labels) {
        options.push({ optionId: `${lb}:yes`, kind: "allow_once", name: `Include: ${lb}` });
        options.push({ optionId: `${lb}:no`, kind: "reject_once", name: `Skip: ${lb}` });
      }
      result.push({ question: q.question, multiSelect: true, options });
    } else {
      const options: PermissionOption[] = labels.map((lb) => ({
        optionId: lb,
        kind: "allow_once",
        name: lb,
      }));
      options.push({ optionId: "__skip__", kind: "reject_once", name: "Skip" });
      result.push({ question: q.question, multiSelect: false, options });
    }
  }
  return result.length > 0 ? result : null;
}

/** Build ACP requestPermission params for one AskUserQuestion question. */
export function buildAskUserAcpParams(
  params: ZcodeInteractionUserInputParams,
  acpSid: string,
  options: PermissionOption[],
): {
  options: PermissionOption[];
  sessionId: string;
  toolCall: { toolCallId: string; rawInput: unknown };
} {
  return {
    options,
    sessionId: acpSid,
    toolCall: { toolCallId: params.toolCallId ?? "", rawInput: params.input },
  };
}

/**
 * Parse one ACP requestPermission response → "yes" | "no" | label | null.
 *
 * Multi-select: optionId `<label>:yes` → "yes", `<label>:no` → "no".
 * Single-select: optionId is the label; __skip__ / cancel → null.
 */
export function parseAskUserResponse(acpResp: unknown): string | null {
  if (!acpResp || typeof acpResp !== "object") return null;
  const outcome = (acpResp as { outcome?: { outcome?: string; optionId?: string } }).outcome ?? {};
  if (outcome.outcome === "cancelled") return null;
  const optionId = outcome.optionId ?? "";
  if (!optionId || optionId === "__skip__") return null;
  if (optionId.endsWith(":yes")) return "yes";
  if (optionId.endsWith(":no")) return "no";
  return optionId;
}

// ---------- elicitation form (preferred when client supports it) ----------

/**
 * Build an elicitation form schema for an AskUserQuestion request.
 *
 * Each question becomes one property in the form:
 *   - Single-select → string enum of labels + a trailing "Skip" option
 *   - Multi-select  → string array enum of labels
 *
 * When the client supports form-based elicitation, this lets the user answer
 * all questions in one form rather than one popup per question. Single-select
 * fields include a "Skip" option so the user can opt out of a question without
 * cancelling the whole form (mirrors the request_permission fallback, which
 * appends a Skip option per question).
 */
export function buildAskUserElicitationForm(
  params: ZcodeInteractionUserInputParams,
  acpSid: string,
  toolCallId?: string,
): {
  mode: "form";
  sessionId: string;
  toolCallId?: string;
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  const questions = params.questions?.length ? params.questions : (params.input?.questions ?? []);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q.question !== "string") continue;
    const key = `q_${i}`;
    const labels = (q.options ?? [])
      .map((o) => o.label ?? o.value ?? "")
      .filter((l) => l.length > 0);
    if (labels.length === 0) continue;
    if (q.multiSelect) {
      properties[key] = {
        type: "array",
        items: { type: "string", enum: labels },
        title: q.question,
        description: q.question,
      };
    } else {
      // Append a Skip option so the user can opt out of this question without
      // cancelling the whole form (parity with the request_permission path).
      properties[key] = {
        type: "string",
        enum: [...labels, ELICIT_SKIP],
        title: q.question,
        description: q.question,
      };
      required.push(key);
    }
  }
  const message =
    questions.length === 1
      ? (questions[0]?.question ?? "Please answer the question.")
      : `Please answer ${questions.length} questions.`;
  const form: {
    mode: "form";
    sessionId: string;
    toolCallId?: string;
    message: string;
    requestedSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  } = {
    mode: "form",
    sessionId: acpSid,
    message,
    requestedSchema: { type: "object", properties, required },
  };
  if (toolCallId) form.toolCallId = toolCallId;
  return form;
}

/** Sentinel enum value marking a single-select question as skipped in the form. */
const ELICIT_SKIP = "__skip__";

/**
 * Parse an elicitation form response into the zcode answers map.
 *
 * Maps each `q_<i>` form field back to the original question text. Multi-select
 * answers (arrays) are comma-joined to match the request_permission path's
 * `"a, b"` format. Returns null if the user declined/cancelled.
 */
export function parseAskUserElicitationResponse(
  acpResp: unknown,
  params: ZcodeInteractionUserInputParams,
): Record<string, string> | null {
  if (!acpResp || typeof acpResp !== "object") return null;
  const resp = acpResp as { action?: string; content?: Record<string, unknown> | null };
  if (resp.action !== "accept" || !resp.content) return null;
  const questions = params.questions?.length ? params.questions : (params.input?.questions ?? []);
  const answers: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q.question !== "string") continue;
    const key = `q_${i}`;
    const val = resp.content[key];
    if (val == null) continue;
    if (Array.isArray(val)) {
      answers[q.question] = val.filter((v) => typeof v === "string").join(", ");
    } else if (typeof val === "string" && val !== ELICIT_SKIP) {
      // Skip the sentinel "__skip__" so a skipped single-select question is
      // simply omitted from the answers map (parity with the request_permission
      // path, which leaves the question unanswered on Skip).
      answers[q.question] = val;
    }
  }
  return answers;
}

/**
 * Build an elicitation form for ExitPlanMode (approve/reject).
 *
 * Uses a single required boolean-style enum so the client renders a clear
 * approve/reject choice in the form UI.
 */
export function buildExitPlanModeElicitationForm(
  params: ZcodeInteractionUserInputParams,
  acpSid: string,
  toolCallId?: string,
): {
  mode: "form";
  sessionId: string;
  toolCallId?: string;
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  const planText =
    params.input && typeof params.input === "object"
      ? ((params.input as { plan?: string }).plan ?? "")
      : "";
  const message = planText ? `Ready to code?\n\n${planText}` : "Ready to code?";
  const form: {
    mode: "form";
    sessionId: string;
    toolCallId?: string;
    message: string;
    requestedSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  } = {
    mode: "form",
    sessionId: acpSid,
    message,
    requestedSchema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["approve", "reject"],
          title: "Decision",
          description: "Approve to exit plan mode and start coding, or reject to keep planning.",
        },
      },
      required: ["decision"],
    },
  };
  if (toolCallId) form.toolCallId = toolCallId;
  return form;
}

/** Parse an ExitPlanMode elicitation response → zcode accept/decline. */
export function parseExitPlanModeElicitationResponse(acpResp: unknown): {
  action: "accept" | "decline";
  reason?: string;
} {
  if (!acpResp || typeof acpResp !== "object") {
    return { action: "decline", reason: "invalid client response" };
  }
  const resp = acpResp as { action?: string; content?: { decision?: string } | null };
  if (resp.action !== "accept" || !resp.content) {
    return { action: "decline", reason: "cancelled" };
  }
  if (resp.content.decision === "approve") {
    return { action: "accept", content: { answer_0: "approve" } } as never;
  }
  return { action: "decline", reason: "rejected" };
}
