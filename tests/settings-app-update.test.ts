/**
 * App self-update tests.
 *
 * What matters here is the DECISION logic, not the network: the manifest parser
 * (a hand-rolled YAML reader), the version comparison (which must not trip over
 * the app's 4-segment build numbers), the platform artifact pick, and the
 * checksum gate that stops a bad download from becoming a bad install.
 *
 * Every network call goes through an injected `fetchImpl`, and the filesystem
 * through a temp `ZCODE_APP_PATH`/`HOME`, so the developer's real app and config
 * are never touched.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appBundlePath,
  appUpdateState,
  checkForAppUpdate,
  downloadRelease,
  installedAppVersion,
  isNewerVersion,
  parseManifest,
  pickReleaseFile,
  releasePlatform,
  resetAppUpdateStateForTest,
  resetExtractForTest,
  setAppUpdatePlatformForTest,
  setExtractForTest,
  setInstallRenameForTest,
  setManifestNetworkForTest,
  startAppUpdate,
} from "../src/settings/app-update.js";
import { zcodeHomeDir } from "../src/utils.js";

const execFileAsync = promisify(execFile);

/** The real manifest shape, trimmed to the fields the parser must handle. */
const MANIFEST_YAML = `version: 3.14.0
files:
    - url: https://cdn-zcode.z.ai/zcode/electron/releases/3.14.0/macos-arm64/ZCode-3.14.0-mac-arm64.zip
      sha512: boBf1tZhyfsqMjedn9h6TsTwkj/VvzMaCMa6i9t7iFpzFpV0LrqrRDmbtwwKZ7yvMc4gB3zSAUiavMKCisbGcQ==
      size: 243908771
    - url: https://cdn-zcode.z.ai/zcode/electron/releases/3.14.0/macos-arm64/ZCode-3.14.0-mac-arm64.dmg
      sha512: l1Rb25qM4MuChhWbYCy9Mehx6SObu/Bg+rVpPHPEDl80yoM/xh8LMrcvb/lRjzL+PeW7AgaQGpY/C/3Vq8KEqQ==
      size: 255178532
path: https://cdn-zcode.z.ai/zcode/electron/releases/3.14.0/macos-arm64/ZCode-3.14.0-mac-arm64.zip
sha512: boBf1tZhyfsqMjedn9h6TsTwkj/VvzMaCMa6i9t7iFpzFpV0LrqrRDmbtwwKZ7yvMc4gB3zSAUiavMKCisbGcQ==
releaseName: Release v3.14.0
releaseNotes: |-
    ## 新功能

    - 新增动态工作流
    - 输入框加号菜单
releaseNotesByLocale:
    en-US:
        title: ""
        markdown: |-
            ## New Features

            - Added dynamic workflows
    zh-CN:
        title: ""
        markdown: |-
            ## 新功能

            - 新增动态工作流
`;

const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  vi.stubEnv("ZCODE_HOME", zcodeHomeDir());
  // Pin the platform so the macOS paths (bundle discovery, plist version, the
  // rename swap) stay covered on a Linux runner.
  setAppUpdatePlatformForTest("darwin");
  // Production unzips with `ditto`, which is macOS-only and absent from CI.
  // `unzip` exists on both, so the extraction and validation logic is still
  // exercised everywhere instead of failing on a missing command.
  setExtractForTest((zipPath, destDir) => execFileAsync("unzip", ["-q", zipPath, "-d", destDir]));
});

afterEach(async () => {
  setAppUpdatePlatformForTest(process.platform);
  resetExtractForTest();
  vi.unstubAllEnvs();
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
});

describe("manifest parsing", () => {
  it("reads the version, both artifacts, and the single-artifact path", () => {
    const manifest = parseManifest(MANIFEST_YAML);
    expect(manifest.version).toBe("3.14.0");
    expect(manifest.releaseName).toBe("Release v3.14.0");
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files[0]).toEqual({
      url: "https://cdn-zcode.z.ai/zcode/electron/releases/3.14.0/macos-arm64/ZCode-3.14.0-mac-arm64.zip",
      sha512:
        "boBf1tZhyfsqMjedn9h6TsTwkj/VvzMaCMa6i9t7iFpzFpV0LrqrRDmbtwwKZ7yvMc4gB3zSAUiavMKCisbGcQ==",
    });
    expect(manifest.path).toContain("ZCode-3.14.0-mac-arm64.zip");
  });

  it("dedents block-scalar release notes", () => {
    const manifest = parseManifest(MANIFEST_YAML);
    expect(manifest.releaseNotes).toBe("## 新功能\n\n- 新增动态工作流\n- 输入框加号菜单");
  });

  it("reads the per-locale notes with their deeper indentation", () => {
    const manifest = parseManifest(MANIFEST_YAML);
    expect(Object.keys(manifest.releaseNotesByLocale ?? {}).sort()).toEqual(["en-US", "zh-CN"]);
    expect(manifest.releaseNotesByLocale?.["en-US"]?.markdown).toBe(
      "## New Features\n\n- Added dynamic workflows",
    );
    expect(manifest.releaseNotesByLocale?.["zh-CN"]?.markdown).toContain("新增动态工作流");
  });

  it("rejects a manifest with no version rather than guessing", () => {
    expect(() => parseManifest("files:\n    - url: https://x/y.zip\n")).toThrow(
      /manifest_missing_version/u,
    );
  });

  it("ignores comments and blank lines", () => {
    const manifest = parseManifest("# a comment\n\nversion: 1.2.3\n\n# trailing\n");
    expect(manifest.version).toBe("1.2.3");
  });
});

describe("artifact selection", () => {
  it("prefers the zip on macOS (extracts without a mount)", () => {
    const manifest = parseManifest(MANIFEST_YAML);
    const picked = pickReleaseFile(manifest);
    expect(picked?.url.endsWith(".zip")).toBe(true);
  });

  it("falls back to the first entry when nothing matches the platform", () => {
    const manifest = parseManifest("version: 1.0.0\nfiles:\n    - url: https://x/other.tar.gz\n");
    expect(pickReleaseFile(manifest)?.url).toBe("https://x/other.tar.gz");
  });
});

describe("version comparison", () => {
  it("treats a higher patch as newer", () => {
    expect(isNewerVersion("3.14.3", "3.14.1")).toBe(true);
  });
  it("treats an equal version as not newer", () => {
    expect(isNewerVersion("3.14.1", "3.14.1")).toBe(false);
  });
  it("treats a lower version as not newer", () => {
    expect(isNewerVersion("3.9.0", "3.14.1")).toBe(false);
  });
  it("compares a build suffix numerically, not lexically", () => {
    expect(isNewerVersion("3.14.1.7714", "3.14.1.7000")).toBe(true);
    expect(isNewerVersion("3.14.1.9000", "3.14.1.7714")).toBe(true);
  });
  it("treats a missing trailing segment as zero", () => {
    expect(isNewerVersion("3.14.1", "3.14.1.0")).toBe(false);
    expect(isNewerVersion("3.14.1.1", "3.14.1")).toBe(true);
  });
});

describe("platform spelling", () => {
  it("maps arm64 darwin to the manifest's aarch64 spelling", () => {
    expect(releasePlatform("darwin", "arm64")).toBe("darwin-aarch64");
  });
  it("maps x64 darwin to x86_64", () => {
    expect(releasePlatform("darwin", "x64")).toBe("darwin-x86_64");
  });
  it("maps win32 x64", () => {
    expect(releasePlatform("win32", "x64")).toBe("windows-x86_64");
  });
});

describe("installed app detection", () => {
  it("reads CFBundleShortVersionString from the bundle's Info.plist", async () => {
    const app = await mkdtemp(path.join(tmpdir(), "app-update-bundle-"));
    cleanups.push(() => rm(app, { recursive: true, force: true }));
    const plist = path.join(app, "Contents", "Info.plist");
    await mkdir(path.dirname(plist), { recursive: true });
    await writeFile(
      plist,
      `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>dev.zcode.app</string><key>CFBundleShortVersionString</key><string>3.14.1</string></dict></plist>`,
      "utf8",
    );
    expect(await installedAppVersion(app, process.env, "darwin")).toBe("3.14.1");
  });

  it("honours an explicit ZCODE_APP_PATH override", async () => {
    const app = await mkdtemp(path.join(tmpdir(), "app-update-override-"));
    cleanups.push(() => rm(app, { recursive: true, force: true }));
    vi.stubEnv("ZCODE_APP_PATH", app);
    expect(appBundlePath()).toBe(path.resolve(app));
  });

  it("returns null when no app is installed", () => {
    vi.stubEnv("ZCODE_APP_PATH", path.join(tmpdir(), "definitely-not-installed-xyz"));
    expect(appBundlePath()).toBeNull();
  });
});

describe("checkForAppUpdate", () => {
  const manifestFor = (version: string): string =>
    MANIFEST_YAML.replace(/^version: .*$/mu, `version: ${version}`);

  /** A fetch that answers the manifest and records the URL it was asked for. */
  function manifestFetch(version: string): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(manifestFor(version), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  /** Install a temp bundle reporting `version` and point ZCODE_APP_PATH at it. */
  async function fakeApp(version: string): Promise<string> {
    const app = await mkdtemp(path.join(tmpdir(), "app-update-fake-"));
    cleanups.push(() => rm(app, { recursive: true, force: true }));
    const plist = path.join(app, "Contents", "Info.plist");
    await mkdir(path.dirname(plist), { recursive: true });
    await writeFile(
      plist,
      `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
      "utf8",
    );
    vi.stubEnv("ZCODE_APP_PATH", app);
    return app;
  }

  it("reports an update when the manifest is strictly newer", async () => {
    await fakeApp("3.14.1");
    const { fetchImpl, urls } = manifestFetch("3.14.3");
    setManifestNetworkForTest(fetchImpl);
    try {
      const check = await checkForAppUpdate({ channel: "stable", platform: "darwin" });
      expect(check.updateAvailable).toBe(true);
      expect(check.currentVersion).toBe("3.14.1");
      expect(check.latestVersion).toBe("3.14.3");
      expect(check.release?.files).toHaveLength(2);
      expect(urls[0]).toContain("channel=1");
    } finally {
      setManifestNetworkForTest(fetch);
    }
  });

  it("reports no update when the manifest is at or below the installed version", async () => {
    await fakeApp("3.14.0");
    const { fetchImpl } = manifestFetch("3.14.0");
    setManifestNetworkForTest(fetchImpl);
    try {
      const check = await checkForAppUpdate({ channel: "stable", platform: "darwin" });
      expect(check.updateAvailable).toBe(false);
      expect(check.release).toBeUndefined();
    } finally {
      setManifestNetworkForTest(fetch);
    }
  });

  it("uses the preview channel value when asked", async () => {
    await fakeApp("3.14.1");
    const { fetchImpl, urls } = manifestFetch("3.14.9");
    setManifestNetworkForTest(fetchImpl);
    try {
      const check = await checkForAppUpdate({ channel: "preview", platform: "darwin" });
      expect(check.channel).toBe("preview");
      expect(urls[0]).toContain("channel=3");
    } finally {
      setManifestNetworkForTest(fetch);
    }
  });

  it("reports no update (not an error) when the app is not installed", async () => {
    vi.stubEnv("ZCODE_APP_PATH", path.join(tmpdir(), "no-such-app-abc"));
    const { fetchImpl } = manifestFetch("9.9.9");
    setManifestNetworkForTest(fetchImpl);
    try {
      const check = await checkForAppUpdate({ channel: "stable", platform: "darwin" });
      expect(check.updateAvailable).toBe(false);
      expect(check.currentVersion).toBeNull();
      expect(check.latestVersion).toBe("9.9.9");
    } finally {
      setManifestNetworkForTest(fetch);
    }
  });

  it("propagates a manifest HTTP failure", async () => {
    await fakeApp("3.14.1");
    const fetchImpl = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    setManifestNetworkForTest(fetchImpl);
    try {
      await expect(checkForAppUpdate({ channel: "stable", platform: "darwin" })).rejects.toThrow(
        /manifest_http_503/u,
      );
    } finally {
      setManifestNetworkForTest(fetch);
    }
  });
});

describe("downloadRelease", () => {
  /** Serve `body` with a content-length so progress can be observed. */
  function serve(body: string): typeof fetch {
    return (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(body)) },
      })) as unknown as typeof fetch;
  }

  it("streams to disk and verifies the manifest's sha512", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "app-update-dl-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const body = "a pretend zip payload";
    const sha512 = createHash("sha512").update(body).digest("base64");
    const result = await downloadRelease(
      {
        url: "https://cdn-zcode.z.ai/zcode/electron/releases/1.0.0/macos-arm64/ZCode-1.0.0.zip",
        sha512,
      },
      { destDir: dir, fetchImpl: serve(body) },
    );
    expect(result.verified).toBe(true);
    expect(result.sizeBytes).toBe(Buffer.byteLength(body));
    expect(path.basename(result.file)).toBe("ZCode-1.0.0.zip");
  });

  it("rejects a download whose hash does not match", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "app-update-bad-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const fetchImpl = (async () =>
      new Response("tampered", { status: 200 })) as unknown as typeof fetch;
    await expect(
      downloadRelease(
        {
          url: "https://cdn-zcode.z.ai/zcode/electron/releases/1.0.0/macos-arm64/ZCode-1.0.0.zip",
          sha512: "not-the-real-hash",
        },
        { destDir: dir, fetchImpl },
      ),
    ).rejects.toThrow(/download_checksum_mismatch/u);
  });

  it("reports progress as bytes arrive", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "app-update-prog-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const body = "0123456789";
    const sha512 = createHash("sha512").update(body).digest("base64");
    const seen: number[] = [];
    await downloadRelease(
      {
        url: "https://cdn-zcode.z.ai/zcode/electron/releases/1.0.0/macos-arm64/ZCode-1.0.0.zip",
        sha512,
      },
      {
        destDir: dir,
        fetchImpl: serve(body),
        onProgress: (p) => seen.push(p.receivedBytes),
      },
    );
    expect(seen.at(-1)).toBe(10);
  });

  it("rejects an HTTP error status", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "app-update-404-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const fetchImpl = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(
      downloadRelease(
        { url: "https://cdn-zcode.z.ai/zcode/electron/releases/1.0.0/macos-arm64/ZCode-1.0.0.zip" },
        { destDir: dir, fetchImpl },
      ),
    ).rejects.toThrow(/download_http_404/u);
  });
});

describe("startAppUpdate", () => {
  /**
   * A real, minimal `ZCode.app/Contents/Info.plist` zip served over the seam.
   *
   * Built with `zip` (present on macOS and on the Linux CI image) rather than a
   * hand-rolled zip writer, so the parser-under-test sees genuine archive bytes
   * including the central directory.
   */
  async function releaseZip(): Promise<{ zip: Buffer; sha512: string }> {
    const src = await mkdtemp(path.join(tmpdir(), "app-update-src-"));
    cleanups.push(() => rm(src, { recursive: true, force: true }));
    await mkdir(path.join(src, "ZCode.app", "Contents"), { recursive: true });
    await writeFile(
      path.join(src, "ZCode.app", "Contents", "Info.plist"),
      `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>9.9.9</string></dict></plist>`,
      "utf8",
    );
    const zipPath = path.join(src, "release.zip");
    await execFileAsync("zip", ["-qr", zipPath, "ZCode.app"], { cwd: src });
    const zip = await readFile(zipPath);
    return { zip, sha512: createHash("sha512").update(zip).digest("base64") };
  }

  /** An installed bundle at `root` reporting `version`. */
  async function installedAppAt(root: string, version: string): Promise<string> {
    const app = path.join(root, "ZCode.app");
    await mkdir(path.join(app, "Contents"), { recursive: true });
    await writeFile(
      path.join(app, "Contents", "Info.plist"),
      `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
      "utf8",
    );
    await writeFile(path.join(app, "Contents", "marker.txt"), "old", "utf8");
    return app;
  }

  it("replaces the bundle and asks for a restart when the location is writable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-update-install-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const app = await installedAppAt(root, "3.14.0");
    vi.stubEnv("ZCODE_APP_PATH", app);
    const { zip, sha512 } = await releaseZip();
    setManifestNetworkForTest(
      (async () => new Response(zip, { status: 200 })) as unknown as typeof fetch,
    );
    try {
      const state = await startAppUpdate(
        {
          url: "https://cdn-zcode.z.ai/zcode/electron/releases/9.9.9/macos-arm64/ZCode-9.9.9.zip",
          sha512,
        },
        "9.9.9",
        { platform: "darwin" },
      );
      expect(state.stage).toBe("done");
      expect(state.restartRequired).toBe(true);
      expect(state.error).toBeUndefined();
      const plist = await readFile(path.join(app, "Contents", "Info.plist"), "utf8");
      expect(plist).toContain("9.9.9");
      // The old bundle must be gone, not left behind as a `.previous-*` sibling.
      const siblings = await readdir(root);
      expect(siblings).toEqual(["ZCode.app"]);
    } finally {
      setManifestNetworkForTest(fetch);
      resetAppUpdateStateForTest();
    }
  });

  it("refuses an archive whose ZCode.app is not a bundle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-update-rollback-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const app = await installedAppAt(root, "3.14.0");
    vi.stubEnv("ZCODE_APP_PATH", app);
    // A zip whose ZCode.app entry is a FILE. Renaming that over the installed
    // bundle would leave a file where a directory is expected and the app would
    // no longer launch — so it must fail before any rename happens.
    const badSrc = await mkdtemp(path.join(tmpdir(), "app-update-badsrc-"));
    cleanups.push(() => rm(badSrc, { recursive: true, force: true }));
    await writeFile(path.join(badSrc, "ZCode.app"), "not a bundle", "utf8");
    const badZip = path.join(root, "bad.zip");
    await execFileAsync("zip", ["-qr", badZip, "ZCode.app"], { cwd: badSrc });
    const badBytes = await readFile(badZip);
    const badSha = createHash("sha512").update(badBytes).digest("base64");
    setManifestNetworkForTest(
      (async () => new Response(badBytes, { status: 200 })) as unknown as typeof fetch,
    );
    try {
      const state = await startAppUpdate(
        {
          url: "https://cdn-zcode.z.ai/zcode/electron/releases/9.9.9/macos-arm64/ZCode-9.9.9.zip",
          sha512: badSha,
        },
        "9.9.9",
        { platform: "darwin" },
      );
      expect(state.stage).toBe("failed");
      expect(state.error).toBe("archive_app_bundle_is_not_a_directory");
      // The installed app is untouched.
      const plist = await readFile(path.join(app, "Contents", "Info.plist"), "utf8");
      expect(plist).toContain("3.14.0");
      expect(await readFile(path.join(app, "Contents", "marker.txt"), "utf8")).toBe("old");
    } finally {
      setManifestNetworkForTest(fetch);
      resetAppUpdateStateForTest();
    }
  });

  it("restores the previous bundle when the replacement rename fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-update-rollback-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const app = await installedAppAt(root, "3.14.0");
    vi.stubEnv("ZCODE_APP_PATH", app);
    const { zip, sha512 } = await releaseZip();
    setManifestNetworkForTest(
      (async () => new Response(zip, { status: 200 })) as unknown as typeof fetch,
    );
    // Fail the SECOND rename only — the one window where a naive implementation
    // would leave the machine with no app. No filesystem setup can produce this
    // (anything that blocks rename #2 blocks rename #1 too), hence the seam.
    const realRename = rename;
    let calls = 0;
    setInstallRenameForTest((async (a: string, b: string) => {
      calls += 1;
      if (calls === 2) {
        const err = new Error("simulated rename failure") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return realRename(a, b);
    }) as typeof rename);
    try {
      const state = await startAppUpdate(
        {
          url: "https://cdn-zcode.z.ai/zcode/electron/releases/9.9.9/macos-arm64/ZCode-9.9.9.zip",
          sha512,
        },
        "9.9.9",
        { platform: "darwin" },
      );
      expect(state.stage).toBe("failed");
      // The original bundle is back in place and still the old version.
      const plist = await readFile(path.join(app, "Contents", "Info.plist"), "utf8");
      expect(plist).toContain("3.14.0");
      expect(await readFile(path.join(app, "Contents", "marker.txt"), "utf8")).toBe("old");
      // And no `.previous-*` sibling is left behind.
      expect(await readdir(root)).toEqual(["ZCode.app"]);
    } finally {
      setInstallRenameForTest(rename);
      setManifestNetworkForTest(fetch);
      resetAppUpdateStateForTest();
    }
  });

  it("reports needs-user-install (not success) when the location is not writable", async () => {
    // The real-world case for an app under `/Applications`: whatever the reason
    // the swap is refused, it must never be reported as a completed install.
    // Hermetic on purpose: a read-only PARENT directory reproduces the refusal
    // without depending on the machine's real `/Applications` (absent on CI, and
    // `chmod` is a no-op on the root of a container's overlay in some runners).
    const root = await mkdtemp(path.join(tmpdir(), "app-update-readonly-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const app = await installedAppAt(root, "3.14.0");
    const previousMode = (await stat(root)).mode;
    await chmod(root, 0o555);
    const stageDir = await mkdtemp(path.join(tmpdir(), "app-update-artifact-"));
    cleanups.push(() => rm(stageDir, { recursive: true, force: true }));
    const previousTmpdir = process.env.TMPDIR;
    try {
      const { zip, sha512 } = await releaseZip();
      setManifestNetworkForTest(
        (async () => new Response(zip, { status: 200 })) as unknown as typeof fetch,
      );
      vi.stubEnv("ZCODE_APP_PATH", app);
      // `accessSync` reads the real filesystem, so the read-only parent must be
      // real for the duration of the call — no stubbing involved.
      vi.stubEnv("TMPDIR", stageDir);
      const state = await startAppUpdate(
        {
          url: "https://cdn-zcode.z.ai/zcode/electron/releases/9.9.9/macos-arm64/ZCode-9.9.9.zip",
          sha512,
        },
        "9.9.9",
        { platform: "darwin" },
      );
      expect(state.stage).toBe("needs-user-install");
      expect(state.artifactPath).toBeTruthy();
      // The verified bundle really is there for the user to move.
      const info = await stat(path.join(state.artifactPath!, "Contents", "Info.plist"));
      expect(info.isFile()).toBe(true);
      // And the installed app is untouched.
      const plist = await readFile(path.join(app, "Contents", "Info.plist"), "utf8");
      expect(plist).toContain("3.14.0");
      expect(plist).not.toContain("9.9.9");
      expect(await readdir(root)).toEqual(["ZCode.app"]);
    } finally {
      await chmod(root, previousMode & 0o777).catch(() => undefined);
      setManifestNetworkForTest(fetch);
      resetAppUpdateStateForTest();
      if (previousTmpdir === undefined) vi.stubEnv("TMPDIR", "");
      else vi.stubEnv("TMPDIR", previousTmpdir);
      vi.unstubAllEnvs();
    }
  });

  it("fails cleanly when no app is installed", async () => {
    vi.stubEnv("ZCODE_APP_PATH", path.join(tmpdir(), "app-update-none-xyz"));
    setManifestNetworkForTest(
      (async () => new Response("x", { status: 200 })) as unknown as typeof fetch,
    );
    try {
      const state = await startAppUpdate(
        { url: "https://cdn-zcode.z.ai/zcode/electron/releases/9.9.9/macos-arm64/ZCode-9.9.9.zip" },
        "9.9.9",
        { platform: "darwin" },
      );
      expect(state.stage).toBe("failed");
      expect(state.error).toBe("app_not_installed");
    } finally {
      setManifestNetworkForTest(fetch);
      resetAppUpdateStateForTest();
    }
  });

  it("runs only one install at a time", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-update-single-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const app = await installedAppAt(root, "3.14.0");
    vi.stubEnv("ZCODE_APP_PATH", app);
    const { zip, sha512 } = await releaseZip();
    let releaseHold: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    // Serve the whole body, but only once the test lets go — that keeps the
    // install parked in the downloading stage while the second caller arrives.
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await held;
        controller.enqueue(new Uint8Array(zip));
        controller.close();
      },
    });
    setManifestNetworkForTest(
      (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch,
    );
    try {
      const file = {
        url: "https://cdn-zcode.z.ai/zcode/electron/releases/9.9.9/macos-arm64/ZCode-9.9.9.zip",
        sha512,
      };
      const first = startAppUpdate(file, "9.9.9", { platform: "darwin" });
      const second = startAppUpdate(file, "9.9.9", { platform: "darwin" });
      // Same promise: the second caller joins the running install rather than
      // starting a second download that would race on the destination.
      expect(second).toBe(first);
      expect(appUpdateState().stage).toBe("downloading");
      releaseHold?.();
      await first;
      expect(appUpdateState().stage).toBe("done");
    } finally {
      releaseHold?.();
      setManifestNetworkForTest(fetch);
      resetAppUpdateStateForTest();
    }
  });
});
