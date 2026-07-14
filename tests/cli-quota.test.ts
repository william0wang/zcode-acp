/**
 * Tests for the `zcode-quota` standalone CLI: argv parsing and interval
 * clamping. The watch loop itself is an I/O loop (sleep + redraw) and is left
 * to manual verification; only the pure helpers are unit-tested.
 *
 * The bin module guards its top-level `main()` behind an `invokedDirectly`
 * check (entry path ends with `bin/quota.js`), so importing it here does NOT
 * fire a real query.
 */

import { describe, expect, it } from "vitest";

import { parseArgs, resolveIntervalMs } from "../src/bin/quota.js";

describe("resolveIntervalMs", () => {
  it("defaults to 30s when no interval given", () => {
    expect(resolveIntervalMs(undefined)).toEqual({ ms: 30_000, clamped: false });
  });

  it("passes through values >= 10s unchanged", () => {
    expect(resolveIntervalMs(10)).toEqual({ ms: 10_000, clamped: false });
    expect(resolveIntervalMs(45)).toEqual({ ms: 45_000, clamped: false });
    expect(resolveIntervalMs(120)).toEqual({ ms: 120_000, clamped: false });
  });

  it("clamps values below 10s to the floor and flags them", () => {
    expect(resolveIntervalMs(5)).toEqual({ ms: 10_000, clamped: true });
    expect(resolveIntervalMs(1)).toEqual({ ms: 10_000, clamped: true });
    expect(resolveIntervalMs(0)).toEqual({ ms: 10_000, clamped: true });
  });

  it("does NOT flag the default 30s as clamped", () => {
    // Important: defaulting to 30s is not a "clamp" — the user supplied nothing.
    expect(resolveIntervalMs(undefined).clamped).toBe(false);
  });
});

describe("parseArgs", () => {
  it("empty argv → one-shot mode with default interval", () => {
    const opts = parseArgs([]);
    expect(opts.watch).toBe(false);
    expect(opts.help).toBe(false);
    expect(opts.intervalMs).toBe(30_000);
    expect(opts.intervalClamped).toBe(false);
  });

  it("empty argv → detail defaults to false (no MCP sub-lines)", () => {
    expect(parseArgs([]).detail).toBe(false);
    expect(parseArgs(["-w"]).detail).toBe(false);
  });

  it("-w enables watch", () => {
    expect(parseArgs(["-w"]).watch).toBe(true);
    expect(parseArgs(["--watch"]).watch).toBe(true);
  });

  it("-h / --help enables help", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("-d / --detail enables MCP detail sub-lines", () => {
    expect(parseArgs(["-d"]).detail).toBe(true);
    expect(parseArgs(["--detail"]).detail).toBe(true);
  });

  it("-i <n> sets the interval (space form)", () => {
    expect(parseArgs(["-w", "-i", "60"]).intervalMs).toBe(60_000);
    expect(parseArgs(["--watch", "--interval", "15"]).intervalMs).toBe(15_000);
  });

  it("-i<n> attached form", () => {
    expect(parseArgs(["-i20"]).intervalMs).toBe(20_000);
  });

  it("--interval=<n> attached form", () => {
    expect(parseArgs(["--interval=45"]).intervalMs).toBe(45_000);
  });

  it("clamps a below-floor interval and sets intervalClamped", () => {
    const opts = parseArgs(["-w", "-i", "3"]);
    expect(opts.intervalMs).toBe(10_000);
    expect(opts.intervalClamped).toBe(true);
  });

  it("does not flag clamped when interval is omitted (default 30s)", () => {
    expect(parseArgs(["-w"]).intervalClamped).toBe(false);
  });

  it("ignores unknown flags", () => {
    const opts = parseArgs(["--bogus", "-w", "--unknown", "x"]);
    expect(opts.watch).toBe(true);
    expect(opts.intervalMs).toBe(30_000);
  });

  it("non-numeric interval value is ignored (falls back to default)", () => {
    const opts = parseArgs(["-i", "abc"]);
    expect(opts.intervalMs).toBe(30_000);
    expect(opts.intervalClamped).toBe(false);
  });
});
