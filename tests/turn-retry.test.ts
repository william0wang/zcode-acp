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

  it("does not retry when the backend explicitly marks a rate limit non-retryable", () => {
    expect(
      isTransientTurnError({
        cause: { code: "rate_limit", context: { retryable: false } },
      }),
    ).toBe(false);
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
});
