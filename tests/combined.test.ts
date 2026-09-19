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
    providerBaseURL: "https://open.bigmodel.cn",
  }),
}));

// Mock the Opencode Go HTTP client so the orchestration tests can feed a
// deterministic (status, text) pair without touching the network.
vi.mock("../src/quota/opencode-go/client.js", () => ({
  fetchGoStatus: vi.fn(),
  goStatusUrl: () => "https://opencode.ai/console/api/go/status",
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

// Mock the Ollama Cloud HTTP client + user-config the same way, so the oc
// orchestration inside queryCombined("all") never touches the network or a
// real ~/.config/zcode-acp/config.json.
vi.mock("../src/quota/ollama-cloud/client.js", () => ({
  fetchOcUsage: vi.fn(),
  fetchOcMe: vi.fn(),
  USAGE_URL: "https://ollama.com/api/usage",
  ME_URL: "https://ollama.com/api/me",
}));
vi.mock("../src/config/user-config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config/user-config.js")>(
    "../src/config/user-config.js",
  );
  return { ...actual, loadUserConfig: () => ({}) };
});

import { clearCache as clearGlmCache } from "../src/quota/cache.js";
import { fetchOcUsage } from "../src/quota/ollama-cloud/client.js";
import { fetchGoStatus } from "../src/quota/opencode-go/client.js";
import {
  clearCache as clearGoCache,
  setClock as setGoClock,
} from "../src/quota/opencode-go/cache.js";
import {
  clearCache as clearOcCache,
  setClock as setOcClock,
} from "../src/quota/ollama-cloud/cache.js";
import {
  defaultGoWindows,
  formatCombinedCard,
  formatCombinedCardPlain,
  queryCombined,
} from "../src/quota/combined.js";
import type { OcQueryResult } from "../src/quota/ollama-cloud/types.js";
import type { GoQueryResult } from "../src/quota/opencode-go/types.js";
import type { QuotaResult } from "../src/quota/types.js";

const mockedGoFetch = vi.mocked(fetchGoStatus);
const mockedOcFetch = vi.mocked(fetchOcUsage);

/** Default oc fixture: unconfigured → section silently dropped in all mode. */
const OC_NONE: OcQueryResult = { kind: "not_configured" };

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
  it("all/go → rolling + weekly + monthly (all three windows)", () => {
    expect(defaultGoWindows("all")).toEqual(["rolling", "weekly", "monthly"]);
    expect(defaultGoWindows("go")).toEqual(["rolling", "weekly", "monthly"]);
  });

  it("glm also returns all three (glm mode never renders Go, so unused)", () => {
    expect(defaultGoWindows("glm")).toEqual(["rolling", "weekly", "monthly"]);
  });
});

describe("formatCombinedCard — all mode", () => {
  it("renders both sections — no banner, sections separated by a blank line", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: OC_NONE },
      { provider: "all" },
    );
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
    // All three Go windows present by default (room for monthly in the layout).
    expect(out).toMatch(/5h.*42%/);
    expect(out).toMatch(/Week.*17%/);
    expect(out).toMatch(/Month.*8%/);
  });

  it("silently drops the Go section when Go is not_configured", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: { kind: "not_configured" }, oc: OC_NONE },
      { provider: "all" },
    );
    expect(out).toContain("GLM Coding Plan");
    expect(out).not.toContain("Opencode Go");
    expect(out).not.toContain("not configured");
  });

  it("shows the Go error line when Go is unavailable (not silently dropped)", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: { kind: "unavailable" }, oc: OC_NONE },
      { provider: "all" },
    );
    expect(out).toContain("Opencode Go");
    expect(out).toContain("unavailable");
  });

  it("shows the Go auth_error line when the cookie expired", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: { kind: "auth_error" }, oc: OC_NONE },
      { provider: "all" },
    );
    expect(out).toContain("auth expired");
  });

  it("wraps in a ```text fence in formatCombinedCard", () => {
    const fenced = formatCombinedCard(
      { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: OC_NONE },
      { provider: "all" },
    );
    expect(fenced.startsWith("```text\n")).toBe(true);
    expect(fenced.endsWith("\n```")).toBe(true);
  });

  it("color mode paints both sections with ANSI escapes", () => {
    const ESC = String.fromCharCode(27);
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: OC_NONE },
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
      { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: OC_NONE },
      { provider: "glm", color: true },
    );
    expect(out).toContain(`${ESC}[48;2;`);
    expect(out).not.toContain("Opencode Go");
  });

  describe("refresh line (refreshSuffix)", () => {
    it("places the refresh countdown on the separator row between sections, right-aligned", () => {
      const out = formatCombinedCardPlain(
        { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: OC_NONE },
        { provider: "all", refreshSuffix: "refresh in 25s" },
      );
      const lines = out.split("\n");
      // GLM section = [header, 5h]; the refresh line sits right after it on the
      // separator row (no extra blank line — the refresh text IS the separator),
      // then the Go header follows directly.
      expect(lines[2]).toBe("refresh in 25s".padStart(34));
      expect(lines[3]).toBe(" Opencode Go");
    });

    it("keeps the refresh row position even when Go is not_configured (only GLM)", () => {
      // Only GLM renders → refresh still trails the first section at the same row.
      const out = formatCombinedCardPlain(
        { glm: GLM_SUCCESS, go: { kind: "not_configured" }, oc: OC_NONE },
        { provider: "all", refreshSuffix: "refresh in 25s" },
      );
      const lines = out.split("\n");
      expect(lines[0]).toBe(" GLM Coding Plan · Pro");
      expect(lines[1]).toMatch(/5h/);
      expect(lines[2]).toBe("refresh in 25s".padStart(34));
      expect(lines[3]).toBeUndefined();
    });

    it("omits the refresh line entirely when no refreshSuffix is given", () => {
      const out = formatCombinedCardPlain(
        { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: OC_NONE },
        { provider: "all" },
      );
      expect(out).not.toContain("refresh");
      // The separator between sections is still a blank line.
      expect(out).toContain("\n\n Opencode Go");
    });

    it("appends the refresh line after the GLM card in glm mode", () => {
      const out = formatCombinedCardPlain(
        { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: OC_NONE },
        { provider: "glm", refreshSuffix: "refresh in 3s" },
      );
      const lines = out.split("\n");
      // glm card = [header, divider, 5h]; refresh is the last line.
      expect(lines[lines.length - 1]).toBe("refresh in 3s".padStart(34));
    });

    it("appends the refresh line after the Go card in go mode", () => {
      const out = formatCombinedCardPlain(
        { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: OC_NONE },
        { provider: "go", refreshSuffix: "refresh in 9s" },
      );
      const lines = out.split("\n");
      expect(lines[lines.length - 1]).toBe("refresh in 9s".padStart(34));
    });
  });
});

describe("formatCombinedCard — glm mode", () => {
  it("renders only GLM (header + divider + body, no banner)", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: OC_NONE },
      { provider: "glm" },
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("GLM Coding Plan · Pro");
    expect(lines[1]).toMatch(/^─+$/);
    expect(out).not.toContain("Quota Overview");
    expect(out).not.toContain("Opencode Go");
  });

  it("GLM non-success → just the fallback prose, no header/divider", () => {
    const out = formatCombinedCardPlain(
      { glm: { kind: "unavailable" }, go: GO_SUCCESS, oc: OC_NONE },
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
      { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: OC_NONE },
      { provider: "go", goWindows: ["rolling", "weekly", "monthly"] },
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("Opencode Go");
    expect(out).not.toContain("Quota Overview");
    expect(out).not.toContain("GLM Coding Plan");
    expect(out).toMatch(/5h.*42%/);
    expect(out).toMatch(/Week.*17%/);
    expect(out).toMatch(/Month.*8%/);
  });

  it("Go not_configured in go mode surfaces the help line (not silently dropped)", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: { kind: "not_configured" }, oc: OC_NONE },
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
    clearOcCache();
    setOcClock(() => 5000);
    mockedGoFetch.mockReset();
    mockedOcFetch.mockReset();
    // GLM still goes through the real client → global fetch (the credentials
    // mock above makes it look configured).
    glmFetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    glmFetchSpy.mockRestore();
    clearGlmCache();
    clearGoCache();
    setGoClock(undefined);
    clearOcCache();
    setOcClock(undefined);
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    delete process.env.OPENCODE_GO_SESSION_TOKEN;
    delete process.env.OLLAMA_API_KEY;
  });

  it("queries both providers in parallel in all mode", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**x";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_token";
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
    // Go: mocked client returns a deterministic status payload.
    mockedGoFetch.mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        access: {
          endsAt: "2026-10-03T02:03:01.000Z",
          meters: {
            fiveHour: {
              resetsAt: null,
              limitMicroCents: "1200000000",
              usedMicroCents: "600000000",
            },
            week: {
              resetsAt: "2026-09-21T04:00:00.000Z",
              limitMicroCents: "3000000000",
              usedMicroCents: "300000000",
            },
          },
        },
      }),
    });

    const combined = await queryCombined("all");
    expect(combined.glm.kind).toBe("success");
    expect(combined.go.kind).toBe("success");
  });

  it("skips the Go fetch entirely in glm mode (no Go client call)", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**x";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_token";
    glmFetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { limits: [] } }), { status: 200 }),
    );
    await queryCombined("glm");
    expect(mockedGoFetch).not.toHaveBeenCalled();
  });

  it("skips the GLM fetch entirely in go mode", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_abc";
    process.env.OPENCODE_GO_AUTH_COOKIE = "Fe26.2**x";
    process.env.OPENCODE_GO_SESSION_TOKEN = "st_token";
    mockedGoFetch.mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        access: {
          meters: {
            fiveHour: { resetsAt: null, limitMicroCents: "1200000000", usedMicroCents: "1" },
          },
        },
      }),
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

describe("formatCombinedCard — oc section", () => {
  const OC_SUCCESS: OcQueryResult = {
    kind: "success",
    session: 0.31,
    weekly: 0.68,
    fetchedAt: 1000,
  };

  it("renders the Ollama Cloud section below Opencode Go in all mode", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: OC_SUCCESS },
      { provider: "all" },
    );
    expect(out).toContain(" Ollama Cloud");
    expect(out).toMatch(/5h.*31%/);
    expect(out).toMatch(/Week.*68%/);
    // Section order: GLM → Go → Ollama Cloud.
    expect(out.indexOf("GLM Coding Plan")).toBeLessThan(out.indexOf("Opencode Go"));
    expect(out.indexOf("Opencode Go")).toBeLessThan(out.indexOf("Ollama Cloud"));
  });

  it("silently drops the oc section when not_configured (all mode)", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: { kind: "not_configured" } },
      { provider: "all" },
    );
    expect(out).not.toContain("Ollama Cloud");
  });

  it("shows the oc error line when the key is bad (auth_error, all mode)", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: { kind: "auth_error" } },
      { provider: "all" },
    );
    expect(out).toContain("Ollama Cloud");
    expect(out).toContain("auth failed");
  });

  it("oc mode renders only the Ollama Cloud section", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: OC_SUCCESS },
      { provider: "oc" },
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("Ollama Cloud");
    expect(out).not.toContain("GLM Coding Plan");
    expect(out).not.toContain("Opencode Go");
  });

  it("oc not_configured in oc mode surfaces the help line", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: { kind: "not_configured" } },
      { provider: "oc" },
    );
    expect(out).toContain("not configured");
    expect(out).toContain("OLLAMA_API_KEY");
  });

  it("refresh suffix appears once, after the first section, even with three sections", () => {
    const out = formatCombinedCardPlain(
      { glm: GLM_SUCCESS, go: GO_SUCCESS, oc: OC_SUCCESS },
      { provider: "all", refreshSuffix: "refresh in 25s" },
    );
    const lines = out.split("\n");
    expect(lines.filter((l) => l.includes("refresh in 25s"))).toHaveLength(1);
    // Go/oc separator stays blank (no duplicated countdown).
    const ocIdx = lines.findIndex((l) => l === " Ollama Cloud");
    expect(ocIdx).toBeGreaterThan(0);
    expect(lines[ocIdx - 1]).toBe("");
  });

  it("skips the oc fetch in glm and go modes; queries it in oc mode", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockedOcFetch.mockResolvedValue({
      status: 200,
      text: JSON.stringify({ limits: { session: { usage: 0.1 }, weekly: { usage: 0.2 } } }),
    });
    // glm mode runs the real GLM client → global fetch; stub it off (no network).
    const glmFetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: { limits: [] } })));
    try {
      await queryCombined("glm");
      await queryCombined("go");
      expect(mockedOcFetch).not.toHaveBeenCalled();
      await queryCombined("oc");
      expect(mockedOcFetch).toHaveBeenCalledTimes(1);
    } finally {
      glmFetchSpy.mockRestore();
    }
  });
});
