/**
 * Tests for the logging utilities: debug-gated verbose log and warn-always.
 *
 * Default behavior is QUIET: verbose `log()` is suppressed unless
 * `ZCODE_ACP_DEBUG=1` is set; `warn()` always emits (perceivable failures).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { log, warn } from "../src/utils.js";

describe("logging", () => {
  const prevDebug = process.env.ZCODE_ACP_DEBUG;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    spy.mockRestore();
    if (prevDebug === undefined) delete process.env.ZCODE_ACP_DEBUG;
    else process.env.ZCODE_ACP_DEBUG = prevDebug;
  });

  it("log() is silenced by default (no ZCODE_ACP_DEBUG)", () => {
    delete process.env.ZCODE_ACP_DEBUG;
    log("should be silenced");
    expect(spy).not.toHaveBeenCalled();
  });

  it("log() writes to stderr with the [zcode-acp] prefix when ZCODE_ACP_DEBUG=1", () => {
    process.env.ZCODE_ACP_DEBUG = "1";
    log("hello");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("[zcode-acp] hello\n");
  });

  it("warn() always writes, even without ZCODE_ACP_DEBUG", () => {
    delete process.env.ZCODE_ACP_DEBUG;
    warn("visible warning");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("[zcode-acp] visible warning\n");
  });

  it("ZCODE_ACP_DEBUG=0 keeps log() silenced (only '1' enables verbose)", () => {
    process.env.ZCODE_ACP_DEBUG = "0";
    log("still silenced");
    expect(spy).not.toHaveBeenCalled();
  });
});
