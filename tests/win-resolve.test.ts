/**
 * Windows discovery unit tests for backend/resolve.ts.
 *
 * These pin the win32 branches added for the Windows adaptation: the
 * PATHEXT-aware PATH scan, the platform-aware node candidate list, and the
 * desktop bundle locations (both the per-user LOCALAPPDATA layout and the
 * machine-wide Program Files layout this machine actually uses).
 */

import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  bundledZcodeCandidates,
  candidateNodeBinaries,
  resolveZcodeCommand,
  windowsPathWhich,
} from "../src/backend/resolve.js";

const isWin = process.platform === "win32";

describe("windowsPathWhich", () => {
  it.skipIf(!isWin)("finds node on PATH with its real extension", () => {
    const found = windowsPathWhich("node");
    expect(found).toBeTruthy();
    expect(found!.toLowerCase()).toMatch(/node\.exe$/);
    expect(existsSync(found!)).toBe(true);
  });

  it.skipIf(!isWin)("resolves a .cmd shim (zcode-style launcher)", () => {
    // A temp dir with a fake .cmd on PATH proves the PATHEXT scan works.
    const tmp = mkdtempSync(path.join(os.tmpdir(), "which-"));
    const shim = path.join(tmp, "fakebin.cmd");
    writeFileSync(shim, "@echo ok\r\n");
    const prevPath = process.env.PATH;
    const prevExt = process.env.PATHEXT;
    process.env.PATH = tmp;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    try {
      const found = windowsPathWhich("fakebin");
      expect(found?.toLowerCase()).toBe(shim.toLowerCase());
    } finally {
      process.env.PATH = prevPath;
      process.env.PATHEXT = prevExt;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(!isWin)("returns null for a binary that does not exist", () => {
    expect(windowsPathWhich("definitely-not-a-real-bin-xyz")).toBeNull();
  });
});

describe("candidateNodeBinaries", () => {
  it.skipIf(!isWin)("includes the bridge's own executable first (non-Electron)", () => {
    const cands = candidateNodeBinaries();
    // On this machine the system node IS the Program Files install, so the
    // dedupe may legitimately collapse the list to one entry.
    expect(cands[0]).toBe(process.execPath);
    expect(cands.length).toBeGreaterThanOrEqual(1);
    expect(cands.some((c) => /nodejs[/\\]node\.exe$/i.test(c))).toBe(true);
  });

  it("never repeats a candidate", () => {
    const seen = new Set(candidateNodeBinaries());
    expect(seen.size).toBe(candidateNodeBinaries().length);
  });
});

describe("bundledZcodeCandidates", () => {
  it.skipIf(!isWin)("covers both Windows install layouts", () => {
    const cands = bundledZcodeCandidates();
    expect(
      cands.some((c) => c.toLowerCase().includes("localappdata") || /appdata[/\\]local/i.test(c)),
    ).toBe(true);
    expect(cands.some((c) => /program files[/\\]zcode/i.test(c))).toBe(true);
  });
});

describe("resolveZcodeCommand", () => {
  it("launches a .cjs entry through an explicit sqlite-capable node", { timeout: 30000 }, () => {
    // Deterministic inputs (tests/resolve.test.ts pattern): bare discovery
    // depends on the machine having the desktop app or zcode on PATH — a
    // CI runner has neither, so the resolver legitimately falls back to the
    // bare `zcode` name and the node assertion below would fail there.
    const prevBin = process.env.ZCODE_BIN;
    const prevNode = process.env.ZCODE_NODE;
    process.env.ZCODE_BIN = "/nonexistent/zcode.cjs";
    process.env.ZCODE_NODE = process.execPath;
    try {
      const argv = resolveZcodeCommand();
      expect(argv.length).toBeGreaterThanOrEqual(4);
      expect(argv[0]!.toLowerCase()).toMatch(/node(\.exe)?$/);
      expect(argv).toContain("app-server");
      expect(argv).toContain("--stdio");
      expect(argv.some((a) => /zcode(\.cjs)?$/i.test(a))).toBe(true);
    } finally {
      if (prevBin === undefined) delete process.env.ZCODE_BIN;
      else process.env.ZCODE_BIN = prevBin;
      if (prevNode === undefined) delete process.env.ZCODE_NODE;
      else process.env.ZCODE_NODE = prevNode;
    }
  });

  it.skipIf(!isWin)("resolves the real desktop zcode.cjs on this machine layout", () => {
    const desktop = "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs";
    if (!existsSync(desktop)) return; // layout guard for other machines
    const prev = process.env.ZCODE_BIN;
    process.env.ZCODE_BIN = desktop;
    try {
      const argv = resolveZcodeCommand();
      expect(argv[0]!.toLowerCase()).toMatch(/node(\.exe)?$/);
      expect(argv.some((a) => a.toLowerCase() === desktop.toLowerCase())).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ZCODE_BIN;
      else process.env.ZCODE_BIN = prev;
    }
  });
});

describe("builtinProviderEnv", () => {
  it.skipIf(!isWin)("injects both provider-table env vars next to the desktop bundle", async () => {
    const desktop = "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs";
    if (!existsSync(desktop)) return;
    const { builtinProviderEnv } = await import("../src/backend/resolve.js");
    const env = builtinProviderEnv(desktop);
    expect(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.toLowerCase()).toContain(
      "config\\provider\\zcode-builtin.json",
    );
    expect(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ?? "").toBeTruthy();
  });
});

afterAll(() => {
  // env restoration is per-test; nothing global to clean
});
