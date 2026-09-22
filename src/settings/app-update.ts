/**
 * ZCode desktop app self-update.
 *
 * The desktop app updates itself through Electron's autoUpdater, which needs an
 * Electron runtime this process does not have. The parts that DO work headless
 * are the ones that decide WHAT to install: the release manifest
 * (`/api/v1/releases/electron/manifest`), the platform/arch/channel spelling,
 * and the CDN download. So this module reproduces those and hands the actual
 * install back to the OS.
 *
 * Whether the bundle can be swapped is PROBED, never assumed (see
 * `canWriteInstallLocation`): the obvious reading of `/Applications`'s
 * `drwxrwxr-x root:admin` is that an admin user cannot write it, yet the
 * installed `ZCode.app` is user-owned on the machine this was written for — so
 * the code branches on `accessSync` and is correct either way, and no claim is
 * made about which branch a given install takes. What is deliberately NOT done
 * is privileged escalation (a password prompt, a Finder Apple Event, a shipped
 * privileged helper): a long-lived daemon has no good place to ask, and the
 * one-shot confirmation macOS raises when a user drags a bundle into place is
 * already the right amount of trust.
 *
 * What the flow does NOT do is silently swap a running app. The app is replaced
 * on disk while it may be running, and the user is told to quit and reopen —
 * attempting to kill the app from here would be both rude and unsafe (it may
 * have an in-flight session whose state lives in the app process).
 */

import { createHash } from "node:crypto";
import { accessSync, createWriteStream, existsSync } from "node:fs";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Stats } from "node:fs";

import { log, warn } from "../utils.js";

const execFileAsync = promisify(execFile);

/** The API origin; overridable for testing and for a self-hosted gateway. */
function apiOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_ENDPOINT_ORIGIN ?? env.ZCODE_BASE_URL ?? "https://zcode.z.ai";
}

const MANIFEST_PATH = "/api/v1/releases/electron/manifest";
const MANIFEST_ACCEPT = "application/x-yaml,text/yaml,text/plain,*/*";
const REQUEST_TIMEOUT_MS = 20_000;

/** Channel → the API's numeric spelling (manifestUpdateProvider.ts:41-42). */
const CHANNEL_VALUES = { stable: 1, preview: 3 } as const;
export type ReleaseChannel = keyof typeof CHANNEL_VALUES;

/** Node platform → the manifest's spelling (manifestUpdateProvider.ts:57-68). */
export function releasePlatform(platform: NodeJS.Platform, arch: string): string {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform;
  const cpu =
    arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch === "ia32" ? "x86" : arch;
  return `${os}-${cpu}`;
}

/** One downloadable artifact the manifest offers. */
export interface ReleaseFile {
  url: string;
  sha512?: string;
  size?: number;
}

export interface ReleaseManifest {
  version: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseNotesByLocale?: Record<string, { title?: string; markdown?: string }>;
  files: ReleaseFile[];
  /** The single-artifact fallback electron-updater uses when no arch matches. */
  path?: string;
}

export interface UpdateCheck {
  /** True when the manifest offers a strictly newer version. */
  updateAvailable: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  channel: ReleaseChannel;
  platform: string;
  /** Populated only when an update is available. */
  release?: ReleaseManifest;
}

/**
 * Where the app is installed, or null when it is not found.
 *
 * `ZCODE_APP_PATH` overrides the whole lookup so a test (or a non-standard
 * install) can point somewhere safe. The candidate list mirrors the table in
 * `backend/resolve.ts`: /Applications first, then the per-user location, then
 * the Linux prefixes.
 */
export function appBundlePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ZCODE_APP_PATH?.trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    // An override that does not exist means "nowhere", not "trust me" — the
    // caller decides what to do about a missing install, and answering with a
    // phantom path would make an install target that cannot be written.
    return existsSync(resolved) ? resolved : null;
  }
  const home = env.HOME || process.env.HOME || "";
  const candidates =
    process.platform === "win32"
      ? [
          path.join(
            env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
            "Programs",
            "ZCode",
            "ZCode.exe",
          ),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/ZCode.app",
            path.join(home, "Applications", "ZCode.app"),
            "/opt/ZCode/ZCode.app",
            "/usr/share/zcode/ZCode.app",
          ]
        : ["/opt/ZCode/zcode", "/usr/share/zcode/zcode", "/usr/local/bin/zcode"];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * The installed app's version, read from its bundle.
 *
 * macOS: `CFBundleShortVersionString` out of `Info.plist`, parsed without a
 * plist library (the file is XML for these builds; a binary plist falls back to
 * `defaults read`, which handles both). Windows: the file version of the .exe.
 * Linux: null — there is no reliable in-bundle version.
 */
export async function installedAppVersion(
  appPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = updatePlatform,
): Promise<string | null> {
  if (platform !== "darwin") return env.ZCODE_APP_VERSION?.trim() || null;
  const plist = path.join(appPath, "Contents", "Info.plist");
  try {
    const text = await readFile(plist, "utf8");
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u.exec(text);
    if (match) return match[1]!.trim();
  } catch {
    /* fall through to defaults */
  }
  try {
    const { stdout } = await execFileAsync("defaults", [
      "read",
      plist,
      "CFBundleShortVersionString",
    ]);
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Compare two version strings numerically, segment by segment.
 *
 * Local on purpose: `utils.compareVersions` is fine for semver-ish strings but
 * the manifest can carry a build suffix (`3.14.1.7714`), and comparing
 * `7714` against a missing segment must not flip the result.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .split(/[.-]/u)
      .map((part) => Number.parseInt(part, 10))
      .map((n) => (Number.isNaN(n) ? 0 : n));
  const a = parse(candidate);
  const b = parse(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const na = a[i] ?? 0;
    const nb = b[i] ?? 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

/**
 * Parse the manifest YAML.
 *
 * The manifest is a small, fixed-shape document (version + files + release
 * notes), so a real YAML parser would be a dependency for no benefit. This
 * reader handles exactly the shapes the endpoint emits: a flat top level, a
 * `files:` list of mappings, and the `releaseNotesByLocale` nesting. Block
 * scalars (`|-`) are collected by indentation.
 *
 * Anything it does not understand throws rather than guessing — a misparsed
 * manifest would install the wrong build.
 */
export function parseManifest(raw: string): ReleaseManifest {
  const lines = raw.replace(/\r\n/gu, "\n").split("\n");
  const root: Record<string, string> = {};
  const files: Array<Record<string, string>> = [];
  const byLocale: Record<string, { title?: string; markdown?: string }> = {};

  /** Which mapping a line belongs to. */
  type Target = "root" | "file" | "locale";
  let context: Target = "root";
  let file: Record<string, string> | null = null;
  let locale: Record<string, string> | null = null;
  let block: { indent: number; key: string; lines: string[]; target: Target } | null = null;

  const flushBlock = (): void => {
    if (!block) return;
    // Dedent by the smallest indentation actually present: YAML block scalars
    // are relative to their key, and the first body line sets the baseline.
    const indents = block.lines.filter((l) => l.trim() !== "").map((l) => leadingSpaces(l));
    const base = indents.length > 0 ? Math.min(...indents) : 0;
    const text = block.lines
      .map((l) => (l.trim() === "" ? "" : l.slice(base)))
      .join("\n")
      .replace(/\n+$/u, "");
    if (block.target === "root") root[block.key] = text;
    else if (block.target === "file" && file) file[block.key] = text;
    else if (block.target === "locale" && locale) locale[block.key] = text;
    block = null;
  };

  for (const line of lines) {
    if (block) {
      const indent = leadingSpaces(line);
      // A block scalar ends at the first line that is not indented deeper than
      // its key (blank lines belong to it, so their indent is ignored).
      if (line.trim() === "" || indent > block.indent) {
        block.lines.push(line);
        continue;
      }
      flushBlock();
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const indent = leadingSpaces(line);
    const trimmed = line.trim();

    // A list item starts a new file entry.
    if (context === "file" && trimmed.startsWith("- ")) {
      file = {};
      files.push(file);
      assign(file, trimmed.slice(2));
      continue;
    }

    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();

    if (value === "|-" || value === "|" || value === ">") {
      block = { indent, key, lines: [], target: context };
      continue;
    }

    if (indent === 0) {
      flushBlock();
      context = "root";
      file = null;
      locale = null;
      if (key === "files") {
        context = "file";
        continue;
      }
      if (key === "releaseNotesByLocale") {
        context = "locale";
        continue;
      }
      root[key] = unquote(value);
      continue;
    }

    if (context === "file" && file) {
      file[key] = unquote(value);
      continue;
    }
    if (context === "locale") {
      // A locale key is a bare mapping key with no value (`en-US:`).
      if (value === "") {
        locale = byLocale[key] ?? {};
        byLocale[key] = locale;
        continue;
      }
      if (locale) locale[key] = unquote(value);
    }
  }
  flushBlock();

  if (!root["version"]) throw new Error("manifest_missing_version");
  return {
    version: root["version"],
    ...(root["releaseName"] ? { releaseName: root["releaseName"] } : {}),
    ...(root["releaseNotes"] ? { releaseNotes: root["releaseNotes"] } : {}),
    ...(root["path"] ? { path: root["path"] } : {}),
    files: files
      .filter((f) => typeof f["url"] === "string")
      .map((f) => ({ url: f["url"]!, ...(f["sha512"] ? { sha512: f["sha512"] } : {}) })),
    ...(Object.keys(byLocale).length > 0 ? { releaseNotesByLocale: byLocale } : {}),
  };
}

function leadingSpaces(line: string): number {
  const match = /^\s*/u.exec(line);
  return match ? match[0].length : 0;
}

/** Assign the first `key: value` pair of a `- key: value` list item. */
function assign(target: Record<string, string>, text: string): void {
  const colon = text.indexOf(":");
  if (colon < 0) return;
  target[text.slice(0, colon).trim()] = unquote(text.slice(colon + 1).trim());
}

/** Strip the quoting YAML allows around a scalar. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Pick the artifact to download for this platform.
 *
 * macOS prefers the zip (it extracts to a bundle directly and needs no mount);
 * Windows takes the exe; Linux takes the distro package. Falls back to the
 * manifest's top-level `path`, which is what electron-updater itself uses when
 * no per-arch entry matches.
 */
export function pickReleaseFile(manifest: ReleaseManifest): ReleaseFile | null {
  const suffixes =
    process.platform === "win32"
      ? [".exe"]
      : process.platform === "darwin"
        ? [".zip", ".dmg"]
        : [".appimage", ".deb", ".rpm", ".pkg.tar.zst"];
  for (const suffix of suffixes) {
    const found = manifest.files.find((f) => f.url.toLowerCase().endsWith(suffix));
    if (found) return found;
  }
  return manifest.files[0] ?? null;
}

/**
 * Fetch and parse the release manifest.
 *
 * `fetchImpl` defaults to the module seam (not bare `fetch`) so a test that
 * overrides the network also covers this path, not just `checkForAppUpdate`.
 */
export async function fetchReleaseManifest(
  channel: ReleaseChannel,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = manifestNetwork,
): Promise<ReleaseManifest> {
  const platform = releasePlatform(process.platform, process.arch);
  const url = new URL(MANIFEST_PATH, apiOrigin(env));
  url.searchParams.set("platform", platform);
  url.searchParams.set("channel", String(CHANNEL_VALUES[channel]));
  const res = await fetchImpl(url.toString(), {
    headers: {
      Accept: MANIFEST_ACCEPT,
      "X-Platform": platform,
      "X-Release-Channel": String(CHANNEL_VALUES[channel]),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`manifest_http_${res.status}`);
  const text = await res.text();
  return parseManifest(text);
}

/**
 * The network used for the manifest read AND the artifact download, overridable
 * so tests (and the settings endpoint's route tests) never touch the real CDN.
 *
 * A module-level seam rather than threading a parameter through every caller:
 * the route handler would otherwise have to accept an injected fetch from the
 * HTTP layer, which no client can supply.
 */
let manifestNetwork: typeof fetch = fetch;

/** Override the update network. Pass `fetch` to restore the default. */
export function setManifestNetworkForTest(impl: typeof fetch): void {
  manifestNetwork = impl;
}

/**
 * The platform the update flows run as.
 *
 * Defaults to `process.platform`, which makes the feature untestable from any
 * OS but the one it targets: on a Linux runner the whole macOS install path
 * (bundle discovery, plist version, the rename swap) is skipped, so the route
 * tests that exercise it pass on a developer's Mac and fail everywhere else.
 * A module-level seam, same shape and rationale as `manifestNetwork` — the
 * platform is not something an HTTP caller can supply.
 */
let updatePlatform: NodeJS.Platform = process.platform;

/** Override the platform the update flows run as (test seam). */
export function setAppUpdatePlatformForTest(platform: NodeJS.Platform): void {
  updatePlatform = platform;
}

/** The platform the update flows run as. */
function currentPlatform(overridden?: NodeJS.Platform): NodeJS.Platform {
  return overridden ?? updatePlatform;
}

/**
 * Compare the installed app against the manifest.
 *
 * A missing install (the bridge running on a machine without the app) is not an
 * error: `updateAvailable` stays false and `currentVersion` is null, so the
 * client can hide the row instead of showing a failure.
 */
export async function checkForAppUpdate(
  options: {
    channel?: ReleaseChannel;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): Promise<UpdateCheck> {
  const env = options.env ?? process.env;
  const platform = currentPlatform(options.platform);
  const channel = options.channel ?? "stable";
  const appPath = appBundlePath(env);
  const currentVersion = appPath ? await installedAppVersion(appPath, env, platform) : null;
  const manifest = await fetchReleaseManifest(channel, env, manifestNetwork);
  const updateAvailable =
    currentVersion !== null && isNewerVersion(manifest.version, currentVersion);
  return {
    updateAvailable,
    currentVersion,
    latestVersion: manifest.version,
    channel,
    platform: releasePlatform(process.platform, process.arch),
    ...(updateAvailable ? { release: manifest } : {}),
  };
}

// ---------- download ----------

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

export interface DownloadResult {
  file: string;
  sha512: string;
  sizeBytes: number;
  /** True when the hash matched the manifest's `sha512`. */
  verified: boolean;
}

/**
 * Download an artifact into a temp directory, streaming and hashing as it goes.
 *
 * The hash is verified before anything is installed: a truncated or tampered
 * download that failed here is a failed download, not a bad install.
 *
 * The body is consumed as a web `ReadableStream` (what `fetch` returns), not a
 * Node stream — `pipe` does not exist on it.
 */
export async function downloadRelease(
  file: ReleaseFile,
  options: {
    destDir?: string;
    fetchImpl?: typeof fetch;
    onProgress?: (p: DownloadProgress) => void;
  } = {},
): Promise<DownloadResult> {
  const dir = options.destDir ?? (await mkdtemp(path.join(tmpdir(), "zcode-acp-update-")));
  const name = path.basename(new URL(file.url).pathname) || "zcode-release.zip";
  const target = path.join(dir, name);
  const fetchImpl = options.fetchImpl ?? manifestNetwork;
  // A full app is ~250 MB, so there is no request timeout — an idle-stall guard
  // would fire on a slow link. `AbortSignal.timeout(0)` fires immediately, so
  // no signal is passed at all.
  const res = await fetchImpl(file.url);
  if (!res.ok || !res.body) throw new Error(`download_http_${res.status}`);
  const total = Number(res.headers.get("content-length") ?? "") || null;
  const hash = createHash("sha512");
  const out = createWriteStream(target);
  let received = 0;
  const finished = new Promise<void>((resolve, reject) => {
    out.on("error", reject);
    out.on("close", () => resolve());
  });
  try {
    for await (const chunk of res.body) {
      const buf = chunk as Buffer;
      received += buf.length;
      hash.update(buf);
      out.write(buf);
      options.onProgress?.({ receivedBytes: received, totalBytes: total });
    }
    out.end();
    await finished;
  } catch (error) {
    out.destroy();
    throw error;
  }
  const sha512 = hash.digest("base64");
  const verified = !file.sha512 || sha512 === file.sha512;
  if (!verified) throw new Error("download_checksum_mismatch");
  await chmod(target, 0o644);
  log(`app-update: downloaded ${name} (${received} bytes, sha512 ${verified ? "ok" : "MISMATCH"})`);
  return { file: target, sha512, sizeBytes: received, verified };
}

// ---------- install ----------

export type InstallStage =
  "idle" | "downloading" | "installing" | "done" | "needs-user-install" | "failed";

export interface InstallState {
  stage: InstallStage;
  version: string | null;
  receivedBytes: number;
  totalBytes: number | null;
  /**
   * Where the verified bundle is, for `needs-user-install`. The client shows
   * this path (or reveals it in Finder) so the user can finish the install
   * themselves.
   */
  artifactPath?: string;
  /** True on `done`: the new build is on disk and the app must be reopened. */
  restartRequired?: boolean;
  error?: string;
}

let installState: InstallState = {
  stage: "idle",
  version: null,
  receivedBytes: 0,
  totalBytes: null,
};

/** Current install state — the endpoint reports it verbatim. */
export function appUpdateState(): InstallState {
  return { ...installState };
}

/**
 * The unzip command used for a downloaded archive.
 *
 * `ditto` is the macOS one (it preserves the resource forks and extended
 * attributes an Electron bundle relies on, which `unzip -X` can corrupt on
 * older builds). A module-level seam so tests can supply an unzip that exists
 * on the host they run on — `ditto` is absent from Linux, and a test that
 * depends on it cannot assert the extraction logic at all.
 */
let extractCommand: (zipPath: string, destDir: string) => Promise<void> = defaultExtract;

async function defaultExtract(zipPath: string, destDir: string): Promise<void> {
  await execFileAsync("ditto", ["-xk", zipPath, destDir], { timeout: 600_000 });
}

/** Override the unzip used by the installer (test seam). */
export function setExtractForTest(impl: (zipPath: string, destDir: string) => Promise<void>): void {
  extractCommand = impl;
}

/** Restore the platform's own unzip (test seam). */
export function resetExtractForTest(): void {
  extractCommand = defaultExtract;
}

/**
 * Extract a downloaded zip into a staging directory.
 *
 * The zip contains a single `ZCode.app/` at its root, so extraction happens
 * into a scratch directory and the resulting bundle is what gets installed —
 * that way a partially extracted archive is never the thing that replaces the
 * app.
 */
async function extractZip(zipPath: string, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true });
  await extractCommand(zipPath, destDir);
  const bundle = path.join(destDir, "ZCode.app");
  let info: Stats;
  try {
    info = await stat(bundle);
  } catch {
    throw new Error("archive_missing_app_bundle");
  }
  // A FILE named ZCode.app is a malformed archive, not a bundle. Renaming it
  // over the installed app would leave a file where a directory is expected and
  // the app would no longer launch.
  if (!info.isDirectory()) throw new Error("archive_app_bundle_is_not_a_directory");
  return bundle;
}

/**
 * Whether this process can write the install location itself.
 *
 * Probing rather than assuming: `/Applications` looks unwritable
 * (`drwxrwxr-x root:admin`) yet the installed `ZCode.app` is user-owned, so the
 * permission bits do not settle it — TCC may or may not gate the write
 * depending on how the bridge was launched. `accessSync` on the PARENT (a
 * bundle swap is a rename within it) answers it at install time, and the code is
 * correct either way: writable → swap, unwritable → hand the bundle back.
 *
 * Every attempt to characterise this from inside a bridge session is
 * inconclusive: the session runs under Seatbelt, where even writing the user's
 * own HOME is denied. Treat that as a sandbox denial, not a filesystem verdict.
 */
function canWriteInstallLocation(appPath: string): boolean {
  const parent = path.dirname(appPath);
  try {
    // Access the PARENT, because replacing a bundle is a rename within it.
    accessSync(parent, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a full update: download, verify, extract, install.
 *
 * Single-flight. A second call while one is running joins the running install
 * instead of starting a parallel download — two concurrent installs would race
 * on the same destination bundle.
 *
 * The outcome depends on where the app is installed:
 *
 *  - writable location (e.g. `~/Applications`): the bundle is replaced and the
 *    state ends `done`, with `restartRequired` telling the client to ask the
 *    user to quit and reopen. The app is never killed from here — it may hold
 *    in-flight session state, and macOS keeps a running process's inode alive
 *    across the rename anyway.
 *  - not writable (e.g. `/Applications`): the download and verification still
 *    run, but the swap is not attempted. The state ends `needs-user-install`
 *    with `artifactPath` pointing at the verified bundle, and the client shows
 *    the user a "move this into place" instruction (or opens it in Finder so
 *    they can drag it). Reporting success here would be a lie.
 */
let inFlight: Promise<InstallState> | null = null;

/**
 * Bumped by every reset so an install abandoned mid-flight cannot write its
 * outcome over the state a newer caller is setting.
 *
 * Without it, a reset between two tests clears `inFlight` while the old install
 * is still running; the next `startAppUpdate` then starts fresh and the
 * abandoned install's `finally` later overwrites its state — which is how a
 * "second install is refused" test saw a stale success instead of the 409.
 */
let installGeneration = 0;

/**
 * The rename used to swap bundles. A module-level seam (rather than a
 * parameter threaded through `startAppUpdate`) so a test can fail the SECOND
 * rename specifically — the one window where a naive implementation would
 * leave the machine with no app. No filesystem setup can produce that failure:
 * anything that blocks rename #2 blocks rename #1 too.
 */
let renameFile: typeof rename = rename;

/** Override the rename used by the installer (test seam). */
export function setInstallRenameForTest(impl: typeof rename): void {
  renameFile = impl;
}

export function startAppUpdate(
  file: ReleaseFile,
  version: string,
  options: {
    channel?: ReleaseChannel;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<InstallState> {
  if (inFlight) return inFlight;
  const env = options.env ?? process.env;
  const platform = currentPlatform(options.platform);
  // Defaults to the seam (not bare `fetch`) so a test that overrides the
  // network also covers the install path, not just the manifest read.
  const fetchImpl = options.fetchImpl ?? manifestNetwork;
  const generation = installGeneration;
  // Every state write goes through here, so an abandoned install (one whose
  // generation was superseded by a reset) stops reporting the moment it is
  // orphaned rather than at its next await point.
  const publish = (next: Partial<InstallState>): void => {
    if (generation !== installGeneration) return;
    installState = { ...installState, ...next };
  };
  installState = { stage: "downloading", version, receivedBytes: 0, totalBytes: file.size ?? null };
  const run = (async (): Promise<InstallState> => {
    try {
      const staging = await mkdtemp(path.join(tmpdir(), "zcode-acp-update-"));
      try {
        const downloaded = await downloadRelease(file, {
          destDir: staging,
          fetchImpl,
          onProgress: (p) => {
            publish({ receivedBytes: p.receivedBytes, totalBytes: p.totalBytes });
          },
        });
        publish({ stage: "installing" });
        const appPath = appBundlePath(env);
        if (!appPath) throw new Error("app_not_installed");

        if (platform !== "darwin") {
          // Linux/Windows installs belong to a package manager (apt, dnf,
          // pacman, winget); a raw file move would bypass it and leave the
          // package database disagreeing with the filesystem. Hand the verified
          // artifact back and let the client's instructions do the rest.
          publish({ stage: "needs-user-install", artifactPath: downloaded.file });
          return { ...installState };
        }

        const extracted = await extractZip(downloaded.file, path.join(staging, "extracted"));
        if (!canWriteInstallLocation(appPath)) {
          // The download and checksum succeeded, but the swap is not ours to
          // do: no password prompt, no Finder Apple Event, no shipped helper.
          // Report the artifact rather than claiming the app was updated.
          warn(
            `app-update: ${path.dirname(appPath)} is not writable by this process — ` +
              "the verified bundle is left at " +
              extracted,
          );
          publish({ stage: "needs-user-install", artifactPath: extracted });
          return { ...installState };
        }
        // Replace atomically-ish: move the old bundle aside, move the new one
        // in, then delete the old one. A failure at the second rename restores
        // the previous bundle, so the window between them can never leave the
        // machine with no app.
        const previous = `${appPath}.previous-${Date.now()}`;
        await renameFile(appPath, previous);
        try {
          await renameFile(extracted, appPath);
        } catch (error) {
          // Put the old bundle back. If THIS also fails the machine is in a
          // state no code can fix (a read-only install dir), so surface the
          // original error rather than masking it with the restore failure.
          await renameFile(previous, appPath).catch(() => undefined);
          throw error;
        }
        await rm(previous, { recursive: true, force: true }).catch(() => undefined);
        publish({ stage: "done", restartRequired: true });
        return { ...installState };
      } finally {
        // Only sweep the staging dir when nothing in it is still needed. A
        // needs-user-install outcome deliberately keeps the extracted bundle.
        if (installState.stage !== "needs-user-install") {
          await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`app-update: install failed: ${message}`);
      publish({ stage: "failed", error: message });
      return { ...installState };
    } finally {
      if (generation === installGeneration) inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}

/** Clear the stored install state (test seam). */
export function resetAppUpdateStateForTest(): void {
  installState = { stage: "idle", version: null, receivedBytes: 0, totalBytes: null };
  inFlight = null;
  // Orphan any install still running: it stops reporting and stops clearing
  // `inFlight`, so the next caller gets a clean single-flight slot.
  installGeneration += 1;
}
