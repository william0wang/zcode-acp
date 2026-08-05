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

  it("defaults provider to 'all' when no positional arg given", () => {
    expect(parseArgs([]).provider).toBe("all");
    expect(parseArgs(["-w"]).provider).toBe("all");
  });

  it("'glm' / 'go' positional → the matching provider", () => {
    expect(parseArgs(["glm"]).provider).toBe("glm");
    expect(parseArgs(["go"]).provider).toBe("go");
  });

  it("provider combines with flags in any order", () => {
    expect(parseArgs(["go", "-w"]).provider).toBe("go");
    expect(parseArgs(["-w", "glm"]).provider).toBe("glm");
    expect(parseArgs(["glm", "-d", "-i", "60"]).provider).toBe("glm");
  });

  it("only the first provider token is honored", () => {
    expect(parseArgs(["glm", "go"]).provider).toBe("glm");
  });

  it("non-provider positional tokens are ignored (falls back to all)", () => {
    expect(parseArgs(["bogus"]).provider).toBe("all");
    expect(parseArgs(["-w", "unknown"]).provider).toBe("all");
  });
});

describe("parseArgs — plain flag", () => {
  it("empty argv → plain defaults to false", () => {
    expect(parseArgs([]).plain).toBe(false);
  });

  it("-p / --plain set plain to true", () => {
    expect(parseArgs(["-p"]).plain).toBe(true);
    expect(parseArgs(["--plain"]).plain).toBe(true);
  });

  it("plain combines with provider and watch flags in any order", () => {
    expect(parseArgs(["--plain", "go"]).plain).toBe(true);
    expect(parseArgs(["go", "--plain"]).plain).toBe(true);
    expect(parseArgs(["-w", "-p"]).plain).toBe(true);
    expect(parseArgs(["-p", "-w", "glm"]).plain).toBe(true);
  });

  it("plain is independent of detail (-d)", () => {
    const opts = parseArgs(["-p", "-d"]);
    expect(opts.plain).toBe(true);
    expect(opts.detail).toBe(true);
  });
});
