/**
 * neutralizeSlashText tests — the `/`-leading prompt wire-text path.
 *
 * Rule under test: IDENTITY on 0.16.9. The open-sourced runtime resolves only
 * /compact, /fork, /rewind natively (turn.ts:105-106,240-267) and passes every
 * other `/name` through as a normal prompt (custom-command-prompt.ts:31-44) —
 * there is no unknown-command hard-fail to defend against, so the old
 * zero-width-space injection only corrupted session history and model input.
 * These tests are the regression guard: any reintroduced rewriting fails here.
 */

import { describe, expect, it } from "vitest";

import { neutralizeSlashText } from "../src/handlers/slash.js";

describe("neutralizeSlashText", () => {
  it("passes non-slash prompts through unchanged", () => {
    expect(neutralizeSlashText("hello world")).toBe("hello world");
    expect(neutralizeSlashText("look at Users/foo")).toBe("look at Users/foo");
  });

  it("passes known commands through unchanged", () => {
    expect(neutralizeSlashText("/compact now")).toBe("/compact now");
    expect(neutralizeSlashText("/model GLM-5.3")).toBe("/model GLM-5.3");
    expect(neutralizeSlashText("/$tdd fix the bug")).toBe("/$tdd fix the bug");
  });

  it("passes unknown commands and pasted paths through VERBATIM (no ZWSP)", () => {
    // The backend itself passes unresolvable /x to the model as a normal
    // prompt (custom-command-prompt.ts:31-44) — the wire text must stay clean.
    expect(neutralizeSlashText("/notacommand")).toBe("/notacommand");
    expect(neutralizeSlashText("/Users/william/Downloads/mitm/fashion")).toBe(
      "/Users/william/Downloads/mitm/fashion",
    );
    expect(neutralizeSlashText("/tmp")).toBe("/tmp");
    // Leading whitespace survives too — the backend trims it itself.
    expect(neutralizeSlashText("  /Users/william/project")).toBe("  /Users/william/project");
  });

  it("never injects a zero-width space", () => {
    for (const text of ["/x", "  /y z", "/compact", "plain"]) {
      expect(neutralizeSlashText(text)).not.toContain("\u200B");
    }
  });
});
