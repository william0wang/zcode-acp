/**
 * CLIProxyAPI quota card: route probing (v8 → v0 fallback + per-process
 * caching), response parsing (credential entries, relayed quota summaries,
 * relay envelope), orchestration (4-state degradation, per-account relay,
 * per-account URL ladder, plain-HTTP guard), config precedence, and section
 * rendering.
 *
 * The client tests inject a fake fetchImpl directly (no module mock); the
 * orchestration tests mock the client module so no real network happens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import process from "node:process";

// Orchestration tests intercept the HTTP layer here; client-layer tests use
// the actual implementation kept alive in `h.actual`.
const h = vi.hoisted(() => ({
  actual: null as typeof import("../src/quota/cliproxy/client.js") | null,
}));
vi.mock("../src/quota/cliproxy/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/quota/cliproxy/client.js")>(
    "../src/quota/cliproxy/client.js",
  );
  h.actual = actual;
  return {
    ...actual,
    fetchCredentials: vi.fn(),
    fetchQuotaSummary: vi.fn(),
  };
});

// Control the config-file side of credential resolution.
const { loadUserConfigMock } = vi.hoisted(() => ({ loadUserConfigMock: vi.fn() }));
vi.mock("../src/config/user-config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config/user-config.js")>(
    "../src/config/user-config.js",
  );
  return { ...actual, loadUserConfig: loadUserConfigMock };
});

import {
  fetchCredentials,
  fetchQuotaSummary,
  QUOTA_SUMMARY_URLS,
  resetRouteCache,
  type CpResponse,
} from "../src/quota/cliproxy/client.js";
import { clearCpCache, formatCpSection, queryCpUsage } from "../src/quota/cliproxy/index.js";
import { loadCpConfig } from "../src/quota/cliproxy/config.js";
import {
  parseCredentialEntries,
  parseQuotaSummary,
  relayUpstreamBody,
  relayUpstreamStatus,
} from "../src/quota/cliproxy/parse.js";

const mockedCreds = vi.mocked(fetchCredentials);
const mockedRelay = vi.mocked(fetchQuotaSummary);

const BASE = "https://cp.example.com:8317";
const KEY = "mgmt-key";

function setConfig(url: string | null, key: string | null): void {
  loadUserConfigMock.mockReturnValue(
    url === null ? {} : { quota: { cliproxyUrl: url, cliproxyManagementKey: key ?? undefined } },
  );
}

/** A relay envelope: upstream status/headers + the upstream body as a string. */
function relay(body: unknown, statusCode = 200): string {
  return JSON.stringify({ status_code: statusCode, header: {}, body: JSON.stringify(body) });
}

/** A relay response object for the mocked client. */
function relayResp(body: unknown, statusCode = 200): CpResponse {
  return { status: 200, text: relay(body, statusCode) };
}

/** Fake fetch for client-layer tests: answers per-URL with recorded calls. */
function fakeFetch(routes: Record<string, { status: number; body: string } | undefined>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const hit = routes[url];
    if (!hit) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return new Response(hit.body, { status: hit.status });
  };
  return { impl, calls };
}

// --- client: route probing --------------------------------------------------

describe("cliproxy client", () => {
  beforeEach(() => resetRouteCache());
  afterEach(() => resetRouteCache());

  /** The real (unmocked) client implementation. */
  function real() {
    if (!h.actual) throw new Error("actual client not loaded");
    return h.actual;
  }

  it("uses the v8 credentials route when it answers", async () => {
    const f = fakeFetch({ [`${BASE}/v8/management/credentials`]: { status: 200, body: "[]" } });
    const resp = await real().fetchCredentials(BASE, KEY, f.impl as unknown as typeof fetch);
    expect(resp.status).toBe(200);
    expect(f.calls.map((c) => c.url)).toEqual([`${BASE}/v8/management/credentials`]);
    // Both auth spellings ride every request (servers accept either).
    expect(f.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(f.calls[0]!.headers["X-Management-Key"]).toBe(KEY);
  });

  it("falls back to the v0 auth-files route on 404, then caches the winner", async () => {
    const f = fakeFetch({
      [`${BASE}/v0/management/auth-files`]: { status: 200, body: "[]" },
    });
    const resp = await real().fetchCredentials(BASE, KEY, f.impl as unknown as typeof fetch);
    expect(resp.status).toBe(200);
    expect(f.calls.map((c) => c.url)).toEqual([
      `${BASE}/v8/management/credentials`,
      `${BASE}/v0/management/auth-files`,
    ]);
    // Second call goes straight to the cached route — no re-probe.
    await real().fetchCredentials(BASE, KEY, f.impl as unknown as typeof fetch);
    expect(f.calls).toHaveLength(3);
  });

  it("api-call relays with the antigravity client UA and accepts an upstream 2xx", async () => {
    const route = `${BASE}/v8/management/requests/api-call`;
    const f = fakeFetch({ [route]: { status: 200, body: relay({ groups: [] }, 200) } });
    const out = await real().fetchQuotaSummary(
      BASE,
      KEY,
      "0",
      "proj",
      f.impl as unknown as typeof fetch,
    );
    expect(out?.status).toBe(200);
    expect(f.calls).toHaveLength(1); // first URL variant satisfied — ladder stops
    const payload = JSON.parse(f.calls[0]!.body!) as {
      auth_index: string;
      url: string;
      header: Record<string, string>;
      data: string;
    };
    expect(payload.auth_index).toBe("0");
    expect(payload.url).toBe(QUOTA_SUMMARY_URLS[0]);
    expect(payload.header.Authorization).toBe("Bearer $TOKEN$");
    // Without an antigravity UA Google answers 403 "no valid license", and the
    // legacy antigravity/cli UA gets a PARTIAL snapshot (Gemini group dropped —
    // observed live 2026-10-20); the hub UA is the full-payload identity.
    expect(payload.header["User-Agent"]).toBe("antigravity/hub/2.23.0 darwin/arm64");
    expect(JSON.parse(payload.data)).toEqual({ project: "proj" });
  });

  it("api-call walks the upstream URL ladder on a non-2xx UPSTREAM status", async () => {
    // The relay answers HTTP 200 with the upstream status INSIDE the envelope —
    // a 403 upstream must move the ladder to the next URL variant, not return.
    const route = `${BASE}/v8/management/requests/api-call`;
    const byUpstream = new Map<string, string>([
      [QUOTA_SUMMARY_URLS[0], relay({}, 403)],
      [QUOTA_SUMMARY_URLS[1], relay({}, 404)],
      [QUOTA_SUMMARY_URLS[2], relay({ groups: [] }, 200)],
    ]);
    const calls: string[] = [];
    const impl = async (url: string, init?: RequestInit) => {
      if (url !== route)
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      const payload = JSON.parse(String(init?.body)) as { url: string };
      calls.push(payload.url);
      return new Response(byUpstream.get(payload.url) ?? relay({}, 500), { status: 200 });
    };
    const out = await real().fetchQuotaSummary(
      BASE,
      KEY,
      "0",
      undefined,
      impl as unknown as typeof fetch,
    );
    expect(out).not.toBeNull();
    expect(relayUpstreamStatus(out!.text)).toBe(200);
    expect(calls).toEqual([...QUOTA_SUMMARY_URLS]);
  });

  it("api-call falls back to the v0 route spelling when v8 404s", async () => {
    const v8 = `${BASE}/v8/management/requests/api-call`;
    const v0 = `${BASE}/v0/management/api-call`;
    const f = fakeFetch({ [v0]: { status: 200, body: relay({}, 200) } });
    const out = await real().fetchQuotaSummary(
      BASE,
      KEY,
      "0",
      undefined,
      f.impl as unknown as typeof fetch,
    );
    expect(out?.status).toBe(200);
    expect(f.calls.map((c) => c.url)).toEqual([v8, v0]);
    // Winner cached: the next URL variant goes straight to v0.
    await real().fetchQuotaSummary(BASE, KEY, "0", undefined, f.impl as unknown as typeof fetch);
    expect(f.calls.map((c) => c.url)).toEqual([v8, v0, v0]);
  });

  it("api-call returns null when every variant fails", async () => {
    const f = fakeFetch({});
    const out = await real().fetchQuotaSummary(
      BASE,
      KEY,
      "0",
      undefined,
      f.impl as unknown as typeof fetch,
    );
    expect(out).toBeNull();
    expect(f.calls.length).toBe(QUOTA_SUMMARY_URLS.length * 2); // URL ladder × route ladder
  });
});

// --- parse -------------------------------------------------------------------

describe("cliproxy parse", () => {
  it("credential entries: array + nested forms, label/project resolution", () => {
    const text = JSON.stringify([
      {
        auth_index: "0",
        provider: "antigravity",
        file: { email: "alice@gmail.com", project_id: "proj-alice" },
      },
      {
        authIndex: "1",
        provider: "antigravity",
        metadata: { email: "bob@gmail.com", projectId: "proj-bob" },
      },
      { auth_index: "2", provider: "codex" },
      { provider: "antigravity" }, // no auth index — dropped
      "junk",
    ]);
    const entries = parseCredentialEntries(text);
    expect(entries).toEqual([
      { authIndex: "0", provider: "antigravity", label: "alice", projectId: "proj-alice" },
      { authIndex: "1", provider: "antigravity", label: "bob", projectId: "proj-bob" },
      { authIndex: "2", provider: "codex", label: "2", projectId: undefined },
    ]);
    // Nested envelope (some builds wrap the array).
    expect(parseCredentialEntries(JSON.stringify({ auth_files: [] }))).toEqual([]);
    expect(parseCredentialEntries("not json")).toEqual([]);
  });

  it("quota summary: antigravity groups shape, windowed (live-server form)", () => {
    // Verbatim shape observed against a real CLIProxy + antigravity account
    // (2026-10): groups are model families, buckets are windows (5h/weekly).
    const groups = [
      {
        displayName: "Gemini Models",
        description: "Models within this group: Gemini Flash, Gemini Pro",
        buckets: [
          {
            window: "weekly",
            remainingFraction: 0.7360983,
            resetTime: "2026-10-18T03:52:19Z",
            displayName: "Weekly Limit Remaining",
          },
          { window: "5h", remainingFraction: 0.9602678, resetTime: "2026-10-14T12:46:51Z" },
        ],
      },
      {
        display_name: "Claude and GPT models",
        buckets: [{ window: "weekly", remaining_fraction: 1 }],
      },
      { displayName: "no valid buckets", buckets: [{ remainingFraction: 2 }, "junk"] },
      "junk",
    ];
    const out = parseQuotaSummary(JSON.stringify({ groups, description: "…" }));
    expect(out).toEqual([
      {
        name: "Gemini Models",
        windows: [
          { window: "5h", used: 1 - 0.9602678, resetAt: Date.parse("2026-10-14T12:46:51Z") },
          { window: "week", used: 1 - 0.7360983, resetAt: Date.parse("2026-10-18T03:52:19Z") },
        ],
      },
      { name: "Claude and GPT models", windows: [{ window: "week", used: 0 }] },
    ]);
    // A bucket without a window is dropped even in an unnamed group; a named
    // window in an unnamed group still parses with the positional fallback.
    expect(
      parseQuotaSummary(JSON.stringify({ groups: [{ buckets: [{ remainingFraction: 0.5 }] }] })),
    ).toEqual([]);
    expect(
      parseQuotaSummary(
        JSON.stringify({ groups: [{ buckets: [{ window: "5h", remainingFraction: 0.5 }] }] }),
      ),
    ).toEqual([{ name: "Quota Group 1", windows: [{ window: "5h", used: 0.5 }] }]);
  });

  it("quota summary: window spellings normalize; tightest bucket per window wins", () => {
    const groups = [
      {
        displayName: "g1",
        buckets: [
          { window: "Five_Hour", remainingFraction: 0.8 },
          { window: "five-hour", remaining_fraction: 0.25, reset_time: "2026-10-15T06:00:00Z" },
          { window: "week", remainingFraction: 0.9 },
          { window: "5h", remainingFraction: 1.7 }, // out of range — ignored
          { remainingFraction: 0.1 }, // no window — dropped
          { window: "monthly", remainingFraction: 0.1 }, // unknown window — dropped
          "junk",
        ],
      },
    ];
    expect(parseQuotaSummary(JSON.stringify({ groups }))).toEqual([
      {
        name: "g1",
        windows: [
          { window: "5h", used: 0.75, resetAt: Date.parse("2026-10-15T06:00:00Z") },
          { window: "week", used: 1 - 0.9 },
        ],
      },
    ]);
    expect(parseQuotaSummary("nope")).toEqual([]);
    expect(parseQuotaSummary(JSON.stringify({}))).toEqual([]);
    // Legacy non-groups payloads parse to nothing.
    expect(parseQuotaSummary(JSON.stringify({ models: [] }))).toEqual([]);
  });

  it("relay envelope helpers", () => {
    const text = relay({ a: 1 }, 503);
    expect(relayUpstreamStatus(text)).toBe(503);
    expect(relayUpstreamBody(text)).toBe(JSON.stringify({ a: 1 }));
    expect(relayUpstreamStatus("junk")).toBe(200);
    expect(relayUpstreamBody("junk")).toBeUndefined();
  });
});

// --- orchestration -----------------------------------------------------------

describe("queryCpUsage orchestration", () => {
  beforeEach(() => {
    clearCpCache();
    resetRouteCache();
    mockedCreds.mockReset();
    mockedRelay.mockReset();
    setConfig(BASE, KEY);
    delete process.env.CLIPROXY_URL;
    delete process.env.CLIPROXY_MANAGEMENT_KEY;
  });
  afterEach(() => {
    clearCpCache();
    resetRouteCache();
  });

  it("not_configured without url/key (env + file absent)", async () => {
    setConfig(null, null);
    expect((await queryCpUsage()).result.kind).toBe("not_configured");
    expect(mockedCreds).not.toHaveBeenCalled();
  });

  it("the 5-minute TTL guards the Google-side refresh rate", async () => {
    // The quota summary hits a Google internal endpoint with the account's
    // OAuth token — callers polling faster than the TTL (watch mode's 30s
    // ticks) must be absorbed by the cache, not forwarded upstream.
    mockedCreds.mockResolvedValue({ status: 200, text: "[]" });
    await queryCpUsage();
    await queryCpUsage(); // within TTL — served from cache
    await queryCpUsage();
    expect(mockedCreds).toHaveBeenCalledTimes(1);
  });

  it("config file beats env; env fills in when the file is silent", () => {
    setConfig("https://from-file.example.com", "file-key");
    process.env.CLIPROXY_URL = "https://from-env.example.com";
    process.env.CLIPROXY_MANAGEMENT_KEY = "env-key";
    expect(loadCpConfig()!.url).toBe("https://from-file.example.com");
    setConfig(null, null);
    expect(loadCpConfig()).toEqual({ url: "https://from-env.example.com", key: "env-key" });
    process.env.CLIPROXY_URL = "https://from-env.example.com/"; // trailing slash trimmed
    expect(loadCpConfig()!.url).toBe("https://from-env.example.com");
  });

  it("refuses plain HTTP to a non-loopback host; loopback http is allowed", async () => {
    setConfig("http://cp.example.com:8317", KEY);
    expect((await queryCpUsage()).result.kind).toBe("unavailable");
    expect(mockedCreds).not.toHaveBeenCalled();
    setConfig("http://127.0.0.1:8317", KEY);
    mockedCreds.mockResolvedValue({ status: 200, text: "[]" });
    expect((await queryCpUsage()).result.kind).toBe("success");
  });

  it("maps 401 to auth_error, other statuses to unavailable", async () => {
    mockedCreds.mockResolvedValue({ status: 401, text: "{}" });
    expect((await queryCpUsage()).result.kind).toBe("auth_error");
    clearCpCache(); // the caches would otherwise serve the same verdict below
    mockedCreds.mockResolvedValue({ status: 500, text: "{}" });
    expect((await queryCpUsage()).result.kind).toBe("unavailable");
    clearCpCache();
    mockedCreds.mockRejectedValue(new Error("network down"));
    expect((await queryCpUsage()).result.kind).toBe("unavailable");
  });

  it("queries each Gemini account and counts non-Gemini accounts", async () => {
    mockedCreds.mockResolvedValue({
      status: 200,
      text: JSON.stringify([
        { auth_index: "0", provider: "antigravity", file: { email: "alice@gmail.com" } },
        { auth_index: "1", provider: "codex" },
        { auth_index: "2", provider: "claude" },
      ]),
    });
    mockedRelay.mockResolvedValue(
      relayResp({
        groups: [
          { displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0.25 }] },
        ],
      }),
    );
    const { result, otherCount } = await queryCpUsage();
    expect(otherCount).toBe(2);
    expect(result).toMatchObject({ kind: "success" });
    if (result.kind !== "success") return;
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({ label: "alice", provider: "antigravity" });
    expect(result.accounts[0]!.models[0]).toMatchObject({
      name: "Gemini Models",
      windows: [{ window: "5h", used: 0.75 }],
    });
    // One relay per Gemini account, with the resolved auth index.
    expect(mockedRelay).toHaveBeenCalledTimes(1);
    expect(mockedRelay.mock.calls[0]![2]).toBe("0");
  });

  it("a failing account relay is skipped; ALL Gemini relays failing is unavailable", async () => {
    mockedCreds.mockResolvedValue({
      status: 200,
      text: JSON.stringify([
        { auth_index: "0", provider: "antigravity" },
        { auth_index: "1", provider: "antigravity" },
      ]),
    });
    mockedRelay.mockResolvedValueOnce(
      relayResp({
        groups: [{ displayName: "m", buckets: [{ window: "week", remainingFraction: 0.5 }] }],
      }),
    );
    mockedRelay.mockResolvedValueOnce(null); // second account's ladder exhausted
    const { result } = await queryCpUsage();
    if (result.kind !== "success") throw new Error("expected success");
    expect(result.accounts).toHaveLength(1);

    clearCpCache();
    mockedRelay.mockResolvedValue(null);
    expect((await queryCpUsage()).result.kind).toBe("unavailable");
  });

  it("a relay whose upstream body is empty/unparsable skips the account", async () => {
    mockedCreds.mockResolvedValue({
      status: 200,
      text: JSON.stringify([{ auth_index: "0", provider: "antigravity" }]),
    });
    mockedRelay.mockResolvedValue(relayResp({ groups: [] })); // no model buckets
    const { result } = await queryCpUsage();
    expect(result.kind).toBe("unavailable"); // the only Gemini account yielded nothing
  });

  it("a transient failure keeps the last success on display (sticky) and retries past the failure gate", async () => {
    // Observed live 2026-11-10: the credentials listing times out
    // intermittently, and one blip used to blank the card for the whole TTL.
    vi.useFakeTimers();
    try {
      mockedCreds.mockResolvedValue({
        status: 200,
        text: JSON.stringify([{ auth_index: "0", provider: "antigravity" }]),
      });
      mockedRelay.mockResolvedValue(
        relayResp({
          groups: [
            { displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0.25 }] },
          ],
        }),
      );
      const ok = await queryCpUsage();
      expect(ok.result.kind).toBe("success");

      // Past the success TTL the next sweep blips — the stale success serves.
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000);
      mockedCreds.mockRejectedValue(new Error("The operation timed out."));
      const sticky = await queryCpUsage();
      expect(sticky.result.kind).toBe("success"); // NOT unavailable
      expect(mockedCreds).toHaveBeenCalledTimes(2);

      // Inside the failure gate: no re-query, still the last success.
      expect((await queryCpUsage()).result.kind).toBe("success");
      expect(mockedCreds).toHaveBeenCalledTimes(2);

      // Past the gate: the sweep retries and recovers with FRESH data.
      vi.setSystemTime(Date.now() + 60_000 + 1_000);
      mockedCreds.mockResolvedValue({
        status: 200,
        text: JSON.stringify([{ auth_index: "0", provider: "antigravity" }]),
      });
      const fresh = await queryCpUsage();
      expect(fresh.result.kind).toBe("success");
      expect(mockedCreds).toHaveBeenCalledTimes(3);
      if (fresh.result.kind !== "success" || ok.result.kind !== "success") return;
      expect(fresh.result.fetchedAt).toBeGreaterThan(ok.result.fetchedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auth_error surfaces instead of the stale success (durable, actionable)", async () => {
    vi.useFakeTimers();
    try {
      mockedCreds.mockResolvedValue({
        status: 200,
        text: JSON.stringify([{ auth_index: "0", provider: "antigravity" }]),
      });
      mockedRelay.mockResolvedValue(
        relayResp({
          groups: [
            { displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0.25 }] },
          ],
        }),
      );
      expect((await queryCpUsage()).result.kind).toBe("success");

      vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000);
      mockedCreds.mockResolvedValue({ status: 401, text: "{}" }); // key rotated
      expect((await queryCpUsage()).result.kind).toBe("auth_error");
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- format ------------------------------------------------------------------

describe("formatCpSection", () => {
  it("renders pool-wide family × window rows with the earliest reset stamp", () => {
    // Two subscriptions: used fractions SUM into the pool (total used over
    // total capacity = average); each window stamps the EARLIEST reset across
    // accounts (alice's, not bob's).
    const aliceWeek = Date.parse("2026-10-18T03:52:19Z");
    const sec = formatCpSection(
      {
        kind: "success",
        accounts: [
          {
            label: "alice",
            provider: "antigravity",
            models: [
              {
                name: "Gemini Models",
                windows: [
                  { window: "5h", used: 0.1 },
                  { window: "week", used: 0.5, resetAt: aliceWeek },
                ],
              },
            ],
          },
          {
            label: "bob",
            provider: "antigravity",
            models: [
              {
                name: "Gemini Models",
                windows: [
                  { window: "5h", used: 0.3 },
                  { window: "week", used: 0.1, resetAt: aliceWeek + 86_400_000 },
                ],
              },
            ],
          },
        ],
        fetchedAt: 1,
      },
      false,
      2,
      () => 60_000,
    );
    expect(sec.header).toBe("CLIProxy"); // fresh (60s old at the injected clock)
    // Week row first (tightest window: (0.5+0.1)/2 = 30%), then 5h (20%).
    const week = new Date(aliceWeek);
    const stamp = `${String(week.getMonth() + 1).padStart(2, "0")}-${String(
      week.getDate(),
    ).padStart(2, "0")} ${String(week.getHours()).padStart(2, "0")}:${String(
      week.getMinutes(),
    ).padStart(2, "0")}`;
    expect(sec.body[0]).toMatch(
      new RegExp(
        `Gemini Models\\s+Week\\s+[█░]+\\s+30% · ${stamp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      ),
    );
    // 5h has no reset reported by either account — no stamp.
    expect(sec.body[1]).toMatch(/^\s{22}5h\s+[█░]+\s+20%$/);
    expect(sec.body[2]).toBe("      + 2 non-Gemini accounts");
  });

  it("non-success kinds and empty accounts render explanation lines", () => {
    expect(formatCpSection({ kind: "not_configured" }).body[0]).toMatch(/not configured/);
    expect(formatCpSection({ kind: "auth_error" }).body[0]).toMatch(/auth failed/);
    expect(formatCpSection({ kind: "unavailable" }).body[0]).toMatch(/unavailable/);
    expect(formatCpSection({ kind: "success", accounts: [], fetchedAt: 1 }).body[0]).toMatch(
      /no Gemini accounts/,
    );
  });

  it("stamps the section age once the cached values are over 90s old", () => {
    const fresh = formatCpSection(
      { kind: "success", accounts: [], fetchedAt: 10_000 },
      false,
      0,
      () => 100_000,
    );
    expect(fresh.header).toBe("CLIProxy"); // 90s old — still fresh
    const stale = formatCpSection(
      { kind: "success", accounts: [], fetchedAt: 10_000 },
      false,
      0,
      () => 4 * 60_000,
    );
    expect(stale.header).toBe("CLIProxy · 3m old");
    expect(formatCpSection({ kind: "not_configured" }, false, 0, () => 9_999_999).header).toBe(
      "CLIProxy",
    ); // non-success kinds never stamp
  });
});
