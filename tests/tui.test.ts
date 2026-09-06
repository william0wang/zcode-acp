/**
 * Tests for the Martty TUI launcher (src/tui.ts).
 *
 * The launcher is a thin spawn wrapper; the pure pieces (martty resolution,
 * agent argv) are what can break silently, so they are pinned here. The full
 * spawn path is exercised by `pnpm smoke:tui` (martty --check-runtime).
 */

import { describe, expect, it } from "vitest";

import { agentEntryJs, buildTuiArgs, resolveMarttyJs } from "../src/tui.js";

describe("martty launcher", () => {
  it("resolves the bundled martty wrapper (regular dependency)", () => {
    expect(resolveMarttyJs()).toMatch(/martty[/\\]bin[/\\]martty\.js$/);
  });

  it("wires the bridge as the agent over the absolute node binary", () => {
    // A single --agent + one --agent-arg pair: martty treats each --agent-arg
    // as one argv token, so the agent command is exactly `node <dist/index.js>`
    // — no PATH lookup, no shell, same on Windows.
    expect(buildTuiArgs("/x/dist/index.js")).toEqual([
      "--agent",
      process.execPath,
      "--agent-arg",
      "/x/dist/index.js",
    ]);
  });

  it("points the agent at this package's compiled entry", () => {
    expect(agentEntryJs()).toMatch(/index\.js$/);
  });
});
