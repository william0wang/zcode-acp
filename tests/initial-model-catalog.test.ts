import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ZcodeAcpServer } from "../src/server.js";
import { ZcodeBackend } from "../src/backend/client.js";

vi.mock("../src/backend/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveZcodeCommand: () => ["mock"],
}));

const capability = vi.hoisted(() => ({ verified: true }));
vi.mock("../src/config/deferred-probe-capability.js", () => ({
  deferredProbeCapabilityVerified: () => capability.verified,
}));

vi.mock("../src/config/account-provider.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  pushAccountProviderConfig: async () => false,
}));
vi.mock("../src/config/provider-registry.js", () => ({
  buildProviderRegistry: () => ({ providers: [] }),
}));
vi.mock("../src/lazy-sessions.js", () => ({
  rememberLazySession: () => {},
  lookupLazySession: () => undefined,
}));
vi.mock("../src/tasks-index.js", () => ({ reviveTombstonesOnActivity: async () => 0 }));

import { probeInitialModelCatalog } from "../src/config/initial-model-catalog.js";
import { ZcodeAcpServer as Server } from "../src/server.js";
import { buildInitialConfigOptions } from "../src/config/options.js";

const snapshot = {
  session: { sessionId: "probe" },
  settings: {
    model: {
      current: { providerId: "custom:live", modelId: "live" },
      available: [{ ref: { providerId: "custom:live", modelId: "live" } }],
    },
  },
};

function fixture(create: () => Promise<unknown>, start?: () => Promise<unknown>) {
  const calls: Array<{ method: string; params: any }> = [];
  const close = vi.fn(async () => {});
  const backend = {
    close,
    request: async (_id: number, method: string, params: any) => {
      calls.push({ method, params });
      return method === "session/create" ? create() : { result: {} };
    },
  };
  const server = { nextId: () => 1, ensureBackend: start ?? (async () => backend) };
  return { calls, close, backend, factory: async () => server as unknown as ZcodeAcpServer };
}

describe("isolated initial catalog probe", () => {
  it("fails closed without launching when the backend is unsupported", async () => {
    const factory = vi.fn(fixture(async () => ({ result: snapshot })).factory);
    capability.verified = false;
    try {
      expect(await probeInitialModelCatalog("/fixture", factory, 100)).toBeNull();
      expect(factory).not.toHaveBeenCalled();
    } finally {
      capability.verified = true;
    }
  });
  it("disposes the temporary server after the backend closes", async () => {
    const dispose = vi.fn();
    const backend = {
      request: async (_id: number, method: string) =>
        method === "session/create" ? { result: snapshot } : { result: {} },
      close: async () => {},
    };
    const server = { nextId: () => 1, ensureBackend: async () => backend, dispose };
    expect(
      await probeInitialModelCatalog(
        "/fixture",
        async () => server as unknown as ZcodeAcpServer,
        1000,
      ),
    ).toEqual(snapshot);
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("reads the resident selection when create returns availability without current", async () => {
    const noCurrent = {
      session: { sessionId: "probe" },
      settings: { model: { available: snapshot.settings.model.available } },
    };
    const request = vi.fn(async (_id: number, method: string) => {
      if (method === "session/create") return { result: noCurrent };
      if (method === "session/read")
        return { result: { settings: { model: { current: snapshot.settings.model.current } } } };
      return { result: {} };
    });
    const backend = { request, close: async () => {} };
    const factory = async () =>
      ({ nextId: () => 1, ensureBackend: async () => backend }) as unknown as ZcodeAcpServer;
    const result = await probeInitialModelCatalog("/fixture", factory, 1000);
    expect(result?.settings?.model?.current).toEqual(snapshot.settings.model.current);
    const options = await buildInitialConfigOptions(new Server(), undefined, result);
    const model = options.find((option) => option.id === "model");
    expect(model?.type).toBe("select");
    if (model?.type !== "select") throw Error("model option missing");
    expect(model.currentValue).toBe("custom:live\\live");
    expect(model.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "custom:live\\live" })]),
    );
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      "session/create",
      "session/read",
      "session/close",
    ]);
  });
  it("reaps an actual child that would reply after the deadline", async () => {
    const dir = mkdtempSync(path.join(process.env.HOME!, "probe-child-"));
    const script = path.join(dir, "backend.cjs");
    writeFileSync(
      script,
      `
      require("node:readline").createInterface({input:process.stdin}).on("line", line => {
        const msg = JSON.parse(line);
        if (msg.method === "session/create") setTimeout(() => process.stdout.write(JSON.stringify({id:msg.id,result:{session:{sessionId:"late"}}}) + "\\n"), 500);
      });
    `,
    );
    const backend = new ZcodeBackend([process.execPath, script], process.env);
    const server = { nextId: () => 1, ensureBackend: async () => backend };
    expect(
      await probeInitialModelCatalog(dir, async () => server as unknown as ZcodeAcpServer, 100),
    ).toBeNull();
    await vi.waitFor(() =>
      expect(backend.proc.exitCode !== null || backend.proc.signalCode !== null).toBe(true),
    );
  });
  it("falls back when an actual child crashes during create", async () => {
    const dir = mkdtempSync(path.join(process.env.HOME!, "probe-crash-"));
    const script = path.join(dir, "backend.cjs");
    writeFileSync(
      script,
      `require("node:readline").createInterface({input:process.stdin}).on("line", () => process.exit(7));`,
    );
    const backend = new ZcodeBackend([process.execPath, script], process.env);
    const server = { nextId: () => 1, ensureBackend: async () => backend };
    expect(
      await probeInitialModelCatalog(dir, async () => server as unknown as ZcodeAcpServer, 1000),
    ).toBeNull();
    await vi.waitFor(() =>
      expect(backend.proc.exitCode !== null || backend.proc.signalCode !== null).toBe(true),
    );
  });
  it("creates deferred, closes the session and its process", async () => {
    const f = fixture(async () => ({ result: snapshot }));
    expect(await probeInitialModelCatalog("/fixture", f.factory, 1000)).toEqual(snapshot);
    expect(f.calls).toEqual([
      expect.objectContaining({
        method: "session/create",
        params: expect.objectContaining({ persistence: "deferred" }),
      }),
      { method: "session/close", params: { sessionId: "probe" } },
    ]);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("falls back on old backend errors and exceptions without a non-deferred retry", async () => {
    for (const create of [
      async () => ({ error: { code: -32602 } }),
      async () => {
        throw Error("crash");
      },
    ]) {
      const f = fixture(create);
      expect(await probeInitialModelCatalog("/fixture", f.factory, 1000)).toBeNull();
      expect(f.calls).toHaveLength(1);
      expect(f.close).toHaveBeenCalledOnce();
    }
  });
  it("closes the child on timeout and ignores a late create reply", async () => {
    let reply!: (v: unknown) => void;
    const f = fixture(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    expect(await probeInitialModelCatalog("/fixture", f.factory, 20)).toBeNull();
    expect(f.close).toHaveBeenCalledOnce();
    reply({ result: snapshot });
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.calls.map((c) => c.method)).toEqual(["session/create"]);
  });
  it("closes a child whose startup resolves after the deadline", async () => {
    let release!: (v: unknown) => void;
    const f = fixture(
      async () => ({ result: snapshot }),
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    expect(await probeInitialModelCatalog("/fixture", f.factory, 20)).toBeNull();
    release(f.backend);
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.calls).toHaveLength(0);
  });
  it("retains the process-wide slot after timeout until late startup and close settle", async () => {
    let releaseStartup!: (v: unknown) => void;
    let releaseClose!: () => void;
    const f = fixture(
      async () => ({ result: snapshot }),
      () =>
        new Promise((resolve) => {
          releaseStartup = resolve;
        }),
    );
    f.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    );
    expect(await probeInitialModelCatalog("/first", f.factory, 20)).toBeNull();
    const next = vi.fn(fixture(async () => ({ result: snapshot })).factory);
    const queued = probeInitialModelCatalog("/second", next, 100);
    expect(next).not.toHaveBeenCalled();
    releaseStartup(f.backend);
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(next).not.toHaveBeenCalled();
    releaseClose();
    expect(await queued).toEqual(snapshot);
    expect(next).toHaveBeenCalledOnce();
  });
  it("bounds queued requests while a timed-out startup remains hung", async () => {
    let releaseStartup!: (v: unknown) => void;
    const f = fixture(
      async () => ({ result: snapshot }),
      () =>
        new Promise((resolve) => {
          releaseStartup = resolve;
        }),
    );
    expect(await probeInitialModelCatalog("/hung", f.factory, 10)).toBeNull();
    const next = vi.fn(fixture(async () => ({ result: snapshot })).factory);
    const requests = Array.from({ length: 40 }, (_, i) =>
      probeInitialModelCatalog(`/waiting-${i}`, next, 20),
    );
    expect(await Promise.all(requests)).toEqual(Array(40).fill(null));
    expect(next).not.toHaveBeenCalled();
    releaseStartup(f.backend);
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(await probeInitialModelCatalog("/after", next, 100)).toEqual(snapshot);
  });
  it("falls back if startup crashes or returns a malformed session", async () => {
    const failed = fixture(
      async () => ({}),
      async () => {
        throw Error("spawn failed");
      },
    );
    expect(await probeInitialModelCatalog("/fixture", failed.factory, 100)).toBeNull();
    const malformed = fixture(async () => ({ result: { settings: {} } }));
    expect(await probeInitialModelCatalog("/fixture", malformed.factory, 100)).toBeNull();
    expect(malformed.close).toHaveBeenCalledOnce();
  });
  it("reaps a child installed on the server before startup throws", async () => {
    const close = vi.fn(async () => {});
    const server = {
      backend: null as unknown,
      ensureBackend: async () => {
        server.backend = { close };
        throw new Error("startup crashed after spawn");
      },
    };
    expect(
      await probeInitialModelCatalog(
        "/fixture",
        async () => server as unknown as ZcodeAcpServer,
        100,
      ),
    ).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });
  it("reaps an already spawned child even if startup remains pending at the deadline", async () => {
    const close = vi.fn(async () => {});
    let release!: (value: unknown) => void;
    const server = {
      backend: null as unknown,
      ensureBackend: () => {
        server.backend = { close };
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    };
    expect(
      await probeInitialModelCatalog(
        "/fixture",
        async () => server as unknown as ZcodeAcpServer,
        20,
      ),
    ).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    release(server.backend);
    await new Promise((resolve) => setImmediate(resolve));
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("ACP session/new", () => {
  it("falls back to local models when the live current is missing from the registry", async () => {
    const options = await buildInitialConfigOptions(new Server(), undefined, {
      session: { sessionId: "probe" },
      settings: {
        model: {
          current: { providerId: "fixture", modelId: "removed" },
          available: [{ ref: { providerId: "fixture", modelId: "available" } }],
        },
      },
    });
    expect(options.some((option) => option.id === "model")).toBe(true);
  });
  it("falls back to local models when a live registry has no selection", async () => {
    const options = await buildInitialConfigOptions(new Server(), undefined, {
      session: { sessionId: "probe" },
      settings: { model: { available: [] } },
    });
    expect(options.some((option) => option.id === "model")).toBe(true);
  });
});
