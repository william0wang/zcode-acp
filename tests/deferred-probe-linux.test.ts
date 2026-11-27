/**
 * Linux desktop-bundle gate (src/config/deferred-probe-capability.ts).
 *
 * Linux bundles carry no Info.plist: the audited entry is one of the bundled
 * locations, and the desktop version is the package.json inside app.asar —
 * the read the Windows branch already does. The locations are absolute
 * constants (/opt, /usr/lib), so a path overlay stands in for the packages: a
 * virtual path resolves to a real fixture file under the hermetic HOME.
 * `existsSync` answers from the overlay ALONE for the audited locations, so a
 * desktop bundle installed on the test machine cannot leak into a case.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The audited locations, hoisted with the overlay: vi.mock factories run
// before the module body, so they cannot read consts declared below them.
const { fs, DEB_ENTRY, SHARE_ENTRY, ARCH_ENTRY, MACOS_ENTRY } = vi.hoisted(() => ({
  fs: {
    /** Virtual path -> the real file that stands in for it. */
    files: new Map<string, string>(),
    /** While set, the audited locations answer from `files` alone. */
    masked: true,
  },
  DEB_ENTRY: "/opt/ZCode/resources/glm/zcode.cjs",
  SHARE_ENTRY: "/usr/share/zcode/resources/glm/zcode.cjs",
  ARCH_ENTRY: "/usr/lib/zcode/glm/zcode.cjs",
  MACOS_ENTRY: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = (name: string) => actual[name] as (...args: unknown[]) => unknown;
  const audited = new Set([DEB_ENTRY, SHARE_ENTRY, ARCH_ENTRY]);
  const standIn = (p: unknown) => fs.files.get(String(p)) ?? p;
  return {
    ...actual,
    existsSync: (p: unknown) => {
      const key = String(p);
      if (fs.files.has(key)) return true;
      if (fs.masked && audited.has(key)) return false;
      return real("existsSync")(p) as boolean;
    },
    readFileSync: (p: unknown, ...rest: unknown[]) => real("readFileSync")(standIn(p), ...rest),
    openSync: (p: unknown, ...rest: unknown[]) => real("openSync")(standIn(p), ...rest),
    // An overlaid path is a fixture: it is its own real path.
    realpathSync: (p: unknown, ...rest: unknown[]) =>
      fs.files.has(String(p)) ? p : real("realpathSync")(p, ...rest),
  };
});

import {
  boundDeferredProbeCommand,
  catalogProbeDiagnostic,
  deferredProbeCapabilityVerified,
  desktopBundleAtLeast,
  desktopBundleEntryPath,
  desktopBundleEntryPaths,
  desktopBundleVersion,
  resetDeferredProbeMemosForTests,
} from "../src/config/deferred-probe-capability.js";

const realPlatform = process.platform;
function onPlatform(platform: string, body: () => void): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    body();
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  }
}

/** Whether this machine has an audited Linux bundle, for one live case. */
function installedAuditedEntry(): string {
  if (realPlatform !== "linux") return "";
  fs.masked = false;
  let entry = "";
  try {
    entry = desktopBundleEntryPath();
    const PINS = new Set([
      "26785f28ab8fb9f8b0f3821f2bf71d294f4d0b8bf28108785292f86c7e14090d",
      "08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c",
      "0de95ddd65d7712a3beeccc8ee6de53ea0ce96338eb427e52b2717ba2f3afe19",
    ]);
    const digest = createHash("sha256").update(readFileSync(entry)).digest("hex");
    return PINS.has(digest) ? entry : "";
  } catch {
    return "";
  } finally {
    fs.masked = true;
  }
}
const localEntry = installedAuditedEntry();

let fixtures: string;
const savedBin = process.env.ZCODE_BIN;

beforeEach(() => {
  fixtures = mkdtempSync(path.join(process.env.HOME!, "linux-bundle-"));
  fs.files.clear();
  fs.masked = true;
  delete process.env.ZCODE_BIN;
  resetDeferredProbeMemosForTests();
});

afterEach(() => {
  fs.files.clear();
  fs.masked = true;
  resetDeferredProbeMemosForTests();
  if (savedBin === undefined) delete process.env.ZCODE_BIN;
  else process.env.ZCODE_BIN = savedBin;
});

function writeFixture(name: string, bytes: string | Buffer): string {
  const file = path.join(fixtures, name);
  writeFileSync(file, bytes);
  return file;
}

/** The minimal Electron archive `readAsarPackageVersion` accepts. */
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

/** Stand in for an installed Linux desktop app. The entry bytes are NOT an audited pin. */
function installBundle(layout: "deb" | "arch", version: string): void {
  const resources = layout === "deb" ? "/opt/ZCode/resources" : "/usr/lib/zcode";
  const entry = layout === "deb" ? DEB_ENTRY : ARCH_ENTRY;
  fs.files.set(entry, writeFixture(`${layout}-zcode.cjs`, "console.log('not the audited bundle')"));
  fs.files.set(`${resources}/app.asar`, writeAsar(version));
}

describe("Linux desktop bundle gate", () => {
  it("audits the deb/pacman and Arch locations in discovery order", () => {
    onPlatform("linux", () => {
      expect(desktopBundleEntryPaths()).toEqual([DEB_ENTRY, SHARE_ENTRY, ARCH_ENTRY]);
    });
  });

  it("keeps the single macOS entry on darwin", () => {
    onPlatform("darwin", () => {
      expect(desktopBundleEntryPaths()).toEqual([MACOS_ENTRY]);
      expect(desktopBundleEntryPath()).toBe(MACOS_ENTRY);
    });
  });

  it("keeps the LOCALAPPDATA entry on win32", () => {
    const localAppData = path.join(fixtures, "Local");
    onPlatform("win32", () => {
      vi.stubEnv("LOCALAPPDATA", localAppData);
      try {
        const expected = path.join(
          localAppData,
          "Programs",
          "ZCode",
          "resources",
          "glm",
          "zcode.cjs",
        );
        expect(desktopBundleEntryPaths()).toEqual([expected]);
        expect(desktopBundleEntryPath()).toBe(expected);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("picks the first audited entry on disk, else the first", () => {
    onPlatform("linux", () => {
      expect(desktopBundleEntryPath()).toBe(DEB_ENTRY);
      installBundle("arch", "4.0.0");
      expect(desktopBundleEntryPath()).toBe(ARCH_ENTRY);
      installBundle("deb", "4.0.0");
      expect(desktopBundleEntryPath()).toBe(DEB_ENTRY);
    });
  });

  it("follows an explicit ZCODE_BIN only when it is an audited entry", () => {
    installBundle("deb", "4.0.0");
    installBundle("arch", "3.18.2");
    onPlatform("linux", () => {
      process.env.ZCODE_BIN = ARCH_ENTRY;
      expect(desktopBundleEntryPath()).toBe(ARCH_ENTRY);
      expect(desktopBundleVersion()).toBe("3.18.2");
      process.env.ZCODE_BIN = "/custom/zcode.cjs";
      expect(desktopBundleEntryPath()).toBe(DEB_ENTRY);
      expect(desktopBundleVersion()).toBe("4.0.0");
    });
  });

  it("reads the desktop version from app.asar — deb layout", () => {
    installBundle("deb", "4.0.0");
    onPlatform("linux", () => {
      expect(desktopBundleVersion()).toBe("4.0.0");
      expect(desktopBundleAtLeast("4.0.0")).toBe(true);
      expect(desktopBundleAtLeast("4.1.0")).toBe(false);
    });
  });

  it("reads the desktop version from app.asar — Arch layout", () => {
    installBundle("arch", "3.18.2");
    onPlatform("linux", () => {
      expect(desktopBundleVersion()).toBe("3.18.2");
      expect(desktopBundleAtLeast("3.14.3")).toBe(true);
      expect(desktopBundleAtLeast("4.0.0")).toBe(false);
    });
  });

  it("reads an unpacked resources/app/package.json before the archive", () => {
    installBundle("deb", "3.18.2");
    fs.files.set(
      "/opt/ZCode/resources/app/package.json",
      writeFixture("unpacked-package.json", JSON.stringify({ version: "4.0.0" })),
    );
    onPlatform("linux", () => {
      expect(desktopBundleVersion()).toBe("4.0.0");
    });
  });

  it("fails closed when no Linux bundle exists", () => {
    onPlatform("linux", () => {
      expect(desktopBundleVersion()).toBeUndefined();
      expect(desktopBundleAtLeast("3.14.3")).toBe(false);
      expect(catalogProbeDiagnostic()).toBe("catalog probe: desktop bundle unavailable");
    });
  });

  it("doctor reports the bundle it found instead of 'unavailable'", () => {
    installBundle("deb", "4.0.0");
    onPlatform("linux", () => {
      expect(catalogProbeDiagnostic()).toMatch(
        /^catalog probe: version=4\.0\.0 sha256=[a-f0-9]{64} pin=mismatch$/,
      );
    });
  });

  it("still refuses the catalog probe for entry bytes that are not an audited pin", () => {
    installBundle("deb", "4.0.0");
    onPlatform("linux", () => {
      const argv = [process.execPath, DEB_ENTRY, "app-server", "--stdio"];
      expect(deferredProbeCapabilityVerified(argv)).toBe(false);
      expect(boundDeferredProbeCommand(argv)).toBeNull();
    });
  });

  it.runIf(localEntry !== "")("accepts the audited bundle installed on this machine", () => {
    fs.masked = false;
    try {
      expect(desktopBundleEntryPath()).toBe(localEntry);
      expect(
        deferredProbeCapabilityVerified([process.execPath, localEntry, "app-server", "--stdio"]),
      ).toBe(true);
    } finally {
      fs.masked = true;
    }
  });
});
