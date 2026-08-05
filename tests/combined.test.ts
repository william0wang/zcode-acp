/**
 * Tests for the combined multi-provider quota view: the merging logic that
 * renders GLM + Opencode Go side by side in one card.
 *
 * Focuses on the layout decisions (when to show/skip the Go section, banner &
 * divider in `all` mode, single-provider shapes) and on the orchestration's
 * parallel-query + skip-when-single-provider behaviour. Provider fetches are
 * mocked so no real network calls happen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the GLM credentials loader so queryQuota doesn't depend on a real
// ~/.zcode/v2/config.json (absent in CI → "no apiKey" → unavailable).
vi.mock("../src/backend/credentials.js", () => ({
  loadZcodeCredentials: () => ({
    ANTHROPIC_API_KEY: "test-key",
    ZCODE_BASE_URL: "https://open.bigmodel.cn",
  }),
}));

// Mock the Opencode Go HTTP client so the orchestration tests can feed a
// deterministic finalUrl (undici's Response does not honour the init.url
// option, so mocking at the client boundary is cleaner than fighting it).
vi.mock("../src/quota/opencode-go/client.js", () => ({
  fetchGoDashboard: vi.fn(),
  dashboardUrl: (id: string) => `https://opencode.ai/workspace/${id}/go`,
}));

// Stub readConfigFile to return nothing — combined tests drive credentials via
// env only, and this isolates them from a real ~/.pi/agent/opencode-go.json
// that may exist on the dev machine.
vi.mock("../src/quota/opencode-go/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/quota/opencode-go/config.js")>(
    "../src/quota/opencode-go/config.js",
  );
  return { ...actual, readConfigFile: () => ({}) };
});

import { clearCache as clearGlmCache } from "../src/quota/cache.js";
import { fetchGoDashboard } from "../src/quota/opencode-go/client.js";
import {
  clearCache as clearGoCache,
  setClock as setGoClock,
} from "../src/quota/opencode-go/cache.js";
import {
  defaultGoWindows,
  formatCombinedCard,
  formatCombinedCardPlain,
  queryCombined,
} from "../src/quota/combined.js";
import type { GoQueryResult } from "../src/quota/opencode-go/types.js";
import type { QuotaResult } from "../src/quota/types.js";

const mockedGoFetch = vi.mocked(fetchGoDashboard);

// Real-shape GLM fixture (same as tests/quota.test.ts).
const GLM_SUCCESS: QuotaResult = {
  kind: "success",
  level: "pro",
  items: [
    {
      key: "token_5h",
      label: "5h",
      usedPercent: 24,
      leftPercent: 76,
      nextResetTime: 1783436462284,
    },
  ],
};

const GO_SUCCESS: GoQueryResult = {
  kind: "success",
  rolling: { usagePercent: 42, resetInSec: 3600 },
  weekly: { usagePercent: 17, resetInSec: 604800 },
  monthly: { usagePercent: 8, resetInSec: 2592000 },
  fetchedAt: 1000,
};

describe("defaultGoWindows", () => {
  it("all/glm → rolling + weekly (the user's requested default)", () => {
    expect(defaultGoWindows("all")).toEqual(["rolling", "weekly"]);
    expect(defaultGoWindows("glm")).toEqual(["rolling", "weekly"]);
  });

  it("go → rolling + weekly + monthly (full detail)", () => {
    expect(defaultGoWindows("go")).toEqual(["rolling", "weekly", "monthly"]);
  });
});

describe("formatCombinedCard — all mode", () => {
  it("renders both sections — no banner, sections separated by a blank line", () => {
    const out = formatCombinedCardPlain({ glm: GLM_SUCCESS, go: GO_SUCCESS }, { provider: "all" });
    const lines = out.split("\n");
    // No "Quota Overview" banner and no top divider — the section headers
    // identify each provider on their own.
    expect(lines[0]).not.toBe("Quota Overview");
    expect(lines[0]).not.toMatch(/^─+$/);
    expect(out).not.toContain("Quota Overview");
    // GLM section header (indented) first, Go section header second.
    expect(lines[0]).toBe(" GLM Coding Plan · Pro");
    expect(out).toContain(" Opencode Go");
    // The two sections are separated by exactly one blank line.
    expect(out).toContain("\n\n Opencode Go");
    // Both Go default windows present, monthly absent by default.
    expect(out).toMatch(/5h.*42%/);
    expect(out).toMatch(/Week.*17%/);
    expect(out).not.toMatch(/Mon.*8%/);
  });

  it("silently drops the Go section when Go is not_configured", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: { kind: "not_configured" } },
      { provider: "all" },
    );
    expect(out).toContain("GLM Coding Plan");
    expect(out).not.toContain("Opencode Go");
    expect(out).not.toContain("not configured");
  });

  it("shows the Go error line when Go is unavailable (not silently dropped)", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: { kind: "unavailable" } },
      { provider: "all" },
    );
    expect(out).toContain("Opencode Go");
    expect(out).toContain("unavailable");
  });

  it("shows the Go auth_error line when the cookie expired", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: { kind: "auth_error" } },
      { provider: "all" },
    );
    expect(out).toContain("auth expired");
  });

  it("wraps in a ```text fence in formatCombinedCard", () => {
    const fenced = formatCombinedCard({ glm: GLM_SUCCESS, go: GO_SUCCESS }, { provider: "all" });
    expect(fenced.startsWith("```text\n")).toBe(true);
    expect(fenced.endsWith("\n```")).toBe(true);
  });

  it("color mode paints both sections with ANSI escapes", () => {
    const ESC = String.fromCharCode(27);
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: GO_SUCCESS },
      { provider: "all", color: true },
    );
    // Both the GLM bar (24%) and the Go bar (42%) must carry ANSI bg escapes.
    expect(out).toContain(`${ESC}[48;2;`);
    expect(out).toContain(`${ESC}[0m`);
    // Section headers are still present and plain (no escapes in headers).
    expect(out).toContain("GLM Coding Plan");
    expect(out).toContain("Opencode Go");
  });

  it("color mode respects provider=glm (paints GLM, no Go section)", () => {
    const ESC = String.fromCharCode(27);
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: GO_SUCCESS },
      { provider: "glm", color: true },
    );
    expect(out).toContain(`${ESC}[48;2;`);
    expect(out).not.toContain("Opencode Go");
  });
});

describe("formatCombinedCard — glm mode", () => {
  it("renders only GLM (header + divider + body, no banner)", () => {
    const out = formatCombinedCardPlain({ glm: GLM_SUCCESS, go: GO_SUCCESS }, { provider: "glm" });
    const lines = out.split("\n");
    expect(lines[0]).toBe("GLM Coding Plan · Pro");
    expect(lines[1]).toMatch(/^─+$/);
    expect(out).not.toContain("Quota Overview");
    expect(out).not.toContain("Opencode Go");
  });

  it("GLM non-success → just the fallback prose, no header/divider", () => {
    const out = formatCombinedCardPlain(
      { glm: { kind: "unavailable" }, go: GO_SUCCESS },
      { provider: "glm" },
    );
    expect(out).toMatch(/unavailable/i);
    expect(out).not.toContain("GLM Coding Plan ·");
    expect(out).not.toMatch(/^─+$/m);
  });
});

describe("formatCombinedCard — go mode", () => {
  it("renders only Opencode Go with all three windows", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: GO_SUCCESS },
      { provider: "go", goWindows: ["rolling", "weekly", "monthly"] },
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("Opencode Go");
    expect(out).not.toContain("Quota Overview");
    expect(out).not.toContain("GLM Coding Plan");
    expect(out).toMatch(/5h.*42%/);
    expect(out).toMatch(/Week.*17%/);
    expect(out).toMatch(/Mon.*8%/);
  });

  it("Go not_configured in go mode surfaces the help line (not silently dropped)", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: { kind: "not_configured" } },
      { provider: "go" },
    );
    expect(out).toContain("not configured");
    expect(out).toContain("OPENCODE_GO");
  });
});

// --- queryCombined orchestration -----------------------------------------

describe("queryCombined orchestration", () => {
  let glmFetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearGlmCache();
    clearGoCache();
    setGoClock(() => 5000);
    mockedGoFetch.mockReset();
    // GLM still goes through the real client → global fetch (the credentials
    // mock above makes it look configured).
    glmFetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    glmFetchSpy.mockRestore();
    clearGlmCache();
    clearGoCache();
    setGoClock(undefined);
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
  });

  it("queries both providers in parallel in all mode", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**x";
    // GLM: a real success response via global fetch.
    glmFetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { level: "pro", limits: [{ type: "TOKENS_LIMIT", number: 5, percentage: 5 }] },
        }),
        { status: 200 },
      ),
    );
    // Go: mocked client returns a deterministic dashboard payload.
    mockedGoFetch.mockResolvedValue({
      status: 200,
      text: "<script>rollingUsage:$R[2]={usagePercent:42,resetInSec:3600},weeklyUsage:$R[3]={usagePercent:17,resetInSec:604800}</script>",
      finalUrl: "https://opencode.ai/workspace/wrk_abc/go",
    });

    const combined = await queryCombined("all");
    expect(combined.glm.kind).toBe("success");
    expect(combined.go.kind).toBe("success");
  });

  it("skips the Go fetch entirely in glm mode (no Go client call)", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**x";
    glmFetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { limits: [] } }), { status: 200 }),
    );
    await queryCombined("glm");
    expect(mockedGoFetch).not.toHaveBeenCalled();
  });

  it("skips the GLM fetch entirely in go mode", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**x";
    mockedGoFetch.mockResolvedValue({
      status: 200,
      text: "<script>rollingUsage:$R[2]={usagePercent:1,resetInSec:1}</script>",
      finalUrl: "https://opencode.ai/workspace/wrk_abc/go",
    });
    await queryCombined("go");
    expect(glmFetchSpy).not.toHaveBeenCalled();
  });

  it("returns not_configured Go without throwing when env is unset (all mode)", async () => {
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    glmFetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { limits: [] } }), { status: 200 }),
    );
    const combined = await queryCombined("all");
    expect(combined.go.kind).toBe("not_configured");
  });
});
