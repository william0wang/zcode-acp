/**
 * Tests for transient turn.failed classification.
 *
 * The retry loop itself (in `prompt`) is deeply coupled to a live backend and
 * is not unit-tested here; instead we cover the predicate that drives it:
 * `isTransientTurnError`. The real `turn.failed` payload is a nested object —
 * the recoverable cause lives under `error.cause` while the top-level code is
 * almost always the generic `UNKNOWN_ERROR` wrapper — so classification must
 * look at `cause` and not be fooled by the wrapper.
 */

import { describe, expect, it } from "vitest";

import { isTransientTurnError } from "../src/translators/tool-helpers.js";

describe("isTransientTurnError", () => {
  it("matches a transient cause.code (model_request_failed)", () => {
    // The real-world shape observed in transcripts.
    const err = {
      code: "UNKNOWN_ERROR",
      message: "Turn execution failed",
      cause: {
        code: "model_request_failed",
        message: "Network connection failed for the provider request.",
      },
    };
    expect(isTransientTurnError(err)).toBe(true);
  });

  it("matches other whitelisted cause codes", () => {
    for (const code of [
      "invalid_model_request",
      "provider_not_configured",
      "rate_limit",
      "timeout",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "fetch_failed",
    ]) {
      expect(isTransientTurnError({ cause: { code } })).toBe(true);
    }
  });

  it("matches the provider-rejection message shape", () => {
    // The reported interrupt: cause code invalid_model_request with the
    // "Provider rejected the model request" message — retry rather than die.
    const err = {
      code: "UNKNOWN_ERROR",
      message: "Turn execution failed",
      cause: {
        code: "invalid_model_request",
        message: "Provider rejected the model request. (Turn execution failed)",
      },
    };
    expect(isTransientTurnError(err)).toBe(true);
    expect(
      isTransientTurnError({ cause: { message: "provider rejected the model request" } }),
    ).toBe(true);
  });

  it("matches via message keyword when code is absent/unrecognised", () => {
    expect(
      isTransientTurnError({
        cause: { message: "Network connection failed for the provider request." },
      }),
    ).toBe(true);
    expect(isTransientTurnError({ cause: { message: "upstream timed out (110)" } })).toBe(true);
    expect(isTransientTurnError({ cause: { message: "service unavailable" } })).toBe(true);
  });

  it("falls back to the top-level error when no cause is present", () => {
    // Some failures may not nest a cause; the top-level fields should still be
    // inspected as a fallback.
    expect(isTransientTurnError({ code: "timeout" })).toBe(true);
    expect(isTransientTurnError({ message: "network unreachable" })).toBe(true);
  });

  it("returns false for the UNKNOWN_ERROR wrapper WITHOUT a cause", () => {
    // The generic wrapper alone must not be classified as transient — that
    // would retry every business error.
    expect(isTransientTurnError({ code: "UNKNOWN_ERROR", message: "Turn execution failed" })).toBe(
      false,
    );
  });

  it("returns false for non-transient business errors", () => {
    expect(isTransientTurnError({ code: "prompt is running" })).toBe(false);
    expect(isTransientTurnError({ code: "1308", message: "prompt is running" })).toBe(false);
    expect(isTransientTurnError({ cause: { code: "INVALID_PARAMS", message: "bad input" } })).toBe(
      false,
    );
  });

  it("returns false for non-object / malformed input", () => {
    expect(isTransientTurnError(null)).toBe(false);
    expect(isTransientTurnError(undefined)).toBe(false);
    expect(isTransientTurnError("model_request_failed")).toBe(false);
    expect(isTransientTurnError([])).toBe(false);
    expect(isTransientTurnError({})).toBe(false);
  });

  it("inspects cause.type as an alias for cause.code", () => {
    // The translator also surfaces `type` on some payloads.
    expect(isTransientTurnError({ cause: { type: "rate_limit" } })).toBe(true);
  });

  it("does NOT fall back to top-level when a non-transient cause exists", () => {
    // A non-transient cause must short-circuit before the top-level fallback,
    // otherwise a transient-looking top-level message would override it.
    expect(
      isTransientTurnError({
        code: "timeout", // transient-looking top level
        message: "network blip",
        cause: { code: "INVALID_PARAMS", message: "bad input" }, // fatal cause
      }),
    ).toBe(false);
  });
});
