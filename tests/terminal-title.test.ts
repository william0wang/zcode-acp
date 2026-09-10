/**
 * Terminal tab title (OSC 0) unit tests: sanitization, fallback chain,
 * martty gating, and the vitest tty guard.
 */

import { describe, expect, it } from "vitest";

import {
  refreshTerminalTabTitle,
  sanitizeTitle,
  sessionTabTitle,
  ttyTitleIo,
} from "../src/terminal-title.js";
import type { ZcodeAcpServer } from "../src/server.js";

function makeServer(opts: { martty?: boolean; title?: string; cwd?: string }): ZcodeAcpServer {
  return {
    marttyClientSeen: opts.martty ?? false,
    sessionTitles: new Map(opts.title ? [["s1", opts.title]] : []),
    sessionCwds: new Map(opts.cwd ? [["s1", opts.cwd]] : []),
  } as unknown as ZcodeAcpServer;
}

function captureIo(): { io: { write(s: string): boolean }; seen(): string[] } {
  const out: string[] = [];
  return { io: { write: (s) => (out.push(s), true) }, seen: () => out };
}

describe("sanitizeTitle", () => {
  it("strips control chars (an embedded ESC/BEL must not inject escapes)", () => {
    expect(sanitizeTitle("a\x1b]0;evil\x07b")).toBe("a ]0;evil b");
    expect(sanitizeTitle("a\u0000b\u007fc\u009bd")).toBe("a b c d");
  });
  it("collapses whitespace and trims", () => {
    expect(sanitizeTitle("  fix   the \t login\n bug  ")).toBe("fix the login bug");
  });
  it("caps at 100 chars with an ellipsis", () => {
    const long = "x".repeat(150);
    const out = sanitizeTitle(long);
    expect(out.length).toBe(100);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("sessionTabTitle", () => {
  it("combines project dir · conversation title (title sanitized)", () => {
    expect(sessionTabTitle("Fix login", "/any/repo")).toBe("repo · Fix login");
    expect(sessionTabTitle("Fix   login\n", "/any/repo")).toBe("repo · Fix login");
  });
  it("blank title falls back to the project dir name (hub parity)", () => {
    expect(sessionTabTitle(undefined, "/Users/w/dev/zcode-acp-server")).toBe("zcode-acp-server");
    expect(sessionTabTitle("   ", "/Users/w/dev/zcode-acp-server")).toBe("zcode-acp-server");
  });
  it("no cwd at all → zcode anchor", () => {
    expect(sessionTabTitle(undefined, undefined)).toBe("zcode");
    expect(sessionTabTitle("Fix login", undefined)).toBe("zcode · Fix login");
  });
  it("sanitizes the project segment too (client-controlled cwd, OSC injection)", () => {
    // A remote client's session/new cwd can carry a dirname with ESC/BEL —
    // the basename must not flow raw into the OSC payload.
    expect(sessionTabTitle(undefined, "/dev/na\x1b]52;paste;evil\x07sty")).toBe(
      "na ]52;paste;evil sty",
    );
  });
  it("caps a long project dir at 24 chars (ellipsis), topic untouched", () => {
    const out = sessionTabTitle("Fix login", "/dev/" + "p".repeat(60));
    expect(out.length).toBeLessThanOrEqual(24 + 3 + "Fix login".length);
    expect(out.startsWith("p".repeat(23) + "… · ")).toBe(true);
  });
  it("trims the TOPIC (not the project) when the total exceeds 100", () => {
    const out = sessionTabTitle("t".repeat(150), "/dev/repo");
    expect(out.length).toBe(100);
    expect(out.startsWith("repo · ")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("ttyTitleIo", () => {
  it("is a hard no-op under vitest (test runs share the developer's tty)", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(ttyTitleIo.write("\x1b]0;x\x07")).toBe(false);
  });
});

describe("refreshTerminalTabTitle", () => {
  it("never writes for a non-martty bridge (Zed can have a controlling tty)", () => {
    const cap = captureIo();
    const wrote = refreshTerminalTabTitle(makeServer({ title: "T", cwd: "/r" }), "s1", cap.io);
    expect(wrote).toBe(false);
    expect(cap.seen()).toEqual([]);
  });

  it("writes OSC 0 with the combined project · title for a martty bridge", () => {
    const cap = captureIo();
    const wrote = refreshTerminalTabTitle(
      makeServer({ martty: true, title: "Fix the login bug", cwd: "/r/repo" }),
      "s1",
      cap.io,
    );
    expect(wrote).toBe(true);
    expect(cap.seen()).toEqual(["\x1b]0;repo · Fix the login bug\x07"]);
  });

  it("falls back to the project dir name before any title exists", () => {
    const cap = captureIo();
    refreshTerminalTabTitle(makeServer({ martty: true, cwd: "/Users/w/dev/repo" }), "s1", cap.io);
    expect(cap.seen()).toEqual(["\x1b]0;repo\x07"]);
  });
});
