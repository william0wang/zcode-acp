import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { warn } from "../utils.js";

// Only these desktop bundle version/hash pairs are audited; the CLI version
// is unrelated. Unknown versions, other platforms, paths and builds fail closed.
// The entry bytes are pinned, not the Node interpreter or dynamically loaded resources.
const MACOS_ENTRY = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const AUDITED: Readonly<Record<string, string>> = {
  "3.18.0": "26785f28ab8fb9f8b0f3821f2bf71d294f4d0b8bf28108785292f86c7e14090d",
  "3.18.2": "08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c",
  "4.0.0": "0de95ddd65d7712a3beeccc8ee6de53ea0ce96338eb427e52b2717ba2f3afe19",
};

/** Desktop-bundled zcode.cjs path for the active platform. */
export function desktopBundleEntryPath(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs");
  }
  return MACOS_ENTRY;
}

export function auditedBundleMatches(version: string, digest: string): boolean {
  return Object.hasOwn(AUDITED, version) && AUDITED[version] === digest;
}

/** Per-process bundle-state memo: the Info.plist / app.asar read + bundle sha256
 * dominate the capability check, which every session/new flight pays even on machines
 * the probe refuses to cover. A desktop update mid-process is served by the
 * next bridge restart (the same trade as the per-generation backend verdicts)
 * — and the mismatch warn below then fires once per process, not per session. */
let bundleStateMemo: { entry: string; version?: string; digest: string } | null = null;

/** Test hook — drop the per-process bundle-state memos. */
export function resetDeferredProbeMemosForTests(): void {
  bundleStateMemo = null;
  bundleVersionMemo = null;
}

/** Read `package.json` version from an Electron app.asar header without buffering the archive. */
export function readAsarPackageVersion(asarPath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(asarPath, "r");
    const sizeBuf = Buffer.alloc(16);
    if (readSync(fd, sizeBuf, 0, 16, 0) !== 16) return undefined;
    const headerSize = sizeBuf.readUInt32LE(4) + 8;
    const jsonLen = sizeBuf.readUInt32LE(12);
    if (jsonLen <= 0 || jsonLen > 16 * 1024 * 1024) return undefined;
    const headerBuf = Buffer.alloc(jsonLen);
    if (readSync(fd, headerBuf, 0, jsonLen, 16) !== jsonLen) return undefined;
    const header = JSON.parse(headerBuf.toString("utf8")) as {
      files?: Record<string, { size?: number; offset?: string }>;
    };
    const pkgNode = header.files?.["package.json"];
    if (!pkgNode || typeof pkgNode.size !== "number" || pkgNode.offset === undefined) {
      return undefined;
    }
    const pkgBuf = Buffer.alloc(pkgNode.size);
    const offset = headerSize + Number(pkgNode.offset);
    if (readSync(fd, pkgBuf, 0, pkgNode.size, offset) !== pkgNode.size) return undefined;
    const pkg = JSON.parse(pkgBuf.toString("utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readDesktopBundleVersion(entry: string): string | undefined {
  if (process.platform === "win32") {
    const resourcesDir = path.dirname(path.dirname(entry));
    const unpackedPkg = path.join(resourcesDir, "app", "package.json");
    if (existsSync(unpackedPkg)) {
      const pkg = JSON.parse(readFileSync(unpackedPkg, "utf8")) as { version?: unknown };
      return typeof pkg.version === "string" ? pkg.version : undefined;
    }
    return readAsarPackageVersion(path.join(resourcesDir, "app.asar"));
  }
  const plist = readFileSync(path.join(path.dirname(entry), "../../Info.plist"), "utf8");
  return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist)?.[1];
}

function bundleState(entry = desktopBundleEntryPath()): { version?: string; digest: string } {
  if (!bundleStateMemo || bundleStateMemo.entry !== entry) {
    const version = readDesktopBundleVersion(entry);
    const digest = createHash("sha256").update(readFileSync(entry)).digest("hex");
    bundleStateMemo = { entry, version, digest };
  }
  return bundleStateMemo;
}

/** Per-process bundle-VERSION memo (no entry hashing — capability gates that
 * only need the version must not pay the sha256 of the whole bundle). */
let bundleVersionMemo: { entry: string; version?: string } | null = null;

/** Desktop bundle version, or undefined when unreadable (non-desktop setups). */
export function desktopBundleVersion(entry = desktopBundleEntryPath()): string | undefined {
  if (!bundleVersionMemo || bundleVersionMemo.entry !== entry) {
    let version: string | undefined;
    try {
      version = readDesktopBundleVersion(entry);
    } catch {
      version = undefined;
    }
    bundleVersionMemo = { entry, version };
  }
  return bundleVersionMemo.version;
}

/** Numeric segment compare of dot-separated version strings. */
function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(".").map((s) => Number.parseInt(s, 10));
  const b = min.split(".").map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return true;
}

/**
 * Whether the desktop bundle's version is >= `min`. Used by capability gates
 * that must answer at `initialize` — before any backend exists to probe —
 * against a source-verified version floor. Fail closed: an unreadable bundle
 * (non-desktop setups) answers false, never a wrong claim of support.
 */
export function desktopBundleAtLeast(min: string): boolean {
  const version = desktopBundleVersion();
  return version !== undefined && versionAtLeast(version, min);
}

/** Read-only bundle pin diagnostics; no backend or user state is opened. */
export function catalogProbeDiagnostic(): string {
  try {
    const { version, digest } = bundleState();
    return `catalog probe: version=${version ?? "unknown"} sha256=${digest} pin=${auditedBundleMatches(version ?? "", digest) ? "match" : "mismatch"}`;
  } catch {
    return "catalog probe: desktop bundle unavailable";
  }
}

function parseEntryIndex(argv: readonly string[] | undefined, entry: string): number {
  if (!argv || argv.length < 4) return -1;
  // Do not trust wrappers, interpreter flags or aliases to an arbitrary CLI.
  if (realpathSync(argv[0]!) !== realpathSync(process.execPath)) return -1;
  let index = 1;
  if (argv[index] === "--no-network-family-autoselection") index++;
  if (argv[index] === "--dns-result-order=ipv4first") index++;
  if (argv[index + 1] !== "app-server" || argv[index + 2] !== "--stdio") return -1;
  const tail = argv.slice(index + 3);
  if (tail.length !== 0 && !(tail.length === 2 && tail[0] === "--disallowed-tools" && tail[1]))
    return -1;
  const candidate = argv[index];
  if (!candidate) return -1;
  if (process.platform === "win32") {
    const resolvedEntry = path.resolve(entry);
    if (path.resolve(candidate).toLowerCase() !== resolvedEntry.toLowerCase()) return -1;
    const realEntry = realpathSync(entry);
    if (
      realpathSync(candidate) !== realEntry ||
      realEntry.toLowerCase() !== resolvedEntry.toLowerCase()
    ) {
      return -1;
    }
    return index;
  }
  if (candidate !== entry || realpathSync(entry) !== entry) return -1;
  return index;
}

/** Identity is necessary, but is not an authorization to access a data store. */
function verifiedDigest(
  argv?: readonly string[],
): { entry: string; index: number; digest: string } | null {
  try {
    const entry = desktopBundleEntryPath();
    const index = parseEntryIndex(argv, entry);
    if (index < 0) return null;
    const { version, digest: actual } = bundleState(entry);
    const expected = version ? AUDITED[version] : undefined;
    if (!version || !auditedBundleMatches(version, actual)) {
      warn(`Deferred catalog probe pin mismatch: version=${version ?? "unknown"} sha256=${actual}`);
      return null;
    }
    return expected ? { entry, index, digest: expected } : null;
  } catch {
    return null;
  }
}

export function deferredProbeCapabilityVerified(argv?: readonly string[]): boolean {
  return verifiedDigest(argv) !== null;
}

/** Read, verify and execute the same bytes inside the child, retaining the
 * original filename for bundled resource and relative module resolution. */
export function boundDeferredProbeCommand(argv: readonly string[]): string[] | null {
  const verified = verifiedDigest(argv);
  if (!verified) return null;
  const { entry, index, digest } = verified;
  const loader = `
    const fs = require("node:fs"), crypto = require("node:crypto"), Module = require("node:module"), path = require("node:path");
    const filename = ${JSON.stringify(entry)};
    const bytes = fs.readFileSync(filename);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== ${JSON.stringify(digest)}) process.exit(78);
    const main = new Module(filename);
    main.id = "."; main.filename = filename; main.paths = Module._nodeModulePaths(path.dirname(filename));
    process.mainModule = main; Module._cache[filename] = main;
    main._compile(bytes.toString("utf8"), filename);
    main.loaded = true;
  `;
  return [argv[0]!, ...argv.slice(1, index), "-e", loader, ...argv.slice(index)];
}
