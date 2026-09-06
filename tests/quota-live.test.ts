/**
 * Quota dock refresher tests (ADR-0021): lazy singleton lifecycle, interval +
 * forceRefresh, hub-first with silent direct-query fallback, martty-only
 * config_option_update targeting, and the null-hides contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryQuotaMock, buildOptionsMock, remoteConfigMock } = vi.hoisted(() => ({
  queryQuotaMock: vi.fn(),
  buildOptionsMock: vi.fn(),
  remoteConfigMock: vi.fn(),
}));

vi.mock("../src/quota/index.js", () => ({ queryQuota: queryQuotaMock }));
vi.mock("../src/config/options.js", () => ({ buildConfigOptions: buildOptionsMock }));
vi.mock("../src/remote/config.js", () => ({ parseRemoteConfig: remoteConfigMock }));

import {
  forceRefreshQuota,
  QUOTA_REFRESH_INTERVAL_MS,
  resetQuotaRefresherForTest,
  startQuotaRefresher,
} from "../src/quota/live.js";
import type { QuotaResult } from "../src/quota/types.js";
import type { ZcodeAcpServer } from "../src/server.js";

const SUCCESS: QuotaResult = {
  kind: "success",
  level: "pro",
  items: [
    { key: "token_5h", label: "5h", usedPercent: 45, leftPercent: 55 },
    { key: "token_week", label: "Week", usedPercent: 12, leftPercent: 88 },
  ],
};

interface NotifyCall {
  method: string;
  params: { sessionId: string; update: Record<string, unknown> };
}

/** Minimal fake server: martty flags, session maps, and a notify-recording client registry. */
function fakeServer(opts: { martty?: boolean } = {}) {
  const calls: NotifyCall[] = [];
  const marttyRoot = { id: "martty-root" };
  const editorRoot = { id: "editor-root" };
  const marttyCx = {
    connectionContext: marttyRoot,
    notify: async (method: string, params: NotifyCall["params"]) => {
      calls.push({ method, params });
    },
  };
  const editorCx = {
    connectionContext: editorRoot,
    notify: async () => {
      throw new Error("editor must not be targeted");
    },
  };
  const server = {
    marttyClientSeen: opts.martty ?? true,
    quotaDock: null as string | null,
    marttyConnectionRoots: new Set<unknown>([marttyRoot]),
    sessionMap: new Map([["acp-1", "z-1"]]),
    pendingSessions: new Map([["acp-pending", {}]]),
    resolveSid: (sid: string) =>
      sid === "acp-1" ? "z-1" : sid === "acp-pending" ? undefined : undefined,
    clients: {
      snapshot: () => [marttyCx, editorCx],
    },
  };
  return { server: server as unknown as ZcodeAcpServer, calls };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  queryQuotaMock.mockReset();
  buildOptionsMock.mockReset();
  remoteConfigMock.mockReset();
  remoteConfigMock.mockReturnValue(null);
  buildOptionsMock.mockResolvedValue([{ id: "model" }]);
});

afterEach(() => {
  resetQuotaRefresherForTest();
  vi.useRealTimers();
});

describe("startQuotaRefresher", () => {
  it("no-ops (and never queries) without a martty client", async () => {
    const { server } = fakeServer({ martty: false });
    startQuotaRefresher(server);
    await flushMicrotasks();
    expect(queryQuotaMock).not.toHaveBeenCalled();
  });

  it("refreshes immediately on start, stores the dock string, and emits to martty only", async () => {
    queryQuotaMock.mockResolvedValue(SUCCESS);
    const { server, calls } = fakeServer();
    startQuotaRefresher(server);
    await flushMicrotasks();
    expect(queryQuotaMock).toHaveBeenCalledTimes(1);
    expect(server.quotaDock).toBe("5h 45% · wk 12%");
    // Full-replace options for every known session alias (live + pending).
    const acpSids = calls.map((c) => c.params.sessionId).sort();
    expect(acpSids).toEqual(["acp-1", "acp-pending"]);
    for (const c of calls) {
      expect(c.method).toBe("session/update");
      expect(c.params.update.sessionUpdate).toBe("config_option_update");
      expect(c.params.update.configOptions).toEqual([{ id: "model" }]);
    }
  });

  it("refreshes again on the interval", async () => {
    vi.useFakeTimers();
    queryQuotaMock.mockResolvedValue(SUCCESS);
    const { server } = fakeServer();
    startQuotaRefresher(server);
    await vi.advanceTimersByTimeAsync(10);
    expect(queryQuotaMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUOTA_REFRESH_INTERVAL_MS);
    expect(queryQuotaMock).toHaveBeenCalledTimes(2);
    expect(server.quotaDock).toBe("5h 45% · wk 12%");
  });
});

describe("forceRefreshQuota", () => {
  it("refreshes on demand and collapses concurrent calls into one fetch", async () => {
    queryQuotaMock.mockResolvedValue(SUCCESS);
    const { server } = fakeServer();
    server.marttyClientSeen = true;
    startQuotaRefresher(server);
    await flushMicrotasks();
    queryQuotaMock.mockClear();
    await Promise.all([forceRefreshQuota(), forceRefreshQuota()]);
    await flushMicrotasks();
    expect(queryQuotaMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-emit when the string is unchanged", async () => {
    queryQuotaMock.mockResolvedValue(SUCCESS);
    const { server, calls } = fakeServer();
    startQuotaRefresher(server);
    await flushMicrotasks();
    expect(calls.length).toBe(2);
    await forceRefreshQuota();
    await flushMicrotasks();
    expect(calls.length).toBe(2); // no new config_option_update
  });
});

describe("hub-first lookup", () => {
  it("uses the hub payload when reachable and skips the direct query", async () => {
    remoteConfigMock.mockReturnValue({
      token: "t",
      hubHost: "127.0.0.1",
      hubPort: 8377,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ formatted: "5h 50% · wk 9% · reset 1h00m", fetchedAt: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      queryQuotaMock.mockResolvedValue(SUCCESS);
      const { server, calls } = fakeServer();
      startQuotaRefresher(server);
      await flushMicrotasks();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:8377/api/quota/dock");
      expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe("Bearer t");
      expect(queryQuotaMock).not.toHaveBeenCalled();
      expect(server.quotaDock).toBe("5h 50% · wk 9% · reset 1h00m");
      expect(calls.length).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the direct query when the hub is unreachable", async () => {
    remoteConfigMock.mockReturnValue({ token: "t", hubHost: "127.0.0.1", hubPort: 8377 });
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      queryQuotaMock.mockResolvedValue(SUCCESS);
      const { server } = fakeServer();
      startQuotaRefresher(server);
      await flushMicrotasks();
      expect(queryQuotaMock).toHaveBeenCalledTimes(1);
      expect(server.quotaDock).toBe("5h 45% · wk 12%");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("treats a hub formatted:null as dock-hidden and does not emit", async () => {
    remoteConfigMock.mockReturnValue({ token: "t", hubHost: "127.0.0.1", hubPort: 8377 });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ formatted: null, fetchedAt: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      queryQuotaMock.mockResolvedValue(SUCCESS);
      const { server, calls } = fakeServer();
      startQuotaRefresher(server);
      await flushMicrotasks();
      expect(queryQuotaMock).not.toHaveBeenCalled();
      expect(server.quotaDock).toBeNull();
      expect(calls.length).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("failure contract", () => {
  it("stores null and emits nothing when the direct query fails", async () => {
    queryQuotaMock.mockResolvedValue({ kind: "unavailable" });
    const { server, calls } = fakeServer();
    server.quotaDock = "stale";
    startQuotaRefresher(server);
    await flushMicrotasks();
    expect(server.quotaDock).toBeNull();
    expect(calls.length).toBe(0);
  });
});
