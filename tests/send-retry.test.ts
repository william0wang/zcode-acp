import { describe, expect, it } from "vitest";

import { isTransientSendError } from "../src/handlers/session.js";

describe("isTransientSendError", () => {
  it("matches the real backend cold-start wording (observed in production)", () => {
    expect(
      isTransientSendError(
        "历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。",
      ),
    ).toBe(true);
  });

  it("matches generic English model-unavailable forms", () => {
    expect(isTransientSendError("model glm-4 is unavailable")).toBe(true);
    expect(isTransientSendError("The requested model is no longer available")).toBe(true);
  });

  it("rejects busy and permanent errors", () => {
    expect(isTransientSendError("Cannot send while a prompt is running")).toBe(false);
    // "not found" is a permanent condition — must not match the unavailable form.
    expect(isTransientSendError("model not found")).toBe(false);
    expect(isTransientSendError("authentication failed")).toBe(false);
    expect(isTransientSendError("")).toBe(false);
  });
});
