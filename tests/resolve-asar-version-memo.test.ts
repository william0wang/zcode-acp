import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The version inside app.asar is parsed once per archive. `builtinProviderEnv`
// reads it on every call and the provider-table readers call that in loops, so
// an unmemoized parse put the whole header read on each lookup (about 16 ms on
// the Linux desktop 4.0.0 bundle).
//
// resolve.ts imports readSync from node:fs by name, so the read counter has to
// replace that named export.
const { readSyncMock } = vi.hoisted(() => ({ readSyncMock: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  readSyncMock.mockImplementation(actual.readSync);
  return { ...actual, readSync: readSyncMock };
});

import {
  APP_VERSION_ENV,
  builtinProviderEnv,
  resetResolveMemosForTests,
} from "../src/backend/resolve.js";

const SAVED_APP_VERSION = process.env.ZCODE_APP_VERSION;
let scratch: string;

/** The bundle layout readDesktopAppVersion falls back to app.asar for. */
function makeBundle(resources: string, version: string): string {
  const glm = path.join(resources, "glm");
  mkdirSync(path.join(resources, "config", "provider"), { recursive: true });
  mkdirSync(glm, { recursive: true });
  writeFileSync(path.join(glm, "zcode.cjs"), "// fake cli");
  writeFileSync(path.join(resources, "config", "provider", "zcode-builtin.json"), "{}");
  writeAsar(path.join(resources, "app.asar"), version);
  return path.join(glm, "zcode.cjs");
}

/** A minimal Electron archive whose package.json carries `version`. `pad`
 * grows that file without touching the version, so two archives can differ in
 * size and stay distinguishable on a filesystem with coarse timestamps. */
function writeAsar(file: string, version: string, pad = 0): void {
  const name = "@zcode/desktop".padEnd("@zcode/desktop".length + pad, " ");
  const pkgBytes = Buffer.from(JSON.stringify({ name, version }));
  const headerBytes = Buffer.from(
    JSON.stringify({ files: { "package.json": { size: pkgBytes.length, offset: "0" } } }),
  );
  const alignedHeaderLen = Math.ceil(headerBytes.length / 4) * 4;
  const pre = Buffer.alloc(16);
  pre.writeUInt32LE(4, 0);
  pre.writeUInt32LE(8 + alignedHeaderLen, 4);
  pre.writeUInt32LE(4 + alignedHeaderLen, 8);
  pre.writeUInt32LE(headerBytes.length, 12);
  const paddedHeader = Buffer.alloc(alignedHeaderLen);
  headerBytes.copy(paddedHeader);
  writeFileSync(file, Buffer.concat([pre, paddedHeader, pkgBytes]));
}

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "zcode-asar-version-"));
  delete process.env.ZCODE_APP_VERSION;
  readSyncMock.mockClear();
  resetResolveMemosForTests();
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (SAVED_APP_VERSION === undefined) delete process.env.ZCODE_APP_VERSION;
  else process.env.ZCODE_APP_VERSION = SAVED_APP_VERSION;
});

describe("app.asar version memo", () => {
  it("parses the archive header once, however often the env is built", () => {
    const entry = makeBundle(path.join(scratch, "resources"), "4.0.0");
    expect(builtinProviderEnv(entry)[APP_VERSION_ENV]).toBe("4.0.0");
    // prelude, header, package.json
    expect(readSyncMock).toHaveBeenCalledTimes(3);

    readSyncMock.mockClear();
    for (let i = 0; i < 20; i++) builtinProviderEnv(entry);

    expect(readSyncMock).not.toHaveBeenCalled();
    expect(builtinProviderEnv(entry)[APP_VERSION_ENV]).toBe("4.0.0");
  });

  it("reads the new version once the archive is replaced", () => {
    const resources = path.join(scratch, "resources");
    const entry = makeBundle(resources, "4.0.0");
    expect(builtinProviderEnv(entry)[APP_VERSION_ENV]).toBe("4.0.0");

    writeAsar(path.join(resources, "app.asar"), "3.18.2", 1);

    expect(builtinProviderEnv(entry)[APP_VERSION_ENV]).toBe("3.18.2");
  });

  it("reads the new version after a same-size, in-place rewrite", () => {
    const resources = path.join(scratch, "resources");
    const entry = makeBundle(resources, "4.0.0");
    expect(builtinProviderEnv(entry)[APP_VERSION_ENV]).toBe("4.0.0");

    // A version bump keeps the byte length (4.0.0 -> 4.0.1): the rewrite is in
    // place and the size does not change, so only the timestamps differ.
    const asar = path.join(resources, "app.asar");
    const sizeBefore = statSync(asar).size;
    writeAsar(asar, "4.0.1");
    expect(statSync(asar).size).toBe(sizeBefore);

    expect(builtinProviderEnv(entry)[APP_VERSION_ENV]).toBe("4.0.1");
  });
});
