/**
 * Tests for the Opencode Go usage feature: dashboard HTML parsing (both field
 * orderings, missing windows, parser rot), the HTTP client (cookie/UA
 * headers), query orchestration (env-driven credentials, cache TTL, error
 * degradation), duration formatting, and section rendering.
 *
 * Parser/formatter tests are pure-function. The client test spies on global
 * fetch. The orchestration test mocks the client module so we control the
 * (finalUrl, html) pair deterministically — undici's Response does not honour
 * the `url` init option, so mocking at the client boundary is cleaner than
 * constructing real Response objects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import process from "node:process";

// Mock the client so queryGoUsage orchestration can inject a deterministic
// (status, text, finalUrl) without depending on undici's Response.url.
vi.mock("../src/quota/opencode-go/client.js", () => ({
  fetchGoDashboard: vi.fn(),
  dashboardUrl: (id: string) => `https://opencode.ai/workspace/${id}/go`,
}));

// Compute the config path here (not via import) so the fs mock factory below
// can reference it without worrying about vitest mock-hoist ordering. This
// must match src/quota/opencode-go/config.ts::CONFIG_PATH exactly.
const CONFIG_PATH_MOCK = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".pi",
  "agent",
  "opencode-go.json",
);

// Mock node:fs so readConfigFile tests can supply a fake config file without
// touching the real ~/.pi/agent/opencode-go.json (which may exist on the dev
// machine). The config path is fully intercepted: a hit returns the mock
// content, a miss throws ENOENT — it never falls through to the real fs, so
// tests are hermetic regardless of the host environment. Other paths fall
// through unchanged.
const mockFiles = new Map<string, string>();
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string, ...rest: unknown[]) => {
      if (p === CONFIG_PATH_MOCK) {
        if (mockFiles.has(p)) return mockFiles.get(p)!;
        const err = new Error(`ENOENT, no such file or directory '${p}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return actual.readFileSync(p, ...(rest as [string]));
    },
  };
});

import { formatDuration, formatGoSection } from "../src/quota/opencode-go/format.js";
import { looksLikeDashboard, parseGoDashboard } from "../src/quota/opencode-go/parse.js";
import type { GoQueryResult } from "../src/quota/opencode-go/types.js";
import { clearCache, setClock } from "../src/quota/opencode-go/cache.js";
import { fetchGoDashboard } from "../src/quota/opencode-go/client.js";
import { CONFIG_PATH, readConfigFile } from "../src/quota/opencode-go/config.js";
import { queryGoUsage } from "../src/quota/opencode-go/index.js";

// `fetchGoDashboard` is mocked (see vi.mock above) for orchestration tests.
// The real HTTP-client header test lives in tests/combined.test.ts, which does
// not mock the client module and so can spy on global fetch directly.
void fetchGoDashboard;

// --- parser --------------------------------------------------------------

/**
 * Build a synthetic dashboard `<script>`. The SSR payload uses **unquoted** JS
 * identifiers (not JSON), so we hand-assemble the object literal — JSON.stringify
 * would add quotes around keys and fail to match the extraction regex.
 */
function dashboardHtml(windows: {
  rolling?: { usagePercent: number; resetInSec: number };
  weekly?: { usagePercent: number; resetInSec: number };
  monthly?: { usagePercent: number; resetInSec: number };
}): string {
  const lit = (w: { usagePercent: number; resetInSec: number }) =>
    `{usagePercent:${w.usagePercent},resetInSec:${w.resetInSec}}`;
  const parts: string[] = [];
  if (windows.rolling) parts.push(`rollingUsage:$R[2]=${lit(windows.rolling)}`);
  if (windows.weekly) parts.push(`weeklyUsage:$R[3]=${lit(windows.weekly)}`);
  if (windows.monthly) parts.push(`monthlyUsage:$R[4]=${lit(windows.monthly)}`);
  return `<html><script>window.__SSR={${parts.join(",")}}</script></html>`;
}

describe("parseGoDashboard", () => {
  it("extracts all three windows (usagePercent-first ordering)", () => {
    const html = dashboardHtml({
      rolling: { usagePercent: 42, resetInSec: 3600 },
      weekly: { usagePercent: 17, resetInSec: 604800 },
      monthly: { usagePercent: 8, resetInSec: 2592000 },
    });
    const r = parseGoDashboard(html);
    expect(r.rolling).toEqual({ usagePercent: 42, resetInSec: 3600 });
    expect(r.weekly).toEqual({ usagePercent: 17, resetInSec: 604800 });
    expect(r.monthly).toEqual({ usagePercent: 8, resetInSec: 2592000 });
    expect(r.parserOutdated).toBe(false);
  });

  it("extracts windows when fields are in resetInSec-first order", () => {
    // Solid may emit fields in either order; the regexes cover both.
    const html =
      `<html><script>` +
      `rollingUsage:$R[2]={resetInSec:7200,usagePercent:50}` +
      `</script></html>`;
    const r = parseGoDashboard(html);
    expect(r.rolling).toEqual({ usagePercent: 50, resetInSec: 7200 });
  });

  it("returns nulls for absent windows (no parserOutdated when nothing looks like dashboard)", () => {
    const r = parseGoDashboard("<html>nothing here</html>");
    expect(r.rolling).toBeNull();
    expect(r.weekly).toBeNull();
    expect(r.monthly).toBeNull();
    expect(r.parserOutdated).toBe(false);
  });

  it("flags parserOutdated when HTML looks like a dashboard but no window matched", () => {
    // The variable names are present but the object shape is unrecognised —
    // signals the SolidJS hydration format has drifted.
    const html = `<script>rollingUsage:$R[2]={someUnknownField:42}</script>`;
    const r = parseGoDashboard(html);
    expect(r.rolling).toBeNull();
    expect(r.parserOutdated).toBe(true);
  });

  it("looksLikeDashboard detects the window variable names", () => {
    expect(looksLikeDashboard("rollingUsage:$R[2]={}")).toBe(true);
    expect(looksLikeDashboard("weeklyUsage:$R[3]={}")).toBe(true);
    expect(looksLikeDashboard("monthlyUsage:$R[4]={}")).toBe(true);
    expect(looksLikeDashboard("<html>login page</html>")).toBe(false);
  });
});

// --- formatDuration ------------------------------------------------------

describe("formatDuration", () => {
  it("< 60s → <1m", () => {
    expect(formatDuration(0)).toBe("<1m");
    expect(formatDuration(30)).toBe("<1m");
    expect(formatDuration(59.9)).toBe("<1m");
  });

  it("minutes only", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(45 * 60)).toBe("45m");
  });

  it("hours + minutes", () => {
    expect(formatDuration(2 * 3600 + 30 * 60)).toBe("2h 30m");
  });

  it("days + hours", () => {
    expect(formatDuration(6 * 86_400 + 8 * 3600)).toBe("6d 8h");
  });

  it("non-finite → <1m (defensive)", () => {
    expect(formatDuration(Number.NaN)).toBe("<1m");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("<1m");
  });
});

// --- formatGoSection -----------------------------------------------------

describe("formatGoSection", () => {
  const success: GoQueryResult = {
    kind: "success",
    rolling: { usagePercent: 42, resetInSec: 3600 },
    weekly: { usagePercent: 17, resetInSec: 604800 },
    monthly: { usagePercent: 8, resetInSec: 2592000 },
    fetchedAt: 1000,
  };

  it("renders all three windows when requested", () => {
    const sec = formatGoSection(success, ["rolling", "weekly", "monthly"], 1000);
    expect(sec.header).toBe("Opencode Go");
    expect(sec.body).toHaveLength(3);
    expect(sec.body[0]).toContain("5h");
    expect(sec.body[0]).toContain("42%");
    // Reset time renders as an absolute MM-DD HH:MM stamp (same layout as GLM).
    expect(sec.body[0]).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    expect(sec.body[1]).toContain("Week");
    expect(sec.body[1]).toContain("17%");
    expect(sec.body[2]).toContain("Month");
    expect(sec.body[2]).toContain("8%");
  });

  it("renders only requested windows (rolling + weekly)", () => {
    const sec = formatGoSection(success, ["rolling", "weekly"], 1000);
    expect(sec.body).toHaveLength(2);
    expect(sec.body.find((l) => l.includes("Month"))).toBeUndefined();
  });

  it("shows the reset time advancing as elapsed time grows (live ticker)", () => {
    // Reset stamp = fetchedAt + remainingSec*1000. As `now` advances, remaining
    // shrinks, so the stamp moves earlier. The rolling window (resetInSec=3600)
    // at now=1000  → resets at fetchedAt+3600s; at now=31000 → fetchedAt+3570s.
    const early = formatGoSection(success, ["rolling"], 1000).body[0]!;
    const later = formatGoSection(success, ["rolling"], 31_000).body[0]!;
    // Both must be valid MM-DD HH:MM stamps.
    expect(early).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    expect(later).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    // The later fetch's reset is ~30s sooner (3570s vs 3600s of remaining).
    expect(later).not.toBe(early);
  });

  it("clamps the remaining time at 0 (reset stamp stays at fetchedAt, never negative)", () => {
    // When elapsed far exceeds resetInSec, remaining is clamped to 0 → the
    // reset stamp equals fetchedAt (1ms into epoch). It must not throw and must
    // still render a valid-looking stamp or the "<1m" fallback.
    const sec = formatGoSection(success, ["rolling"], 1000 + 10_000_000);
    expect(sec.body[0]).toMatch(/(\d{2}-\d{2} \d{2}:\d{2}|<1m)/);
  });

  it("renders '(no data)' when a requested window is null", () => {
    const noMonthly: GoQueryResult = { ...success, monthly: null };
    const sec = formatGoSection(noMonthly, ["rolling", "weekly", "monthly"], 1000);
    expect(sec.body.find((l) => l.includes("Month"))?.includes("(no data)")).toBe(true);
  });

  it("non-success kinds render a single explanation line", () => {
    expect(formatGoSection({ kind: "not_configured" }, ["rolling"]).body[0]).toMatch(
      /not configured/i,
    );
    expect(formatGoSection({ kind: "auth_error" }, ["rolling"]).body[0]).toMatch(/auth expired/i);
    expect(formatGoSection({ kind: "unavailable" }, ["rolling"]).body[0]).toMatch(/unavailable/i);
  });

  describe("color mode", () => {
    const ESC = String.fromCharCode(27);
    const stripAnsi = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

    it("emits ANSI escapes and overlays NN% inside the bar; reset stays on the right", () => {
      const sec = formatGoSection(success, ["rolling", "weekly"], 1000, true);
      const rolling = sec.body[0]!;
      expect(rolling).toContain(`${ESC}[48;2;`); // bg color
      expect(rolling).toContain(`${ESC}[0m`); // reset
      // Overlay percent is inside the bar; visible right margin keeps reset only.
      const visible = stripAnsi(rolling);
      expect(visible).toContain("42%");
      expect(visible).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/); // reset stamp
      // Color mode renders the bar with ANSI bg on space cells, NOT with the
      // plain █/░ block characters — so they must be absent.
      expect(visible).not.toContain("█");
      expect(visible).not.toContain("░");
    });

    it("color=false keeps the classic plain layout (no ANSI)", () => {
      const sec = formatGoSection(success, ["rolling"], 1000, false);
      const line = sec.body[0]!;
      expect(line).not.toContain("\x1b[");
      expect(line).toMatch(/5h\s+█+░*\s+42%/);
    });
  });
});

// --- queryGoUsage orchestration ------------------------------------------

// The client module is mocked at the top of this file. We drive queryGoUsage
// by controlling fetchGoDashboard's return/reject per-test, which lets us feed
// a deterministic finalUrl (the basis for redirect-to-login detection).
const mockedFetch = vi.mocked(fetchGoDashboard);

describe("queryGoUsage orchestration", () => {
  beforeEach(() => {
    clearCache();
    setClock(() => 5000);
    mockedFetch.mockReset();
    mockFiles.clear();
  });
  afterEach(() => {
    clearCache();
    setClock(undefined);
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    mockFiles.clear();
  });

  it("returns not_configured when env vars are absent", async () => {
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    expect((await queryGoUsage()).kind).toBe("not_configured");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("returns not_configured when workspaceId format is invalid", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "bad-id";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**x";
    expect((await queryGoUsage()).kind).toBe("not_configured");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("returns not_configured when cookie prefix is wrong", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "not-the-right-prefix";
    expect((await queryGoUsage()).kind).toBe("not_configured");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("parses a successful dashboard response", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**secret";
    mockedFetch.mockResolvedValue({
      status: 200,
      text: dashboardHtml({
        rolling: { usagePercent: 42, resetInSec: 3600 },
        weekly: { usagePercent: 17, resetInSec: 604800 },
        monthly: { usagePercent: 8, resetInSec: 2592000 },
      }),
      finalUrl: "https://opencode.ai/workspace/wrk_abc/go",
    });
    const result = await queryGoUsage();
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.rolling.usagePercent).toBe(42);
    expect(result.weekly.usagePercent).toBe(17);
    expect(result.monthly?.usagePercent).toBe(8);
  });

  it("detects redirect-to-login as auth_error (final URL changed)", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**expired";
    // opencode.ai bounces expired cookies to /login with a 200.
    mockedFetch.mockResolvedValue({
      status: 200,
      text: "<html>please log in</html>",
      finalUrl: "https://opencode.ai/login",
    });
    expect((await queryGoUsage()).kind).toBe("auth_error");
  });

  it("degrades to unavailable on network failure", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**secret";
    mockedFetch.mockRejectedValue(new Error("network down"));
    expect((await queryGoUsage()).kind).toBe("unavailable");
  });

  it("degrades to unavailable on parser rot (dashboard but no windows)", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**secret";
    mockedFetch.mockResolvedValue({
      status: 200,
      text: "<script>rollingUsage:$R[2]={unknown:1}</script>",
      finalUrl: "https://opencode.ai/workspace/wrk_abc/go",
    });
    expect((await queryGoUsage()).kind).toBe("unavailable");
  });

  it("serves a cached result within the TTL window", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**secret";
    mockedFetch.mockResolvedValue({
      status: 200,
      text: dashboardHtml({ rolling: { usagePercent: 1, resetInSec: 1 } }),
      finalUrl: "https://opencode.ai/workspace/wrk_abc/go",
    });
    await queryGoUsage();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    setClock(() => 5000 + 9_000); // 9s later — still fresh
    await queryGoUsage();
    expect(mockedFetch).toHaveBeenCalledTimes(1); // cached — no new fetch
  });

  it("re-fetches once the TTL expires", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**secret";
    mockedFetch.mockResolvedValue({
      status: 200,
      text: dashboardHtml({ rolling: { usagePercent: 1, resetInSec: 1 } }),
      finalUrl: "https://opencode.ai/workspace/wrk_abc/go",
    });
    await queryGoUsage();
    setClock(() => 5000 + 10_001); // expired
    await queryGoUsage();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});

// --- readConfigFile (mocked fs) ------------------------------------------

describe("readConfigFile", () => {
  afterEach(() => mockFiles.clear());

  it("parses a valid {workspaceId, authCookie} JSON file", () => {
    mockFiles.set(CONFIG_PATH, JSON.stringify({ workspaceId: "wrk_x", authCookie: "Fe26.2**y" }));
    expect(readConfigFile()).toEqual({ workspaceId: "wrk_x", authCookie: "Fe26.2**y" });
  });

  it("returns empty object when the file is missing (ENOENT — silent)", () => {
    mockFiles.clear();
    expect(readConfigFile()).toEqual({});
  });

  it("returns empty object on invalid JSON (logged, non-fatal)", () => {
    mockFiles.set(CONFIG_PATH, "{not valid json");
    expect(readConfigFile()).toEqual({});
  });

  it("ignores non-string / unknown fields", () => {
    mockFiles.set(
      CONFIG_PATH,
      JSON.stringify({ workspaceId: "wrk_x", authCookie: 123, extra: "ignored" }),
    );
    // authCookie is a number → treated as absent.
    expect(readConfigFile()).toEqual({ workspaceId: "wrk_x", authCookie: undefined });
  });

  it("rejects a top-level non-object (array / primitive)", () => {
    mockFiles.set(CONFIG_PATH, JSON.stringify(["nope"]));
    expect(readConfigFile()).toEqual({});
    mockFiles.set(CONFIG_PATH, JSON.stringify("nope"));
    expect(readConfigFile()).toEqual({});
  });
});

// --- queryGoUsage credential merging (env + config file) -----------------

describe("queryGoUsage credential merging", () => {
  beforeEach(() => {
    clearCache();
    setClock(() => 5000);
    mockedFetch.mockReset();
    mockFiles.clear();
    // Dynamic mock: finalUrl must contain the workspaceId passed in, or the
    // orchestrator's redirect-to-login check will misfire.
    mockedFetch.mockImplementation(async (workspaceId: string) => ({
      status: 200,
      text: dashboardHtml({ rolling: { usagePercent: 1, resetInSec: 1 } }),
      finalUrl: `https://opencode.ai/workspace/${workspaceId}/go`,
    }));
  });
  afterEach(() => {
    clearCache();
    setClock(undefined);
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    mockFiles.clear();
  });

  it("uses the config file when env is absent", async () => {
    mockFiles.set(
      CONFIG_PATH,
      JSON.stringify({ workspaceId: "wrk_FILE0", authCookie: "Fe26.2**file" }),
    );
    const result = await queryGoUsage();
    expect(result.kind).toBe("success");
    // The fetch is called with the workspaceId from the file.
    expect(mockedFetch).toHaveBeenCalledWith("wrk_FILE0", "Fe26.2**file");
  });

  it("env overrides the file field-by-field", async () => {
    mockFiles.set(
      CONFIG_PATH,
      JSON.stringify({ workspaceId: "wrk_FILE0", authCookie: "Fe26.2**file" }),
    );
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_ENV0"; // override only workspaceId
    const result = await queryGoUsage();
    expect(result.kind).toBe("success");
    expect(mockedFetch).toHaveBeenCalledWith("wrk_ENV0", "Fe26.2**file");
  });

  it("env fills a field the file lacks", async () => {
    mockFiles.set(CONFIG_PATH, JSON.stringify({ workspaceId: "wrk_FILE0" })); // no cookie
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**env"; // provide the cookie
    const result = await queryGoUsage();
    expect(result.kind).toBe("success");
    expect(mockedFetch).toHaveBeenCalledWith("wrk_FILE0", "Fe26.2**env");
  });

  it("returns not_configured when neither env nor file supplies both fields", async () => {
    // File has only workspaceId; no env. Both fields incomplete.
    mockFiles.set(CONFIG_PATH, JSON.stringify({ workspaceId: "wrk_FILE0" }));
    expect((await queryGoUsage()).kind).toBe("not_configured");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("returns not_configured when the file is corrupt and env is absent", async () => {
    mockFiles.set(CONFIG_PATH, "{broken");
    expect((await queryGoUsage()).kind).toBe("not_configured");
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
