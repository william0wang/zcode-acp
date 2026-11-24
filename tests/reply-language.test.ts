/**
 * Agent reply-language reader tests.
 *
 * readReplyLanguage reads <zcode-home>/v2/setting.json LIVE per call (the
 * backend re-reads on every attachment collection; the desktop app can change
 * the value at any time). Every failure shape — missing key, non-string, empty
 * string, corrupt JSON, BOM-prefixed file, absent file — reads as null and
 * never throws. Valid values pass through verbatim: the backend's schema is
 * the only validator.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readReplyLanguage } from "../src/config/reply-language.js";

let home: string;

function writeSetting(contents: string): void {
  const v2 = path.join(home, "v2");
  mkdirSync(v2, { recursive: true });
  writeFileSync(path.join(v2, "setting.json"), contents);
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "reply-language-test-"));
  vi.stubEnv("ZCODE_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("readReplyLanguage", () => {
  it("returns a configured language verbatim", () => {
    writeSetting(JSON.stringify({ replyLanguage: "日本語" }));
    expect(readReplyLanguage()).toBe("日本語");
  });

  it("re-reads the file on every call (no memoization)", () => {
    writeSetting(JSON.stringify({ replyLanguage: "Deutsch" }));
    expect(readReplyLanguage()).toBe("Deutsch");
    writeSetting(JSON.stringify({ replyLanguage: "简体中文" }));
    expect(readReplyLanguage()).toBe("简体中文");
  });

  it("returns null when the key is absent", () => {
    writeSetting(JSON.stringify({ localePreference: "zh" }));
    expect(readReplyLanguage()).toBeNull();
  });

  it("returns null for a non-string value", () => {
    writeSetting(JSON.stringify({ replyLanguage: 42 }));
    expect(readReplyLanguage()).toBeNull();
  });

  it("returns null for an empty string", () => {
    writeSetting(JSON.stringify({ replyLanguage: "" }));
    expect(readReplyLanguage()).toBeNull();
  });

  it("returns null for a corrupt JSON file", () => {
    writeSetting("{not json");
    expect(readReplyLanguage()).toBeNull();
  });

  it("reads a BOM-prefixed file", () => {
    writeSetting(`\uFEFF${JSON.stringify({ replyLanguage: "Français" })}`);
    expect(readReplyLanguage()).toBe("Français");
  });

  it("returns null when the file does not exist", () => {
    expect(readReplyLanguage()).toBeNull();
  });
});
