/**
 * Tests for the Unified CLI dispatcher (src/cli.ts).
 *
 * The module guards its top-level `main()` behind an `invokedDirectly` check
 * (entry path matches cli.js/cli.ts or a bin symlink name), so importing it
 * here does NOT start a subcommand. resolveInvocation is pure and exported
 * for exactly this purpose.
 */

import { describe, expect, it } from "vitest";

import { resolveInvocation } from "../src/cli.js";

describe("resolveInvocation", () => {
  it("routes the legacy zcode-acp-server bin alias straight to server", () => {
    // Editors spawn `zcode-acp-server` with no subcommand; the symlink lands
    // here with argv[1] keeping the alias name.
    expect(resolveInvocation("zcode-acp-server", [])).toEqual({ kind: "server" });
    // Even if extra args sneak in, the alias is not a subcommand parser.
    expect(resolveInvocation("zcode-acp-server", ["--anything"])).toEqual({ kind: "server" });
  });

  it("maps each subcommand, passing through trailing args", () => {
    expect(resolveInvocation("cli.js", ["server"])).toEqual({ kind: "server" });
    expect(resolveInvocation("cli.js", ["hub"])).toEqual({ kind: "hub" });
    expect(resolveInvocation("cli.js", ["quota"])).toEqual({ kind: "quota", args: [] });
    expect(resolveInvocation("cli.js", ["quota", "-w", "glm"])).toEqual({
      kind: "quota",
      args: ["-w", "glm"],
    });
  });

  it("treats bare invocation as the interactive REPL and help flags as help", () => {
    // Bare is NOT explicit: without a TTY it falls back to the stdio server
    // (Windows npm shims land there with the bin name lost from argv).
    expect(resolveInvocation("cli.js", [])).toEqual({ kind: "repl", explicit: false });
    expect(resolveInvocation("cli.js", ["repl"])).toEqual({ kind: "repl", explicit: true });
    expect(resolveInvocation("cli.js", ["tui"])).toEqual({ kind: "repl", explicit: true });
    expect(resolveInvocation("cli.js", ["-h"])).toEqual({ kind: "help" });
    expect(resolveInvocation("cli.js", ["--help"])).toEqual({ kind: "help" });
    expect(resolveInvocation("cli.js", ["help"])).toEqual({ kind: "help" });
  });

  it("reports unknown subcommands with the offending token", () => {
    expect(resolveInvocation("cli.js", ["serve"])).toEqual({ kind: "unknown", sub: "serve" });
    // A bare prompt string is not a subcommand — it does not start a turn.
    expect(resolveInvocation("cli.js", ["hello world"])).toEqual({
      kind: "unknown",
      sub: "hello world",
    });
  });
});
