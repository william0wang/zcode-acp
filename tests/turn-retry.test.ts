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

import {
  isBackendLostError,
  isGatewayBlipTurnError,
  isTransientTurnError,
} from "../src/translators/tool-helpers.js";

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
      "model_rate_limited",
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

  it("does not retry when the backend explicitly marks a rate limit non-retryable", () => {
    expect(
      isTransientTurnError({
        cause: { code: "rate_limit", context: { retryable: false } },
      }),
    ).toBe(false);
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

describe("isGatewayBlipTurnError", () => {
  it("matches the observed relay-gateway 400 marked non-retryable", () => {
    // 2026-10-28: a local OpenAI-compatible relay intermittently answered
    // 400 invalid_request_error mid-conversation; the upstream classifier
    // marks the shape retryable:false (it judges the request, not the
    // gateway), and resending the same prompt succeeded.
    const err = {
      code: "UNKNOWN_ERROR",
      message: "Turn execution failed",
      cause: {
        code: "invalid_model_request",
        message: "Upstream request failed: [invalid_request_error] thinking must be passed back",
        context: { attempt: 1, maxAttempts: 11, providerCode: "server_error", retryable: false },
      },
    };
    expect(isGatewayBlipTurnError(err)).toBe(true);
  });

  it("matches request-failure cause codes even when marked non-retryable", () => {
    expect(
      isGatewayBlipTurnError({
        cause: { code: "model_request_failed", context: { retryable: false } },
      }),
    ).toBe(true);
    expect(
      isGatewayBlipTurnError({
        cause: { code: "provider_not_configured", context: { retryable: false } },
      }),
    ).toBe(true);
  });

  it("falls back to the top-level code when no cause is present", () => {
    expect(isGatewayBlipTurnError({ code: "model_request_failed" })).toBe(true);
  });

  it("does not match quota, context-window or model-not-found failures", () => {
    // Those stay terminal for a plain resend: quota has dedicated wait
    // machinery (quota.autoResume, goal-loop waits), context-exceeded needs
    // compaction, model-not-found is a configuration error.
    expect(
      isGatewayBlipTurnError({
        cause: {
          code: "model_rate_limited",
          context: { reason: "rate_limited", retryable: false },
        },
      }),
    ).toBe(false);
    expect(isGatewayBlipTurnError({ cause: { code: "model_context_exceeded" } })).toBe(false);
    expect(isGatewayBlipTurnError({ cause: { code: "model_not_found" } })).toBe(false);
  });

  it("ignores message wording — the verdict is the code alone", () => {
    // Deliberately narrower than isTransientTurnError: a gateway blip is not
    // re-derived from message keywords, so quota/business wording that merely
    // resembles a network failure cannot sneak into the bounded resend.
    expect(isGatewayBlipTurnError({ cause: { message: "network connection failed" } })).toBe(false);
  });

  it("returns false for non-object / malformed input", () => {
    expect(isGatewayBlipTurnError(null)).toBe(false);
    expect(isGatewayBlipTurnError("invalid_model_request")).toBe(false);
    expect(isGatewayBlipTurnError([])).toBe(false);
    expect(isGatewayBlipTurnError({})).toBe(false);
  });
});

describe("isBackendLostError", () => {
  it("matches the observed shutdown-race payload (two-level cause nesting)", () => {
    // 2026-09-11 incident: prompt accepted during the agent's own shutdown.
    const err = {
      name: "Error",
      code: "UNKNOWN_ERROR",
      message: "Turn execution failed",
      cause: {
        name: "Error",
        code: "ERR_INVALID_STATE",
        message: "database is not open",
      },
    };
    expect(isBackendLostError(err)).toBe(true);
  });

  it("matches ERR_INVALID_STATE by code alone", () => {
    expect(isBackendLostError({ cause: { code: "ERR_INVALID_STATE" } })).toBe(true);
  });

  it("matches backend-lost message fragments", () => {
    expect(isBackendLostError({ cause: { message: "database is not open" } })).toBe(true);
    expect(isBackendLostError({ cause: { message: "Session is not active" } })).toBe(true);
    expect(isBackendLostError({ cause: { message: "write EPIPE: broken pipe" } })).toBe(true);
  });

  it("matches at the inner cause.cause level", () => {
    expect(
      isBackendLostError({
        cause: { code: "UNKNOWN_ERROR", cause: { message: "database is not open" } },
      }),
    ).toBe(true);
  });

  it("falls back to the top-level error when no cause is present", () => {
    expect(isBackendLostError({ message: "reader dead" })).toBe(true);
  });

  it("does not match transient or plain wrapper errors", () => {
    expect(isBackendLostError({ cause: { code: "model_request_failed" } })).toBe(false);
    expect(isBackendLostError({ code: "UNKNOWN_ERROR", message: "Turn execution failed" })).toBe(
      false,
    );
    expect(isBackendLostError({ cause: { code: "INVALID_PARAMS", message: "bad input" } })).toBe(
      false,
    );
  });

  it("returns false for non-object / malformed input", () => {
    expect(isBackendLostError(null)).toBe(false);
    expect(isBackendLostError("database is not open")).toBe(false);
    expect(isBackendLostError([])).toBe(false);
    expect(isBackendLostError({})).toBe(false);
  });
});
