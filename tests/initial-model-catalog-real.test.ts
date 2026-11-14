import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { connect } from "node:net";
import { expect, it, vi } from "vitest";

// Run only inside the external Seatbelt harness: it denies the real HOME,
// all network and all Mach service lookups, including the OS keychain.
// Exercises the production capability check and bound loader without credentials.
it.runIf(process.env.ZCODE_CATALOG_REAL_TEST === "1")(
  "probes the real backend through the verified production launch",
  async () => {
    expect(process.env.ZCODE_CATALOG_COMPILED_ENTRY).toBeTruthy();
    let homeDenied = false;
    try {
      expect(process.env.ZCODE_CATALOG_PROTECTED_HOME).toBeTruthy();
      statSync(path.join(process.env.ZCODE_CATALOG_PROTECTED_HOME!, ".zcode/v2/config.json"));
    } catch (error) {
      homeDenied = ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");
    }
    expect(homeDenied).toBe(true);
    for (const protectedPath of [
      "/Library/Keychains",
      "/System/Library/Keychains",
      "/private/var/db",
    ]) {
      expect(() => statSync(protectedPath)).toThrow();
      try {
        statSync(protectedPath);
      } catch (error) {
        expect(["EPERM", "EACCES"]).toContain((error as NodeJS.ErrnoException).code);
      }
    }
    const deniedNetwork = await new Promise<boolean>((resolve) => {
      const socket = connect(9, "127.0.0.1");
      socket.on("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("error", (error: NodeJS.ErrnoException) =>
        resolve(["EPERM", "EACCES"].includes(error.code ?? "")),
      );
    });
    expect(deniedNetwork).toBe(true);
    expect(process.env.HOME).toMatch(
      /^\/private\/tmp\/zcode-catalog-test\.[^/]+\/tmp\/zacp-test-home-[^/]+$/,
    );
    const home = process.env.HOME!;
    process.chdir(home);
    const zhome = path.join(home, ".zcode");
    process.env.ZCODE_HOME = zhome;
    process.env.ZCODE_DATA_BASE_DIR = home;
    process.env.ZCODE_BIN = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
    process.env.ZCODE_NODE = process.execPath;
    const capability = await vi.importActual<
      typeof import("../src/config/deferred-probe-capability.js")
    >("../src/config/deferred-probe-capability.js");
    const { resolveZcodeCommand } = await import("../src/backend/resolve.js");
    expect(capability.deferredProbeCapabilityVerified(resolveZcodeCommand())).toBe(true);
    const v2 = path.join(zhome, "v2");
    mkdirSync(v2, { recursive: true });
    writeFileSync(
      path.join(v2, "config.json"),
      JSON.stringify({
        provider: {
          "builtin:bigmodel-coding-plan": {
            enabled: true,
            options: { apiKey: "synthetic" },
            models: { "stale-model": {} },
          },
        },
      }),
    );
    writeFileSync(
      path.join(v2, "provider_config.json"),
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "fixture-provider",
                providerName: "Fixture",
                enabled: true,
                config: {
                  api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:9/v1" },
                  access: { type: "api-key", apiKey: "synthetic" },
                  personalModelIds: ["live-model"],
                },
              },
            ],
          },
          modelConfigRules: {
            providerModelRules: [
              { providerId: "fixture-provider", modelId: "live-model", config: { enabled: true } },
            ],
            manualProviderModelRules: [],
          },
        },
      }),
    );
    const { probeInitialModelCatalog } = await import("../src/config/initial-model-catalog.js");
    const marker = path.join(home, "preload-ran");
    const preload = path.join(home, "preload.cjs");
    writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`);
    process.env.NODE_OPTIONS = `--require=${preload}`;
    let snapshot;
    try {
      snapshot = await probeInitialModelCatalog(home, undefined, 25000);
    } finally {
      delete process.env.NODE_OPTIONS;
    }
    expect(existsSync(marker)).toBe(false);
    expect(snapshot?.session.sessionId).toBeTruthy();
    expect(snapshot?.settings?.model?.available?.length).toBeGreaterThan(0);
    // A fresh process must produce the same catalog after a timed-out probe.
    expect(await probeInitialModelCatalog(home, undefined, 1)).toBeNull();
    // A timed-out startup retains the global slot until its child exits.
    // Wait for that cleanup instead of assuming it finishes in one tick.
    let recovered = await probeInitialModelCatalog(home, undefined, 25000);
    const recoveryDeadline = Date.now() + 10000;
    while (!recovered && Date.now() < recoveryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      recovered = await probeInitialModelCatalog(home, undefined, 25000);
    }
    expect(recovered?.settings?.model?.available).toEqual(snapshot?.settings?.model?.available);
    const child = spawn(process.execPath, [process.env.ZCODE_CATALOG_COMPILED_ENTRY!], {
      cwd: home,
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = createInterface({ input: child.stdout });
    const responses = new Map<number, (message: any) => void>();
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      responses.get(message.id)?.(message);
    });
    const request = (id: number, method: string, params: object) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 25000);
        responses.set(id, (message) => {
          clearTimeout(timer);
          responses.delete(id);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    let response: any;
    try {
      const initialized = await request(1, "initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      expect(initialized.error).toBeUndefined();
      const created = await request(2, "session/new", { cwd: home, mcpServers: [] });
      expect(created.error).toBeUndefined();
      response = created.result;
    } finally {
      child.stdin.end();
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      lines.close();
    }
    const model = response.configOptions?.find((item) => item.id === "model");
    expect(model?.type).toBe("select");
    if (model?.type !== "select") throw Error("model option missing");
    const values = model.options.flatMap((item) =>
      "value" in item ? [item.value] : item.options.map((option) => option.value),
    );
    const expected = snapshot!.settings!.model!.available!.map(
      (item) => `${item.ref!.providerId}\\${item.ref!.modelId}`,
    );
    expect(values).toEqual(expect.arrayContaining(expected));
    expect(values.some((value) => value.includes("stale-model"))).toBe(false);
    expect(response.sessionId).toBeTruthy();
    const { DatabaseSync } = createRequire(import.meta.url)(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const db = new DatabaseSync(path.join(zhome, "cli", "db", "db.sqlite"), { readOnly: true });
    try {
      for (const table of [
        "session",
        "session_entry",
        "session_input",
        "session_runtime_presence",
      ]) {
        const row = db.prepare(`SELECT count(*) AS n FROM "${table}"`).get();
        expect(row?.n, table).toBe(0);
      }
    } finally {
      db.close();
    }
  },
  65000,
);
