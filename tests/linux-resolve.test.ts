/**
 * Linux CLI discovery (src/backend/resolve.ts).
 *
 * Linux packages put the DESKTOP launcher on PATH as `zcode`, so PATH-first
 * discovery launched the GUI as the backend. `which`, the node probes and the
 * platform are stubbed, and a path overlay stands in for the packages (a
 * virtual path resolves to a real fixture under the hermetic HOME). The bundled
 * locations answer from the overlay ALONE, so a desktop app installed on the
 * test machine cannot leak into a case.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The bundled locations, hoisted with the fakes: vi.mock factories run before
// the module body, so they cannot read consts declared below them.
const { fake, execFileSyncMock, DEB_ENTRY, ARCH_ENTRY, MACOS_ENTRY } = vi.hoisted(() => ({
  fake: {
    /** Virtual path -> the real file that stands in for it. */
    files: new Map<string, string>(),
    /** Virtual symlink -> its target. */
    links: new Map<string, string>(),
    /** What `which zcode` answers; null when nothing is on PATH. */
    onPath: null as string | null,
  },
  execFileSyncMock: vi.fn(),
  DEB_ENTRY: "/opt/ZCode/resources/glm/zcode.cjs",
  ARCH_ENTRY: "/usr/lib/zcode/glm/zcode.cjs",
  MACOS_ENTRY: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFileSync: execFileSyncMock,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = (name: string) => actual[name] as (...args: unknown[]) => unknown;
  const bundled = new Set([
    MACOS_ENTRY,
    DEB_ENTRY,
    "/usr/share/zcode/resources/glm/zcode.cjs",
    ARCH_ENTRY,
  ]);
  const standIn = (p: unknown) => fake.files.get(String(p)) ?? p;
  return {
    ...actual,
    existsSync: (p: unknown) => {
      const key = String(p);
      if (fake.files.has(key)) return true;
      return !bundled.has(key) && (real("existsSync")(p) as boolean);
    },
    readFileSync: (p: unknown, ...rest: unknown[]) => real("readFileSync")(standIn(p), ...rest),
    openSync: (p: unknown, ...rest: unknown[]) => real("openSync")(standIn(p), ...rest),
    realpathSync: (p: unknown, ...rest: unknown[]) =>
      fake.links.get(String(p)) ??
      (fake.files.has(String(p)) ? p : real("realpathSync")(p, ...rest)),
  };
});

execFileSyncMock.mockImplementation((file: string, args: readonly string[]) => {
  if (file === "which") return args[0] === "zcode" ? (fake.onPath ?? "") : process.execPath;
  // The node ladder: its --version lookup and the sqlite/sea module probe.
  if (file === process.execPath) return args[0] === "--version" ? "v22.0.0" : "";
  throw new Error(`unexpected execFileSync: ${file} ${args.join(" ")}`);
});

import {
  bundledZcodeCandidates,
  builtinProviderEnv,
  resetResolveMemosForTests,
  resolveZcodeCommand,
} from "../src/backend/resolve.js";
import { desktopBundleEntryPaths } from "../src/config/deferred-probe-capability.js";

const realPlatform = process.platform;
function onPlatform(platform: string, body: () => void): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    body();
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  }
}

const SAVED = {
  ZCODE_BIN: process.env.ZCODE_BIN,
  ZCODE_APP_VERSION: process.env.ZCODE_APP_VERSION,
};
let fixtures: string;

beforeEach(() => {
  fixtures = mkdtempSync(path.join(process.env.HOME!, "linux-resolve-"));
  fake.files.clear();
  fake.links.clear();
  fake.onPath = "/usr/bin/zcode";
  delete process.env.ZCODE_BIN;
  delete process.env.ZCODE_APP_VERSION;
  resetResolveMemosForTests();
});

afterEach(() => {
  fake.files.clear();
  fake.links.clear();
  resetResolveMemosForTests();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function writeFixture(name: string, bytes: string | Buffer): string {
  const file = path.join(fixtures, name);
  writeFileSync(file, bytes);
  return file;
}

/** The minimal Electron archive the asar reader accepts. */
function writeAsar(version: string): string {
  const pkgBytes = Buffer.from(JSON.stringify({ name: "@zcode/desktop", version }), "utf8");
  const headerJson = Buffer.from(
    JSON.stringify({ files: { "package.json": { size: pkgBytes.length, offset: "0" } } }),
    "utf8",
  );
  const alignedLen = (headerJson.length + 3) & ~3;
  const sizeBuf = Buffer.alloc(16);
  sizeBuf.writeUInt32LE(4, 0);
  sizeBuf.writeUInt32LE(8 + alignedLen, 4);
  sizeBuf.writeUInt32LE(4 + alignedLen, 8);
  sizeBuf.writeUInt32LE(headerJson.length, 12);
  return writeFixture(
    `app-${version}.asar`,
    Buffer.concat([sizeBuf, headerJson, Buffer.alloc(alignedLen - headerJson.length), pkgBytes]),
  );
}

const RELEASE = JSON.stringify({
  schemaVersion: 1,
  revision: 1,
  config: { providerConfigRules: [], modelConfigRules: [] },
});

/** Stand in for an installed Linux desktop app: entry, provider table, app.asar. */
function installDesktop(layout: "deb" | "arch", version = "4.0.0"): void {
  const resources = layout === "deb" ? "/opt/ZCode/resources" : "/usr/lib/zcode";
  const entry = layout === "deb" ? DEB_ENTRY : ARCH_ENTRY;
  fake.files.set(entry, writeFixture(`${layout}-zcode.cjs`, "console.log('zcode')"));
  fake.files.set(
    `${resources}/config/provider/zcode-builtin.json`,
    writeFixture(`${layout}-zcode-builtin.json`, RELEASE),
  );
  fake.files.set(`${resources}/app.asar`, writeAsar(version));
}

describe("bundledZcodeCandidates on Linux", () => {
  it("carries every location the bundle gate audits, in the gate's order", () => {
    onPlatform("linux", () => {
      const gate = desktopBundleEntryPaths();
      const discovery = bundledZcodeCandidates().filter((c) => gate.includes(c));
      expect(discovery).toEqual(gate);
      expect(discovery).toEqual([
        DEB_ENTRY,
        "/usr/share/zcode/resources/glm/zcode.cjs",
        ARCH_ENTRY,
      ]);
    });
  });
});

describe("discoverZcodeBin on Linux", () => {
  it("lets a desktop launcher on PATH yield to the bundled zcode.cjs (deb layout)", () => {
    installDesktop("deb");
    onPlatform("linux", () => {
      const argv = resolveZcodeCommand();
      expect(argv[0]).toBe(process.execPath);
      expect(argv).toContain(DEB_ENTRY);
      expect(argv).not.toContain("/usr/bin/zcode");
    });
  });

  it("lets a desktop launcher on PATH yield to the bundled zcode.cjs (Arch layout)", () => {
    installDesktop("arch");
    onPlatform("linux", () => {
      expect(resolveZcodeCommand()).toContain(ARCH_ENTRY);
    });
  });

  it("lets a symlink to the desktop launcher yield too (the deb's /usr/bin/zcode)", () => {
    installDesktop("deb");
    fake.links.set("/usr/bin/zcode", "/opt/ZCode/zcode");
    onPlatform("linux", () => {
      const argv = resolveZcodeCommand();
      expect(argv).toContain(DEB_ENTRY);
      expect(argv).not.toContain("/usr/bin/zcode");
    });
  });

  it("still uses the launcher as-is when no bundle exists", () => {
    onPlatform("linux", () => {
      const argv = resolveZcodeCommand();
      expect(argv[0]).toBe("/usr/bin/zcode");
      expect(argv.slice(1, 3)).toEqual(["app-server", "--stdio"]);
    });
  });

  it("keeps PATH first for a JS entry (an npm-style CLI)", () => {
    installDesktop("deb");
    fake.onPath = "/usr/local/bin/zcode.js";
    onPlatform("linux", () => {
      // PATH first means the entry, not argv[0]: a JS entry goes through the explicit node.
      const argv = resolveZcodeCommand();
      expect(argv[0]).toBe(process.execPath);
      expect(argv).toContain("/usr/local/bin/zcode.js");
      expect(argv).not.toContain(DEB_ENTRY);
    });
  });

  it("keeps PATH first for a symlink whose target is a JS entry (npm's bin link)", () => {
    installDesktop("deb");
    fake.onPath = "/usr/local/bin/zcode";
    fake.links.set("/usr/local/bin/zcode", "/usr/local/lib/node_modules/@zcode/cli/dist/cli.js");
    onPlatform("linux", () => {
      // Used as-is on its own shebang, not through the explicit node.
      expect(resolveZcodeCommand()[0]).toBe("/usr/local/bin/zcode");
    });
  });

  it("keeps PATH first off Linux", () => {
    installDesktop("deb");
    onPlatform("darwin", () => {
      expect(resolveZcodeCommand()[0]).toBe("/usr/bin/zcode");
    });
  });

  it("still honors ZCODE_BIN first", () => {
    installDesktop("deb");
    process.env.ZCODE_BIN = "/custom/zcode.cjs";
    process.env.ZCODE_NODE = process.execPath;
    try {
      onPlatform("linux", () => {
        const argv = resolveZcodeCommand();
        expect(argv[0]).toBe(process.execPath);
        expect(argv).toContain("/custom/zcode.cjs");
      });
    } finally {
      if (SAVED.ZCODE_NODE === undefined) delete process.env.ZCODE_NODE;
      else process.env.ZCODE_NODE = SAVED.ZCODE_NODE;
    }
  });
});

describe("discoverZcodeBin memo", () => {
  const whichLookups = () =>
    execFileSyncMock.mock.calls.filter(([file, args]) => file === "which" && args[0] === "zcode")
      .length;

  it("asks `which` once for a CLI it found, however often the env is built", () => {
    installDesktop("arch");
    execFileSyncMock.mockClear();
    onPlatform("linux", () => {
      for (let i = 0; i < 5; i++) {
        const env = builtinProviderEnv();
        expect(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toContain("/usr/lib/zcode");
      }
    });
    expect(whichLookups()).toBe(1);
  });

  it("keeps looking while nothing is found, so a first install is still noticed", () => {
    fake.onPath = null;
    execFileSyncMock.mockClear();
    onPlatform("linux", () => {
      for (let i = 0; i < 3; i++) expect(builtinProviderEnv()).toEqual({});
      expect(whichLookups()).toBe(3);
      installDesktop("arch");
      expect(builtinProviderEnv().ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toContain("/usr/lib/zcode");
    });
    expect(whichLookups()).toBe(4);
  });

  it("looks again once PATH changes", () => {
    fake.onPath = "/usr/local/bin/zcode.js";
    try {
      onPlatform("linux", () => {
        expect(resolveZcodeCommand()).toContain("/usr/local/bin/zcode.js");
        vi.stubEnv("PATH", "/opt/tools/bin");
        fake.onPath = "/opt/tools/bin/zcode.cjs";
        expect(resolveZcodeCommand()).toContain("/opt/tools/bin/zcode.cjs");
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("builtinProviderEnv on Linux", () => {
  it("injects the provider table and app version next to the deb bundle", () => {
    installDesktop("deb");
    onPlatform("linux", () => {
      const env = builtinProviderEnv();
      expect(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe(
        "/opt/ZCode/resources/config/provider/zcode-builtin.json",
      );
      expect(env.ZCODE_APP_VERSION).toBe("4.0.0");
      expect(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBeTruthy();
    });
  });

  it("injects the provider table and app version next to the Arch bundle", () => {
    installDesktop("arch", "3.18.2");
    onPlatform("linux", () => {
      const env = builtinProviderEnv();
      expect(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe(
        "/usr/lib/zcode/config/provider/zcode-builtin.json",
      );
      expect(env.ZCODE_APP_VERSION).toBe("3.18.2");
    });
  });
});
